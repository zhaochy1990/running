package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrRaceStrategyNotFound is returned when a read or delete targets a strategy
// row that does not exist (the API answers 404).
var ErrRaceStrategyNotFound = errors.New("storage: race strategy row not found")

// AutoMigrateRaceStrategies creates/updates the race_strategy table. Called by
// cmd/api at boot; the coach writes through the API, not the DB, so the worker
// does not migrate this table.
func (s *Store) AutoMigrateRaceStrategies(ctx context.Context) error {
	db := s.db.WithContext(ctx)
	if err := migrateRaceStrategyTargetKey(db); err != nil {
		return err
	}
	if err := db.AutoMigrate(&RaceStrategy{}); err != nil {
		return fmt.Errorf("storage: automigrate race_strategy: %w", err)
	}
	return nil
}

// migrateRaceStrategyTargetKey moves a pre-v3 table from one-strategy-per-
// (user, race) to one-per-target-time: drop the legacy UNIQUE(user, event)
// index, add the target_finish_time column and backfill it from the content
// JSON. Every step is guarded so it is idempotent and a no-op on a fresh
// database; AutoMigrate then builds the new (user, race, target) unique index.
// The backfill keeps the empty string on rows whose content lacks a well-formed target —
// the legacy unique index guarantees at most one such row per (user, race),
// so the empty value remains a valid (never colliding) key for them. Deploy is
// single-replica stop-the-world (same as every schema change here): between
// DropIndex and the new index there is no uniqueness enforcement.
func migrateRaceStrategyTargetKey(db *gorm.DB) error {
	m := db.Migrator()
	if !m.HasTable(&RaceStrategy{}) {
		return nil
	}
	if m.HasIndex(&RaceStrategy{}, "uidx_race_strategy_user_event") {
		if err := m.DropIndex(&RaceStrategy{}, "uidx_race_strategy_user_event"); err != nil {
			return fmt.Errorf("storage: drop race_strategy legacy unique index: %w", err)
		}
	}
	if !m.HasColumn(&RaceStrategy{}, "target_finish_time") {
		if err := m.AddColumn(&RaceStrategy{}, "TargetFinishTime"); err != nil {
			return fmt.Errorf("storage: add race_strategy.target_finish_time: %w", err)
		}
	}
	// Idempotent backfill, run on every boot (a crash between AddColumn and
	// this UPDATE must not strand rows at '' forever). JSON_VALID guards
	// against a corrupt LONGTEXT row; the REGEXP keeps only well-formed
	// H:MM:SS values — a free-text goal must not become a version key, and a
	// value longer than the column would abort the whole UPDATE in strict
	// mode and fail api boot.
	if err := db.Exec(
		`UPDATE race_strategy SET target_finish_time = COALESCE(JSON_UNQUOTE(JSON_EXTRACT(content, '$.target_finish_time')), '') ` +
			`WHERE target_finish_time = '' AND JSON_VALID(content) ` +
			`AND JSON_UNQUOTE(JSON_EXTRACT(content, '$.target_finish_time')) REGEXP '^[0-9]{1,2}:[0-9]{2}:[0-9]{2}$'`,
	).Error; err != nil {
		return fmt.Errorf("storage: backfill race_strategy.target_finish_time: %w", err)
	}
	return nil
}

// UpsertRaceStrategy creates or overwrites the (user, race, target) version
// row, reporting whether it created the row. The target finish time is the
// version key — the athlete's own goal; regenerating or hand-editing a target
// replaces only that target's version, other targets stay untouched. Like
// UpsertRacePlan it refuses a race that does not exist or is unpublished with
// ErrRaceCalendarNotFound, so a strategy can never point at an offboarded race.
func (s *Store) UpsertRaceStrategy(ctx context.Context, userID string, raceEventID uint64, targetTime, itemType, content string) (*RaceStrategy, bool, error) {
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
				Where("user_id = ? AND race_event_id = ? AND target_finish_time = ?", uid, raceEventID, targetTime).
				First(&cur).Error
			now := time.Now().UTC()
			if errors.Is(e, gorm.ErrRecordNotFound) {
				row := RaceStrategy{
					UserID: uid, RaceEventID: raceEventID, TargetFinishTime: targetTime,
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
	// (user, race, target) can deadlock; one retry takes the plain update path.
	if err != nil && isConcurrentInsertRace(err) {
		err = write()
	}
	if err != nil {
		return nil, false, err
	}
	return out, created, nil
}

// GetRaceStrategies returns all of the user's strategy versions for one race,
// ordered by target finish time (fastest goal first — the report page's pill
// order). "H:MM:SS" hours are not zero-padded, so plain lexical order would
// put 10-hour goals before 2-hour ones: sort by length first, empty key last. An
// empty slice means "not generated yet", not an error.
func (s *Store) GetRaceStrategies(ctx context.Context, userID string, raceEventID uint64) ([]RaceStrategy, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []RaceStrategy
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND race_event_id = ?", uid, raceEventID).
		Order("target_finish_time = '' ASC, CHAR_LENGTH(target_finish_time) ASC, target_finish_time ASC").Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: list race_strategies: %w", err)
	}
	return rows, nil
}

// DeleteRaceStrategy removes one target's version. ErrRaceStrategyNotFound
// when that version does not exist; the race's remaining versions are untouched.
func (s *Store) DeleteRaceStrategy(ctx context.Context, userID string, raceEventID uint64, targetTime string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	result := s.db.WithContext(ctx).
		Where("user_id = ? AND race_event_id = ? AND target_finish_time = ?", uid, raceEventID, targetTime).
		Delete(&RaceStrategy{})
	if result.Error != nil {
		return fmt.Errorf("storage: delete race_strategy: %w", result.Error)
	}
	if result.RowsAffected == 0 {
		return ErrRaceStrategyNotFound
	}
	return nil
}
