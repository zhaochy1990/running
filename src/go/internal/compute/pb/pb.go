// Package pb is a pure Go port of stride_core.pb_records: it detects achieved-
// time personal bests (1K/3K/5K/10K/HM/FM) from a chronological scan of running
// activities, preferring a continuous timeseries segment and falling back to
// activity-level distance matching (ADR 0015). Infra-free: the caller provides
// activities + a timeseries fetcher.
package pb

import (
	"encoding/json"
	"math"
	"sort"
	"time"
)

const maxPlausibleSpeedMps = 8.0

// canonicalRaceDistances / display superset, mirroring pb_records.
var pbDisplayDistances = map[string]float64{
	"1K": 1000.0, "3K": 3000.0, "5K": 5000.0, "10K": 10000.0, "half": 21097.5, "full": 42195.0,
}

var distanceOrder = []string{"1K", "3K", "5K", "10K", "HM", "FM"}
var displayIndex = func() map[string]int {
	m := map[string]int{}
	for i, d := range distanceOrder {
		m[d] = i
	}
	return m
}()

var displayByRaceType = map[string]string{
	"1K": "1K", "3K": "3K", "5K": "5K", "10K": "10K", "half": "HM", "full": "FM",
}
var raceTypeByDisplay = map[string]string{
	"1K": "1K", "3K": "3K", "5K": "5K", "10K": "10K", "HM": "half", "FM": "full",
}

// activityDistanceToleranceM: [low, high] window per display distance.
var activityDistanceToleranceM = map[string][2]float64{
	"1K":  {950.0, 1050.0},
	"3K":  {2900.0, 3100.0},
	"5K":  {4800.0, 5300.0},
	"10K": {9800.0, 10500.0},
	"HM":  {20800.0, 21800.0},
	"FM":  {41800.0, 43500.0},
}

// TSPoint is one raw timeseries row (centisecond timestamp, metres/cm distance).
type TSPoint struct {
	Timestamp *int64
	Distance  *float64
}

// Activity is the metadata the detector needs; timeseries is fetched lazily.
type Activity struct {
	LabelID   string
	Name      *string
	Date      time.Time // UTC instant
	DistanceM *float64
	DurationS *float64
	Pauses    *string
	SportType int
}

// Entry is the persisted PB entry (matches the Python dict, serialised to
// entry_json). History is best-so-far progression.
type Entry struct {
	Distance      string           `json:"distance"`
	RaceType      string           `json:"race_type"`
	PBTimeSec     float64          `json:"pb_time_sec"`
	AchievedAt    string           `json:"achieved_at"`
	LabelID       string           `json:"label_id"`
	Source        string           `json:"source"`
	Name          *string          `json:"name"`
	History       []map[string]any `json:"history"`
	SegmentStartS *float64         `json:"segment_start_s,omitempty"`
	SegmentEndS   *float64         `json:"segment_end_s,omitempty"`
}

type distanceCandidate struct {
	raceType             string
	distanceM, durationS float64
	startS, endS         float64
}

type bestEffort struct {
	distance, raceType   string
	distanceM, durationS float64
	achievedAt, labelID  string
	source               string
	name                 *string
	segStart, segEnd     *float64
}

// TSFetcher returns an activity's raw timeseries.
type TSFetcher func(labelID string) ([]TSPoint, error)

// DetectPersonalBests scans activities (which MUST be ordered chronologically by
// date, label_id) and returns the best entry per display distance. Mirrors
// pb_records.detect_personal_bests with distances = PB_DISPLAY_DISTANCES.
func DetectPersonalBests(activities []Activity, fetch TSFetcher) (map[string]Entry, error) {
	best := map[string]float64{}
	entries := map[string]Entry{}
	history := map[string][]map[string]any{}

	for _, a := range activities {
		cands, err := bestEffortCandidatesForActivity(a, fetch)
		if err != nil {
			return nil, err
		}
		sort.SliceStable(cands, func(i, j int) bool {
			return displayIndex[cands[i].distance] < displayIndex[cands[j].distance]
		})
		for _, c := range cands {
			if prev, ok := best[c.distance]; ok && c.durationS >= prev {
				continue
			}
			best[c.distance] = c.durationS
			pt := map[string]any{
				"date":            c.achievedAt,
				"best_so_far_sec": c.durationS,
				"label_id":        c.labelID,
				"source":          c.source,
			}
			if c.segStart != nil {
				pt["segment_start_s"] = *c.segStart
			}
			if c.segEnd != nil {
				pt["segment_end_s"] = *c.segEnd
			}
			history[c.distance] = append(history[c.distance], pt)
			entries[c.distance] = Entry{
				Distance:      c.distance,
				RaceType:      c.raceType,
				PBTimeSec:     c.durationS,
				AchievedAt:    c.achievedAt,
				LabelID:       c.labelID,
				Source:        c.source,
				Name:          c.name,
				History:       history[c.distance],
				SegmentStartS: c.segStart,
				SegmentEndS:   c.segEnd,
			}
		}
	}
	return entries, nil
}

// EntryJSON serialises an entry the way Python json.dumps(entry) does.
func EntryJSON(e Entry) string {
	b, _ := json.Marshal(e)
	return string(b)
}

func bestEffortCandidatesForActivity(a Activity, fetch TSFetcher) ([]bestEffort, error) {
	if a.LabelID == "" {
		return nil, nil
	}
	achievedAt := shanghaiDayStr(a.Date)
	var out []bestEffort

	ts, err := fetch(a.LabelID)
	if err != nil {
		return nil, err
	}
	if len(ts) >= 2 {
		norm := normalizeTimeseries(ts, a.DistanceM)
		if len(norm) >= 2 {
			var t0 int64
			if ts[0].Timestamp != nil {
				t0 = *ts[0].Timestamp
			}
			pauses := parsePauses(a.Pauses, t0)
			for raceType, seg := range bestDistanceCandidates(norm, pauses, pbDisplayDistances) {
				st := seg.startS
				en := seg.endS
				out = append(out, bestEffort{
					distance:   displayByRaceType[raceType],
					raceType:   raceType,
					distanceM:  seg.distanceM,
					durationS:  seg.durationS,
					achievedAt: achievedAt,
					labelID:    a.LabelID,
					source:     "segment",
					name:       a.Name,
					segStart:   &st,
					segEnd:     &en,
				})
			}
		}
	}

	// Activity-level fallback (all display distances allowed).
	out = append(out, activityLevelCandidates(a, achievedAt)...)

	// Drop physically-impossible candidates.
	filtered := out[:0]
	for _, c := range out {
		if c.durationS > 0 && c.distanceM/c.durationS <= maxPlausibleSpeedMps {
			filtered = append(filtered, c)
		}
	}

	// Keep fastest per distance, returned in DISTANCE_ORDER.
	bestByDist := map[string]bestEffort{}
	for _, c := range filtered {
		if cur, ok := bestByDist[c.distance]; !ok || c.durationS < cur.durationS {
			bestByDist[c.distance] = c
		}
	}
	var result []bestEffort
	for _, d := range distanceOrder {
		if c, ok := bestByDist[d]; ok {
			result = append(result, c)
		}
	}
	return result, nil
}

func activityLevelCandidates(a Activity, achievedAt string) []bestEffort {
	if a.DurationS == nil || *a.DurationS <= 0 {
		return nil
	}
	distanceM := 0.0
	if a.DistanceM != nil && *a.DistanceM > 0 {
		distanceM = *a.DistanceM
	}
	var out []bestEffort
	for _, display := range distanceOrder {
		win := activityDistanceToleranceM[display]
		if distanceM < win[0] || distanceM > win[1] {
			continue
		}
		raceType := raceTypeByDisplay[display]
		out = append(out, bestEffort{
			distance:   display,
			raceType:   raceType,
			distanceM:  pbDisplayDistances[raceType],
			durationS:  *a.DurationS,
			achievedAt: achievedAt,
			labelID:    a.LabelID,
			source:     "activity",
			name:       a.Name,
		})
	}
	return out
}

// normalizeTimeseries mirrors pb_records.normalize_timeseries_units: (elapsed_s,
// distance_m) tuples from monotonic-distance rows, centisecond timestamps.
func normalizeTimeseries(rows []TSPoint, activityDistanceM *float64) [][2]float64 {
	var filtered [][2]float64
	for _, r := range rows {
		if r.Timestamp != nil && r.Distance != nil {
			filtered = append(filtered, [2]float64{float64(*r.Timestamp), *r.Distance})
		}
	}
	if len(filtered) == 0 {
		return nil
	}
	var monotonic [][2]float64
	last := math.Inf(-1)
	for _, p := range filtered {
		if p[1] < last {
			continue
		}
		monotonic = append(monotonic, p)
		last = p[1]
	}
	if len(monotonic) == 0 {
		return nil
	}
	t0 := monotonic[0][0]
	scale := distanceScaleTS(monotonic, activityDistanceM)
	out := make([][2]float64, len(monotonic))
	for i, p := range monotonic {
		out[i] = [2]float64{(p[0] - t0) / 100.0, p[1] / scale}
	}
	return out
}

func distanceScaleTS(monotonic [][2]float64, activityDistanceM *float64) float64 {
	if len(monotonic) == 0 || activityDistanceM == nil || *activityDistanceM <= 0 {
		return 1.0
	}
	rawSpan := monotonic[len(monotonic)-1][1] - monotonic[0][1]
	if rawSpan <= 0 {
		return 1.0
	}
	if rawSpan/(*activityDistanceM) > 10.0 {
		return 100.0
	}
	return 1.0
}

// parsePauses mirrors pb_records.parse_pauses (activity-relative seconds).
func parsePauses(raw *string, t0 int64) [][2]float64 {
	if raw == nil || *raw == "" {
		return nil
	}
	var data []map[string]any
	if err := json.Unmarshal([]byte(*raw), &data); err != nil {
		return nil
	}
	var out [][2]float64
	for _, entry := range data {
		sv, sok := numeric(entry["start_ts"])
		ev, eok := numeric(entry["end_ts"])
		if !sok || !eok {
			continue
		}
		startS := (sv - float64(t0)) / 100.0
		endS := (ev - float64(t0)) / 100.0
		if endS <= startS {
			continue
		}
		out = append(out, [2]float64{startS, endS})
	}
	return out
}

// bestDistanceCandidates mirrors segments.best_distance_candidates: fastest
// continuous segment of each target distance not overlapping a pause.
func bestDistanceCandidates(ts [][2]float64, pauses [][2]float64, distances map[string]float64) map[string]distanceCandidate {
	out := map[string]distanceCandidate{}
	if len(ts) < 2 {
		return out
	}
	totalDist := ts[len(ts)-1][1] - ts[0][1]
	for raceType, target := range distances {
		if totalDist < target {
			continue
		}
		haveBest := false
		var bestDur, bestStart, bestEnd float64
		j := 0
		for i := 0; i < len(ts); i++ {
			ti, di := ts[i][0], ts[i][1]
			for j < len(ts) && ts[j][1]-di < target {
				j++
			}
			if j == len(ts) {
				break
			}
			aT, aD := ts[j-1][0], ts[j-1][1]
			bT, bD := ts[j][0], ts[j][1]
			var endT float64
			if bD == aD {
				endT = bT
			} else {
				endT = aT + (di+target-aD)/(bD-aD)*(bT-aT)
			}
			if overlapsAnyPause(ti, endT, pauses) {
				continue
			}
			segDur := endT - ti
			if !haveBest || segDur < bestDur {
				haveBest = true
				bestDur, bestStart, bestEnd = segDur, ti, endT
			}
		}
		if haveBest {
			out[raceType] = distanceCandidate{
				raceType:  raceType,
				distanceM: target,
				durationS: bestDur,
				startS:    bestStart,
				endS:      bestEnd,
			}
		}
	}
	return out
}

func overlapsAnyPause(segStart, segEnd float64, pauses [][2]float64) bool {
	for _, p := range pauses {
		if p[1] > segStart && p[0] < segEnd {
			return true
		}
	}
	return false
}

func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int64:
		return float64(n), true
	case int:
		return float64(n), true
	default:
		return 0, false
	}
}

func shanghaiDayStr(utc time.Time) string {
	sh := utc.UTC().Add(8 * time.Hour)
	return time.Date(sh.Year(), sh.Month(), sh.Day(), 0, 0, 0, 0, time.UTC).Format("2006-01-02")
}
