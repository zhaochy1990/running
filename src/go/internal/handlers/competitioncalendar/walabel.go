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

// waLabelYearSummary reports one year's work, split by which side of the match a
// row was, so an operator can tell a failed cross-source match (Labeled falling
// to zero) from the routine self-mirror still working (Mirrored steady).
type waLabelYearSummary struct {
	// Labeled counts 中国田协 rows that took a tier from their World Athletics
	// counterpart; Unmatched counts those that found no counterpart.
	Labeled   int `json:"labeled"`
	Unmatched int `json:"unmatched"`
	// Cleared counts 中国田协 rows whose tier was removed (the listing is gone or
	// the two no longer match). Listed before Unmatched because the two are
	// different states: a cleared row had a tier and lost it.
	Cleared int `json:"cleared"`
	// Mirrored counts World Athletics rows that took their own tier into
	// wa_label — routine, and the whole count for races 中国田协 does not list.
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

			desired, matched := matchWALabels(scope)
			_ = hb("label:"+year, 60)

			// Write only what changes, so a routine day writes nothing at all and
			// a re-run of the same day is a no-op.
			// Both calendars are reconciled, not only the 中国田协 side: a WA row
			// carries its own tier (see matchWALabels). A fresh slice rather than
			// append(scope.ChinaAth, ...) — that would write into the scope's own
			// backing array when it has spare capacity.
			all := make([]storage.RaceCalendarEvent, 0, len(scope.ChinaAth)+len(scope.WorldAth))
			all = append(all, scope.ChinaAth...)
			all = append(all, scope.WorldAth...)

			changed := make([]storage.RaceCalendarWALabel, 0, len(all))
			summary := waLabelYearSummary{Unmatched: len(scope.ChinaAth) - matched}
			for _, row := range all {
				want := desired[row.ID]
				if sameLabel(row.WALabel, want) {
					continue
				}
				changed = append(changed, storage.RaceCalendarWALabel{ID: row.ID, WALabel: want})
				switch {
				case row.Source == storage.RaceSourceWorldAth:
					summary.Mirrored++
				case want == nil:
					summary.Cleared++
				default:
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

// matchWALabels maps each in-scope row id to the World Athletics tier it should
// carry, and reports how many 中国田协 rows found a counterpart.
//
// THE CONTRACT: the map must contain an entry for every row that has a tier, and
// the caller treats an ABSENT entry as "clear it". That is what lets a race which
// lost its World Athletics listing shed a stale tier — but it also means
// forgetting to populate a row here does not leave it blank, it ERASES it. Every
// source in the scope must be enumerated below; removing the World Athletics loop
// would silently wipe those rows' tiers rather than merely stop filling them.
//
// A present entry may itself hold nil, which also clears — that is how a
// 中国田协 row whose counterpart carries no tier is handled.
//
// The counterpart must be unique: two World Athletics listings sharing a city and
// date would leave the choice a coin flip, so an ambiguous 中国田协 row is left out
// of the map (and therefore cleared) rather than guessed at. The same rule is why
// a WA date that has drifted onto another race's day cannot cause a wrong label.
func matchWALabels(scope storage.RaceCalendarLabelScope) (map[uint64]*string, int) {
	byKey := make(map[labelKey][]storage.RaceCalendarEvent, len(scope.WorldAth))
	for _, wa := range scope.WorldAth {
		k, ok := keyOf(wa)
		if !ok {
			continue
		}
		byKey[k] = append(byKey[k], wa)
	}

	desired := make(map[uint64]*string, len(scope.ChinaAth)+len(scope.WorldAth))

	// A World Athletics row carries its own tier, and mirrors it onto itself.
	//
	// This is not redundant. For the 38 races both calendars list, the tier lands
	// on the 中国田协 row and the WA row is a duplicate nobody reads. But 12 races
	// exist ONLY in the World Athletics calendar — 上海马拉松 (Platinum),
	// 北京马拉松 (Gold), 桂林, 黄石, 义乌, 深圳… — and for those the WA row *is*
	// the race, so its `label` is the only place the tier lives. Without this the
	// wa_label column would read empty for exactly the races whose tier is
	// Platinum, which reads as "no World Athletics tier" rather than "not copied".
	//
	// The rule is then uniform and source-independent: wa_label is this race's
	// World Athletics tier wherever one is known. A reader consults one column
	// instead of reasoning about which calendar a row came from.
	for _, wa := range scope.WorldAth {
		desired[wa.ID] = wa.Label
	}

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
