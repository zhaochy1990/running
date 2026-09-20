package storage

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// AutoMigrateRaceCalendar creates/updates the race_calendar table. Called by
// the worker at boot (the pipeline that writes it).
func (s *Store) AutoMigrateRaceCalendar(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&RaceCalendarEvent{}); err != nil {
		return fmt.Errorf("storage: automigrate race_calendar: %w", err)
	}
	return nil
}

// raceCalendarUpsertCols are the mutable data columns refreshed on a conflict,
// keyed on (source, name, race_date). name_cn is deliberately excluded — it is
// an app-side asset (curated Chinese names) that the upstream sync must never
// overwrite — and created_at keeps its first-seen timestamp.
var raceCalendarUpsertCols = []string{
	"race_date", "month", "dayofmonth", "country", "province", "city", "label",
	"updated_at",
}

// ReplaceRaceCalendarResult reports what one year's sync did.
type ReplaceRaceCalendarResult struct {
	Upserted int
	Deleted  int
}

// ReplaceRaceCalendarYear mirrors one source's year into race_calendar, keyed
// on (source, name, race_date). It upserts every supplied race (refreshing the
// mutable columns, keeping name_cn and created_at), then deletes rows of that
// year that upstream no longer lists, so the table stays a faithful mirror.
//
// Source on each race is overwritten with the passed value, and Month/DayOfMonth
// are derived from RaceDate (single source of truth). Only the remaining fields
// are read from the rows. year is not stored (RaceDate carries it) but bounds
// the stale-delete to that calendar year, so older years' history is untouched.
// An empty races slice is a no-op (returns zero counts) rather than a wipe: a
// transient empty upstream response must not clear a populated year.
func (s *Store) ReplaceRaceCalendarYear(ctx context.Context, source, year string, races []RaceCalendarEvent) (ReplaceRaceCalendarResult, error) {
	if len(races) == 0 {
		return ReplaceRaceCalendarResult{}, nil
	}
	for i := range races {
		races[i].Source = source
		races[i].UpdatedAt = time.Now().UTC()
		races[i].Month, races[i].DayOfMonth = monthDayOf(races[i].RaceDate)
	}

	var res ReplaceRaceCalendarResult
	from, to := yearDateRange(year)
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "source"}, {Name: "name"}, {Name: "race_date"}},
			DoUpdates: clause.AssignmentColumns(raceCalendarUpsertCols),
		}).Create(&races).Error; err != nil {
			return fmt.Errorf("storage: upsert race_calendar: %w", err)
		}
		res.Upserted = len(races)

		// Stale rows are matched on the composite key (name, race_date): two
		// different races can share a name in a year (e.g. two half marathons
		// both called "Medio Maraton Sevilla"), so a plain name NOT IN would
		// delete the same-named survivor. MySQL row-value IN keeps them apart.
		// The delete is bounded to the year being synced so older history stays.
		keys := make([][]any, len(races))
		for i, r := range races {
			keys[i] = []any{r.Name, r.RaceDate}
		}
		del := tx.Where("source = ? AND race_date BETWEEN ? AND ? AND (name, race_date) NOT IN ?",
			source, from, to, keys).
			Delete(&RaceCalendarEvent{})
		if del.Error != nil {
			return fmt.Errorf("storage: delete stale race_calendar: %w", del.Error)
		}
		res.Deleted = int(del.RowsAffected)
		return nil
	})
	if err != nil {
		return ReplaceRaceCalendarResult{}, err
	}
	return res, nil
}

// monthDayOf parses a "2006-01-02" calendar date into its month and day of
// month. An unparseable date yields (0, 0) rather than failing the whole sync
// (upstream always sends well-formed dates; a 0 is a visible data anomaly).
func monthDayOf(raceDate string) (int8, int8) {
	t, err := time.Parse("2006-01-02", raceDate)
	if err != nil {
		return 0, 0
	}
	return int8(t.Month()), int8(t.Day())
}

// yearDateRange returns the inclusive calendar-date range of a "yyyy" year,
// used to bound the stale-delete to the year being synced.
func yearDateRange(year string) (string, string) {
	return year + "-01-01", year + "-12-31"
}
