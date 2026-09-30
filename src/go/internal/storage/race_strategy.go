package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrRaceStrategyNotFound is returned when a read targets a strategy row that
// does not exist (the API answers 404).
var ErrRaceStrategyNotFound = errors.New("storage: race strategy row not found")

// AutoMigrateRaceStrategies creates/updates the race_strategy table. Called by
// cmd/api at boot; the coach writes through the API, not the DB, so the worker
// does not migrate this table.
func (s *Store) AutoMigrateRaceStrategies(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&RaceStrategy{}); err != nil {
		return fmt.Errorf("storage: automigrate race_strategy: %w", err)
	}
	return nil
}

// UpsertRaceStrategy creates or overwrites the user's single strategy for one
// race (the UNIQUE(user, event) row), reporting whether it created the row.
// Overwrite-in-place is the contract (#386): a new coach draft or a runner edit
// replaces the previous version; nothing but the latest survives. Like
// UpsertRacePlan it refuses a race that does not exist or is unpublished with
// ErrRaceCalendarNotFound, so a strategy can never point at an offboarded race.
func (s *Store) UpsertRaceStrategy(ctx context.Context, userID string, raceEventID uint64, itemType, content string) (*RaceStrategy, bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, false, err
	}
	var out *RaceStrategy
	var created bool
	write := func() error {
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var event RaceCalendarEvent
			e := tx.Select("id", "published").First(&event, raceEventID).Error
			if errors.Is(e, gorm.ErrRecordNotFound) {
				return ErrRaceCalendarNotFound
			}
			if e != nil {
				return fmt.Errorf("storage: load race for strategy: %w", e)
			}
			if !event.Published {
				return ErrRaceCalendarNotFound
			}

			var cur RaceStrategy
			e = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("user_id = ? AND race_event_id = ?", uid, raceEventID).
				First(&cur).Error
			now := time.Now().UTC()
			if errors.Is(e, gorm.ErrRecordNotFound) {
				row := RaceStrategy{
					UserID: uid, RaceEventID: raceEventID,
					ItemType: itemType, Content: content,
					CreatedAt: now, UpdatedAt: now,
				}
				if err := tx.Create(&row).Error; err != nil {
					return fmt.Errorf("storage: create race_strategy: %w", err)
				}
				out = &row
				created = true
				return nil
			}
			if e != nil {
				return fmt.Errorf("storage: load race_strategy: %w", e)
			}
			cur.ItemType = itemType
			cur.Content = content
			cur.UpdatedAt = now
			if err := tx.Save(&cur).Error; err != nil {
				return fmt.Errorf("storage: update race_strategy: %w", err)
			}
			out = &cur
			created = false
			return nil
		})
	}
	err = write()
	// Same gap-lock race as UpsertRacePlan: two first-time writers of the same
	// (user, race) can deadlock; one retry takes the plain update path.
	if err != nil && isConcurrentInsertRace(err) {
		err = write()
	}
	if err != nil {
		return nil, false, err
	}
	return out, created, nil
}

// GetRaceStrategy returns the user's latest strategy for one race, or
// ErrRaceStrategyNotFound when none exists.
func (s *Store) GetRaceStrategy(ctx context.Context, userID string, raceEventID uint64) (*RaceStrategy, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row RaceStrategy
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND race_event_id = ?", uid, raceEventID).
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrRaceStrategyNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get race_strategy: %w", err)
	}
	return &row, nil
}
