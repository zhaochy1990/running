package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	// ErrRaceContentNotFound means no content row matched the requested city.
	// (Race-level content lives on race_calendar rows; its not-found is
	// ErrRaceCalendarNotFound and its conflict is ErrRaceContentConflict.)
	ErrRaceContentNotFound = errors.New("storage: race content not found")
	// ErrRaceContentConflict means the requested content write violates a
	// uniqueness rule: the city is already taken, or a move-content target
	// already carries content.
	ErrRaceContentConflict = errors.New("storage: race content conflict")
)

// AutoMigrateRaceContent reconciles the race-content schema. Race-level content
// lives ON the race_calendar row and item-level content ON the
// race_calendar_item row (both migrated by AutoMigrateRaceCalendar, which the
// worker also runs); this function migrates the city content table and drops the
// retired split content tables. Production is not live yet and the split tables
// carried no data worth preserving, so the drops are unconditional.
func (s *Store) AutoMigrateRaceContent(ctx context.Context) error {
	db := s.db.WithContext(ctx)
	m := db.Migrator()
	if m.HasTable(&RaceCityContent{}) {
		for _, col := range []string{"climate", "weather_windows", "status"} {
			if !m.HasColumn(&RaceCityContent{}, col) {
				continue
			}
			if err := m.DropColumn(&RaceCityContent{}, col); err != nil {
				return fmt.Errorf("storage: drop race_city_content.%s: %w", col, err)
			}
		}
	}
	if err := db.AutoMigrate(&RaceCityContent{}); err != nil {
		return fmt.Errorf("storage: automigrate race_city_content: %w", err)
	}
	// The types are gone from the model layer; the table names are all that is
	// left to clean up. race_item_content was folded into race_calendar_item so
	// an item's content shares its row's provenance and merge semantics.
	if m.HasTable("race_content_version") {
		if err := m.DropTable("race_content_version"); err != nil {
			return fmt.Errorf("storage: drop race_content_version: %w", err)
		}
	}
	for _, table := range []string{"race_item_content", "race_content_item", "race_content"} {
		if m.HasTable(table) {
			if err := m.DropTable(table); err != nil {
				return fmt.Errorf("storage: drop %s: %w", table, err)
			}
		}
	}
	return nil
}

// GetRaceCityContent returns the content of city (the race_calendar.city
// spelling, e.g. 厦门市), or nil when the city has none yet.
func (s *Store) GetRaceCityContent(ctx context.Context, city string) (*RaceCityContent, error) {
	var row RaceCityContent
	err := s.db.WithContext(ctx).Where("city = ?", city).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: get race city content: %w", err)
	}
	return &row, nil
}

// UpsertRaceCityContent creates or replaces the working state of a city's
// content — the save IS the content (no lifecycle). City on the incoming row
// is the identity; everything admin-writable is overwritten.
func (s *Store) UpsertRaceCityContent(ctx context.Context, in *RaceCityContent) (*RaceCityContent, error) {
	var saved *RaceCityContent
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row RaceCityContent
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("city = ?", in.City).First(&row).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			now := nowUTC()
			created := *in
			created.ID = 0
			created.CreatedAt, created.UpdatedAt = now, now
			if err := tx.Create(&created).Error; err != nil {
				if isDuplicateKey(err) {
					return ErrRaceContentConflict
				}
				return fmt.Errorf("storage: create race city content: %w", err)
			}
			saved = &created
			return nil
		case err != nil:
			return fmt.Errorf("storage: lock race city content: %w", err)
		}
		applyRaceCityContentUpdate(&row, in)
		row.UpdatedAt = nowUTC()
		// Save (not Updates(map)): serializer-typed columns only serialize on
		// model writes, and a full-row write clears absent sections to NULL.
		if err := tx.Save(&row).Error; err != nil {
			return fmt.Errorf("storage: update race city content: %w", err)
		}
		saved = &row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return saved, nil
}

// UpsertRaceCityContentAIDraft merges an AI-generated intro into a city's
// working content without touching the other sections (province, attractions).
// There is no lifecycle, so the merge always applies. (Climate moved to race
// level — the race-content AI draft covers it.)
func (s *Store) UpsertRaceCityContentAIDraft(ctx context.Context, in *RaceCityContent) (*RaceCityContent, error) {
	var saved *RaceCityContent
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row RaceCityContent
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("city = ?", in.City).First(&row).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			now := nowUTC()
			created := *in
			created.ID = 0
			// Only the intro is AI-generated; everything else is deliberately
			// left empty for the admin to fill in later.
			created.Province = nil
			created.Attractions = nil
			created.CreatedAt, created.UpdatedAt = now, now
			if err := tx.Create(&created).Error; err != nil {
				if isDuplicateKey(err) {
					return ErrRaceContentConflict
				}
				return fmt.Errorf("storage: create race city content draft: %w", err)
			}
			saved = &created
			return nil
		case err != nil:
			return fmt.Errorf("storage: lock race city content: %w", err)
		}
		row.Intro = in.Intro
		row.UpdatedAt = nowUTC()
		if err := tx.Save(&row).Error; err != nil {
			return fmt.Errorf("storage: update race city content draft: %w", err)
		}
		saved = &row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return saved, nil
}

// applyRaceCityContentUpdate copies the admin-writable city content fields from
// in onto row, leaving identity (id, city) alone.
func applyRaceCityContentUpdate(row *RaceCityContent, in *RaceCityContent) {
	row.Province = in.Province
	row.Intro = in.Intro
	row.Attractions = in.Attractions
}

// nowUTC is the shared UTC write instant (ADR 0003 discipline: the domain sets
// timestamps itself, truncated to the millisecond Datetime(6) precision).
func nowUTC() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}
