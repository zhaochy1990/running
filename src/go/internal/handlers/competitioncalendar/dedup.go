// This file is the mirror's dedup (devops#443, reworked in devops#533): a
// World Athletics listing for a Chinese race must not become its own
// race_calendar row when the Chinese row — the one a runner sees, carrying the
// curated name and the admin content — already exists. The listing's tier is
// applied to that row instead, and the listing is dropped from the mirror
// write, which is also what clears an existing duplicate: a dropped row is no
// longer in the year's keys, so ReplaceRaceCalendarYear's stale-delete removes
// the previous English-name row on the same run that stops rebuilding it.
//
// The match runs in two tiers over the normalized city, each requiring a
// unique candidate on BOTH sides whose race types do not contradict each
// other. There is deliberately no fuzzy fallback:
//
//   - Names are useless for MATCHING across the sources. WA says "Fuzhou
//     Marathona" (the upstream typo) and "Xi'an" while 中国田协 says "2026福州马拉松";
//     matching on name tokens would be a second heuristic to be wrong in.
//   - T1 is the exact-(race_date, city) match, the discipline since devops#443.
//   - T2 allows the dates to drift up to 30 days within the same city — the
//     2026南昌马拉松 case, where WA still lists 11-08 and the organiser's
//     announced (and 中国田协's) date is 11-15. A same-city ±30d window is wide:
//     big cities run several races a month, so T2 adds a stricter type guard —
//     when WA's own race_types carry no distance (most listings), the distance
//     is derived from the listing's English name, and a pair the guard cannot
//     pin down is refused (kept as its own row) rather than guessed at.
//
// Uniqueness guards both directions because the key is a heuristic, not an
// identity: two Chinese rows in one window, or two upstream listings near one
// Chinese row, make the pick a coin flip — every row involved is kept as-is
// and nothing is stamped.
//
// The city is normalized through the chinaCity table on BOTH sides, so a
// stored English spelling ("Hengshui") joins the Chinese row's 衡水市 without
// rewriting any stored row (devops#533; ~55 historical WA rows store English
// city names their 中国田协 counterparts spell in Chinese).
package competitioncalendar

import (
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/racetypes"
	"github.com/zhaochy1990/stride/internal/storage"
)

// driftWindowDays is the T2 tier's date tolerance, both directions.
const driftWindowDays = 30

// mirrorDedupSummary reports one year's dedup decisions, for the job result and
// the sync log.
type mirrorDedupSummary struct {
	// Deduped counts World Athletics listings not written because a unique
	// Chinese row covers them; their tiers land on those rows instead.
	Deduped int
	// Drifted counts the Deduped listings that matched through the T2 tier
	// (dates disagreeing by up to driftWindowDays) rather than on the exact
	// date — the number to watch: each one is a heuristic call, not an
	// identity match.
	Drifted int
	// Ambiguous counts listings kept because the match is not unique on one
	// side or the other — merging could attach a tier to the wrong race.
	Ambiguous int
	// TypeRefused counts listings kept because the unique candidate's race
	// types contradict the listing's — likely two different races sharing a
	// city and day.
	TypeRefused int
	// Stamped counts rows whose wa_label the mirror sets or changes.
	Stamped int
	// Cleared counts rows whose stored wa_label no longer has a listing
	// behind it and is removed.
	Cleared int
}

// planMirrorDedup decides, for one year's fetched upstream rows against the
// year's candidate rows, what the mirror writes and which wa_label values land
// on Chinese rows.
//
// It returns the rows to hand to ReplaceRaceCalendarYear (the mirror write; a
// dropped listing makes its stored twin stale and gets it deleted) and the
// changed-only RaceCalendarWALabel list to hand to ApplyRaceCalendarWALabels —
// both the stamps for matched pairs and the clears for rows whose tier no
// listing supports any more.
//
// The store re-checks origin and the wa_label override on every write. A manual
// row therefore dedups (no ghost row beside it) without receiving the tier: the
// sync never writes a detached row, and the tier on it is the administrator's
// to set. That beats keeping the listing as its own row just to carry a tier on
// an unpublished duplicate nobody reads.
func planMirrorDedup(upstream, candidates []storage.RaceCalendarEvent) ([]storage.RaceCalendarEvent, []storage.RaceCalendarWALabel, mirrorDedupSummary) {
	// Index candidates and CHN listings per normalized city; the match walks
	// each listing from its exact date (T1) out to the ±30d window (T2).
	cnByCity := make(map[string][]storage.RaceCalendarEvent, len(candidates))
	for _, cn := range candidates {
		if city, ok := matchCityOf(cn); ok {
			cnByCity[city] = append(cnByCity[city], cn)
		}
	}
	// Upstream indexes by city only — the per-date counts below run over these
	// lists, so a refused window keeps every row in it and a matched listing
	// drops exactly itself while preserving input order.
	upstreamByCity := make(map[string][]int)
	for i, in := range upstream {
		if in.Country != "CHN" {
			continue
		}
		if city, ok := matchCityOf(in); ok {
			upstreamByCity[city] = append(upstreamByCity[city], i)
		}
	}

	// The tier each Chinese row should carry: absent means none, and a row left
	// absent by the match loop below gets nil — that is the reconcile half,
	// what retires a tier whose listing is gone, drifted to another day, or
	// became ambiguous.
	desired := make(map[uint64]*string, len(candidates))
	dropped := make(map[int]bool)
	var summary mirrorDedupSummary

	for city, is := range upstreamByCity {
		for _, i := range is {
			in := upstream[i]

			// T1: the exact date, unique on both sides.
			var exact []storage.RaceCalendarEvent
			for _, cn := range cnByCity[city] {
				if cn.RaceDate == in.RaceDate {
					exact = append(exact, cn)
				}
			}
			if len(exact) == 1 && countOnDate(upstream, is, in.RaceDate) == 1 {
				if typesCompatible(in.RaceTypes, exact[0].RaceTypes) {
					dropped[i] = true
					desired[exact[0].ID] = in.Label
				} else {
					summary.TypeRefused++
				}
				continue
			}

			// T2: drift within the window, in the same city, unique on both
			// sides and passing the stricter type guard. Only T1's ambiguous
			// pairs fall through here — a type-refused pair continued above.
			// Either way T2 re-examines them under the same or a stricter rule:
			// a wider net never rescues a refused pair.
			var window []storage.RaceCalendarEvent
			for _, cn := range cnByCity[city] {
				if withinDrift(cn.RaceDate, in.RaceDate) {
					window = append(window, cn)
				}
			}
			switch {
			case len(window) == 0:
				// No Chinese row in the window: the listing IS the race
				// (北京马拉松 and friends).
			case len(window) > 1 || countWithinDrift(upstream, is, window[0].RaceDate) != 1:
				summary.Ambiguous++
			default:
				if driftCompatible(in, window[0]) {
					dropped[i] = true
					desired[window[0].ID] = in.Label
					summary.Drifted++
				} else {
					summary.TypeRefused++
				}
			}
		}
	}

	keep := make([]storage.RaceCalendarEvent, 0, len(upstream))
	for i, in := range upstream {
		if dropped[i] {
			summary.Deduped++
			continue
		}
		keep = append(keep, in)
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

// matchCityOf derives the city half of the match key, normalized to the
// Chinese spelling the chinaCity table knows; ok is false when the row cannot
// take part: a row without a city has nothing to join on.
func matchCityOf(row storage.RaceCalendarEvent) (string, bool) {
	if row.City == nil || strings.TrimSpace(*row.City) == "" {
		return "", false
	}
	return matchCity(strings.TrimSpace(*row.City)), true
}

// countOnDate counts one city's CHN listings listed on the exact date — the
// listing-side uniqueness half of T1.
func countOnDate(upstream []storage.RaceCalendarEvent, is []int, date string) int {
	n := 0
	for _, i := range is {
		if upstream[i].RaceDate == date {
			n++
		}
	}
	return n
}

// withinDrift reports whether two calendar dates sit within driftWindowDays of
// each other. An unparseable date never drift-matches (T1 still sees it).
func withinDrift(a, b string) bool {
	da, errA := time.Parse("2006-01-02", a)
	db, errB := time.Parse("2006-01-02", b)
	if errA != nil || errB != nil {
		return false
	}
	d := int(da.Sub(db) / (24 * time.Hour))
	if d < 0 {
		d = -d
	}
	return d <= driftWindowDays
}

// countWithinDrift counts one city's CHN listings within the drift window of a
// Chinese row's date — the listing-side uniqueness half of T2: two listings
// near one row make the pick a coin flip even when the row side is unique.
func countWithinDrift(upstream []storage.RaceCalendarEvent, is []int, date string) int {
	n := 0
	for _, i := range is {
		if withinDrift(upstream[i].RaceDate, date) {
			n++
		}
	}
	return n
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
		if slices.Contains(cnTypes, t) {
			return true
		}
		// WA stated a concrete type the candidate row does not list.
		return false
	}
	// Nothing but Unknown/Other on the WA side: no opinion.
	return true
}

// driftCompatible is T2's stricter type guard. A same-city ±30d window can
// hold unrelated races (a half marathon and the marathon three weeks later),
// so a drift match needs a distance opinion on the WA side too: when the
// listing's race_types say only Unknown, the distance is derived from its
// English name, and a pair whose Chinese row states concrete types the derived
// distance contradicts is refused. A listing whose distance cannot be derived
// at all is refused outright — that is what keeps an 上马 Platinum stamp off a
// same-city half marathon half a month away.
func driftCompatible(in, cn storage.RaceCalendarEvent) bool {
	if !typesCompatible(in.RaceTypes, cn.RaceTypes) {
		return false
	}
	// The listing's distance opinion: WA fills race_types only from the GW/GL
	// tiers; everything else is Unknown, so the name is the fallback source.
	derived := concreteType(decodeTypes(in.RaceTypes))
	if derived == "" {
		derived = distanceTypeFromName(in.Name)
		if derived == "" {
			return false
		}
		hasOpinion, hasDerived := false, false
		for _, t := range decodeTypes(cn.RaceTypes) {
			if t == racetypes.Unknown || t == racetypes.Other {
				continue
			}
			hasOpinion = true
			if t == derived {
				hasDerived = true
			}
		}
		// The Chinese row has no distance opinion: the derived type cannot
		// contradict it. ponytail: no cross-check against the row's name — the
		// curated row's types are the signal, and adding name matching on this
		// side would be the second heuristic dedup refuses to run.
		if hasOpinion && !hasDerived {
			return false
		}
	}
	// A stated WA type passed typesCompatible above, which already required the
	// candidate to list it.
	return true
}

// concreteType returns the first concrete (non-Unknown/Other) type token, or
// "" when the row states no opinion.
func concreteType(types []string) string {
	for _, t := range types {
		if t != racetypes.Unknown && t != racetypes.Other {
			return t
		}
	}
	return ""
}

// distanceTypeFromName derives a distance token from a World Athletics
// listing's English name. Deliberately narrow — three observed patterns, not a
// parser (ponytail: extend only when a real drift pair is missed for lack of a
// pattern): "half marathon" → HalfMarathon, "10k" → 10Km, else a bare
// "marathon" → Marathon; anything else derives nothing. Priority matters: the
// half check runs first because "Half Marathon" contains "marathon".
func distanceTypeFromName(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "half marathon"), strings.Contains(n, "half-marathon"):
		return racetypes.HalfMarathon
	case strings.Contains(n, "10k"):
		return racetypes.DistanceKm(10)
	case strings.Contains(n, "marathon"):
		return racetypes.Marathon
	default:
		return ""
	}
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
// comparison would miss equal strings, and the whole point is to write only
// real changes.
func sameLabel(current, want *string) bool {
	if current == nil || want == nil {
		return current == nil && want == nil
	}
	return *current == *want
}
