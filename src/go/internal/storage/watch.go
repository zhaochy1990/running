// watch.go adds the watch-sync data layer to Store: schema migration, the
// canonical-UUID guard, and idempotent upserts. coros.SyncUser writes through
// the Writer interface (dependency injection), so the sync core never imports a
// concrete DB.
package storage

import (
	"context"
	"fmt"
	"reflect"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Writer is the watch-sync write surface. It is implemented by *Store and
// injected into the COROS adapter so the sync orchestration depends on an
// interface, not a concrete database.
type Writer interface {
	ActivityExists(ctx context.Context, userID, labelID string) (bool, error)
	UpsertActivity(ctx context.Context, a *Activity, laps []Lap, ts []TimeseriesPoint, zones []ActivityWatchZone) error
	UpsertActivityPreservingEmptyChildren(ctx context.Context, a *Activity, laps []Lap, ts []TimeseriesPoint, zones []ActivityWatchZone) error
	UpsertDailyHealth(ctx context.Context, h *DailyHealth) error
	UpsertDashboard(ctx context.Context, d *Dashboard) error
	UpsertDashboardPreservingNil(ctx context.Context, d *Dashboard) error
	UpsertDailyHRV(ctx context.Context, h *DailyHRV) error
	UpsertRacePrediction(ctx context.Context, p *RacePrediction) error
	SetMeta(ctx context.Context, userID, key, value string) error
	GetMeta(ctx context.Context, userID, key string) (value string, ok bool, err error)
}

var _ Writer = (*Store)(nil)

// AutoMigrateWatch creates/updates the watch-domain tables plus the
// onboarding-compute derived tables (Go owns both schemas, ADR 0006 / 0015).
func (s *Store) AutoMigrateWatch(ctx context.Context) error {
	models := append(watchModels(), computeModels()...)
	models = append(models, &Race{})
	if err := s.db.WithContext(ctx).AutoMigrate(models...); err != nil {
		return fmt.Errorf("storage: automigrate watch: %w", err)
	}
	// Drop the legacy mixed calibration-zone table now that pace and heart-rate
	// zones live in running_calibration_pace_zone / running_calibration_hr_zone.
	// AutoMigrate never drops orphaned tables, so retire it explicitly here.
	m := s.db.WithContext(ctx).Migrator()
	if m.HasTable("running_calibration_zone") {
		if err := m.DropTable("running_calibration_zone"); err != nil {
			return fmt.Errorf("storage: drop legacy running_calibration_zone: %w", err)
		}
	}
	return nil
}

// canonicalUserID validates that id is a real UUID and returns its canonical
// lowercase hyphenated form. It rejects anything non-UUID — in particular the
// numeric COROS account id — so it can never leak into the user_id key.
func canonicalUserID(id string) (string, error) {
	u, err := uuid.Parse(id)
	if err != nil {
		return "", fmt.Errorf("storage: user_id must be a canonical UUID, got %q: %w", id, err)
	}
	return u.String(), nil
}

// ActivityExists reports whether (user_id, label_id) is already stored.
func (s *Store) ActivityExists(ctx context.Context, userID, labelID string) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	var n int64
	err = s.db.WithContext(ctx).Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Count(&n).Error
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// UpsertActivity writes an activity and replaces its child rows (laps,
// timeseries, watch zones) in one transaction — matching the Python
// upsert_activity delete-then-insert semantics. a.UserID is canonicalised and
// stamped onto every child so callers cannot desync the tenant key.
func (s *Store) UpsertActivity(ctx context.Context, a *Activity, laps []Lap, ts []TimeseriesPoint, zones []ActivityWatchZone) error {
	return s.upsertActivity(ctx, a, laps, ts, zones, false)
}

// UpsertActivityPreservingEmptyChildren updates the activity but replaces only
// non-empty child collections. Garmin may legitimately return an empty detail
// payload; preserving existing children avoids turning an incomplete response
// into destructive data loss.
func (s *Store) UpsertActivityPreservingEmptyChildren(ctx context.Context, a *Activity, laps []Lap, ts []TimeseriesPoint, zones []ActivityWatchZone) error {
	return s.upsertActivity(ctx, a, laps, ts, zones, true)
}

func (s *Store) upsertActivity(ctx context.Context, a *Activity, laps []Lap, ts []TimeseriesPoint, zones []ActivityWatchZone, preserveEmpty bool) error {
	uid, err := canonicalUserID(a.UserID)
	if err != nil {
		return err
	}
	a.UserID = uid
	for i := range laps {
		laps[i].UserID, laps[i].LabelID = uid, a.LabelID
	}
	for i := range ts {
		ts[i].UserID, ts[i].LabelID = uid, a.LabelID
	}
	for i := range zones {
		zones[i].UserID, zones[i].LabelID = uid, a.LabelID
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Garmin can return an empty details payload while still returning the
		// summary. In that incomplete-response path, preserve the previously
		// cached start alongside the preserved timeseries. Omit the two columns
		// from the upsert rather than adding a read query per activity. A
		// non-empty details response remains authoritative and may update or
		// clear the start.
		activityWrite := tx
		if preserveEmpty && len(ts) == 0 && a.StartGPSLat == nil && a.StartGPSLon == nil {
			activityWrite = activityWrite.Omit("StartGPSLat", "StartGPSLon")
		}
		if err := activityWrite.Clauses(clause.OnConflict{UpdateAll: true}).Create(a).Error; err != nil {
			return fmt.Errorf("storage: upsert activity: %w", err)
		}
		if !preserveEmpty || len(laps) > 0 {
			if err := replaceChildren(tx, uid, a.LabelID, &Lap{}, laps); err != nil {
				return err
			}
		}
		if !preserveEmpty || len(ts) > 0 {
			if err := replaceChildren(tx, uid, a.LabelID, &TimeseriesPoint{}, ts); err != nil {
				return err
			}
		}
		if !preserveEmpty || len(zones) > 0 {
			if err := replaceChildren(tx, uid, a.LabelID, &ActivityWatchZone{}, zones); err != nil {
				return err
			}
		}
		return nil
	})
}

// childInsertBatch caps rows per multi-value INSERT for an activity's child
// tables. MySQL allows at most 65535 bind placeholders per statement; the widest
// child (TimeseriesPoint binds 18 columns — 19 fields minus the auto-increment
// id) at this size uses 18*2000 = 36000, leaving generous headroom, while
// cutting the number of round-trips to the DB ~4x vs the previous 500 (a long
// run has thousands of timeseries points).
const childInsertBatch = 2000

// replaceChildren deletes all rows of model for (user_id, label_id) then inserts
// rows (if any). rows must be a slice; an empty slice just clears.
func replaceChildren[T any](tx *gorm.DB, userID, labelID string, model any, rows []T) error {
	if err := tx.Where("user_id = ? AND label_id = ?", userID, labelID).Delete(model).Error; err != nil {
		return fmt.Errorf("storage: clear children: %w", err)
	}
	if len(rows) > 0 {
		if err := tx.CreateInBatches(&rows, childInsertBatch).Error; err != nil {
			return fmt.Errorf("storage: insert children: %w", err)
		}
	}
	return nil
}

// UpsertDailyHealth upserts a daily_health row.
func (s *Store) UpsertDailyHealth(ctx context.Context, h *DailyHealth) error {
	uid, err := canonicalUserID(h.UserID)
	if err != nil {
		return err
	}
	h.UserID = uid
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(h).Error
}

// UpsertDashboard upserts the per-user dashboard row.
func (s *Store) UpsertDashboard(ctx context.Context, d *Dashboard) error {
	uid, err := canonicalUserID(d.UserID)
	if err != nil {
		return err
	}
	d.UserID = uid
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(d).Error
}

// UpsertDashboardPreservingNil updates only metrics present in the response.
func (s *Store) UpsertDashboardPreservingNil(ctx context.Context, d *Dashboard) error {
	uid, err := canonicalUserID(d.UserID)
	if err != nil {
		return err
	}
	d.UserID = uid
	updates := map[string]any{"provider": d.Provider, "updated_at": d.UpdatedAt}
	for key, value := range map[string]any{
		"running_level": d.RunningLevel, "aerobic_score": d.AerobicScore,
		"lactate_threshold_score":   d.LactateThresholdScore,
		"anaerobic_endurance_score": d.AnaerobicEnduranceScore,
		"anaerobic_capacity_score":  d.AnaerobicCapacityScore,
		"rhr":                       d.RHR, "threshold_hr": d.ThresholdHR,
		"threshold_pace_s_km": d.ThresholdPaceSKm, "recovery_pct": d.RecoveryPct,
		"avg_sleep_hrv": d.AvgSleepHRV, "hrv_normal_low": d.HRVNormalLow,
		"hrv_normal_high": d.HRVNormalHigh, "weekly_distance_m": d.WeeklyDistanceM,
		"weekly_duration_s": d.WeeklyDurationS,
	} {
		if !reflect.ValueOf(value).IsNil() {
			updates[key] = value
		}
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(d).Error; err != nil {
			return err
		}
		return tx.Model(&Dashboard{}).Where("user_id = ?", uid).Updates(updates).Error
	})
}

// UpsertDailyHRV upserts a daily_hrv row.
func (s *Store) UpsertDailyHRV(ctx context.Context, h *DailyHRV) error {
	uid, err := canonicalUserID(h.UserID)
	if err != nil {
		return err
	}
	h.UserID = uid
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(h).Error
}

// UpsertRacePrediction upserts a race_predictions row.
func (s *Store) UpsertRacePrediction(ctx context.Context, p *RacePrediction) error {
	uid, err := canonicalUserID(p.UserID)
	if err != nil {
		return err
	}
	p.UserID = uid
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(p).Error
}

// MetaKeyLastSyncTime is the sync_meta key holding the RFC3339 UTC timestamp of
// the user's most recent successful watch sync. It is written by the watch_sync
// handler and read by GET /watch (last_sync_at). Distinct from the last_label_id
// position cursor.
const MetaKeyLastSyncTime = "last_sync_time"

// SetMeta upserts a per-user sync cursor.
func (s *Store) SetMeta(ctx context.Context, userID, key, value string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	v := value
	row := &SyncMeta{UserID: uid, Key: key, Value: &v}
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(row).Error
}

// GetMeta reads a per-user sync cursor. ok is false when the key is absent.
func (s *Store) GetMeta(ctx context.Context, userID, key string) (string, bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return "", false, err
	}
	var row SyncMeta
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND meta_key = ?", uid, key).
		First(&row).Error
	if err == gorm.ErrRecordNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if row.Value == nil {
		return "", true, nil
	}
	return *row.Value, true, nil
}

// SaveCredential upserts a per-user provider credential (ADR 0008).
func (s *Store) SaveCredential(ctx context.Context, c *ProviderCredential) error {
	uid, err := canonicalUserID(c.UserID)
	if err != nil {
		return err
	}
	c.UserID = uid
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(c).Error
}

// GetCredential reads a per-user provider credential. It returns
// (nil, nil) when none exists.
func (s *Store) GetCredential(ctx context.Context, userID, provider string) (*ProviderCredential, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var c ProviderCredential
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND provider = ?", uid, provider).
		First(&c).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// DeleteCredential removes a user's stored credential for a provider (watch
// disconnect). Deleting a nonexistent row is not an error. Synced watch data is
// intentionally retained — only the login binding is cleared.
func (s *Store) DeleteCredential(ctx context.Context, userID, providerName string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	return s.db.WithContext(ctx).
		Where("user_id = ? AND provider = ?", uid, providerName).
		Delete(&ProviderCredential{}).Error
}

// LatestActivityDevice returns the device model string of the user's most recent
// activity (by date) for the watch status card. ok is false when the user has no
// activity carrying a non-empty device.
func (s *Store) LatestActivityDevice(ctx context.Context, userID string) (string, bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return "", false, err
	}
	var a Activity
	err = s.db.WithContext(ctx).
		Select("device").
		Where("user_id = ? AND device IS NOT NULL AND device <> ''", uid).
		Order("date DESC").
		First(&a).Error
	if err == gorm.ErrRecordNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if a.Device == nil {
		return "", false, nil
	}
	return *a.Device, true, nil
}

// ProviderForUser returns the watch provider the user has a stored credential
// for, and whether any was found. Single-watch users have exactly one row, so
// this is unambiguous. If a user has credentials for several providers
// (dual-watch), the most recently *written* one wins (updated_at DESC) — note
// this bumps on token refresh too, not only login, so it tracks the most
// recently active provider rather than a fixed binding.
func (s *Store) ProviderForUser(ctx context.Context, userID string) (string, bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return "", false, err
	}
	var c ProviderCredential
	err = s.db.WithContext(ctx).
		Where("user_id = ?", uid).
		Order("updated_at DESC").
		First(&c).Error
	if err == gorm.ErrRecordNotFound {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return c.Provider, true, nil
}
