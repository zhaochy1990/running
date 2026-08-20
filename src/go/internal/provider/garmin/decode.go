// decode.go holds Garmin-specific encoding → normalized-domain mappings and unit
// conversions. Go port of garmin_sync.normalize + the unit helpers in
// garmin_sync.models. Mapping tables live here (in the adapter), not in
// internal/normalize, to keep the dependency direction adapter → core.
//
// Unit conventions (Garmin → internal): distance meters→meters, duration
// seconds→seconds, speed m/s→s/km (1000/mps), calories kcal→kcal.
package garmin

import (
	"math"
	"time"

	"github.com/zhaochy1990/stride/internal/normalize"
)

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic sport_type ints for Garmin rows
//
// COROS uses 100..10004; Garmin has no int sport code, so we synthesize one in
// the 8000-range so a row's int unambiguously identifies its provider. Matches
// garmin_sync.models._GARMIN_TYPEKEY_TO_INT.
// ─────────────────────────────────────────────────────────────────────────────

const garminSportTypeBase = 8000

var garminTypeKeyToInt = map[string]int{
	"running":             8001,
	"indoor_running":      8002,
	"treadmill_running":   8003,
	"track_running":       8004,
	"trail_running":       8005,
	"walking":             8010,
	"hiking":              8011,
	"cycling":             8020,
	"indoor_cycling":      8021,
	"gravel_cycling":      8022,
	"mountain_biking":     8023,
	"road_biking":         8024,
	"lap_swimming":        8030,
	"open_water_swimming": 8031,
	"strength_training":   8040,
	"cardio":              8050,
	"elliptical":          8051,
	"stair_climbing":      8052,
	"fitness_equipment":   8053,
	"hiit":                8054,
	"indoor_rowing":       8055,
	"rowing":              8056,
	"yoga":                8060,
	"pilates":             8061,
	"mobility":            8062,
	"multi_sport":         8070,
	"triathlon":           8071,
}

// syntheticSportType maps a Garmin typeKey to a stable int for activities.sport_type.
func syntheticSportType(typeKey string) int {
	if typeKey == "" {
		return garminSportTypeBase
	}
	if v, ok := garminTypeKeyToInt[typeKey]; ok {
		return v
	}
	return garminSportTypeBase
}

// ─────────────────────────────────────────────────────────────────────────────
// typeKey → normalized Sport
// ─────────────────────────────────────────────────────────────────────────────

var sportByTypeKey = map[string]normalize.Sport{
	"running":                    normalize.SportRunOutdoor,
	"indoor_running":             normalize.SportRunIndoor,
	"treadmill_running":          normalize.SportRunTreadmill,
	"track_running":              normalize.SportRunTrack,
	"trail_running":              normalize.SportRunTrail,
	"walking":                    normalize.SportWalk,
	"hiking":                     normalize.SportHike,
	"cycling":                    normalize.SportBikeOutdoor,
	"indoor_cycling":             normalize.SportBikeIndoor,
	"gravel_cycling":             normalize.SportBikeGravel,
	"e_bike_fitness":             normalize.SportBikeE,
	"mountain_biking":            normalize.SportBikeOutdoor,
	"road_biking":                normalize.SportBikeOutdoor,
	"lap_swimming":               normalize.SportSwimPool,
	"open_water_swimming":        normalize.SportSwimOpen,
	"strength_training":          normalize.SportStrength,
	"cardio":                     normalize.SportCardio,
	"elliptical":                 normalize.SportCardio,
	"stair_climbing":             normalize.SportCardio,
	"fitness_equipment":          normalize.SportGym,
	"hiit":                       normalize.SportHIIT,
	"indoor_rowing":              normalize.SportRowing,
	"rowing":                     normalize.SportRowing,
	"yoga":                       normalize.SportStrength,
	"pilates":                    normalize.SportStrength,
	"mobility":                   normalize.SportStrength,
	"multi_sport":                normalize.SportMultisport,
	"triathlon":                  normalize.SportTriathlon,
	"resort_skiing_snowboarding": normalize.SportSkiDownhill,
	"skate_skiing":               normalize.SportSkiXC,
	"cross_country_skiing":       normalize.SportSkiXC,
	"backcountry_skiing":         normalize.SportSkiTouring,
	"tennis":                     normalize.SportTennis,
}

// sportFromTypeKey maps a Garmin typeKey to a normalized Sport (Unknown fallback).
func sportFromTypeKey(typeKey string) normalize.Sport {
	if s, ok := sportByTypeKey[typeKey]; ok {
		return s
	}
	return normalize.SportUnknown
}

// ─────────────────────────────────────────────────────────────────────────────
// trainingEffectLabel → TrainKind
// ─────────────────────────────────────────────────────────────────────────────

var trainKindByLabel = map[string]normalize.TrainKind{
	"RECOVERY":           normalize.TrainRecovery,
	"BASE":               normalize.TrainBase,
	"AEROBIC_BASE":       normalize.TrainBase,
	"TEMPO":              normalize.TrainTempo,
	"THRESHOLD":          normalize.TrainThreshold,
	"VO2MAX":             normalize.TrainVO2Max,
	"ANAEROBIC":          normalize.TrainAnaerobic,
	"ANAEROBIC_CAPACITY": normalize.TrainAnaerobic,
	"SPRINT":             normalize.TrainSprint,
	"LACTATE_THRESHOLD":  normalize.TrainThreshold,
}

// trainKindFromLabel maps a Garmin trainingEffectLabel to a normalized TrainKind.
// An empty or unmapped label yields ("", false) so the caller leaves it NULL.
func trainKindFromLabel(label string) (normalize.TrainKind, bool) {
	if label == "" {
		return "", false
	}
	if k, ok := trainKindByLabel[label]; ok {
		return k, true
	}
	return normalize.TrainUnknown, true
}

// feelFromScore converts Garmin's 0-100 feel slider to the unified numeric
// 0–10 feel scale (feel = raw÷10). Returns nil when no rating (0/absent) —
// leave the column NULL.
func feelFromScore(v *int) *float64 {
	if v == nil || *v <= 0 {
		return nil
	}
	return fptr(float64(*v) / 10.0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit conversions & helpers
// ─────────────────────────────────────────────────────────────────────────────

// msToPaceSKm converts a Garmin m/s speed to seconds-per-km, preserving nil and
// treating non-positive speed as absent (matches _ms_to_pace_s_km).
func msToPaceSKm(mps *float64) *float64 {
	if mps == nil || *mps <= 0 {
		return nil
	}
	p := 1000.0 / *mps
	return &p
}

// gmtToISO converts Garmin's "YYYY-MM-DD HH:MM:SS" GMT string to a UTC time.
func gmtToISO(startTimeGMT string) time.Time {
	if startTimeGMT == "" {
		return time.Time{}
	}
	if t, err := time.Parse("2006-01-02 15:04:05", startTimeGMT); err == nil {
		return t.UTC()
	}
	return time.Time{}
}

// fatigueFromGarmin maps Garmin training-load signals onto the COROS-style
// fatigue scale (ACWR-driven), matching garmin_sync.models._fatigue_from_garmin:
// score = 45 + (ratio-1)*30, clamped to [25,75]. Falls back to ATI/CTI ratio.
func fatigueFromGarmin(ratio, ati, cti *float64) *float64 {
	var eff float64
	switch {
	case ratio != nil:
		eff = *ratio
	case ati != nil && cti != nil && *cti > 0:
		eff = *ati / *cti
	default:
		return nil
	}
	score := 45.0 + (eff-1.0)*30.0
	score = math.Max(25.0, math.Min(75.0, score))
	score = math.Round(score*10) / 10
	return &score
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }

func fptr(f float64) *float64 { return &f }
func sptr(s string) *string   { return &s }

// iround rounds a float pointer to an int pointer (nil-preserving). Matches the
// Python _to_int / _to_positive_int helpers (int(round(x))) — used for the
// timeseries path.
func iround(f *float64) *int {
	if f == nil {
		return nil
	}
	v := int(math.Round(*f))
	return &v
}

// itrunc truncates a float pointer toward zero (nil-preserving). Matches Python's
// bare int(...) coercion used for activity / lap / daily_health / dashboard integer
// columns — reconcile parity depends on truncation, not rounding.
func itrunc(f *float64) *int {
	if f == nil {
		return nil
	}
	v := int(math.Trunc(*f))
	return &v
}

// distanceOrZero rounds a distance to 2 dp, coercing a missing value to 0.0 (never
// nil) — matches Python round(float(x or 0.0), 2) for activity/lap distance.
func distanceOrZero(m *float64) *float64 {
	if m == nil {
		return fptr(0.0)
	}
	return fptr(round2(*m))
}

// durationOrZero coerces a missing duration to 0.0 (never nil) — matches Python
// float(x or 0.0) for activity/lap duration.
func durationOrZero(s *float64) *float64 {
	if s == nil {
		return fptr(0.0)
	}
	return s
}

// truthyDistance rounds a distance, mapping a missing OR zero value to nil —
// matches Python's daily_health truthiness (round(x, 2) if x else None).
func truthyDistance(m *float64) *float64 {
	if m == nil || *m == 0 {
		return nil
	}
	return fptr(round2(*m))
}

// firstTruthyFloat returns the first non-nil, non-zero value (Python `a or b`
// truthiness), else nil.
func firstTruthyFloat(vals ...*float64) *float64 {
	for _, v := range vals {
		if v != nil && *v != 0 {
			return v
		}
	}
	return nil
}
