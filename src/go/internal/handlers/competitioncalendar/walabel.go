// This file is the race_calendar_wa_label step: it runs after both mirrors have
// run.
//
// It exists because a World Athletics row must carry its own tier in wa_label,
// not just in label — the races 中国田协 does not list (上海马拉松 Platinum,
// 北京马拉松 Gold…) have their 国际田联 row as the only row a runner sees, and
// readers consult the one wa_label column instead of reasoning about which
// calendar a row came from. The mirror writes wa_label on freshly inserted rows
// only via the upsert's insert path (the column is deliberately outside
// raceCalendarUpsertCols, so no mirror's merge can clobber it); this step
// re-mirrors the tier on every run so an upstream tier change reaches the
// stored rows too.
//
// The cross-source half this step used to perform — copying a 国际田联 row's
// tier onto the matching 中国田协 row — moved into the 国际田联 mirror itself
// (devops#443): there the listing is deduped against the Chinese row instead of
// being written, and its tier is applied to that row in the same run. This step
// must not copy across sources any more: after the dedup there IS no 国际田联
// row for a matched race, so a copy pass would read "no counterpart" and erase
// the tier the mirror just wrote.
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
	"github.com/zhaochy1990/stride/internal/racetypes"
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

// waLabelYearSummary reports one year's work. The self-mirror is the whole job
// since devops#443; the copy counts below stay in the result shape (dashboards
// read this JSON) and are always zero — a nonzero Labeled/Cleared after this
// change would mean the cross-source half came back.
type waLabelYearSummary struct {
	// Labeled counts 中国田协 rows that took a tier from their World Athletics
	// counterpart; Unmatched counts those that found no counterpart.
	//
	// Always zero since devops#443: the copy moved into the 国际田联 mirror's
	// dedup (after which there is no counterpart row to find).
	Labeled   int `json:"labeled"`
	Unmatched int `json:"unmatched"`
	// Cleared counts 中国田协 rows whose tier was removed (the listing is gone or
	// the two no longer match).
	//
	// Always zero since devops#443: the mirror's dedup reconciles the Chinese
	// rows' tiers in the same run that decides the matches.
	Cleared int `json:"cleared"`
	// Mirrored counts World Athletics rows that took their own tier into
	// wa_label — the job's entire remaining work.
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

// labelKey is the match key: the race's calendar date and its city. Both sides
// store city at the prefecture level (see the chinaCity table), which is what
// makes this join sound. The match itself lives in dedup.go (the 国际田联
// mirror's dedup); keyOf and typesCompatible below are its shared helpers.
type labelKey struct {
	RaceDate string
	City     string
}

// keyOf derives the match key, reporting false when the row cannot take part: a
// row without a city has nothing to join on.
func keyOf(row storage.RaceCalendarEvent) (labelKey, bool) {
	if row.City == nil || strings.TrimSpace(*row.City) == "" {
		return labelKey{}, false
	}
	return labelKey{RaceDate: row.RaceDate, City: strings.TrimSpace(*row.City)}, true
}

// typesCompatible reports whether a World Athletics row's race types are
// consistent with the 中国田协 row's. It only ever refutes: WA fills race types
// from the GW/GL ranking categories alone, so most rows say ["Unknown"] and can
// never confirm anything. When WA does state a type, the 中国田协 row's item-derived
// set must contain it — that is what catches a drifted WA date landing on a
// different race in the same city (a marathon's tier on a half marathon).
func typesCompatible(wa, cn *string) bool {
	waTypes := decodeTypes(wa)
	if len(waTypes) == 0 {
		return true
	}
	cnTypes := decodeTypes(cn)
	for _, t := range waTypes {
		if t == racetypes.Unknown || t == racetypes.Other {
			continue
		}
		for _, c := range cnTypes {
			if c == t {
				return true
			}
		}
		// WA stated a concrete type the 中国田协 row does not list.
		return false
	}
	// Nothing but Unknown/Other on the WA side: no opinion.
	return true
}

// decodeTypes reads a row's race_types JSON array. A malformed or absent value
// decodes to nothing, which typesCompatible treats as "no opinion".
func decodeTypes(encoded *string) []string {
	if encoded == nil || strings.TrimSpace(*encoded) == "" {
		return nil
	}
	var out []string
	if err := json.Unmarshal([]byte(*encoded), &out); err != nil {
		return nil
	}
	return out
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
