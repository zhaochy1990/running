// Package racetypes is the shared vocabulary for race types stored in
// race_calendar.race_types (a JSON array of these tokens). Every source
// (World Athletics, 中国田协) maps its upstream markers into this one set, so
// the app can filter across sources without knowing their vocabularies. The
// tokens are English so the storage layer stays locale-free; localization to
// Chinese labels is an app-side concern.
//
// Mapping philosophy: only explicit upstream markers are used — a category
// code, a declared distance, a declared event kind. Race-name pattern matching
// is deliberately excluded (too fragile); anything that cannot be determined
// from an explicit marker is Unknown.
package racetypes

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

const (
	// Marathon is the full marathon distance (42.195 km).
	Marathon = "Marathon"
	// HalfMarathon is the half marathon distance (21.0975 km).
	HalfMarathon = "HalfMarathon"
	// Other is a race with no fixed competitive distance the source declared —
	// fun runs, mini/parent-child/health runs, walks (中国田协's 迷你/欢乐跑/…).
	Other = "Other"
	// Unknown is the fallback when no explicit marker is available. Distinct
	// from Other: Other means "declared to be a non-distance event", Unknown
	// means "the source gave us nothing to go on".
	Unknown = "Unknown"
)

// DistanceKm renders a non-marathon distance as its canonical "{n}Km" token
// (whole numbers collapse: 10 -> "10Km", 5.20 -> "5.2Km").
func DistanceKm(km float64) string {
	if km == math.Trunc(km) {
		return fmt.Sprintf("%dKm", int(km))
	}
	return strconv.FormatFloat(km, 'f', -1, 64) + "Km"
}

// distanceRe extracts "<number><unit>" from a 中国田协 race-item segment. The
// unit tolerates the variants observed upstream (公里 / km / KM / Km) and the
// number tolerates decoration around it ("约5公里", "5公里亲子跑", "欢乐跑（6km）").
var distanceRe = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*(?:公里|[kK][mM])`)

// otherKeywords are the 中国田协 segment markers that declare a no-fixed-distance
// event kind (fun run, parent-child, walk, relay without a distance, …).
var otherKeywords = []string{
	"迷你", "欢乐", "亲子", "健康", "家庭", "情侣", "徒步", "健步",
	"温馨", "公益", "体验", "穿越", "儿童", "接力", "其他", "其它",
}

// FromWACategory maps a World Athletics CalendarEvent.rankingCategory into
// race types. Only GW/GL are trusted: they are curated top-tier categories that
// were full-marathon / half-marathon with zero exceptions across 2023–2026
// (1198 calendar rows). The remaining categories (A–E) are quality tiers that
// mix distances, so they map to Unknown — race-name pattern matching is
// deliberately not used.
func FromWACategory(rankingCategory string) []string {
	switch rankingCategory {
	case "GW":
		return []string{Marathon}
	case "GL":
		return []string{HalfMarathon}
	default:
		return []string{Unknown}
	}
}

// FromChinaItems maps a 中国田协 race's raceItem array (one upstream JSON-decoded
// string per declared event, e.g. ["全程","半程"]) into race types. Segments can
// carry multiple "、" separated items ("全程、半程、其他") and decoration around a
// distance ("迷你马拉松（3公里）"). Tokens are deduplicated in first-seen order.
// An empty or nil items slice yields [Unknown] — the caller is expected to pass
// what the upstream gave; a client-side JSON parse failure also arrives here as
// nil.
func FromChinaItems(items []string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(t string) {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	for _, item := range items {
		for _, seg := range strings.Split(item, "、") {
			if t, ok := mapChinaSegment(seg); ok {
				add(t)
			}
		}
	}
	if len(out) == 0 {
		return []string{Unknown}
	}
	return out
}

// FromChinaSegment maps one raw 中国田协 race-item segment (already split on the
// "、" separator) to its race-type token. Segments that carry no classifiable
// marker degrade to Unknown rather than being dropped, because the item row's
// name is still worth persisting for an administrator to classify.
func FromChinaSegment(seg string) string {
	if t, ok := mapChinaSegment(seg); ok {
		return t
	}
	return Unknown
}

// mapChinaSegment maps one race-item segment to a race type. ok is false for a
// segment that carries no classifiable marker at all (blank or opaque), which
// the caller then omits — if every segment is like that the result is Unknown.
//
// Priority within a segment: 半程/全程 keyword (they can decorate a distance,
// e.g. "半程马拉松（21.0975公里）"), then an explicit distance (which outranks
// the word 马拉松 — "环岛马拉松31公里" is a 31Km race), then the no-distance
// event kinds, then a bare 马拉松 (Chinese usage: a race called "X马拉松" with
// no qualifier is the full marathon), else nothing.
func mapChinaSegment(seg string) (t string, ok bool) {
	s := strings.TrimSpace(seg)
	if s == "" {
		return "", false
	}
	if strings.Contains(s, "半程") {
		return HalfMarathon, true
	}
	if strings.Contains(s, "全程") {
		return Marathon, true
	}
	if strings.Contains(s, "十公里") {
		return DistanceKm(10), true
	}
	if m := distanceRe.FindStringSubmatch(s); m != nil {
		km, err := strconv.ParseFloat(m[1], 64)
		if err == nil {
			switch {
			case km >= 42 && km < 44:
				return Marathon, true
			case km >= 21 && km < 24:
				return HalfMarathon, true
			default:
				return DistanceKm(km), true
			}
		}
	}
	for _, kw := range otherKeywords {
		if strings.Contains(s, kw) {
			return Other, true
		}
	}
	if strings.Contains(s, "马拉松") {
		return Marathon, true
	}
	return "", false
}
