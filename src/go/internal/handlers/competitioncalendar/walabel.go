// This file is the race_calendar_wa_label step: it runs after both mirrors have
// run.
//
// The job is the self-mirror only: every 国际田联 row's own tier (Platinum /
// Gold / Elite / Label) lands in its wa_label column. That is what keeps
// wa_label populated for the races 中国田协 does not list (上海马拉松 Platinum,
// 北京马拉松 Gold…), where the 国际田联 row *is* the only row a runner sees —
// readers consult the one wa_label column instead of reasoning about which
// calendar a row came from.
//
// The column is deliberately outside raceCalendarUpsertCols, so no mirror's
// upsert writes it and a tier can never be clobbered by a merge; this step is
// what re-mirrors an upstream tier change onto the stored rows.
//
// A matched race's 中国田协 row gets its tier from the 国际田联 mirror's dedup
// (dedup.go), not here — after that dedup there IS no 国际田联 row for a matched
// race, so a copy pass here would read "no counterpart" and erase the tier the
// mirror just wrote. Chinese rows are off limits to this step.
//
// It runs as its own single-step pipeline rather than inside the mirror: the
// mirrors run as parallel jobs in the daily workflow, and a row inserted by
// today's mirror run is labelled the same morning without either pipeline
// waiting on the other.
package competitioncalendar

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// JobTypeWALabel is the registered job_type for the label step. It MUST match
// catalog.JobTypeRaceCalendarWALabel.
const JobTypeWALabel = "race_calendar_wa_label"

// WALabelStore is the slice of *storage.Store this handler needs.
type WALabelStore interface {
	LoadRaceCalendarLabelScope(ctx context.Context, year string) (storage.RaceCalendarLabelScope, error)
	ApplyRaceCalendarWALabels(ctx context.Context, labels []storage.RaceCalendarWALabel) (int, error)
}

// WALabelConfig is the handler's static dependencies and defaults.
type WALabelConfig struct {
	Store WALabelStore
	// DefaultYears is used when the job input omits "years". Empty means the
	// current Shanghai year.
	DefaultYears []string
	Logger       *zap.Logger
}

type waLabelInput struct {
	Years []string `json:"years"`
}

// waLabelYearSummary reports one year's work. The copy counts below are part of
// the job result's operator-facing shape but are always zero: the cross-source
// copy onto 中国田协 rows is the 国际田联 mirror's dedup now (dedup.go). A
// nonzero Labeled or Cleared means that dedup is no longer running — treat it as
// an alarm.
type waLabelYearSummary struct {
	Labeled   int `json:"labeled"`
	Unmatched int `json:"unmatched"`
	Cleared   int `json:"cleared"`
	// Mirrored counts World Athletics rows whose stored tier changed — the
	// job's entire work.
	Mirrored int `json:"mirrored"`
}

// NewWALabel returns the race_calendar_wa_label job.Handler.
func NewWALabel(cfg WALabelConfig) job.Handler {
	log := cfg.Logger
	if log == nil {
		log = logging.Default()
	}
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		var in waLabelInput
		if s := strings.TrimSpace(j.InputJSON); s != "" {
			if err := json.Unmarshal([]byte(s), &in); err != nil {
				log.Error("race_calendar_wa_label: malformed job input",
					zap.String("job_id", j.ID),
					zap.String("error_code", "bad_payload"),
					zap.Error(err))
				return "", job.NewPermanentError("bad_payload", err)
			}
		}
		years := in.Years
		if len(years) == 0 {
			years = cfg.DefaultYears
		}
		if len(years) == 0 {
			// The current and next Shanghai year, matching the 中国田协 mirror's
			// own default: the rows being labelled are the ones that mirror
			// wrote, so the two steps must cover the same span or next season's
			// races carry no tier until the year rolls over.
			yr := timefmt.ShanghaiToday().Year()
			years = []string{fmt.Sprintf("%d", yr), fmt.Sprintf("%d", yr+1)}
		}

		out := struct {
			Years map[string]waLabelYearSummary `json:"years"`
		}{Years: make(map[string]waLabelYearSummary)}

		for _, year := range years {
			_ = hb("label:"+year, 10)
			scope, err := cfg.Store.LoadRaceCalendarLabelScope(ctx, year)
			if err != nil {
				log.Error("race_calendar_wa_label: load scope failed",
					zap.String("job_id", j.ID), zap.String("year", year), zap.Error(err))
				return "", err
			}

			// The self-mirror: every World Athletics row carries its own tier.
			// Write only what changes, so a routine day writes nothing at all and
			// a re-run of the same day is a no-op. The scope's 中国田协 half is
			// loaded for the log's row counts only — the mirror's dedup owns
			// those rows' tiers now.
			changed := make([]storage.RaceCalendarWALabel, 0, len(scope.WorldAth))
			for _, row := range scope.WorldAth {
				want := row.Label
				if sameLabel(row.WALabel, want) {
					continue
				}
				changed = append(changed, storage.RaceCalendarWALabel{ID: row.ID, WALabel: want})
			}

			applied, err := cfg.Store.ApplyRaceCalendarWALabels(ctx, changed)
			if err != nil {
				if storage.IsDeterministicWriteError(err) {
					log.Error("race_calendar_wa_label: write failed (deterministic)",
						zap.String("job_id", j.ID), zap.String("year", year),
						zap.String("error_code", "storage_constraint"), zap.Error(err))
					return "", job.NewPermanentError("storage_constraint", err)
				}
				log.Error("race_calendar_wa_label: write failed",
					zap.String("job_id", j.ID), zap.String("year", year), zap.Error(err))
				return "", err
			}
			// applied < len(changed) means the store's origin/override guards
			// skipped rows — expected, but worth seeing when it happens.
			log.Info("race_calendar_wa_label: year done",
				zap.String("job_id", j.ID), zap.String("year", year),
				zap.Int("china_ath", len(scope.ChinaAth)),
				zap.Int("world_ath", len(scope.WorldAth)),
				zap.Int("changed", len(changed)),
				zap.Int("applied", applied))
			out.Years[year] = waLabelYearSummary{Mirrored: len(changed)}
		}

		_ = hb("label", 100)
		encoded, err := json.Marshal(out)
		if err != nil {
			return "", fmt.Errorf("race_calendar_wa_label: marshal result: %w", err)
		}
		return string(encoded), nil
	}
}

// sameLabel reports whether a row already carries the desired tier. Pointer
// comparison would miss equal strings, and the whole point is to write only real
// changes.
func sameLabel(current, want *string) bool {
	if current == nil || want == nil {
		return current == nil && want == nil
	}
	return *current == *want
}
