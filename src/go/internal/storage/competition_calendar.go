package storage

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// AutoMigrateCompetitionCalendar creates/updates the competition_calendar table.
// Called by the worker at boot (the pipeline that writes it).
func (s *Store) AutoMigrateCompetitionCalendar(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&CompetitionCalendarEvent{}); err != nil {
		return fmt.Errorf("storage: automigrate competition_calendar: %w", err)
	}
	return nil
}

// competitionCalendarUpsertCols are the mutable data columns refreshed on a
// conflict. created_at is deliberately excluded so a row keeps its first-seen
// timestamp across syncs.
var competitionCalendarUpsertCols = []string{
	"iaaf_id", "name", "venue", "country", "start_date", "end_date", "date_range",
	"disciplines", "ranking_category", "competition_subgroup",
	"has_results", "has_startlist", "has_api_results", "has_competition_information",
	"updated_at",
}

// ReplaceCompetitionCalendarResult reports what one season sync did.
type ReplaceCompetitionCalendarResult struct {
	Upserted int
	Deleted  int
}

// ReplaceCompetitionCalendarSeason mirrors one source's season into
// competition_calendar, keyed on (source, season, event_id). It upserts every
// supplied event (refreshing the mutable columns, keeping created_at), then
// deletes rows of that season that upstream no longer lists, so the table stays
// a faithful mirror.
//
// Source/Season on each event are overwritten with the passed values; only the
// remaining fields are read from the rows. An empty events slice is a no-op
// (returns zero counts) rather than a wipe: a transient empty upstream response
// must not clear a populated season.
func (s *Store) ReplaceCompetitionCalendarSeason(ctx context.Context, source, season string, events []CompetitionCalendarEvent) (ReplaceCompetitionCalendarResult, error) {
	if len(events) == 0 {
		return ReplaceCompetitionCalendarResult{}, nil
	}
	for i := range events {
		events[i].Source = source
		events[i].Season = season
		events[i].UpdatedAt = time.Now().UTC()
	}

	var res ReplaceCompetitionCalendarResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "source"}, {Name: "season"}, {Name: "event_id"}},
			DoUpdates: clause.AssignmentColumns(competitionCalendarUpsertCols),
		}).Create(&events).Error; err != nil {
			return fmt.Errorf("storage: upsert competition_calendar: %w", err)
		}
		res.Upserted = len(events)

		ids := make([]int64, len(events))
		for i, e := range events {
			ids[i] = e.EventID
		}
		del := tx.Where("source = ? AND season = ? AND event_id NOT IN ?", source, season, ids).
			Delete(&CompetitionCalendarEvent{})
		if del.Error != nil {
			return fmt.Errorf("storage: delete stale competition_calendar: %w", del.Error)
		}
		res.Deleted = int(del.RowsAffected)
		return nil
	})
	if err != nil {
		return ReplaceCompetitionCalendarResult{}, err
	}
	return res, nil
}
