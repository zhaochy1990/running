package storage

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// This file is the persistence half of the race_calendar_wa_label step: it loads
// the two sources' rows for a year so the step can match them, and applies the
// tiers it derived.
//
// The step exists because the two calendars describe the same races under
// different grades — a 中国田协 row carries 中国田协's own grade (A/B/C…), a
// 国际田联 row carries the World Athletics tier (Platinum/Gold/Elite/Label) —
// and the product wants both on the one row a runner sees. Neither mirror can
// write the other's rows (ReplaceRaceCalendarYear is scoped to its own source),
// so the tier is copied by a third pass that owns no source at all.

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
