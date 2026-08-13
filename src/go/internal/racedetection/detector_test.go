package racedetection

import (
	"context"
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/activityarea"
)

type fakeClassifier struct {
	assessments map[string]ModelAssessment
	seen        []Candidate
}

func TestLocationContextUsesHistoricalMajorityCluster(t *testing.T) {
	lat, lon := 39.9042, 116.4074
	area := activityarea.Infer([]activityarea.Coordinate{
		{Latitude: 31.2304, Longitude: 121.4737},
		{Latitude: 31.2200, Longitude: 121.4800},
		{Latitude: 31.2400, Longitude: 121.4600},
		{Latitude: 39.9042, Longitude: 116.4074},
	})
	context := LocationContextForTrace(area, []TracePoint{{Latitude: &lat, Longitude: &lon}})
	if context == nil || context.SupportingActivityCount != 3 || context.CandidateStartDistanceKM == nil {
		t.Fatalf("location context = %+v", context)
	}
	if math.Abs(*context.CandidateStartDistanceKM-1067) > 10 {
		t.Fatalf("candidate distance = %.1f km, want about 1067 km", *context.CandidateStartDistanceKM)
	}
}

func TestUsualActivityAreaStaysUnknownWithoutMajority(t *testing.T) {
	if got := activityarea.Infer([]activityarea.Coordinate{
		{Latitude: 31.2304, Longitude: 121.4737},
		{Latitude: 39.9042, Longitude: 116.4074},
		{Latitude: 23.1291, Longitude: 113.2644},
	}); got != nil {
		t.Fatalf("location context = %+v, want unknown", got)
	}
}

func TestLocationContextForTraceReusesInferredArea(t *testing.T) {
	area := activityarea.Infer([]activityarea.Coordinate{
		{Latitude: 31.2304, Longitude: 121.4737},
		{Latitude: 31.2200, Longitude: 121.4800},
		{Latitude: 31.2400, Longitude: 121.4600},
	})
	lat, lon := 39.9042, 116.4074
	got := LocationContextForTrace(area, []TracePoint{{Latitude: &lat, Longitude: &lon}})
	if got == nil || got.CandidateStartDistanceKM == nil || got.SupportingActivityCount != 3 {
		t.Fatalf("location context = %+v", got)
	}
}

func (f *fakeClassifier) Assess(_ context.Context, candidate Candidate) (ModelAssessment, error) {
	f.seen = append(f.seen, candidate)
	return f.assessments[candidate.LabelID], nil
}

func TestCandidateTypeUsesOnlyHalfAndFullMarathonBands(t *testing.T) {
	tests := []struct {
		sport     string
		distanceM float64
		want      RaceType
		ok        bool
	}{
		{"run_outdoor", 20899, "", false},
		{"run_outdoor", 20900, RaceTypeHalfMarathon, true},
		{"run_track", 22000, RaceTypeHalfMarathon, true},
		{"run_outdoor", 22001, "", false},
		{"run_outdoor", 30000, "", false},
		{"run_outdoor", 41899, "", false},
		{"run_track", 41900, RaceTypeMarathon, true},
		{"run_outdoor", 44000, RaceTypeMarathon, true},
		{"run_outdoor", 44001, "", false},
		{"run_indoor", 21100, "", false},
		{"run_trail", 42195, "", false},
		{"run_treadmill", 42195, "", false},
	}

	for _, tt := range tests {
		got, ok := CandidateType(tt.sport, tt.distanceM)
		if got != tt.want || ok != tt.ok {
			t.Errorf("CandidateType(%q, %v) = (%q, %v), want (%q, %v)", tt.sport, tt.distanceM, got, ok, tt.want, tt.ok)
		}
	}
}

func TestDetectorClassifiesOnlyDistanceAndSportCandidates(t *testing.T) {
	classifier := &fakeClassifier{assessments: map[string]ModelAssessment{
		"hm-race": {EventIntent: EvidenceRace, IntensityContinuity: EvidenceRace},
	}}
	detector := New(classifier)
	got, err := detector.Detect(context.Background(), Candidate{
		LabelID: "hm-race", Sport: "run_outdoor", DistanceM: 21100,
	})
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if !got {
		t.Fatal("candidate should be confirmed")
	}
	if len(classifier.seen) != 1 || classifier.seen[0].CandidateType != RaceTypeHalfMarathon {
		t.Fatalf("classifier saw %+v", classifier.seen)
	}
}

func TestDetectorDoesNotClassifyRejectedCandidate(t *testing.T) {
	classifier := &fakeClassifier{assessments: map[string]ModelAssessment{"long-run": {EventIntent: EvidenceRace, IntensityContinuity: EvidenceRace}}}
	detector := New(classifier)
	got, err := detector.Detect(context.Background(), Candidate{
		LabelID: "long-run", Sport: "run_outdoor", DistanceM: 30_000,
	})
	if err != nil || got {
		t.Fatalf("Detect rejected candidate = (%v, %v), want (false, nil)", got, err)
	}
	if len(classifier.seen) != 0 {
		t.Fatalf("classifier called for rejected candidate: %+v", classifier.seen)
	}
}

func TestScoreAssessmentUsesFixedWeightsAndThreshold(t *testing.T) {
	assessment := scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceUnknown, IntensityContinuity: EvidenceRace},
		DistancePrior: EvidenceRace, PausePattern: EvidenceTraining, RouteShape: EvidenceUnknown,
		Travel: EvidenceUnknown, TimeWindow: EvidenceRace,
	}
	result, err := ScoreAssessment(assessment)
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	// +25 distance +20 intensity -20 pauses +10 time = 35. The threshold is inclusive.
	if result.Score != 35 || result.Threshold != DefaultRaceScoreThreshold || !result.IsRace {
		t.Fatalf("score result = %+v", result)
	}
	want := map[ScoreDimension]int{
		DimensionEventIntent: 0, DimensionDistancePrior: 25, DimensionIntensityContinuity: 20,
		DimensionPausePattern: -20, DimensionRouteShape: 0, DimensionTravel: 0, DimensionTimeWindow: 10,
	}
	for _, contribution := range result.Dimensions {
		if contribution.Contribution != want[contribution.Dimension] {
			t.Errorf("dimension %s contribution = %d, want %d", contribution.Dimension, contribution.Contribution, want[contribution.Dimension])
		}
	}
}

func TestScoreAssessmentUsesRequestedRouteAndTravelRaceWeights(t *testing.T) {
	result, err := ScoreAssessment(scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceUnknown, IntensityContinuity: EvidenceUnknown},
		DistancePrior: EvidenceUnknown, PausePattern: EvidenceUnknown, RouteShape: EvidenceRace,
		Travel: EvidenceRace, TimeWindow: EvidenceUnknown,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	if result.Score != 45 || !result.IsRace {
		t.Fatalf("route and travel score = %+v, want 45 and race", result)
	}
	wantRaceWeights := map[ScoreDimension]int{
		DimensionRouteShape: 20,
		DimensionTravel:     25,
	}
	for _, contribution := range result.Dimensions {
		if want, ok := wantRaceWeights[contribution.Dimension]; ok && contribution.RaceWeight != want {
			t.Errorf("dimension %s race weight = %d, want %d", contribution.Dimension, contribution.RaceWeight, want)
		}
	}
}

func TestScoreAssessmentAppliesTrainingTimeAgainstPositiveRoute(t *testing.T) {
	result, err := ScoreAssessment(scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceUnknown, IntensityContinuity: EvidenceRace},
		DistancePrior: EvidenceUnknown, PausePattern: EvidenceUnknown, RouteShape: EvidenceRace,
		Travel: EvidenceUnknown, TimeWindow: EvidenceTraining,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	// Intensity +20 and the requested route weight +20 exactly offset a
	// training-like time window (-20) at the inclusive race threshold.
	if result.Score != 20 || !result.IsRace {
		t.Fatalf("score result = %+v", result)
	}
}

func TestScoreAssessmentPreservesExplicitPersonalTimeTrial(t *testing.T) {
	result, err := ScoreAssessment(scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceRace, IntensityContinuity: EvidenceRace},
		DistancePrior: EvidenceUnknown, PausePattern: EvidenceUnknown, RouteShape: EvidenceTraining,
		Travel: EvidenceUnknown, TimeWindow: EvidenceTraining,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	if result.Score != 20 || !result.IsRace {
		t.Fatalf("explicit personal time trial score = %+v", result)
	}
}

func TestScoreAssessmentRejectsMissingOrUnknownEvidence(t *testing.T) {
	assessment := scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceRace, IntensityContinuity: EvidenceUnknown},
		DistancePrior: EvidenceUnknown, PausePattern: EvidenceUnknown, RouteShape: EvidenceUnknown, Travel: EvidenceUnknown,
		// TimeWindow deliberately omitted.
	}
	if _, err := ScoreAssessment(assessment); err == nil {
		t.Fatal("missing dimension evidence must fail")
	}
	assessment.TimeWindow = Evidence("maybe")
	if _, err := ScoreAssessment(assessment); err == nil {
		t.Fatal("unknown dimension evidence must fail")
	}
}
