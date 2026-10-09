package storage

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// This file is the persistence half of the World Athletics tier plumbing: it
// loads the row sets a step needs to match (the race_calendar_wa_label job's
// year scope, and the Chinese rows the 国际田联 mirror dedups against), and
// applies derived tiers.
//
// The tier exists because the two calendars describe the same races under
// different grades — a 中国田协 row carries 中国田协's own grade (A/B/C…), a
// 国际田联 row carries the World Athletics tier (Platinum/Gold/Elite/Label) —
// and the product wants both on the one row a runner sees. Since devops#443 the
// tier lands on the 中国田协 row in the mirror step itself: a 国际田联 listing
// whose (race_date, city) matches an existing Chinese row is not written at all,
// and its tier is applied to that row via ApplyRaceCalendarWALabels. The
// race_calendar_wa_label job keeps only the self-mirror (a 国际田联 row carrying
// its own tier, for the races no Chinese row exists for).

// RaceCalendarLabelScope is the row set one label run reconciles for a year:
// both calendars' rows, because wa_label is written on both (a World Athletics
// row mirrors its own tier; see the model's WALabel doc).
//
// 中国田协 rows are loaded without a country filter because that source is
// China-only by construction; 国际田联 is scoped to CHN because the two calendars
// only overlap on Chinese races. A World Athletics race abroad is not in scope:
// there is no 中国田协 row to copy onto, and its own row already carries its tier
// in label — mirroring it into wa_label would be work for no reader.
type RaceCalendarLabelScope struct {
	ChinaAth []RaceCalendarEvent
	WorldAth []RaceCalendarEvent
}

// LoadRaceCalendarLabelScope returns one year's rows for both calendars.
func (s *Store) LoadRaceCalendarLabelScope(ctx context.Context, year string) (RaceCalendarLabelScope, error) {
	from, to := yearDateRange(year)
	var scope RaceCalendarLabelScope

	err := s.db.WithContext(ctx).
		Where("source = ? AND race_date BETWEEN ? AND ?", RaceSourceChinaAth, from, to).
		Order("race_date, name").
		Find(&scope.ChinaAth).Error
	if err != nil {
		return scope, fmt.Errorf("storage: load 中国田协 label scope: %w", err)
	}

	err = s.db.WithContext(ctx).
		Where("source = ? AND country = ? AND race_date BETWEEN ? AND ?", RaceSourceWorldAth, "CHN", from, to).
		Order("race_date, name").
		Find(&scope.WorldAth).Error
	if err != nil {
		return scope, fmt.Errorf("storage: load 国际田联 label scope: %w", err)
	}
	return scope, nil
}

// LoadRaceCalendarDedupScope returns the Chinese rows one year's 国际田联
// mirror dedups against (devops#443): every 中国田协 row plus every manually
// sourced row of the year. A WA listing matching one of these on (race_date,
// city) must not create an English-name row — the Chinese row is the race.
//
// The 国际田联 mirror's own rows are excluded by construction (neither source
// matches), so a WA row can never dedup against another WA row: those are
// handled by ReplaceRaceCalendarYear's own (source, name, race_date) key. The
// rows carry WALabel so the caller can skip writes whose value already matches.
func (s *Store) LoadRaceCalendarDedupScope(ctx context.Context, year string) ([]RaceCalendarEvent, error) {
	from, to := yearDateRange(year)
	var rows []RaceCalendarEvent
	err := s.db.WithContext(ctx).
		Where("source IN ? AND race_date BETWEEN ? AND ?", []string{RaceSourceChinaAth, RaceSourceManual}, from, to).
		Order("race_date, name").
		Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: load race_calendar dedup scope: %w", err)
	}
	return rows, nil
}

// RaceCalendarWALabel is one derived tier to write: the target 中国田协 row and
// the World Athletics tier to put on it. A nil WALabel clears the column.
type RaceCalendarWALabel struct {
	ID      uint64
	WALabel *string
}

// ApplyRaceCalendarWALabels writes each derived tier and reports how many rows it
// actually touched. The caller passes only the rows whose value differs from what
// is stored, so the write is idempotent and a routine day writes nothing.
//
// Two guards live here rather than in the caller, because a wrong write would be
// silent and durable:
//
//   - origin = 'sync'. A manual row has no upstream listing to match, and a row
//     an administrator detached must not be relabelled behind their back.
//   - wa_label not in admin_overrides. The match is a heuristic over
//     (race_date, city); an administrator who corrected a tier outranks it, and
//     this is the check that makes the override mean something for a column the
//     中国田协 mirror never writes.
//
// Rows failing either guard are skipped, not counted.
func (s *Store) ApplyRaceCalendarWALabels(ctx context.Context, labels []RaceCalendarWALabel) (int, error) {
	if len(labels) == 0 {
		return 0, nil
	}
	applied := 0
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		for _, l := range labels {
			res := tx.Model(&RaceCalendarEvent{}).
				Where("id = ?", l.ID).
				Where("origin = ?", RaceOriginSync).
				Where("admin_overrides IS NULL OR JSON_CONTAINS(admin_overrides, JSON_QUOTE(?)) = 0", OverrideFieldWALabel).
				Updates(map[string]any{"wa_label": l.WALabel, "updated_at": now})
			if res.Error != nil {
				return fmt.Errorf("storage: apply wa_label to race %d: %w", l.ID, res.Error)
			}
			applied += int(res.RowsAffected)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return applied, nil
}
