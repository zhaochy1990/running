// This file is the mirror's dedup (devops#443): a World Athletics listing for a
// Chinese race must not become its own race_calendar row when the Chinese row —
// the one a runner sees, carrying the curated name and the admin content —
// already exists. The listing's tier is applied to that row instead, and the
// listing is dropped from the mirror write, which is also what clears an
// existing duplicate: a dropped row is no longer in the year's keys, so
// ReplaceRaceCalendarYear's stale-delete removes the previous English-name row
// on the same run that stops rebuilding it.
//
// The match discipline is the race_calendar_wa_label step's, moved to where the
// upstream data enters: (race_date, city), exact, requiring a unique candidate
// on BOTH sides whose race types do not contradict each other. There is
// deliberately no fuzzy fallback:
//
//   - Names are useless across the sources. WA says "Fuzhou Marathona" (the
//     upstream typo) and "Xi'an" while 中国田协 says "2026福州马拉松"; matching on
//     name tokens would be a second heuristic to be wrong in.
//   - race_types cannot carry the match either. WA fills it only from the
//     GW/GL ranking categories, so most listings say ["Unknown"] — it can
//     refute a match but rarely confirm one, which is exactly how the check is
//     used: a stated type the Chinese row does not list refutes the pair and
//     keeps the listing (likely two different races sharing a city and day).
//   - A date disagreement is left unmatched rather than guessed at. 2026南昌马拉松
//     is 11-15 (the organiser's announced date, corroborated by the local press)
//     but WA still lists 11-08; the race keeps its listing as its own row rather
//     than risk merging whatever else that city ran that day.
//
// Uniqueness guards both directions because the key is a heuristic, not an
// identity: two Chinese rows on one city+day, or two upstream listings on one
// city+day (two different races, or one race listed twice), make the pick a
// coin flip — every row involved is kept as-is and nothing is stamped.
package competitioncalendar

import (
	"encoding/json"
	"strings"

	"github.com/zhaochy1990/stride/internal/racetypes"
	"github.com/zhaochy1990/stride/internal/storage"
)

// mirrorDedupSummary reports one year's dedup decisions, for the job result and
// the sync log.
type mirrorDedupSummary struct {
	// Deduped counts World Athletics listings not written because a unique
	// Chinese row covers them; their tiers land on those rows instead.
	Deduped int
	// Ambiguous counts listings kept because their (race_date, city) key is not
	// unique on one side or the other — merging could attach a tier to the
	// wrong race.
	Ambiguous int
	// TypeRefused counts listings kept because the unique candidate's race types
	// contradict the listing's — likely two different races sharing a city and
	// day.
	TypeRefused int
	// Stamped counts Chinese rows whose wa_label the mirror sets or changes.
	Stamped int
	// Cleared counts Chinese rows whose stored wa_label no longer has a listing
	// behind it and is removed.
	Cleared int
}

// planMirrorDedup decides, for one year's fetched upstream rows against the
// year's Chinese rows, what the mirror writes and which wa_label values land on
// Chinese rows.
//
// It returns the rows to hand to ReplaceRaceCalendarYear (the mirror write; a
// dropped listing makes its stored twin stale and gets it deleted) and the
// changed-only RaceCalendarWALabel list to hand to ApplyRaceCalendarWALabels —
// both the stamps for matched pairs and the clears for Chinese rows whose tier
// no listing supports any more.
//
// The store re-checks origin and the wa_label override on every write. A manual
// row therefore dedups (no ghost row beside it) without receiving the tier: the
// sync never writes a detached row, and the tier on it is the administrator's
// to set. That beats keeping the listing as its own row just to carry a tier on
// an unpublished duplicate nobody reads.
func planMirrorDedup(upstream, candidates []storage.RaceCalendarEvent) ([]storage.RaceCalendarEvent, []storage.RaceCalendarWALabel, mirrorDedupSummary) {
	cnByKey := make(map[labelKey][]storage.RaceCalendarEvent, len(candidates))
	for _, cn := range candidates {
		k, ok := keyOf(cn)
		if !ok {
			continue
		}
		cnByKey[k] = append(cnByKey[k], cn)
	}
	// Upstream indexes by key, so a refused key keeps every row in it and a
	// matched key drops exactly its one listing while preserving input order.
	upstreamIdx := make(map[labelKey][]int)
	for i, in := range upstream {
		if in.Country != "CHN" {
			continue
		}
		if k, ok := keyOf(in); ok {
			upstreamIdx[k] = append(upstreamIdx[k], i)
		}
	}

	// The tier each Chinese row should carry: absent means none, and a row left
	// absent by the match loop below gets nil — that is the reconcile half,
	// what retires a tier whose listing is gone, drifted to another day, or
	// became ambiguous.
	desired := make(map[uint64]*string, len(candidates))
	dropped := make(map[int]bool)

	for k, idxs := range upstreamIdx {
		cns := cnByKey[k]
		if len(cns) != 1 || len(idxs) != 1 {
			continue
		}
		in := upstream[idxs[0]]
		if !typesCompatible(in.RaceTypes, cns[0].RaceTypes) {
			continue
		}
		dropped[idxs[0]] = true
		desired[cns[0].ID] = in.Label
	}

	keep := make([]storage.RaceCalendarEvent, 0, len(upstream))
	var summary mirrorDedupSummary
	for i, in := range upstream {
		if dropped[i] {
			summary.Deduped++
			continue
		}
		keep = append(keep, in)
		if in.Country != "CHN" {
			continue
		}
		if k, ok := keyOf(in); ok {
			switch n := len(cnByKey[k]); {
			case n == 0:
				// No Chinese row: the listing IS the race (北京马拉松 and friends).
			case len(upstreamIdx[k]) != 1 || n != 1:
				summary.Ambiguous++
			default:
				// Unique on both sides but the types refused the pair.
				summary.TypeRefused++
			}
		}
	}

	labels := make([]storage.RaceCalendarWALabel, 0, len(candidates))
	for _, cn := range candidates {
		want := desired[cn.ID]
		if sameLabel(cn.WALabel, want) {
			continue
		}
		labels = append(labels, storage.RaceCalendarWALabel{ID: cn.ID, WALabel: want})
		if want == nil {
			summary.Cleared++
		} else {
			summary.Stamped++
		}
	}
	return keep, labels, summary
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

// typesCompatible reports whether a World Athletics listing's race types are
// consistent with the candidate row's. It only ever refutes: WA fills race types
// from the GW/GL ranking categories alone, so most listings say ["Unknown"] and
// can never confirm anything. When WA does state a concrete type, the candidate's
// set must contain it — that is what catches a drifted WA date landing on a
// different race in the same city (a marathon's tier on a half marathon), and it
// is why a refused pair keeps its listing as its own row.
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
		// WA stated a concrete type the candidate row does not list.
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
