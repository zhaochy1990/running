package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// AutoMigrateGoals creates/updates the race_goal table (ADR 0021). Called by
// cmd/api at boot; the worker does not need this table.
func (s *Store) AutoMigrateGoals(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&RaceGoal{}); err != nil {
		return fmt.Errorf("storage: automigrate race_goal: %w", err)
	}
	return nil
}

// GetActiveRaceGoal returns the athlete's single active race goal, or (nil, nil)
// when none exists (the handler renders 404).
func (s *Store) GetActiveRaceGoal(ctx context.Context, userID string) (*RaceGoal, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var g RaceGoal
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND status = ?", uid, RaceGoalStatusActive).
		First(&g).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// CreateRaceGoal sets a new active race goal, archiving the prior active one in
// the same transaction so active_flag can never drift out of sync with status.
// It mints a UUID4 goal_id when g.GoalID is empty (the normal create path) and
// preserves a caller-supplied id (the backfill re-mint path). GORM stamps
// created_at/updated_at. The returned pointer is g, populated with the persisted
// id and timestamps.
func (s *Store) CreateRaceGoal(ctx context.Context, g *RaceGoal) (*RaceGoal, error) {
	uid, err := canonicalUserID(g.UserID)
	if err != nil {
		return nil, err
	}
	g.UserID = uid
	if g.GoalID == "" {
		g.GoalID = uuid.NewString()
	}
	g.Status = RaceGoalStatusActive
	one := int8(1)
	g.ActiveFlag = &one

	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Archive the current active row first (active_flag -> NULL) so the new
		// row's active_flag=1 does not collide on UNIQUE(user_id, active_flag).
		if err := tx.Model(&RaceGoal{}).
			Where("user_id = ? AND status = ?", uid, RaceGoalStatusActive).
			Updates(map[string]any{
				"status":      RaceGoalStatusArchived,
				"active_flag": nil,
				"updated_at":  time.Now().UTC(),
			}).Error; err != nil {
			return fmt.Errorf("storage: archive prior race goal: %w", err)
		}
		if err := tx.Create(g).Error; err != nil {
			return fmt.Errorf("storage: create race goal: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return g, nil
}

// UpdateActiveRaceGoal edits the athlete's active race goal in place. It matches
// on (user_id, goal_id) against the active row — a concurrency guard mirroring
// the Python contract: if the active goal is missing or its id differs from
// upd.GoalID (e.g. a newer goal was set since the client fetched), it returns
// (nil, nil) and the handler renders 404. created_at, status and active_flag are
// preserved; only the mutable domain fields and updated_at change.
func (s *Store) UpdateActiveRaceGoal(ctx context.Context, upd *RaceGoal) (*RaceGoal, error) {
	uid, err := canonicalUserID(upd.UserID)
	if err != nil {
		return nil, err
	}

	var result *RaceGoal
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var cur RaceGoal
		e := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ? AND status = ? AND goal_id = ?", uid, RaceGoalStatusActive, upd.GoalID).
			First(&cur).Error
		if errors.Is(e, gorm.ErrRecordNotFound) {
			return nil // result stays nil -> 404
		}
		if e != nil {
			return e
		}

		// Overwrite the mutable domain fields; leave identity, status,
		// active_flag and created_at untouched.
		cur.RaceDate = upd.RaceDate
		cur.RaceDistance = upd.RaceDistance
		cur.RaceName = upd.RaceName
		cur.TargetFinishTime = upd.TargetFinishTime
		cur.WeeklyTrainingDays = upd.WeeklyTrainingDays
		cur.AvailableTimeSlots = upd.AvailableTimeSlots
		cur.StrengthWillingness = upd.StrengthWillingness
		cur.RaceLocation = upd.RaceLocation
		cur.RaceTimezone = upd.RaceTimezone

		if e := tx.Save(&cur).Error; e != nil {
			return fmt.Errorf("storage: update race goal: %w", e)
		}
		result = &cur
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}
