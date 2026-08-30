// Package ability is a pure-math Go port of stride_core.ability: the 4-layer
// custom running-ability score (L1 per-activity quality, L2 daily freshness,
// L3 six-dimension rolling ability, L4 composite + marathon/half estimates).
// It has no DB or provider dependency — the caller loads source data and hands
// it in via a Source.
//
// Port target: src/stride_core/ability.py. Numeric behavior is kept 1:1 so a
// given (activities, health, dashboard, pbs, hr_max, date) yields the same
// snapshot as Python.
package ability

import "github.com/zhaochy1990/stride/internal/normalize"

// runSportIDs mirrors stride_core.models.RUN_SPORT_IDS — the sport_type ints
// counted as "running" for the ability/pb scan.
var runSportIDs = map[int]bool{
	100: true, 101: true, 102: true, 103: true, 104: true,
	600: true, 601: true,
	8001: true, 8002: true, 8003: true, 8004: true, 8005: true,
}

// Activity is one running activity's ability inputs. Optional scalars are
// pointers so "absent" stays distinct from 0, mirroring Python's NULL cells.
type Activity struct {
	LabelID    string
	SportType  int // 0 == unknown
	Date       string
	DistanceM  float64
	DurationS  float64
	AvgPaceSKm *float64 // seconds per km
	AvgHR      *int
	MaxHR      *int
	AvgCadence *int
	TrainKind  normalize.TrainKind // resolved (train_kind or derived from train_type)
	TrainType  *string             // legacy, used to derive TrainKind
	Laps       []Lap
	Samples    []Sample
}

// Lap is one activity lap (split segment).
type Lap struct {
	LapIndex     int
	LapType      string
	ExerciseType *int // 1 warmup, 2 training, 3 cooldown, 4 recovery
	DistanceM    float64
	DurationS    float64
	AvgPace      *float64 // seconds per km
	AvgHR        *int
	MaxHR        *int
	AvgCadence   *int
}

// Sample is one timeseries point.
type Sample struct {
	HeartRate *int
	Speed     *float64 // m/s
	Cadence   *int
}

// HealthRow is one daily_health input.
type HealthRow struct {
	Date    string
	ATI     *float64
	CTI     *float64
	RHR     *int
	Fatigue *float64
}

// Dashboard is the per-user dashboard summary used by the L2 HRV sub-score.
type Dashboard struct {
	AvgSleepHRV   *float64
	HRVNormalLow  *float64
	HRVNormalHigh *float64
}

// Vo2MaxPB is one per-race-type best VDOT PB row (table vo2max_pb), the PB-memory
// channel input.
type Vo2MaxPB struct {
	RaceType  string
	DistanceM float64
	DurationS float64
	Vdot      float64
	PBDate    string
	LabelID   string
	EvenPaced bool
}

// Source is everything compute_ability_snapshot needs, pre-assembled by the
// loader (abilitysource). HRMax is the resolved baseline (never recomputed here).
type Source struct {
	Activities []Activity
	Health28D  []HealthRow
	Dashboard  *Dashboard
	Vo2MaxPBs  []Vo2MaxPB
	HRMax      *int
}

// Snapshot is the full ability snapshot for one date, mirroring the Python dict.
type Snapshot struct {
	ModelVersion          int
	Date                  string
	L1Latest              *L1Result
	L2Freshness           *L2Result
	L3Dimensions          L3Dimensions
	L4Composite           float64
	L4MarathonEstimateS   *int
	DistanceToSub250S     *int
	MarathonEstimates     MarathonEstimates
	HalfMarathonEstimates MarathonEstimates
	EvidenceActivityIDs   []string
	BaselineRHR           *float64
}

// L1Result is L1 quality for one activity.
type L1Result struct {
	Total     float64
	Breakdown L1Breakdown
	Evidence  []string
}

// L1Breakdown holds the L1 sub-scores.
type L1Breakdown struct {
	PaceAdherence    float64
	HRZoneAdherence  float64
	PaceStability    float64
	HRDecoupling     float64
	CadenceStability float64
	HRDecouplingRaw  float64
	TargetHRRange    [2]int
}

// L2Result is L2 freshness.
type L2Result struct {
	Total     float64
	Breakdown L2Breakdown
	TSB       *float64
}

// L2Breakdown holds the L2 sub-scores.
type L2Breakdown struct {
	TSBScore     float64
	RHRScore     float64
	HRVScore     float64
	FatigueScore float64
}

// L3Dimensions is the six L3 dimensions plus carried-through VDOT.
type L3Dimensions struct {
	Aerobic   L3Score
	LT        L3Score
	VO2Max    L3Score
	Endurance L3Score
	Economy   L3Score
	Recovery  L3Score

	VO2MaxUsedVdot float64
}

// L3Score is one dimension's score + evidence + details.
type L3Score struct {
	Score    float64
	Evidence []string
	Details  map[string]any
}

// MarathonEstimates carries the training/race/best_case seconds and boost info.
type MarathonEstimates struct {
	TrainingS            *int
	RaceS                *int
	BestCaseS            *int
	RaceDayBoostMax      float64
	BestCaseBoostMax     float64
	RaceDayBoostApplied  float64
	BestCaseBoostApplied float64
}

// dstToKm mirrors ability._distance_to_km: metres → km, 0 for degenerate input.
func dstToKm(dist, sportType float64) float64 {
	if dist <= 0 {
		return 0
	}
	return dist / 1000.0
}
