package racedetection

import (
	"fmt"
	"time"
)

type Evidence string

const (
	EvidenceRace     Evidence = "支持比赛"
	EvidenceTraining Evidence = "支持训练"
	EvidenceUnknown  Evidence = "信息不足"

	// DefaultRaceScoreThreshold requires at least two independent positive
	// signals: the strongest single dimension (event intent) alone cannot
	// cross it, while HR intensity plus a gun-time-window start can.
	DefaultRaceScoreThreshold = 40
)

// ModelAssessment contains only dimensions that require semantic judgement.
// Route, distance, pauses, travel, and clock time are scored by Go.
type ModelAssessment struct {
	EventIntent         Evidence `json:"赛事或全力自测意图"`
	IntensityContinuity Evidence `json:"强度与跑动连续性"`
}

type ScoreDimension string

const (
	DimensionEventIntent         ScoreDimension = "event_intent"
	DimensionDistancePrior       ScoreDimension = "distance_prior"
	DimensionIntensityContinuity ScoreDimension = "intensity_continuity"
	DimensionHRIntensity         ScoreDimension = "hr_intensity"
	DimensionPausePattern        ScoreDimension = "pause_pattern"
	DimensionRouteShape          ScoreDimension = "route_shape"
	DimensionHabitualStart       ScoreDimension = "habitual_start"
	DimensionTravel              ScoreDimension = "travel"
	DimensionTimeWindow          ScoreDimension = "time_window"
)

type EvidenceSource string

const (
	EvidenceSourceLLM EvidenceSource = "llm"
	EvidenceSourceGo  EvidenceSource = "go"
)

type scoringEvidence struct {
	Model         ModelAssessment
	DistancePrior Evidence
	HRIntensity   Evidence
	PausePattern  Evidence
	RouteShape    Evidence
	HabitualStart Evidence
	Travel        Evidence
	TimeWindow    Evidence
}

type ScoreContribution struct {
	Dimension      ScoreDimension `json:"dimension"`
	Evidence       Evidence       `json:"evidence"`
	RaceWeight     int            `json:"race_weight"`
	TrainingWeight int            `json:"training_weight"`
	Contribution   int            `json:"contribution"`
	Source         EvidenceSource `json:"source"`
}

type ScoreResult struct {
	IsRace     bool                `json:"is_race"`
	Score      int                 `json:"score"`
	Threshold  int                 `json:"threshold"`
	Dimensions []ScoreContribution `json:"dimensions"`
}

var scoringDimensions = []struct {
	dimension      ScoreDimension
	raceWeight     int
	trainingWeight int
	source         EvidenceSource
	value          func(scoringEvidence) Evidence
}{
	{DimensionEventIntent, 35, 30, EvidenceSourceLLM, func(e scoringEvidence) Evidence { return e.Model.EventIntent }},
	{DimensionDistancePrior, 15, 25, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.DistancePrior }},
	{DimensionIntensityContinuity, 20, 20, EvidenceSourceLLM, func(e scoringEvidence) Evidence { return e.Model.IntensityContinuity }},
	{DimensionHRIntensity, 20, 20, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.HRIntensity }},
	{DimensionPausePattern, 20, 20, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.PausePattern }},
	{DimensionRouteShape, 10, 15, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.RouteShape }},
	{DimensionHabitualStart, 0, 20, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.HabitualStart }},
	{DimensionTravel, 10, 15, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.Travel }},
	// A typical Sunday start is only weak positive evidence, while a clearly
	// training-like start window is a stronger negative signal.
	{DimensionTimeWindow, 10, 20, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.TimeWindow }},
}

func ScoreAssessment(evidence scoringEvidence) (ScoreResult, error) {
	result := ScoreResult{Threshold: DefaultRaceScoreThreshold, Dimensions: make([]ScoreContribution, 0, len(scoringDimensions))}
	for _, rule := range scoringDimensions {
		value := rule.value(evidence)
		if !validEvidence(value) {
			return ScoreResult{}, fmt.Errorf("race detection: dimension %s has invalid evidence %q", rule.dimension, value)
		}
		contribution := 0
		if value == EvidenceRace {
			contribution = rule.raceWeight
		} else if value == EvidenceTraining {
			contribution = -rule.trainingWeight
		}
		result.Score += contribution
		result.Dimensions = append(result.Dimensions, ScoreContribution{
			Dimension: rule.dimension, Evidence: value, RaceWeight: rule.raceWeight, TrainingWeight: rule.trainingWeight,
			Contribution: contribution, Source: rule.source,
		})
	}
	result.IsRace = result.Score >= result.Threshold
	return result, nil
}

func validEvidence(value Evidence) bool {
	return value == EvidenceRace || value == EvidenceTraining || value == EvidenceUnknown
}

func buildScoringEvidence(candidate Candidate, model ModelAssessment, route RouteAnalysis) scoringEvidence {
	return scoringEvidence{
		Model: model, DistancePrior: distanceEvidence(candidate), HRIntensity: hrIntensityEvidence(candidate.AvgHR, candidate.MaxHR),
		PausePattern: pauseEvidence(candidate.Pauses),
		RouteShape:   routeEvidence(route.Shape), HabitualStart: habitualStartEvidence(candidate.NearbyLongRunStarts),
		Travel: travelEvidence(candidate.Location), TimeWindow: timeWindowEvidence(candidate.Date),
	}
}

// habitualStartMinOthers fires the training evidence when at least this many
// of the user's OTHER half/full-band activities started within
// habitualStartRadiusM of the candidate's start. Production calibration: a
// weekend-racing athlete's real venue starts peaked at 8 nearby starts, while
// the habitual-route false positives started alongside 15+ of the user's own
// long runs — 9 separates the two with one start of headroom.
const (
	habitualStartRadiusM  = 2_000.0
	habitualStartMinCount = 9
)

// habitualStartEvidence encodes the dominant residual false-positive profile:
// the habitual distance-long run from a fixed start point, whose GPS fix sits
// among many of the athlete's own same-band starts. A race venue is shared
// with few of the athlete's other long runs, so this stays neutral there.
func habitualStartEvidence(nearbyOthers int) Evidence {
	if nearbyOthers >= habitualStartMinCount {
		return EvidenceTraining
	}
	return EvidenceUnknown
}

// NearbyLongRunStartCount counts the user's same-band activity starts within
// the habitual radius of one start point, excluding the given label.
func NearbyLongRunStartCount(start Coordinate, excludeLabel string, starts []LabeledCoordinate) int {
	count := 0
	for _, point := range starts {
		if point.LabelID == excludeLabel {
			continue
		}
		if haversineKM(start, point.Coordinate)*1000 <= habitualStartRadiusM {
			count++
		}
	}
	return count
}

// hrIntensityRaceMinRatio and hrIntensityTrainingMaxRatio bound the
// average-to-max heart-rate ratio evidence. Verified races in production data
// cluster at 0.88–0.97, routine distance-long training runs at ≤0.87.
const (
	hrIntensityRaceMinRatio     = 0.90
	hrIntensityTrainingMaxRatio = 0.86
)

// hrIntensityEvidence judges physiological effort without any model call: an
// athlete racing a half or full marathon holds average HR close to their
// maximum, while habitual distance-long training runs stay well below. Missing
// heart-rate data stays neutral.
func hrIntensityEvidence(avgHR, maxHR *int) Evidence {
	if avgHR == nil || maxHR == nil || *avgHR <= 0 || *maxHR <= 0 {
		return EvidenceUnknown
	}
	ratio := float64(*avgHR) / float64(*maxHR)
	switch {
	case ratio >= hrIntensityRaceMinRatio:
		return EvidenceRace
	case ratio <= hrIntensityTrainingMaxRatio:
		return EvidenceTraining
	default:
		return EvidenceUnknown
	}
}

func distanceEvidence(candidate Candidate) Evidence {
	if candidate.CandidateType == RaceTypeMarathon && candidate.DistanceM >= 42_000 && candidate.DistanceM <= 43_500 {
		return EvidenceRace
	}
	return EvidenceUnknown
}

func pauseEvidence(pauses *PauseContext) Evidence {
	if pauses != nil && (pauses.Count >= 3 || pauses.TotalDurationS >= 120) {
		return EvidenceTraining
	}
	return EvidenceUnknown
}

func routeEvidence(shape RouteShape) Evidence {
	switch shape {
	case RouteShapeSmallRepeatedLoop, RouteShapeOutAndBack:
		return EvidenceTraining
	case RouteShapeLargeLoopOrPointToPoint:
		return EvidenceRace
	default:
		return EvidenceUnknown
	}
}

func travelEvidence(location *LocationContext) Evidence {
	if location != nil && location.CandidateStartDistanceKM != nil && *location.CandidateStartDistanceKM > usualActivityAreaRadiusKM {
		return EvidenceRace
	}
	return EvidenceUnknown
}

func timeWindowEvidence(localStart string) Evidence {
	start, err := time.Parse("2006-01-02 15:04:05", localStart)
	if err != nil {
		return EvidenceUnknown
	}
	minutes := start.Hour()*60 + start.Minute()
	if start.Weekday() == time.Sunday && minutes >= 7*60 && minutes <= 8*60+30 {
		return EvidenceRace
	}
	// Chinese road races gun in the morning — every calendar-verified race in
	// production started 06:00–08:30 local. An afternoon start is
	// training-shaped on ANY weekday: an all-out afternoon effort is at most a
	// personal time trial away from any race scene, and the product counts
	// races, not workouts. Listed afternoon races still confirm through the
	// calendar matcher's own gun-time window, which this never overrides.
	if minutes >= 13*60 {
		return EvidenceTraining
	}
	if start.Weekday() == time.Saturday || (start.Weekday() == time.Sunday && minutes <= 5*60+30) ||
		(start.Weekday() >= time.Monday && start.Weekday() <= time.Friday && minutes >= 17*60) {
		return EvidenceTraining
	}
	return EvidenceUnknown
}
