package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/zhaochy1990/stride/internal/job"
)

// AutoMigrateUsers creates/updates the user_profile and user_onboarding tables
// (ADR 0013). Called by cmd/api at boot; the worker does not need these tables.
func (s *Store) AutoMigrateUsers(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&UserProfile{}, &UserOnboarding{}); err != nil {
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
	p.UserID = uid
	p.UpdatedAt = time.Now().UTC()
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"display_name", "dob", "sex", "height_cm", "weight_kg", "updated_at",
		}),
	}).Create(p).Error
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

// SetOnboardingRun associates an active onboarding pipeline run with the user and
// clears any prior completion marker. Pipeline runs remain the progress source.
func (s *Store) SetOnboardingRun(ctx context.Context, userID, runID string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	row := &UserOnboarding{UserID: uid, OnboardingRunID: &runID, UpdatedAt: now}
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "user_id"}},
		DoUpdates: clause.Assignments(map[string]interface{}{
			"onboarding_run_id": runID,
			"completed_at":      nil,
			"updated_at":        now,
		}),
	}).Create(row).Error
}

// ClaimOnboardingRun durably reserves a user's onboarding association for runID.
// It succeeds for a first run, a failed prior run, or a stale active run. updated_at
// is the durable claim timestamp while a pipeline row has not yet been created, so
// a fresh missing-run association is preserved for the caller that owns the claim.
func (s *Store) ClaimOnboardingRun(ctx context.Context, userID, runID string, staleBefore time.Time) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	now := time.Now().UTC()
	returnClaimed := false
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Ensure the row exists without overwriting profile/watch flags.
		if err := tx.Exec("INSERT IGNORE INTO user_onboarding (user_id, watch_ready, profile_ready, created_at, updated_at) VALUES (?, false, false, ?, ?)", uid, now, now).Error; err != nil {
			return err
		}
		// The predicate joins the durable pipeline state into the conditional update.
		// When a claim has no run yet, onboarding.updated_at is its durable claim
		// timestamp; only a stale claim may be recovered. That closes the window
		// between this reservation and StartPipelineWithID creating the run row.
		result := tx.Exec(`UPDATE user_onboarding AS o
			LEFT JOIN pipeline_runs AS r ON r.run_id = o.onboarding_run_id
			SET o.onboarding_run_id = ?, o.completed_at = NULL, o.updated_at = ?
			WHERE o.user_id = ? AND o.watch_ready = true AND o.completed_at IS NULL
			  AND (COALESCE(o.onboarding_run_id, '') = '' OR r.status = 'failed' OR r.updated_at < ? OR (r.run_id IS NULL AND o.updated_at < ?))`, runID, now, uid, staleBefore, staleBefore)
		if result.Error != nil {
			return result.Error
		}
		returnClaimed = result.RowsAffected > 0
		return nil
	})
	return returnClaimed, err
}

// ClearOnboardingRun releases a claim only when it still references runID. It is
// used to compensate a pipeline-start failure after a durable claim.
func (s *Store) ClearOnboardingRun(ctx context.Context, userID, runID string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	return s.db.WithContext(ctx).Model(&UserOnboarding{}).
		Where("user_id = ? AND onboarding_run_id = ? AND completed_at IS NULL", uid, runID).
		Updates(map[string]interface{}{"onboarding_run_id": nil, "updated_at": now}).Error
}

// CompleteOnboardingRun marks onboarding complete only when runID is still the
// user's linked run. A superseded or disconnected old worker can never reopen
// the onboarding gate.
func (s *Store) CompleteOnboardingRun(ctx context.Context, userID, runID string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	return s.db.WithContext(ctx).Model(&UserOnboarding{}).
		Where("user_id = ? AND onboarding_run_id = ? AND watch_ready = ?", uid, runID, true).
		Updates(map[string]interface{}{"completed_at": now, "updated_at": now}).Error
}

// OnPipelineCompleted fulfills pipeline.CompletionListener. Only the canonical
// onboarding pipeline may open the onboarding gate.
func (s *Store) OnPipelineCompleted(ctx context.Context, run *job.PipelineRun) error {
	if run.Name != "onboarding" || run.UserID == "" {
		return nil
	}
	return s.CompleteOnboardingRun(ctx, run.UserID, run.RunID)
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
