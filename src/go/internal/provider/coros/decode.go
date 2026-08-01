// Package coros decodes COROS-specific encodings into the normalized domain.
//
// This is the Go port of coros_sync.normalize + the COROS unit conversions in
// stride_core.models. Mapping tables live here (in the adapter), not in
// internal/normalize, to keep the dependency direction adapter → core. The
// provider-specific quirks (e.g. COROS using both 402 and 800 for strength,
// distances in centimetres, GPS as int×1e7) are isolated from the rest of the
// system.
package coros

import "github.com/zhaochy1990/stride/internal/normalize"

// ─────────────────────────────────────────────────────────────────────────────
// Enum decoding
// ─────────────────────────────────────────────────────────────────────────────

// sportByCode maps COROS sport_type → normalized Sport. COROS has historically
// used both 402 and 800 for strength; the forward map is well-defined (only the
// inverse is ambiguous, which we never use).
var sportByCode = map[int]normalize.Sport{
	// Running family
	100: normalize.SportRunOutdoor,
	101: normalize.SportRunIndoor,
	102: normalize.SportRunTrail,
	103: normalize.SportRunTrack,
	104: normalize.SportRunTreadmill,
	// Cycling
	200: normalize.SportBikeOutdoor,
	201: normalize.SportBikeIndoor,
	202: normalize.SportBikeE,
	203: normalize.SportBikeGravel,
	// Swimming
	300: normalize.SportSwimPool,
	301: normalize.SportSwimOpen,
	// Multisport
	400: normalize.SportTriathlon,
	401: normalize.SportMultisport,
	402: normalize.SportStrength,
	// Gym / cardio
	500: normalize.SportCardio,
	501: normalize.SportGym,
	502: normalize.SportHIIT,
	503: normalize.SportJumpRope,
	504: normalize.SportRowing,
	// Walking / hiking
	600: normalize.SportWalk,
	601: normalize.SportHike,
	// Snow
	700: normalize.SportSkiDownhill,
	701: normalize.SportSnowboard,
	702: normalize.SportSkiXC,
	703: normalize.SportSkiTouring,
	// Strength (alternate code)
	800: normalize.SportStrength,
	// Misc
	1005:  normalize.SportTennis,
	10000: normalize.SportGPSCardio,
	10001: normalize.SportFlatwater,
	10002: normalize.SportWhitewater,
	10003: normalize.SportWindsurfing,
	10004: normalize.SportSpeedsurfing,
}

// SportFromCode maps a COROS sport_type to a normalized Sport, falling back to
// SportUnknown for codes we haven't catalogued (sync must never crash on a new
// watch sport type).
func SportFromCode(code int) normalize.Sport {
	if s, ok := sportByCode[code]; ok {
		return s
	}
	return normalize.SportUnknown
}

// trainKindByCode maps COROS trainType (1-8) → normalized TrainKind. Inferred
// kinds (TEMPO, LONG_RUN, RACE) have no COROS code and are never produced here.
var trainKindByCode = map[int]normalize.TrainKind{
	1: normalize.TrainBase,
	2: normalize.TrainAerobic,
	3: normalize.TrainThreshold,
	4: normalize.TrainInterval,
	5: normalize.TrainVO2Max,
	6: normalize.TrainAnaerobic,
	7: normalize.TrainSprint,
	8: normalize.TrainRecovery,
}

// TrainKindFromCode maps a COROS trainType to a normalized TrainKind, falling
// back to TrainUnknown.
func TrainKindFromCode(code int) normalize.TrainKind {
	if k, ok := trainKindByCode[code]; ok {
		return k
	}
	return normalize.TrainUnknown
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit conversions
//
// COROS encodes distances in centimetres, durations in centiseconds, GPS as
// signed int×1e7 degrees, and the vertical stride ratio as pct×10. These
// conversions match stride_core.models exactly so the Go store is byte-for-byte
// comparable with the Python SQLite path (see cmd/reconcile).
// ─────────────────────────────────────────────────────────────────────────────

// DistanceCmToMeters converts a COROS centimetre distance to metres. It matches
// _coros_distance_cm_to_meters: a mandatory field whose missing/zero value is 0.
func DistanceCmToMeters(cm float64) float64 { return cm / 100.0 }

// OptionalDistanceCmToMeters converts an optional COROS centimetre distance to
// metres, preserving "absent" as nil (matches _coros_optional_distance_cm_to_meters).
func OptionalDistanceCmToMeters(cm *float64) *float64 {
	if cm == nil {
		return nil
	}
	m := *cm / 100.0
	return &m
}

// CentisecondsToSeconds converts a COROS centisecond duration to seconds.
// Integer centiseconds divide exactly to 2 decimals, matching round(cs/100, 2).
func CentisecondsToSeconds(cs int64) float64 { return float64(cs) / 100.0 }

// VerticalRatioPct converts COROS verticalStrideRatio (pct×10) to a percentage.
func VerticalRatioPct(raw float64) float64 { return raw / 10.0 }

// GPSCoord converts a COROS int×1e7 coordinate to decimal degrees (WGS84). A raw
// value of 0 means "no fix" and returns ok=false (matches the Python None/0
// guard); callers store the coordinate only when ok.
func GPSCoord(raw int64) (deg float64, ok bool) {
	if raw == 0 {
		return 0, false
	}
	return float64(raw) / 1e7, true
}
