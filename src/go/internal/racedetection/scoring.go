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

	DefaultRaceScoreThreshold = 20
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
	DimensionPausePattern        ScoreDimension = "pause_pattern"
	DimensionRouteShape          ScoreDimension = "route_shape"
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
	PausePattern  Evidence
	RouteShape    Evidence
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
	{DimensionDistancePrior, 25, 25, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.DistancePrior }},
	{DimensionIntensityContinuity, 20, 20, EvidenceSourceLLM, func(e scoringEvidence) Evidence { return e.Model.IntensityContinuity }},
	{DimensionPausePattern, 20, 20, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.PausePattern }},
	{DimensionRouteShape, 20, 15, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.RouteShape }},
	{DimensionTravel, 25, 15, EvidenceSourceGo, func(e scoringEvidence) Evidence { return e.Travel }},
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
		Model: model, DistancePrior: distanceEvidence(candidate), PausePattern: pauseEvidence(candidate.Pauses),
		RouteShape: routeEvidence(route.Shape), Travel: travelEvidence(candidate.Location), TimeWindow: timeWindowEvidence(candidate.Date),
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
	if start.Weekday() == time.Saturday || (start.Weekday() == time.Sunday && minutes <= 5*60+30) ||
		(start.Weekday() >= time.Monday && start.Weekday() <= time.Friday && minutes >= 17*60) {
		return EvidenceTraining
	}
	return EvidenceUnknown
}
