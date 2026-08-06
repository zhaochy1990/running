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

// SetWatchReady marks the user's watch as connected (login). It upserts the row,
// flipping only watch_ready so a concurrent profile_ready is never clobbered.
func (s *Store) SetWatchReady(ctx context.Context, userID string) error {
	return s.setOnboardingFlag(ctx, userID, "watch_ready", true)
}

// ClearWatchReady marks the user's watch as disconnected (DELETE /watch). It
// upserts the row, flipping only watch_ready to false; profile_ready and
// completed_at are left untouched (completed_at is the onboarding gate owned by
// the not-yet-ported sync-complete flow, ADR 0018).
func (s *Store) ClearWatchReady(ctx context.Context, userID string) error {
	return s.setOnboardingFlag(ctx, userID, "watch_ready", false)
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
		&UserOnboarding{}, &UserProfile{},
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
