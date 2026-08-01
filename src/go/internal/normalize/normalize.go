// Package normalize holds the provider-agnostic normalized enums for activity
// and training metadata. Every adapter (coros, garmin, …) translates its
// provider-specific encodings into these values at the boundary; the rest of
// the system speaks only this normalized vocabulary.
//
// Go port of stride_core.normalize. Mapping tables (e.g. COROS sport_type 100 →
// SportRunOutdoor) live in each adapter package, not here, to keep the
// dependency direction adapter → core.
package normalize

// Sport is a normalized activity type. String values are stable wire/storage
// codes.
type Sport string

const (
	SportRunOutdoor   Sport = "run_outdoor"
	SportRunIndoor    Sport = "run_indoor"
	SportRunTrail     Sport = "run_trail"
	SportRunTrack     Sport = "run_track"
	SportRunTreadmill Sport = "run_treadmill"

	SportWalk Sport = "walk"
	SportHike Sport = "hike"

	SportBikeOutdoor Sport = "bike_outdoor"
	SportBikeIndoor  Sport = "bike_indoor"
	SportBikeGravel  Sport = "bike_gravel"
	SportBikeE       Sport = "bike_e"

	SportSwimPool Sport = "swim_pool"
	SportSwimOpen Sport = "swim_open"

	SportTriathlon  Sport = "triathlon"
	SportMultisport Sport = "multisport"

	SportStrength Sport = "strength"
	SportCardio   Sport = "cardio"
	SportGym      Sport = "gym"
	SportHIIT     Sport = "hiit"
	SportJumpRope Sport = "jump_rope"
	SportRowing   Sport = "rowing"

	SportSkiDownhill Sport = "ski_downhill"
	SportSkiXC       Sport = "ski_xc"
	SportSkiTouring  Sport = "ski_touring"
	SportSnowboard   Sport = "snowboard"

	SportFlatwater    Sport = "flatwater"
	SportWhitewater   Sport = "whitewater"
	SportWindsurfing  Sport = "windsurfing"
	SportSpeedsurfing Sport = "speedsurfing"

	SportTennis    Sport = "tennis"
	SportGPSCardio Sport = "gps_cardio"
	SportOther     Sport = "other"

	// SportUnknown — adapter encountered a code it has no mapping for.
	SportUnknown Sport = "unknown"
)

// RunningSports are the sports that count as "running" for ability/training-load
// purposes.
var RunningSports = map[Sport]bool{
	SportRunOutdoor:   true,
	SportRunIndoor:    true,
	SportRunTrail:     true,
	SportRunTrack:     true,
	SportRunTreadmill: true,
}

// TrainKind is the intent of a training session.
type TrainKind string

const (
	TrainBase      TrainKind = "base"
	TrainAerobic   TrainKind = "aerobic"
	TrainThreshold TrainKind = "threshold"
	TrainInterval  TrainKind = "interval"
	TrainVO2Max    TrainKind = "vo2max"
	TrainAnaerobic TrainKind = "anaerobic"
	TrainSprint    TrainKind = "sprint"
	TrainRecovery  TrainKind = "recovery"
	TrainLongRun   TrainKind = "long_run" // inferred, not a COROS native value
	TrainRace      TrainKind = "race"     // inferred
	TrainTempo     TrainKind = "tempo"    // inferred (subset of threshold)
	TrainUnknown   TrainKind = "unknown"
)

// Feel is stored as a unified numeric 0–10 scale (higher = better), not a
// string enum. The conversion from each provider's native encoding lives in the
// adapter: COROS feelType 1–5 → feel = feelType×2 (note: COROS low code = good,
// so the numeric axis is inverted relative to the raw code); Garmin's 0–100
// slider → feel = raw÷10. NULL when unrated. No normalize-level type is needed.
