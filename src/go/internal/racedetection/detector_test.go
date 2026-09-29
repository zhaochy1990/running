package racedetection

import (
	"context"
	"math"
	"strings"
	"testing"
)

type fakeClassifier struct {
	assessments map[string]ModelAssessment
	seen        []Candidate
}

func TestLocationContextUsesHistoricalMajorityCluster(t *testing.T) {
	lat, lon := 39.9042, 116.4074
	area := InferUsualActivityArea([]Coordinate{
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
	if got := InferUsualActivityArea([]Coordinate{
		{Latitude: 31.2304, Longitude: 121.4737},
		{Latitude: 39.9042, Longitude: 116.4074},
		{Latitude: 23.1291, Longitude: 113.2644},
	}); got != nil {
		t.Fatalf("location context = %+v, want unknown", got)
	}
}

func TestLocationContextForTraceReusesInferredArea(t *testing.T) {
	area := InferUsualActivityArea([]Coordinate{
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
		DistancePrior: EvidenceRace, HRIntensity: EvidenceRace, PausePattern: EvidenceTraining, RouteShape: EvidenceUnknown,
		HabitualStart: EvidenceUnknown, Travel: EvidenceUnknown, TimeWindow: EvidenceRace,
	}
	result, err := ScoreAssessment(assessment)
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	// +15 distance +20 intensity +20 hr -20 pauses +10 time = 45. The threshold is inclusive.
	if result.Score != 45 || result.Threshold != DefaultRaceScoreThreshold || !result.IsRace {
		t.Fatalf("score result = %+v", result)
	}
	want := map[ScoreDimension]int{
		DimensionEventIntent: 0, DimensionDistancePrior: 15, DimensionIntensityContinuity: 20,
		DimensionHRIntensity: 20, DimensionPausePattern: -20, DimensionRouteShape: 0, DimensionHabitualStart: 0, DimensionTravel: 0, DimensionTimeWindow: 10,
	}
	for _, contribution := range result.Dimensions {
		if contribution.Contribution != want[contribution.Dimension] {
			t.Errorf("dimension %s contribution = %d, want %d", contribution.Dimension, contribution.Contribution, want[contribution.Dimension])
		}
	}
}

func TestScoreAssessmentKeepsWeakGoPositivesBelowThreshold(t *testing.T) {
	result, err := ScoreAssessment(scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceUnknown, IntensityContinuity: EvidenceUnknown},
		DistancePrior: EvidenceUnknown, HRIntensity: EvidenceUnknown, PausePattern: EvidenceUnknown, RouteShape: EvidenceRace,
		HabitualStart: EvidenceUnknown, Travel: EvidenceRace, TimeWindow: EvidenceUnknown,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	// A big-city loop plus an out-of-town start are routine long-run signals;
	// together they must no longer confirm a race on their own.
	if result.Score != 20 || result.IsRace {
		t.Fatalf("route and travel score = %+v, want 20 and not race", result)
	}
	wantRaceWeights := map[ScoreDimension]int{
		DimensionRouteShape: 10,
		DimensionTravel:     10,
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
		DistancePrior: EvidenceUnknown, HRIntensity: EvidenceUnknown, PausePattern: EvidenceUnknown, RouteShape: EvidenceRace,
		HabitualStart: EvidenceUnknown, Travel: EvidenceUnknown, TimeWindow: EvidenceTraining,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	// Intensity +20 plus the weakened route weight +10 no longer offsets a
	// training-like time window (-20) enough to reach the threshold.
	if result.Score != 10 || result.IsRace {
		t.Fatalf("score result = %+v, want 10 and not race", result)
	}
}

func TestScoreAssessmentPreservesExplicitPersonalTimeTrial(t *testing.T) {
	// A named all-out time trial needs physiological corroboration under the
	// higher threshold: HR intensity evidence (+20) exactly offsets the
	// training-shaped route (-15) and time window (-20) on top of the model's
	// intent (+35) and intensity (+20) evidence.
	result, err := ScoreAssessment(scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceRace, IntensityContinuity: EvidenceRace},
		DistancePrior: EvidenceUnknown, HRIntensity: EvidenceRace, PausePattern: EvidenceUnknown, RouteShape: EvidenceTraining,
		HabitualStart: EvidenceUnknown, Travel: EvidenceUnknown, TimeWindow: EvidenceTraining,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	if result.Score != 40 || !result.IsRace {
		t.Fatalf("explicit personal time trial score = %+v, want 40 and race", result)
	}
	// Without any HR evidence the same profile stays below the threshold:
	// production false positives were exactly model-only confirmations.
	result, err = ScoreAssessment(scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceRace, IntensityContinuity: EvidenceRace},
		DistancePrior: EvidenceUnknown, HRIntensity: EvidenceUnknown, PausePattern: EvidenceUnknown, RouteShape: EvidenceTraining,
		HabitualStart: EvidenceUnknown, Travel: EvidenceUnknown, TimeWindow: EvidenceTraining,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	if result.Score != 20 || result.IsRace {
		t.Fatalf("unevidenced personal time trial score = %+v, want 20 and not race", result)
	}
}

func TestHRIntensityEvidenceBoundaries(t *testing.T) {
	cases := []struct {
		name         string
		avgHR, maxHR *int
		want         Evidence
	}{
		{"race ratio inclusive", intPtr(171), intPtr(190), EvidenceRace},
		{"training ratio inclusive", intPtr(129), intPtr(150), EvidenceTraining},
		{"borderline stays neutral high", intPtr(132), intPtr(150), EvidenceUnknown},
		{"borderline stays neutral low", intPtr(130), intPtr(150), EvidenceUnknown},
		{"missing avg", nil, intPtr(190), EvidenceUnknown},
		{"missing max", intPtr(171), nil, EvidenceUnknown},
		{"zero max", intPtr(171), intPtr(0), EvidenceUnknown},
	}
	for _, tc := range cases {
		if got := hrIntensityEvidence(tc.avgHR, tc.maxHR); got != tc.want {
			t.Errorf("%s: hrIntensityEvidence(%v, %v) = %q, want %q", tc.name, tc.avgHR, tc.maxHR, got, tc.want)
		}
	}
}

func intPtr(v int) *int { return &v }

func TestScoreAssessmentRejectsMissingOrUnknownEvidence(t *testing.T) {
	assessment := scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceRace, IntensityContinuity: EvidenceUnknown},
		DistancePrior: EvidenceUnknown, HRIntensity: EvidenceUnknown, PausePattern: EvidenceUnknown, RouteShape: EvidenceUnknown, Travel: EvidenceUnknown,
		HabitualStart: EvidenceUnknown,
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

func TestHabitualStartEvidenceBoundaries(t *testing.T) {
	if got := habitualStartEvidence(8); got != EvidenceUnknown {
		t.Errorf("8 nearby starts = %q, want unknown (venue-level, calibrated to production)", got)
	}
	if got := habitualStartEvidence(9); got != EvidenceTraining {
		t.Errorf("9 nearby starts = %q, want training", got)
	}
	if got := habitualStartEvidence(30); got != EvidenceTraining {
		t.Errorf("30 nearby starts = %q, want training", got)
	}
	if got := habitualStartEvidence(0); got != EvidenceUnknown {
		t.Errorf("0 nearby starts = %q, want unknown", got)
	}
}

func TestHabitualStartOffsetsModelOnlyConfirmation(t *testing.T) {
	// The residual production false positive: race-level HR ratio, gun-window
	// start, city-loop route and a model that (without baseline context) read
	// a moderate pace as race-like summed to exactly the threshold. The
	// baseline context is what must flip the model's intensity verdict; the
	// habitual-start counter adds margin. When the model STILL says race with
	// baseline context present, confirmation stands (boundary case), but the
	// Go-only profile below no longer clears the bar.
	result, err := ScoreAssessment(scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceUnknown, IntensityContinuity: EvidenceRace},
		DistancePrior: EvidenceUnknown, HRIntensity: EvidenceRace, PausePattern: EvidenceUnknown, RouteShape: EvidenceRace,
		HabitualStart: EvidenceTraining, Travel: EvidenceUnknown, TimeWindow: EvidenceRace,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	if result.Score != 40 || !result.IsRace {
		t.Fatalf("model-corroborated profile with habitual offset = %+v, want 40 and race", result)
	}
	result, err = ScoreAssessment(scoringEvidence{
		Model:         ModelAssessment{EventIntent: EvidenceUnknown, IntensityContinuity: EvidenceUnknown},
		DistancePrior: EvidenceUnknown, HRIntensity: EvidenceRace, PausePattern: EvidenceUnknown, RouteShape: EvidenceRace,
		HabitualStart: EvidenceTraining, Travel: EvidenceUnknown, TimeWindow: EvidenceRace,
	})
	if err != nil {
		t.Fatalf("ScoreAssessment: %v", err)
	}
	if result.Score != 20 || result.IsRace {
		t.Fatalf("go-only profile with habitual offset = %+v, want 20 and not race", result)
	}
}

func TestNearbyLongRunStartCountExcludesSelfAndHonorsRadius(t *testing.T) {
	home := Coordinate{Latitude: 31.127, Longitude: 121.055}
	within := Coordinate{Latitude: 31.1275, Longitude: 121.0555} // ~70m away
	far := Coordinate{Latitude: 31.30, Longitude: 121.30}        // ~30km away
	starts := []LabeledCoordinate{
		{LabelID: "self", Coordinate: home},
		{LabelID: "a", Coordinate: within},
		{LabelID: "b", Coordinate: within},
		{LabelID: "c", Coordinate: far},
	}
	if got := NearbyLongRunStartCount(home, "self", starts); got != 2 {
		t.Fatalf("nearby count = %d, want 2 (self excluded, far ignored)", got)
	}
	if got := NearbyLongRunStartCount(home, "a", starts); got != 2 {
		t.Fatalf("nearby count excluding a = %d, want 2 (self now counted as other)", got)
	}
}

func TestLocalizedCandidateJSONCarriesBaseline(t *testing.T) {
	median, best := 294.0, 246.0 // 4:54 / 4:06 per km
	body, err := localizedCandidateJSON(Candidate{
		Name: "上海市 跑步", Sport: "run_outdoor", Date: "2025-01-05 15:00:00",
		DistanceM: 21_130, AvgPaceSKm: floatPtrDet(306), AvgHR: intPtrDet(148), MaxHR: intPtrDet(163),
		CandidateType: RaceTypeHalfMarathon,
		UserBaseline:  &PaceBaselineContext{SampleCount: 63, MedianPaceSKm: median, BestPaceSKm: best},
	})
	if err != nil {
		t.Fatalf("localizedCandidateJSON: %v", err)
	}
	decoded := string(body)
	for _, fragment := range []string{"用户长距离跑基线", `"样本数":63`, `"中位配速_秒每公里":294`, `"最快配速_秒每公里":246`} {
		if !strings.Contains(decoded, fragment) {
			t.Fatalf("candidate JSON missing %s: %s", fragment, decoded)
		}
	}
	// Without a baseline the key is omitted entirely.
	absent, _ := localizedCandidateJSON(Candidate{Name: "x", Sport: "run_outdoor", Date: "2025-01-05 15:00:00", DistanceM: 21_000, CandidateType: RaceTypeHalfMarathon})
	if strings.Contains(string(absent), "用户长距离跑基线") {
		t.Fatalf("baseline key must be omitted without context: %s", absent)
	}
}

func containsFragment(body, fragment string) bool {
	return len(fragment) > 0 && indexOf(body, fragment) >= 0
}

func indexOf(body, fragment string) int {
	for i := 0; i+len(fragment) <= len(body); i++ {
		if body[i:i+len(fragment)] == fragment {
			return i
		}
	}
	return -1
}

func floatPtrDet(v float64) *float64 { return &v }
func intPtrDet(v int) *int           { return &v }

func TestTimeWindowEvidenceRejectsAfternoonStarts(t *testing.T) {
	cases := []struct {
		start string
		want  Evidence
	}{
		{"2025-11-16 07:05:00", EvidenceRace},    // Sunday gun window
		{"2025-11-16 08:31:00", EvidenceUnknown}, // just past the gun window, still morning
		{"2025-11-15 13:00:00", EvidenceTraining},
		{"2024-12-11 16:00:00", EvidenceTraining}, // weekday afternoon
		{"2023-10-08 17:00:00", EvidenceTraining}, // Sunday afternoon
		{"2020-11-14 20:00:00", EvidenceTraining}, // evening
		{"2025-11-16 12:59:00", EvidenceUnknown},  // boundary stays neutral
	}
	for _, tc := range cases {
		if got := timeWindowEvidence(tc.start); got != tc.want {
			t.Errorf("timeWindowEvidence(%s) = %q, want %q", tc.start, got, tc.want)
		}
	}
}

func TestDetectGatesAfternoonConfirmation(t *testing.T) {
	// Race-like everything — intent, intensity, HR ratio, route — but a 17:00
	// local start. This is the exact production profile (evening Chengdu and
	// Chongqing efforts at HR ratio 0.92–0.94) that re-confirmed after
	// deletion: evidence-weighted rejection was not enough.
	classifier := &fakeClassifier{assessments: map[string]ModelAssessment{
		"evidence": {EventIntent: EvidenceRace, IntensityContinuity: EvidenceRace},
	}}
	afternoon := Candidate{
		LabelID: "evidence", Name: "成都市 跑步", Sport: "run_outdoor",
		Date: "2025-09-07 17:00:00", DistanceM: 21_700,
		AvgHR: intPtr(161), MaxHR: intPtr(171),
	}
	result, err := New(classifier).DetectWithUsage(context.Background(), afternoon)
	if err != nil {
		t.Fatalf("DetectWithUsage: %v", err)
	}
	if result.Score < DefaultRaceScoreThreshold {
		t.Fatalf("score = %d, want the ungated score above threshold to prove the gate (not the score) rejected it", result.Score)
	}
	if result.IsRace {
		t.Fatal("afternoon start must not be confirmable by scoring even with race-like evidence")
	}

	morning := afternoon
	morning.Date = "2025-09-07 08:00:00"
	result, err = New(classifier).DetectWithUsage(context.Background(), morning)
	if err != nil {
		t.Fatalf("DetectWithUsage: %v", err)
	}
	if !result.IsRace {
		t.Fatalf("morning start with the same evidence must confirm, score = %d", result.Score)
	}
}
