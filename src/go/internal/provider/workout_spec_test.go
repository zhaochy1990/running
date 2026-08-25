// Tests for the normalized workout spec JSON round-trip (from_dict parity with
// Python NormalizedRunWorkout.from_dict / NormalizedStrengthWorkout.from_dict).
package provider

import (
	"strings"
	"testing"
)

func TestRunWorkoutFromJSON(t *testing.T) {
	raw := `{
		"schema": "run-workout/v1",
		"name": "Easy 10K",
		"date": "2026-05-01",
		"blocks": [{
			"repeat": 1,
			"steps": [{
				"step_kind": "work",
				"duration": {"kind": "distance_m", "value": 10000},
				"target": {"kind": "pace_s_km", "low": 340, "high": 320}
			}]
		}]
	}`
	w, err := RunWorkoutFromJSON([]byte(raw))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if w.Name != "Easy 10K" || w.Date != "2026-05-01" || len(w.Blocks) != 1 {
		t.Fatalf("parsed = %+v", w)
	}
	step := w.Blocks[0].Steps[0]
	if step.Duration.Value == nil || *step.Duration.Value != 10000 {
		t.Errorf("duration = %+v", step.Duration)
	}
	if step.Target.Low == nil || *step.Target.Low != 340 || step.Target.High == nil || *step.Target.High != 320 {
		t.Errorf("target = %+v", step.Target)
	}
}

func TestRunWorkoutFromJSONRejectsWrongSchema(t *testing.T) {
	raw := `{"schema":"strength-workout/v1","name":"x","date":"2026-05-01","exercises":[]}`
	_, err := RunWorkoutFromJSON([]byte(raw))
	if err == nil || !strings.Contains(err.Error(), "unexpected run workout schema") {
		t.Fatalf("err = %v, want schema mismatch", err)
	}
}

func TestRunWorkoutFromJSONRejectsMalformed(t *testing.T) {
	raw := `{"schema":"run-workout/v1","name":"x","date":"2026-05-01","blocks":[]}`
	_, err := RunWorkoutFromJSON([]byte(raw))
	if err == nil || !strings.Contains(err.Error(), "at least one block") {
		t.Fatalf("err = %v, want block validation", err)
	}
}

func TestStrengthWorkoutFromJSON(t *testing.T) {
	raw := `{
		"schema": "strength-workout/v1",
		"name": "力量训练",
		"date": "2026-05-04",
		"exercises": [{
			"canonical_id": "squat", "display_name": "深蹲", "sets": 3,
			"target_kind": "reps", "target_value": 12, "rest_seconds": 90,
			"provider_id": "T1262"
		}]
	}`
	w, err := StrengthWorkoutFromJSON([]byte(raw))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if w.Name != "力量训练" || len(w.Exercises) != 1 {
		t.Fatalf("parsed = %+v", w)
	}
	ex := w.Exercises[0]
	if ex.Sets != 3 || ex.TargetValue != 12 || ex.ProviderID == nil || *ex.ProviderID != "T1262" {
		t.Errorf("exercise = %+v", ex)
	}
}
