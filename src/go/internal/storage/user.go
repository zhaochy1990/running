package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// AutoMigrateUsers creates/updates the user_profile and user_onboarding tables
// (ADR 0013). Called by cmd/api at boot; the worker does not need these tables.
func (s *Store) AutoMigrateUsers(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&UserProfile{}, &UserOnboarding{}, &InjuryRecord{}); err != nil {
		return fmt.Errorf("storage: automigrate users: %w", err)
	}
	return nil
}

// GetUserProfile returns the profile for userID, or (nil, nil) when none exists.
func (s *Store) GetUserProfile(ctx context.Context, userID string) (*UserProfile, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var p UserProfile
	err = s.db.WithContext(ctx).Where("user_id = ?", uid).First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// UpsertUserProfile inserts or updates the five core fields for a user, keyed on
// user_id. created_at is preserved on update; only the value columns + updated_at
// are overwritten.
func (s *Store) UpsertUserProfile(ctx context.Context, p *UserProfile) error {
	uid, err := canonicalUserID(p.UserID)
	if err != nil {
		return err
	}
	if p.RunningAgeRange == "" {
		p.RunningAgeRange = RunningAgeUnknown
	}
	if !ValidRunningAgeRange(p.RunningAgeRange) {
		return fmt.Errorf("storage: invalid running_age_range %q", p.RunningAgeRange)
	}
	p.UserID = uid
	p.UpdatedAt = time.Now().UTC()
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"display_name", "dob", "sex", "height_cm", "weight_kg", "running_age_range", "updated_at",
		}),
	}).Create(p).Error
}

// MigrateRunningAgeIfUnknown conditionally updates a profile's running age. It
// never inserts a profile and cannot overwrite an explicit value, making repeat
// migration runs and concurrent profile edits safe.
func (s *Store) MigrateRunningAgeIfUnknown(ctx context.Context, userID, runningAge string) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	if !ValidRunningAgeRange(runningAge) || runningAge == RunningAgeUnknown {
		return false, fmt.Errorf("storage: invalid migration running_age_range %q", runningAge)
	}
	result := s.db.WithContext(ctx).Model(&UserProfile{}).
		Where("user_id = ? AND running_age_range = ?", uid, RunningAgeUnknown).
		Updates(map[string]interface{}{
			"running_age_range": runningAge,
			"updated_at":        time.Now().UTC(),
		})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

// PatchUserProfile selectively updates an existing core profile and returns the
// persisted row. It never inserts a sparse profile: a missing user returns
// (nil, nil). The update and read run in one transaction so callers receive the
// values produced by this patch without overwriting omitted columns.
func (s *Store) PatchUserProfile(ctx context.Context, userID string, patch UserProfilePatch) (*UserProfile, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}

	updates := map[string]interface{}{}
	if patch.DisplayName != nil {
		updates["display_name"] = *patch.DisplayName
	}
	if patch.DOB != nil {
		updates["dob"] = *patch.DOB
	}
	if patch.Sex != nil {
		updates["sex"] = *patch.Sex
	}
	if patch.HeightCm != nil {
		updates["height_cm"] = *patch.HeightCm
	}
	if patch.WeightKg != nil {
		updates["weight_kg"] = *patch.WeightKg
	}
	if patch.RunningAgeRange != nil {
		if !ValidRunningAgeRange(*patch.RunningAgeRange) {
			return nil, fmt.Errorf("storage: invalid running_age_range %q", *patch.RunningAgeRange)
		}
		updates["running_age_range"] = *patch.RunningAgeRange
	}

	var result *UserProfile
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if len(updates) > 0 {
			updates["updated_at"] = time.Now().UTC()
			if err := tx.Model(&UserProfile{}).Where("user_id = ?", uid).Updates(updates).Error; err != nil {
				return err
			}
		}

		var profile UserProfile
		queryErr := tx.Where("user_id = ?", uid).First(&profile).Error
		if errors.Is(queryErr, gorm.ErrRecordNotFound) {
			return nil
		}
		if queryErr != nil {
			return queryErr
		}
		result = &profile
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// GetUserOnboarding returns the onboarding row for userID, or (nil, nil) when
// none exists (the caller renders the all-false default).
func (s *Store) GetUserOnboarding(ctx context.Context, userID string) (*UserOnboarding, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var o UserOnboarding
	err = s.db.WithContext(ctx).Where("user_id = ?", uid).First(&o).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

// ErrNoProviderCredential reports a readiness transition after the credential
// persistence boundary did not leave any provider credential for the user.
var ErrNoProviderCredential = errors.New("storage: no provider credential")

// SetWatchReady marks a successful provider login as connected. It serializes
// with DisconnectWatch on the user's onboarding row and verifies the provider
// credential inside that lock, so a late readiness write cannot recreate a
// watch_ready=true state after disconnect removed the final credential.
func (s *Store) SetWatchReady(ctx context.Context, userID string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if _, err := ensureLockedUserOnboarding(tx, uid, now); err != nil {
			return err
		}
		var credentials int64
		if err := tx.Model(&ProviderCredential{}).Where("user_id = ?", uid).Count(&credentials).Error; err != nil {
			return err
		}
		if credentials == 0 {
			return ErrNoProviderCredential
		}
		return tx.Model(&UserOnboarding{}).Where("user_id = ?", uid).Updates(map[string]interface{}{
			"watch_ready": true,
			"updated_at":  now,
		}).Error
	})
}

// ClearWatchReady is the compatibility flag mutation used by non-atomic stores.
// The production disconnect path uses DisconnectWatch so credentials and all
// watch-dependent onboarding state change atomically.
func (s *Store) ClearWatchReady(ctx context.Context, userID string) error {
	return s.setOnboardingFlag(ctx, userID, "watch_ready", false)
}

// FinalizeOnboardingRun marks a connected user's onboarding complete after the
// API has verified that runID is their completed onboarding pipeline. The write
// deliberately does not require onboarding_run_id to be linked: generic full
// sync runs must never mutate onboarding state. Both prerequisite predicates
// make a concurrent profile or final-watch change win safely. The returned
// boolean reports whether this call wrote the marker; an existing completion is
// idempotent.
func (s *Store) FinalizeOnboardingRun(ctx context.Context, userID, runID string) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	now := time.Now().UTC()
	result := s.db.WithContext(ctx).Model(&UserOnboarding{}).
		Where("user_id = ? AND profile_ready = ? AND watch_ready = ? AND completed_at IS NULL", uid, true, true).
		Updates(map[string]interface{}{"completed_at": now, "updated_at": now})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

// ensureLockedUserOnboarding creates a default row without clobbering existing
// flags, then locks it as the cross-replica per-user onboarding mutex.
func ensureLockedUserOnboarding(tx *gorm.DB, userID string, now time.Time) (*UserOnboarding, error) {
	if err := tx.Exec("INSERT IGNORE INTO user_onboarding (user_id, watch_ready, profile_ready, created_at, updated_at) VALUES (?, false, false, ?, ?)", userID, now, now).Error; err != nil {
		return nil, err
	}
	var onboarding UserOnboarding
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("user_id = ?", userID).First(&onboarding).Error; err != nil {
		return nil, err
	}
	return &onboarding, nil
}

// DisconnectWatch atomically removes one provider credential. It resets
// watch-dependent onboarding state only when the user has no other provider
// credentials; dual-watch users remain connected through their remaining source.
// Synced watch data is retained.
func (s *Store) DisconnectWatch(ctx context.Context, userID, providerName string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// The locked onboarding row is the per-user mutex shared with
		// SetWatchReady. Create it first because a credential may predate any
		// onboarding state (for example after an older login path).
		if _, err := ensureLockedUserOnboarding(tx, uid, now); err != nil {
			return err
		}
		if err := tx.Where("user_id = ? AND provider = ?", uid, providerName).Delete(&ProviderCredential{}).Error; err != nil {
			return err
		}
		var remaining int64
		if err := tx.Model(&ProviderCredential{}).Where("user_id = ?", uid).Count(&remaining).Error; err != nil {
			return err
		}
		if remaining > 0 {
			return nil
		}
		return tx.Model(&UserOnboarding{}).Where("user_id = ?", uid).Updates(map[string]interface{}{
			"watch_ready":       false,
			"completed_at":      nil,
			"onboarding_run_id": nil,
			"updated_at":        now,
		}).Error
	})
}

// DeleteUserData removes every row owned by userID in one transaction. The
// explicit model list is intentional: this schema has no cross-table cascade,
// and keeping deletion in storage makes new user-owned tables visible in review.
func (s *Store) DeleteUserData(ctx context.Context, userID string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}

	models := []any{
		&RunningCalibrationPaceZone{}, &RunningCalibrationHRZone{},
		&RunningCalibrationSnapshot{}, &ActivityTrainingLoad{}, &DailyTrainingLoad{},
		&PersonalBest{}, &ActivityWatchZone{}, &TimeseriesPoint{}, &Lap{}, &Activity{},
		&DailyHealth{}, &Dashboard{}, &DailyHRV{}, &RacePrediction{}, &SyncMeta{},
		&ProviderCredential{}, &WeeklyPlan{}, &MasterPlan{}, &RaceGoal{},
		&UserOnboarding{}, &UserProfile{}, &InjuryRecord{},
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, model := range models {
			if err := tx.Where("user_id = ?", uid).Delete(model).Error; err != nil {
				return fmt.Errorf("storage: delete user data from %s: %w", tx.Statement.Table, err)
			}
		}
		// Jobs and runs also carry created_by provenance. Delete either ownership
		// shape so account deletion leaves no actor identifier behind.
		if err := tx.Where("user_id = ? OR created_by = ?", uid, uid).Delete(&jobModel{}).Error; err != nil {
			return fmt.Errorf("storage: delete user jobs: %w", err)
		}
		if err := tx.Where("user_id = ? OR created_by = ?", uid, uid).Delete(&pipelineRunModel{}).Error; err != nil {
			return fmt.Errorf("storage: delete user pipeline runs: %w", err)
		}
		return nil
	})
}

// SetProfileReady marks the user's basic profile as saved (POST profile). It
// upserts the row, flipping only profile_ready.
func (s *Store) SetProfileReady(ctx context.Context, userID string) error {
	return s.setOnboardingFlag(ctx, userID, "profile_ready", true)
}

// setOnboardingFlag upserts a single onboarding boolean without disturbing the
// other flag: on insert the whole row lands with the named flag set to value; on
// conflict only the named column and updated_at are written.
func (s *Store) setOnboardingFlag(ctx context.Context, userID, column string, value bool) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	row := &UserOnboarding{UserID: uid, UpdatedAt: now}
	switch column {
	case "watch_ready":
		row.WatchReady = value
	case "profile_ready":
		row.ProfileReady = value
	default:
		return fmt.Errorf("storage: unknown onboarding flag %q", column)
	}
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.Assignments(map[string]interface{}{
			column:       value,
			"updated_at": now,
		}),
	}).Create(row).Error
}
