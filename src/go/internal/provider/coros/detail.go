// detail.go parses the COROS /activity/detail/query payload into storage rows,
// applying the COROS unit conversions and normalized-enum decoding. Go port of
// stride_core.models.ActivityDetail.from_api (+ the watch-zone capture that the
// Python path deliberately drops — ADR 0007).
package coros

import (
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/zhaochy1990/stride/internal/normalize"
	"github.com/zhaochy1990/stride/internal/storage"
)

// rawDetail mirrors the COROS detail `data` object returned by
// GetActivityDetail (already unwrapped from the envelope).
type rawDetail struct {
	Summary       rawSummary     `json:"summary"`
	Weather       rawWeather     `json:"weather"`
	SportFeelInfo rawSportFeel   `json:"sportFeelInfo"`
	LapList       []rawLapGroup  `json:"lapList"`
	FrequencyList []rawFreq      `json:"frequencyList"`
	PauseList     []rawPause     `json:"pauseList"`
	ZoneList      []rawZoneGroup `json:"zoneList"`
}

type rawSummary struct {
	Name            *string  `json:"name"`
	SportType       int      `json:"sportType"`
	StartTimestamp  int64    `json:"startTimestamp"` // centiseconds epoch
	Distance        *float64 `json:"distance"`       // centimetres
	TotalTime       *int64   `json:"totalTime"`      // centiseconds
	AvgSpeed        *float64 `json:"avgSpeed"`
	AdjustedPace    *float64 `json:"adjustedPace"`
	BestKm          *float64 `json:"bestKm"`
	MaxSpeed        *float64 `json:"maxSpeed"`
	AvgHr           *int     `json:"avgHr"`
	MaxHr           *int     `json:"maxHr"`
	AvgCadence      *int     `json:"avgCadence"`
	MaxCadence      *int     `json:"maxCadence"`
	AvgPower        *int     `json:"avgPower"`
	MaxPower        *int     `json:"maxPower"`
	AvgStepLen      *float64 `json:"avgStepLen"`
	ElevGain        *float64 `json:"elevGain"`
	TotalDescent    *float64 `json:"totalDescent"`
	Calories        *float64 `json:"calories"`
	AerobicEffect   *float64 `json:"aerobicEffect"`
	AnaerobicEffect *float64 `json:"anaerobicEffect"`
	TrainingLoad    *float64 `json:"trainingLoad"`
	CurrentVo2Max   *float64 `json:"currentVo2Max"`
	Performance     *float64 `json:"performance"`
	TrainType       *int     `json:"trainType"`
}

type rawWeather struct {
	Temperature  *float64 `json:"temperature"`  // ×10
	Humidity     *float64 `json:"humidity"`     // ×10
	BodyFeelTemp *float64 `json:"bodyFeelTemp"` // ×10
	WindSpeed    *float64 `json:"windSpeed"`    // ×10
}

type rawSportFeel struct {
	FeelType  *int    `json:"feelType"`
	SportNote *string `json:"sportNote"`
}

type rawLapGroup struct {
	Type        int      `json:"type"`
	LapItemList []rawLap `json:"lapItemList"`
}

type rawLap struct {
	Distance        *float64 `json:"distance"` // centimetres
	Time            *int64   `json:"time"`     // centiseconds
	AvgPace         *float64 `json:"avgPace"`
	AdjustedPace    *float64 `json:"adjustedPace"`
	AvgHr           *int     `json:"avgHr"`
	MaxHr           *int     `json:"maxHr"`
	AvgCadence      *int     `json:"avgCadence"`
	AvgPower        *int     `json:"avgPower"`
	ElevGain        *float64 `json:"elevGain"`
	TotalDescent    *float64 `json:"totalDescent"`
	ExerciseType    *int     `json:"exerciseType"`
	ExerciseNameKey *string  `json:"exerciseNameKey"`
	Mode            *int     `json:"mode"`
}

type rawFreq struct {
	Timestamp           *int64   `json:"timestamp"`
	Distance            *float64 `json:"distance"` // centimetres
	Heart               *int     `json:"heart"`
	Speed               *float64 `json:"speed"`
	AdjustedPace        *float64 `json:"adjustedPace"`
	Cadence             *int     `json:"cadence"`
	Altitude            *float64 `json:"altitude"`
	Power               *int     `json:"power"`
	GroundTime          *float64 `json:"groundTime"`
	VerticalVibration   *float64 `json:"verticalVibration"`
	VerticalStrideRatio *float64 `json:"verticalStrideRatio"` // ×10
	CadenceLength       *float64 `json:"cadenceLength"`
	Slope               *int     `json:"slope"`
	HeartLevel          *int     `json:"heartLevel"`
	GpsLat              *int64   `json:"gpsLat"` // ×1e7
	GpsLon              *int64   `json:"gpsLon"` // ×1e7
}

type rawPause struct {
	StartTimestamp int64 `json:"startTimestamp"`
	EndTimestamp   int64 `json:"endTimestamp"`
	Duration       int64 `json:"duration"`
	Type           int   `json:"type"`
}

// rawZoneGroup / rawZoneItem model the COROS `zoneList` buckets. Field names were
// the churn-prone risk flagged in ADR 0007; they are now CONFIRMED against a live
// /activity/detail/query payload (captured 2026): each group is
// {zoneType, type, zoneItemList:[{leftScope, rightScope, second, percent, zoneIndex}]}.
// ZoneTypeRaw still preserves the raw zoneType int so future encoding drift stays
// observable. Note the inner array is `zoneItemList` (NOT `list`) — the earlier
// assumed name silently yielded zero buckets, leaving activity_watch_zones empty.
type rawZoneGroup struct {
	ZoneType int           `json:"zoneType"`
	List     []rawZoneItem `json:"zoneItemList"`
}

// rawZoneItem is one bucket. For pace groups the scopes are ms/km and leftScope is
// the SLOWER (numerically larger) bound; for HR groups they are bpm. `second` is
// the dwell time in whole seconds.
type rawZoneItem struct {
	LeftScope  *float64 `json:"leftScope"`
	RightScope *float64 `json:"rightScope"`
	Second     *int     `json:"second"`
	Percent    *float64 `json:"percent"`
}

// ParseActivityDetail converts a COROS detail payload into an activity row and
// its children. fallbackDate is used when the summary lacks a startTimestamp
// (the list-scan date), so the NOT NULL date column is always set.
func ParseActivityDetail(userID, labelID string, fallbackDate time.Time, payload json.RawMessage) (
	*storage.Activity, []storage.Lap, []storage.TimeseriesPoint, []storage.ActivityWatchZone, error,
) {
	var d rawDetail
	if err := json.Unmarshal(payload, &d); err != nil {
		return nil, nil, nil, nil, fmt.Errorf("coros: parse detail %s: %w", labelID, err)
	}
	s := d.Summary

	date := fallbackDate
	if s.StartTimestamp != 0 {
		date = centisecondEpochToUTC(s.StartTimestamp)
	}

	a := &storage.Activity{
		UserID:    userID,
		LabelID:   labelID,
		Name:      s.Name,
		SportType: s.SportType,
		Date:      date,
		DistanceM: fptr(round2(DistanceCmToMeters(derefF(s.Distance)))),
		DurationS: fptr(CentisecondsToSeconds(derefI(s.TotalTime))),

		AvgPaceSKm:   s.AvgSpeed,
		AdjustedPace: s.AdjustedPace,
		BestKmPace:   s.BestKm,
		MaxPace:      s.MaxSpeed,
		AvgHR:        s.AvgHr,
		MaxHR:        s.MaxHr,
		AvgCadence:   s.AvgCadence,
		MaxCadence:   s.MaxCadence,
		AvgPower:     s.AvgPower,
		MaxPower:     s.MaxPower,
		AvgStepLenCm: s.AvgStepLen,
		AscentM:      s.ElevGain,
		DescentM:     s.TotalDescent,
		CaloriesKcal: caloriesKcal(s.Calories),

		AerobicEffect:   s.AerobicEffect,
		AnaerobicEffect: s.AnaerobicEffect,
		TrainingLoad:    s.TrainingLoad,
		VO2Max:          s.CurrentVo2Max,
		Performance:     s.Performance,

		Temperature: weatherScaled(d.Weather.Temperature),
		Humidity:    weatherScaled(d.Weather.Humidity),
		FeelsLike:   weatherScaled(d.Weather.BodyFeelTemp),
		WindSpeed:   weatherScaled(d.Weather.WindSpeed),

		FeelType:  d.SportFeelInfo.FeelType,
		SportNote: emptyToNil(d.SportFeelInfo.SportNote),

		Sport:    sptr(string(SportFromCode(s.SportType))),
		Provider: "coros",
		SyncedAt: time.Now().UTC(),
	}
	// train_kind / feel: COROS reports a 0 code for "untagged"/"unrated"; match
	// Python's truthiness and leave them NULL rather than mapping 0 → "unknown".
	if s.TrainType != nil && *s.TrainType != 0 {
		a.TrainKind = sptr(string(coros_TrainKind(*s.TrainType)))
	}
	if d.SportFeelInfo.FeelType != nil && *d.SportFeelInfo.FeelType != 0 {
		// Unified numeric feel: COROS feelType 1–5 → feel = feelType×2 (0–10).
		a.Feel = fptr(float64(*d.SportFeelInfo.FeelType) * 2)
	}
	if pauses := marshalPauses(d.PauseList); pauses != nil {
		a.Pauses = pauses
	}

	laps := parseLaps(d.LapList)
	ts := parseTimeseries(d.FrequencyList)
	zones := parseWatchZones(d.ZoneList)
	return a, laps, ts, zones, nil
}

func parseLaps(groups []rawLapGroup) []storage.Lap {
	var laps []storage.Lap
	for _, g := range groups {
		if g.Type == -1 {
			continue
		}
		lapType := lapTypeName(g.Type)
		for i, l := range g.LapItemList {
			laps = append(laps, storage.Lap{
				LapIndex:        i + 1,
				LapType:         lapType,
				DistanceM:       fptr(round2(DistanceCmToMeters(derefF(l.Distance)))),
				DurationS:       fptr(round2(CentisecondsToSeconds(derefI(l.Time)))),
				AvgPace:         l.AvgPace,
				AdjustedPace:    l.AdjustedPace,
				AvgHR:           l.AvgHr,
				MaxHR:           l.MaxHr,
				AvgCadence:      l.AvgCadence,
				AvgPower:        l.AvgPower,
				AscentM:         l.ElevGain,
				DescentM:        l.TotalDescent,
				ExerciseType:    l.ExerciseType,
				ExerciseNameKey: l.ExerciseNameKey,
				Mode:            l.Mode,
			})
		}
	}
	return laps
}

func parseTimeseries(points []rawFreq) []storage.TimeseriesPoint {
	var ts []storage.TimeseriesPoint
	for _, p := range points {
		pt := storage.TimeseriesPoint{
			Timestamp:             p.Timestamp,
			Distance:              OptionalDistanceCmToMeters(p.Distance),
			HeartRate:             p.Heart,
			Speed:                 p.Speed,
			AdjustedPace:          p.AdjustedPace,
			Cadence:               p.Cadence,
			Altitude:              p.Altitude,
			Power:                 p.Power,
			GroundContactTimeMs:   p.GroundTime,
			VerticalOscillationMm: p.VerticalVibration,
			CadenceLengthCm:       p.CadenceLength,
			Slope:                 p.Slope,
			HeartLevel:            p.HeartLevel,
		}
		if p.VerticalStrideRatio != nil {
			pt.VerticalRatioPct = fptr(VerticalRatioPct(*p.VerticalStrideRatio))
		}
		if p.GpsLat != nil {
			if v, ok := GPSCoord(*p.GpsLat); ok {
				pt.GPSLat = fptr(v)
			}
		}
		if p.GpsLon != nil {
			if v, ok := GPSCoord(*p.GpsLon); ok {
				pt.GPSLon = fptr(v)
			}
		}
		ts = append(ts, pt)
	}
	return ts
}

// parseWatchZones captures the COROS watch-reported zone buckets (ADR 0007). The
// raw zoneType is preserved for churn detection; the decoded label + range unit
// are best-effort from the shapes observed in a live 2026 payload.
//
// COROS can emit two zone groups that decode to the SAME label for one activity.
// Since zone_index restarts per group and the storage unique index
// uq_watch_zones keys on (user_id, label_id, zone_type=label, zone_index), the
// duplicate group's buckets collide with the first group's in a single INSERT
// batch — a hard, deterministic MySQL 1062 that pins the whole watch_sync on
// that activity (delete-then-insert can't help: the collision is intra-batch).
// Two observed sources: (1) pre-2026 activities carry the pace group TWICE under
// zoneType=1 with different inner `type` sub-codes (observed 130 and 173) but
// byte-identical buckets; (2) the churny pace-group zoneType 1→0 migration means
// the raw code alone is not stable, so zoneType 0 and 1 both decode to "pace".
//
// We keep the FIRST group for a given decoded label and skip any later group
// that repeats it. Dedup is at the GROUP level (not per bucket) so a repeat
// group that is longer than the first cannot leak its tail buckets past the
// first group's length. First-wins keeps old and new activities on the same
// pace-zone definition (the canonical type-130 group is listed first and is the
// only one 2026 activities still emit); it is loss-free only because the
// duplicate groups have been observed byte-identical.
func parseWatchZones(groups []rawZoneGroup) []storage.ActivityWatchZone {
	var zones []storage.ActivityWatchZone
	seenLabel := make(map[string]bool)
	for _, g := range groups {
		label := zoneTypeName(g.ZoneType)
		if seenLabel[label] {
			continue // duplicate churny group for an already-emitted label (e.g. pace type 173 after 130)
		}
		seenLabel[label] = true
		unit := zoneRangeUnit(g.ZoneType)
		for i, item := range g.List {
			zones = append(zones, storage.ActivityWatchZone{
				ZoneType:    label,
				ZoneIndex:   i + 1,
				ZoneTypeRaw: g.ZoneType,
				RangeMin:    item.LeftScope,
				RangeMax:    item.RightScope,
				RangeUnit:   unit,
				DurationS:   item.Second,
				Percent:     item.Percent,
			})
		}
	}
	return zones
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

// centisecondEpochToUTC converts a COROS centisecond epoch to a UTC time.
func centisecondEpochToUTC(cs int64) time.Time {
	sec := cs / 100
	nsec := (cs % 100) * 10_000_000
	return time.Unix(sec, nsec).UTC()
}

func lapTypeName(t int) string {
	switch t {
	case 10:
		return "autoKm"
	case 11:
		return "autoMile"
	default:
		return fmt.Sprintf("type%d", t)
	}
}

// zoneTypeName best-effort decodes a COROS zoneType. Codes 0 (pace) and 3
// (heartRate) are confirmed against a live 2026 payload; 1 stays "pace" for the
// legacy encoding (COROS moved the pace group 1→0). Unknown codes keep an explicit
// typeN label so the raw value stays traceable (ADR 0007) — a power group, if the
// watch ever emits one, will surface as typeN rather than a wrong guess.
func zoneTypeName(t int) string {
	switch t {
	case 0, 1:
		return "pace"
	case 3:
		return "heartRate"
	default:
		return fmt.Sprintf("type%d", t)
	}
}

// zoneRangeUnit returns the unit of leftScope/rightScope for a zoneType, from the
// units observed in a live 2026 payload: pace scopes are ms/km, HR scopes are bpm.
// Unknown zoneTypes get no unit (NULL) rather than a guess.
func zoneRangeUnit(t int) *string {
	switch t {
	case 0, 1:
		return sptr("ms/km")
	case 3:
		return sptr("bpm")
	default:
		return nil
	}
}

func marshalPauses(pauses []rawPause) *string {
	if len(pauses) == 0 {
		return nil
	}
	b, err := json.Marshal(pauses)
	if err != nil {
		return nil
	}
	s := string(b)
	return &s
}

func caloriesKcal(cal *float64) *int {
	if cal == nil || *cal == 0 {
		return nil
	}
	v := int(math.Round(*cal / 1000.0))
	return &v
}

func weatherScaled(raw *float64) *float64 {
	if raw == nil || *raw == 0 {
		return nil
	}
	v := round1(*raw / 10.0)
	return &v
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }
func round1(f float64) float64 { return math.Round(f*10) / 10 }

func derefF(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
func derefI(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func fptr(f float64) *float64 { return &f }
func sptr(s string) *string   { return &s }
func emptyToNil(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

// small aliases so the mapping above reads cleanly.
func coros_TrainKind(code int) normalize.TrainKind { return TrainKindFromCode(code) }
