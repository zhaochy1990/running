// Translation tests for provider.RunWorkout → Garmin payload — Go port of
// tests/test_workout_translate.py::TestGarminTranslation.
package garmin

import (
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

func garminEasyRun10km() provider.RunWorkout {
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

func garminIntervals6x800() provider.RunWorkout {
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

func garminPayload(t *testing.T, w provider.RunWorkout) map[string]any {
	t.Helper()
	p, err := NormalizedToGarminWorkout(w)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	return p
}

func garminSteps(t *testing.T, payload map[string]any) []map[string]any {
	t.Helper()
	segments := payload["workoutSegments"].([]any)
	seg := segments[0].(map[string]any)
	return seg["workoutSteps"].([]map[string]any)
}

func TestGarminEnvelopeShape(t *testing.T) {
	payload := garminPayload(t, garminEasyRun10km())
	if payload["workoutName"] != "Easy 10K" {
		t.Errorf("workoutName = %v", payload["workoutName"])
	}
	if payload["sportType"].(map[string]any)["sportTypeKey"] != "running" {
		t.Errorf("sportType = %v", payload["sportType"])
	}
	if payload["subSportType"] != "GENERIC" {
		t.Errorf("subSportType = %v", payload["subSportType"])
	}
	if len(garminSteps(t, payload)) != 1 {
		t.Fatalf("steps = %d, want 1", len(garminSteps(t, payload)))
	}
}

func TestGarminEasyRunEmitsSingleExecutableStep(t *testing.T) {
	payload := garminPayload(t, garminEasyRun10km())
	steps := garminSteps(t, payload)
	if len(steps) != 1 {
		t.Fatalf("steps = %d, want 1", len(steps))
	}
	s := steps[0]
	if s["type"] != "ExecutableStepDTO" {
		t.Errorf("type = %v", s["type"])
	}
	if s["stepType"].(map[string]any)["stepTypeKey"] != "interval" {
		t.Errorf("stepType = %v", s["stepType"])
	}
	// 10 km in meters; Garmin stores distance in m.
	if s["endCondition"].(map[string]any)["conditionTypeKey"] != "distance" {
		t.Errorf("endCondition = %v", s["endCondition"])
	}
	if s["endConditionValue"] != 10000.0 {
		t.Errorf("endConditionValue = %v, want 10000.0", s["endConditionValue"])
	}
	// Pace: 5:40 (340 s/km) → 1000/340 ≈ 2.94 m/s (slow, valueOne);
	// 5:20 (320 s/km) → 1000/320 ≈ 3.125 m/s (fast, valueTwo).
	target := s["targetType"].(map[string]any)
	if target["workoutTargetTypeKey"] != "pace.zone" {
		t.Errorf("targetType = %v", target)
	}
	vOne, vTwo := s["targetValueOne"].(float64), s["targetValueTwo"].(float64)
	if vOne < 2.93 || vOne > 2.95 {
		t.Errorf("targetValueOne = %v, want ~2.94 m/s", vOne)
	}
	if vTwo < 3.12 || vTwo > 3.13 {
		t.Errorf("targetValueTwo = %v, want ~3.125 m/s", vTwo)
	}
	if vTwo <= vOne {
		t.Errorf("faster bound must be > slower bound in m/s: %v <= %v", vTwo, vOne)
	}
}

func TestGarminIntervalsEmitRepeatGroup(t *testing.T) {
	payload := garminPayload(t, garminIntervals6x800())
	steps := garminSteps(t, payload)
	if len(steps) != 3 { // warmup, repeat group, cooldown
		t.Fatalf("steps = %d, want 3", len(steps))
	}
	warmup := steps[0]
	if warmup["stepType"].(map[string]any)["stepTypeKey"] != "warmup" {
		t.Errorf("warmup stepType = %v", warmup["stepType"])
	}
	if warmup["endCondition"].(map[string]any)["conditionTypeKey"] != "time" || warmup["endConditionValue"] != 600.0 {
		t.Errorf("warmup endCondition = %v/%v, want time/600.0", warmup["endCondition"], warmup["endConditionValue"])
	}

	group := steps[1]
	if group["type"] != "RepeatGroupDTO" || group["stepType"].(map[string]any)["stepTypeKey"] != "repeat" {
		t.Errorf("group = %v/%v", group["type"], group["stepType"])
	}
	if group["numberOfIterations"] != 6 {
		t.Errorf("numberOfIterations = %v, want 6", group["numberOfIterations"])
	}
	nested := group["workoutSteps"].([]map[string]any)
	if len(nested) != 2 {
		t.Fatalf("nested = %d, want 2", len(nested))
	}
	work := nested[0]
	if work["stepType"].(map[string]any)["stepTypeKey"] != "interval" {
		t.Errorf("work stepType = %v", work["stepType"])
	}
	if work["endCondition"].(map[string]any)["conditionTypeKey"] != "distance" || work["endConditionValue"] != 800.0 {
		t.Errorf("work endCondition = %v/%v, want distance/800.0", work["endCondition"], work["endConditionValue"])
	}
	recovery := nested[1]
	if recovery["stepType"].(map[string]any)["stepTypeKey"] != "recovery" || recovery["endConditionValue"] != 60.0 {
		t.Errorf("recovery = %v/%v", recovery["stepType"], recovery["endConditionValue"])
	}

	cooldown := steps[2]
	if cooldown["stepType"].(map[string]any)["stepTypeKey"] != "cooldown" {
		t.Errorf("cooldown stepType = %v", cooldown["stepType"])
	}
}

func TestGarminOpenDurationUsesLapButton(t *testing.T) {
	w := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Open warmup",
		Date:   "2026-05-05",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{
			{StepKind: provider.StepWarmup, Duration: provider.OpenDuration()},
			{StepKind: provider.StepWork, Duration: provider.DurationOfDistanceKM(5)},
		}}},
	}
	steps := garminSteps(t, garminPayload(t, w))
	s := steps[0]
	if s["endCondition"].(map[string]any)["conditionTypeKey"] != "lap.button" {
		t.Errorf("endCondition = %v, want lap.button", s["endCondition"])
	}
	if s["endConditionValue"] != nil {
		t.Errorf("endConditionValue = %v, want nil", s["endConditionValue"])
	}
}

func TestGarminNoTargetWhenStepHasNoTarget(t *testing.T) {
	w := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Easy",
		Date:   "2026-05-06",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork, Duration: provider.DurationOfDistanceKM(8),
		}}}},
	}
	s := garminSteps(t, garminPayload(t, w))[0]
	if s["targetType"].(map[string]any)["workoutTargetTypeKey"] != "no.target" {
		t.Errorf("targetType = %v", s["targetType"])
	}
	if s["targetValueOne"] != nil || s["targetValueTwo"] != nil {
		t.Errorf("targetValue = %v/%v, want nil", s["targetValueOne"], s["targetValueTwo"])
	}
}

func TestGarminDistanceEstimateAggregatesRepeats(t *testing.T) {
	// 6 repeats × 800m = 4800m total in the interval block (only distance
	// steps count; warmup/cooldown/recovery are time-based).
	payload := garminPayload(t, garminIntervals6x800())
	if payload["estimatedDistanceInMeters"] != 4800 {
		t.Errorf("estimatedDistanceInMeters = %v, want 4800", payload["estimatedDistanceInMeters"])
	}
}

func TestGarminPaceUnitsAreMetersPerSecond(t *testing.T) {
	low, _ := provider.ParsePaceSKM("4:05")
	high, _ := provider.ParsePaceSKM("4:00")
	w := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Tempo",
		Date:   "2026-05-07",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfDistanceKM(8),
			Target:   provider.PaceRangeSKM(float64(low), float64(high)),
		}}}},
	}
	s := garminSteps(t, garminPayload(t, w))[0]
	// 4:05 = 245 s/km → 1000/245 = 4.082 m/s (slower, valueOne);
	// 4:00 = 240 s/km → 1000/240 = 4.167 m/s (faster, valueTwo).
	vOne, vTwo := s["targetValueOne"].(float64), s["targetValueTwo"].(float64)
	if math.Abs(vOne-1000.0/245.0) > 0.01 || math.Abs(vTwo-1000.0/240.0) > 0.01 {
		t.Errorf("pace values = %v/%v, want 1000/245 / 1000/240", vOne, vTwo)
	}
}

func TestGarminHrCapAppendedToStepDescription(t *testing.T) {
	cap := 167
	low, _ := provider.ParsePaceSKM("4:10")
	high, _ := provider.ParsePaceSKM("4:05")
	w := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "[STRIDE] 4x3K",
		Date:   "2026-05-08",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfDistanceKM(3),
			Target:   provider.PaceRangeSKM(float64(low), float64(high)),
			HRCapBPM: &cap,
		}}}},
	}
	s := garminSteps(t, garminPayload(t, w))[0]
	if s["description"] != "HR ≤167" {
		t.Errorf("description = %v, want %q", s["description"], "HR ≤167")
	}
}

func TestGarminHrCapJoinsNote(t *testing.T) {
	note := "配速参考 6:00-6:30/km"
	cap := 160
	w := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "[STRIDE] HR easy",
		Date:   "2026-05-09",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfTimeMin(40),
			Target:   provider.HRRangeBPM(130, 148),
			Note:     &note,
			HRCapBPM: &cap,
		}}}},
	}
	s := garminSteps(t, garminPayload(t, w))[0]
	if want := "配速参考 6:00-6:30/km HR ≤160"; s["description"] != want {
		t.Errorf("description = %v, want %q", s["description"], want)
	}
}

func TestGarminNoteUnchangedWithoutHrCap(t *testing.T) {
	note := "steady effort"
	w := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "[STRIDE] easy",
		Date:   "2026-05-10",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfDistanceKM(8),
			Note:     &note,
		}}}},
	}
	s := garminSteps(t, garminPayload(t, w))[0]
	if s["description"] != "steady effort" {
		t.Errorf("description = %v, want %q", s["description"], "steady effort")
	}
}

func TestGarminHrCapNotDuplicatedWhenNoteStatesIt(t *testing.T) {
	for _, note := range []string{"4x3K，HR≤167", "控制强度，HR < 167", "心率 ≤167，别越线"} {
		cap := 167
		w := provider.RunWorkout{
			Schema: provider.RunWorkoutSchema,
			Name:   "[STRIDE] 4x3K",
			Date:   "2026-05-08",
			Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
				StepKind: provider.StepWork,
				Duration: provider.DurationOfDistanceKM(3),
				Target:   provider.PaceRangeSKM(245, 250),
				Note:     &note,
				HRCapBPM: &cap,
			}}}},
		}
		s := garminSteps(t, garminPayload(t, w))[0]
		if s["description"] != note {
			t.Errorf("note %q: description = %v, want unchanged", note, s["description"])
		}
	}
}

func TestGarminHrCapStillAppendedWhenNoteStatesDifferentValue(t *testing.T) {
	// The structured HRCapBPM is authoritative: a note that mentions a *different*
	// ceiling does not suppress the guardrail.
	note := "HR≤160"
	cap := 167
	w := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "[STRIDE] 4x3K",
		Date:   "2026-05-08",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfDistanceKM(3),
			Target:   provider.PaceRangeSKM(245, 250),
			Note:     &note,
			HRCapBPM: &cap,
		}}}},
	}
	s := garminSteps(t, garminPayload(t, w))[0]
	if want := "HR≤160 HR ≤167"; s["description"] != want {
		t.Errorf("description = %v, want %q", s["description"], want)
	}
}
