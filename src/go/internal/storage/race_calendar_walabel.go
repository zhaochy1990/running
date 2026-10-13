package storage

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// This file is the persistence half of the World Athletics tier plumbing: it
// loads the row set the 国际田联 mirror matches against, and applies derived
// tiers.
//
// The tier lands on the 中国田协 row in the mirror step itself (devops#443,
// reworked in devops#533): a 国际田联 listing whose (race_date, city) matches an
// existing Chinese row is not written at all, and its tier is applied to that
// row via ApplyRaceCalendarWALabels.

// LoadRaceCalendarDedupScope returns one year's rows the 国际田联 mirror may
// dedup against: every row of the year EXCEPT the mirror's own still-synced
// rows (source = 国际田联 AND origin = sync). The exclusion rule is what makes
// the match set complete:
//
//   - 中国田协 rows and manually sourced rows are the obvious targets — a WA
//     listing matching one of these on (race_date, city) must not create an
//     English-name row.
//   - A detached 国际田联 row (origin = manual: an administrator renamed it,
//     moved its date, or edited anything else, which flips the whole row to
//     manual) is ALSO a target (devops#533). Before the exclusion rule the
//     scope listed sources, so an administrator-taken-over row vanished from
//     the match set and the next sync re-inserted its English-name twin beside
//     it (2026 上海/常州/深圳/南山/南昌 all grew such pairs). Excluding only
//     still-synced WA rows puts those rows back in scope without ever letting
//     a WA listing dedup against another live WA row — same-key WA rows are
//     ReplaceRaceCalendarYear's own (source, name, race_date) business.
//
// The rows carry WALabel so the caller can skip writes whose value already
// matches.
func (s *Store) LoadRaceCalendarDedupScope(ctx context.Context, year string) ([]RaceCalendarEvent, error) {
	from, to := yearDateRange(year)
	var rows []RaceCalendarEvent
	err := s.db.WithContext(ctx).
		Where("race_date BETWEEN ? AND ?", from, to).
		Where("NOT (source = ? AND origin = ?)", RaceSourceWorldAth, RaceOriginSync).
		Order("race_date, name").
		Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: load race_calendar dedup scope: %w", err)
	}
	return rows, nil
}

// RaceCalendarWALabel is one derived tier to write: the target row and the
// World Athletics tier to put on it. A nil WALabel clears the column.
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
