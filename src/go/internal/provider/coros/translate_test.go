// Translation tests for provider.RunWorkout → COROS builder — Go port of
// tests/test_workout_translate.py::TestCorosTranslation plus the note-based
// pace fallback and the wire payload shape.
package coros

import (
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: representative workouts users actually push
// ─────────────────────────────────────────────────────────────────────────────

func easyRun10km() provider.RunWorkout {
	// Linear easy run with one block, one work step.
	low, _ := provider.ParsePaceSKM("5:40")
	high, _ := provider.ParsePaceSKM("5:20")
	return provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Easy 10K",
		Date:   "2026-05-01",
		Blocks: []provider.WorkoutBlock{{
			Repeat: 1,
			Steps: []provider.WorkoutStep{{
				StepKind: provider.StepWork,
				Duration: provider.DurationOfDistanceKM(10),
				Target:   provider.PaceRangeSKM(float64(low), float64(high)),
			}},
		}},
	}
}

func intervals6x800() provider.RunWorkout {
	// Warmup → 6x(800m work + 60s recovery) → cooldown.
	low, _ := provider.ParsePaceSKM("3:35")
	high, _ := provider.ParsePaceSKM("3:25")
	return provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "6x800m @ 3:30",
		Date:   "2026-05-02",
		Blocks: []provider.WorkoutBlock{
			{Repeat: 1, Steps: []provider.WorkoutStep{{
				StepKind: provider.StepWarmup, Duration: provider.DurationOfTimeMin(10),
			}}},
			{Repeat: 6, Steps: []provider.WorkoutStep{
				{
					StepKind: provider.StepWork,
					Duration: provider.DurationOfDistanceM(800),
					Target:   provider.PaceRangeSKM(float64(low), float64(high)),
				},
				{StepKind: provider.StepRecovery, Duration: provider.DurationOfTimeS(60)},
			}},
			{Repeat: 1, Steps: []provider.WorkoutStep{{
				StepKind: provider.StepCooldown, Duration: provider.DurationOfTimeMin(5),
			}}},
		},
	}
}

func longRun25km() provider.RunWorkout {
	low, _ := provider.ParsePaceSKM("5:30")
	high, _ := provider.ParsePaceSKM("5:10")
	return provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Long Run 25K",
		Date:   "2026-05-04",
		Blocks: []provider.WorkoutBlock{{
			Repeat: 1,
			Steps: []provider.WorkoutStep{{
				StepKind: provider.StepWork,
				Duration: provider.DurationOfDistanceKM(25),
				Target:   provider.PaceRangeSKM(float64(low), float64(high)),
			}},
		}},
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// COROS translation
// ─────────────────────────────────────────────────────────────────────────────

func TestTranslateEasyRunYieldsOneTrainingSegment(t *testing.T) {
	b, err := NormalizedToCorosRun(easyRun10km())
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if b.name != "Easy 10K" {
		t.Errorf("name = %q, want Easy 10K", b.name)
	}
	if b.date != "20260501" { // ISO → COROS YYYYMMDD
		t.Errorf("date = %q, want 20260501", b.date)
	}
	if b.workoutType != "easy" {
		t.Errorf("workout_type = %q, want easy", b.workoutType)
	}
	if len(b.segments) != 1 {
		t.Fatalf("segments = %d, want 1", len(b.segments))
	}
	seg := b.segments[0]
	if seg.segmentType != "training" {
		t.Errorf("segment_type = %q, want training", seg.segmentType)
	}
	if seg.distanceKm == nil || *seg.distanceKm != 10.0 {
		t.Errorf("distance_km = %v, want 10.0", seg.distanceKm)
	}
	if seg.paceLow == nil || *seg.paceLow != "5:40" {
		t.Errorf("pace_low = %v, want 5:40", seg.paceLow)
	}
	if seg.paceHigh == nil || *seg.paceHigh != "5:20" {
		t.Errorf("pace_high = %v, want 5:20", seg.paceHigh)
	}
}

func TestTranslateIntervalsCollapsedToIntervalSegment(t *testing.T) {
	b, err := NormalizedToCorosRun(intervals6x800())
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	var types []string
	for _, s := range b.segments {
		types = append(types, s.segmentType)
	}
	// Expect: warmup, interval (sets=6), cooldown.
	if len(types) != 3 || types[0] != "warmup" || types[1] != "interval" || types[2] != "cooldown" {
		t.Fatalf("segment types = %v, want [warmup interval cooldown]", types)
	}
	interval := b.segments[1]
	if interval.sets != 6 {
		t.Errorf("sets = %d, want 6", interval.sets)
	}
	if interval.distanceKm == nil || *interval.distanceKm != 0.8 {
		t.Errorf("distance_km = %v, want 0.8", interval.distanceKm)
	}
	if interval.paceLow == nil || *interval.paceLow != "3:35" {
		t.Errorf("pace_low = %v, want 3:35", interval.paceLow)
	}
	if interval.paceHigh == nil || *interval.paceHigh != "3:25" {
		t.Errorf("pace_high = %v, want 3:25", interval.paceHigh)
	}
	if interval.recoveryDurationS != 60 {
		t.Errorf("recovery_duration_s = %d, want 60", interval.recoveryDurationS)
	}
	if b.workoutType != "interval" {
		t.Errorf("workout_type = %q, want interval", b.workoutType)
	}
}

func TestTranslateLongRunWorkoutTypeInferred(t *testing.T) {
	b, err := NormalizedToCorosRun(longRun25km())
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if b.workoutType != "long" {
		t.Errorf("workout_type = %q, want long", b.workoutType)
	}
}

func TestTranslatePaceFormatRoundTrip(t *testing.T) {
	// Confirm the s/km int → "M:SS" string conversion holds for a tempo run.
	low, _ := provider.ParsePaceSKM("4:08")
	high, _ := provider.ParsePaceSKM("4:05")
	wo := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Tempo 8K",
		Date:   "2026-05-03",
		Blocks: []provider.WorkoutBlock{{
			Repeat: 1,
			Steps: []provider.WorkoutStep{{
				StepKind: provider.StepWork,
				Duration: provider.DurationOfDistanceKM(8),
				Target:   provider.PaceRangeSKM(float64(low), float64(high)),
			}},
		}},
	}
	b, err := NormalizedToCorosRun(wo)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	seg := b.segments[0]
	if seg.paceLow == nil || *seg.paceLow != "4:08" {
		t.Errorf("pace_low = %v, want 4:08", seg.paceLow)
	}
	if seg.paceHigh == nil || *seg.paceHigh != "4:05" {
		t.Errorf("pace_high = %v, want 4:05", seg.paceHigh)
	}
	// workout_type heuristic: faster bound 245 s/km <= 270 → tempo.
	if b.workoutType != "tempo" {
		t.Errorf("workout_type = %q, want tempo", b.workoutType)
	}
}

func TestTranslateExtractsPaceFromNote(t *testing.T) {
	note := "HR 130-148, 配速参考 6:00-6:30/km"
	step := provider.WorkoutStep{
		StepKind: provider.StepWork,
		Duration: provider.DurationOfTimeMin(40),
		Target:   provider.HRRangeBPM(130, 148),
		Note:     &note,
	}
	b, err := NormalizedToCorosRun(provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "HR easy",
		Date:   "2026-05-05",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{step}}},
	})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	seg := b.segments[0]
	// Range regex picks 6:00-6:30 → slow 6:30 / fast 6:00 (normalized order).
	if seg.paceLow == nil || *seg.paceLow != "6:30" {
		t.Errorf("pace_low = %v, want 6:30 (slower bound)", seg.paceLow)
	}
	if seg.paceHigh == nil || *seg.paceHigh != "6:00" {
		t.Errorf("pace_high = %v, want 6:00 (faster bound)", seg.paceHigh)
	}
}

func TestTranslateNoPaceTargetYieldsOpenSegment(t *testing.T) {
	b, err := NormalizedToCorosRun(provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "No pace",
		Date:   "2026-05-06",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork, Duration: provider.DurationOfTimeMin(30),
		}}}},
	})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	seg := b.segments[0]
	if seg.paceLow != nil || seg.paceHigh != nil {
		t.Errorf("pace bounds = %v/%v, want nil (no pace on watch)", seg.paceLow, seg.paceHigh)
	}
}

func TestTranslateRepeatBlockNonStandardFlattens(t *testing.T) {
	// work + recovery + cooldown under one repeat>1 block is not a clean
	// (work, recovery) pair → flatten each repeat as separate segments.
	wo := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "odd block",
		Date:   "2026-05-07",
		Blocks: []provider.WorkoutBlock{{
			Repeat: 2,
			Steps: []provider.WorkoutStep{
				{StepKind: provider.StepWork, Duration: provider.DurationOfTimeMin(5)},
				{StepKind: provider.StepRecovery, Duration: provider.DurationOfTimeS(60)},
				{StepKind: provider.StepCooldown, Duration: provider.DurationOfTimeMin(3)},
			},
		}},
	}
	b, err := NormalizedToCorosRun(wo)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if len(b.segments) != 6 { // 2 repeats × 3 steps
		t.Fatalf("segments = %d, want 6 (flattened)", len(b.segments))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire payload shape (one representative per workout family)
// ─────────────────────────────────────────────────────────────────────────────

func TestEasyRunPayloadShape(t *testing.T) {
	b, err := NormalizedToCorosRun(easyRun10km())
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	payload := b.BuildPayload(7)
	programs := payload["programs"].([]any)
	entities := payload["entities"].([]any)
	versionObjects := payload["versionObjects"].([]any)
	if len(programs) != 1 || len(entities) != 1 || len(versionObjects) != 1 {
		t.Fatalf("payload lengths = %d/%d/%d, want 1/1/1", len(programs), len(entities), len(versionObjects))
	}
	program := programs[0].(map[string]any)
	entity := entities[0].(map[string]any)
	if program["name"] != "Easy 10K" {
		t.Errorf("program name = %v", program["name"])
	}
	if program["sportType"] != 1 {
		t.Errorf("sportType = %v, want 1 (running)", program["sportType"])
	}
	if program["idInPlan"] != 7 {
		t.Errorf("idInPlan = %v, want 7", program["idInPlan"])
	}
	if entity["happenDay"] != "20260501" {
		t.Errorf("happenDay = %v, want 20260501", entity["happenDay"])
	}
	if _, ok := entity["exerciseBarChart"]; !ok {
		t.Errorf("entity missing exerciseBarChart")
	}
	exercises := program["exercises"].([]map[string]any)
	if len(exercises) != 1 {
		t.Fatalf("exercises = %d, want 1", len(exercises))
	}
	ex := exercises[0]
	if ex["targetType"] != 5 || ex["targetValue"] != 1_000_000 { // 10 km in COROS units
		t.Errorf("target = %v/%v, want 5/1000000", ex["targetType"], ex["targetValue"])
	}
	// COROS renders intensityValue first → must be the FASTER bound (5:20).
	if ex["intensityValue"] != 320000 || ex["intensityValueExtend"] != 340000 {
		t.Errorf("pace bounds = %v/%v, want 320000/340000 (fast/slow)", ex["intensityValue"], ex["intensityValueExtend"])
	}
	if ex["intensityType"] != 3 {
		t.Errorf("intensityType = %v, want 3 (pace)", ex["intensityType"])
	}
}

func TestIntervalPayloadGroupShape(t *testing.T) {
	b, err := NormalizedToCorosRun(intervals6x800())
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	payload := b.BuildPayload(3)
	program := payload["programs"].([]any)[0].(map[string]any)
	exercises := program["exercises"].([]map[string]any)
	// warmup, group, training, recovery, cooldown
	if len(exercises) != 5 {
		t.Fatalf("exercises = %d, want 5", len(exercises))
	}
	group := exercises[1]
	if group["isGroup"] != true || group["exerciseType"] != 0 {
		t.Errorf("group = %v/%v, want isGroup=true exerciseType=0", group["isGroup"], group["exerciseType"])
	}
	if group["sets"] != 6 {
		t.Errorf("group sets = %v, want 6", group["sets"])
	}
	training := exercises[2]
	if training["exerciseType"] != 2 || training["groupId"] != group["id"] {
		t.Errorf("training = %v/%v, want exerciseType=2 groupId=%v", training["exerciseType"], training["groupId"], group["id"])
	}
	if training["targetType"] != 5 || training["targetValue"] != 80000 { // 800 m
		t.Errorf("training target = %v/%v, want 5/80000", training["targetType"], training["targetValue"])
	}
	recoveryEx := exercises[3]
	if recoveryEx["exerciseType"] != 4 || recoveryEx["targetValue"] != 60 {
		t.Errorf("recovery = %v/%v, want exerciseType=4 targetValue=60", recoveryEx["exerciseType"], recoveryEx["targetValue"])
	}
	// Python sums sets over ALL exercises: warmup 1 + group 6 + training 1 +
	// recovery 1 + cooldown 1.
	if program["totalSets"] != 10 {
		t.Errorf("totalSets = %v, want 10", program["totalSets"])
	}
}
