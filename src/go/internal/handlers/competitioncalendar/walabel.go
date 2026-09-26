// This file is the race_calendar_wa_label step: the third pass over the race
// calendars, after both mirrors have run.
//
// It exists because a race has two grades and they live in two tables' rows. The
// 中国田协 mirror writes 中国田协's own grade (A/B/C…) onto its rows; the World
// Athletics mirror writes the WA tier (Platinum/Gold/Elite/Label) onto *its*
// rows. A runner looking at one race should see both, and neither mirror can
// write the other's rows — ReplaceRaceCalendarYear is scoped to its own source
// by construction. So this step matches the two calendars and copies the tier
// across, which is the only cross-source write in the pipeline.
//
// It runs as its own single-step pipeline rather than inside either mirror: the
// two mirrors run as parallel jobs in the daily workflow, so a step needing both
// calendars' output cannot be part of either one.
//
// The match is (race_date, city), exact, and requires a unique candidate. There
// is deliberately no fuzzy fallback:
//
//   - Names are useless across the sources. WA says "Fuzhou Marathona" (the
//     upstream typo) and "Xi'an" while 中国田协 says "2026福州马拉松"; matching on
//     name tokens would be a second heuristic to be wrong in.
//   - race_types cannot carry the match either. WA fills it only from the
//     GW/GL ranking categories, so 31 of the 38 Chinese matches in 2026 are
//     ["Unknown"] — it can refute a match but rarely confirm one, which is
//     exactly how it is used below.
//   - A date disagreement is left unmatched rather than guessed at. 2026南昌马拉松
//     is 11-15 (the organiser's announced date, corroborated by the local press)
//     but WA still lists 11-08; the race simply keeps no tier rather than risk
//     attaching it to whatever else that city ran that day.
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

type waLabelYearSummary struct {
	Labeled  int `json:"labeled"`
	Cleared  int `json:"cleared"`
	Unmerged int `json:"unmatched"`
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

			desired, matched := matchWALabels(scope)
			_ = hb("label:"+year, 60)

			// Write only what changes, so a routine day writes nothing at all and
			// a re-run of the same day is a no-op.
			changed := make([]storage.RaceCalendarWALabel, 0, len(scope.ChinaAth))
			summary := waLabelYearSummary{Unmerged: len(scope.ChinaAth) - matched}
			for _, row := range scope.ChinaAth {
				want := desired[row.ID]
				if sameLabel(row.WALabel, want) {
					continue
				}
				changed = append(changed, storage.RaceCalendarWALabel{ID: row.ID, WALabel: want})
				if want == nil {
					summary.Cleared++
				} else {
					summary.Labeled++
				}
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
				zap.Int("matched", matched),
				zap.Int("changed", len(changed)),
				zap.Int("applied", applied))
			out.Years[year] = summary
		}

		_ = hb("label", 100)
		encoded, err := json.Marshal(out)
		if err != nil {
			return "", fmt.Errorf("race_calendar_wa_label: marshal result: %w", err)
		}
		return string(encoded), nil
	}
}

// matchWALabels maps each 中国田协 row id to the World Athletics tier it should
// carry, and reports how many rows found a counterpart. A row absent from the map
// has no tier and the map value for a present row may be nil when the matched WA
// row itself carries no label.
//
// The candidate must be unique: two World Athletics listings sharing a city and
// date would leave the choice a coin flip, so both are dropped rather than
// guessed. That is the same reason a WA date that has drifted onto another
// race's day cannot cause a wrong label — the second listing is what makes the
// pick ambiguous, and ambiguity is refused.
func matchWALabels(scope storage.RaceCalendarLabelScope) (map[uint64]*string, int) {
	byKey := make(map[labelKey][]storage.RaceCalendarEvent, len(scope.WorldAth))
	for _, wa := range scope.WorldAth {
		k, ok := keyOf(wa)
		if !ok {
			continue
		}
		byKey[k] = append(byKey[k], wa)
	}

	desired := make(map[uint64]*string, len(scope.ChinaAth))
	matched := 0
	for _, cn := range scope.ChinaAth {
		k, ok := keyOf(cn)
		if !ok {
			continue
		}
		candidates := byKey[k]
		if len(candidates) != 1 {
			continue
		}
		wa := candidates[0]
		if !typesCompatible(wa.RaceTypes, cn.RaceTypes) {
			continue
		}
		matched++
		desired[cn.ID] = wa.Label
	}
	return desired, matched
}

// labelKey is the match key: the race's calendar date and its city. Both sides
// store city at the prefecture level (see the chinaCity table), which is what
// makes this join sound.
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
