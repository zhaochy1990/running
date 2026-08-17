package api

import (
	"encoding/json"
	"strings"
	"testing"
)

func validNestedAppliedWeeklyPlan(t *testing.T) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(validAppliedWeeklyPlan("2026-08-17_08-23")), &document); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	document["sessions"] = []any{
		map[string]any{
			"schema": "plan-session/v1", "date": "2026-08-17", "session_index": float64(0),
			"kind": "run", "summary": "Easy run", "notes_md": nil,
			"total_distance_m": float64(8000), "total_duration_s": nil,
			"spec": map[string]any{
				"schema": "run-workout/v1", "name": "Easy run", "date": "2026-08-17", "note": nil,
				"blocks": []any{map[string]any{
					"repeat": float64(1),
					"steps": []any{map[string]any{
						"step_kind": "work",
						"duration":  map[string]any{"kind": "distance_m", "value": float64(8000)},
						"target":    map[string]any{"kind": "pace_s_km", "low": float64(330), "high": float64(360)},
						"note":      nil, "hr_cap_bpm": float64(150),
					}},
				}},
			},
		},
		map[string]any{
			"schema": "plan-session/v1", "date": "2026-08-18", "session_index": float64(0),
			"kind": "strength", "summary": "Strength", "notes_md": nil,
			"total_distance_m": nil, "total_duration_s": float64(1800),
			"spec": map[string]any{
				"schema": "strength-workout/v1", "name": "Strength", "date": "2026-08-18", "note": nil,
				"exercises": []any{map[string]any{
					"canonical_id": "T1262", "display_name": "Split squat",
					"sets": float64(3), "target_kind": "reps", "target_value": float64(8),
					"rest_seconds": float64(60), "note": nil, "provider_id": "T1262",
				}},
			},
		},
		map[string]any{
			"schema": "plan-session/v1", "date": "2026-08-19", "session_index": float64(0),
			"kind": "rest", "summary": "Rest", "spec": nil, "notes_md": nil,
			"total_distance_m": nil, "total_duration_s": nil,
		},
	}
	nutrition := document["nutrition"].([]any)
	nutrition[0].(map[string]any)["meals"] = []any{map[string]any{
		"name": "Breakfast", "time_hint": "08:00", "kcal": float64(600),
		"carbs_g": float64(80), "protein_g": float64(30), "fat_g": nil, "items_md": nil,
	}}
	return document
}

func cloneAppliedWeeklyPlan(t *testing.T, document map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	var clone map[string]any
	if err := json.Unmarshal(raw, &clone); err != nil {
		t.Fatalf("clone fixture: %v", err)
	}
	return clone
}

func TestValidateAppliedWeeklyPlanAcceptsCanonicalNestedContent(t *testing.T) {
	document := validNestedAppliedWeeklyPlan(t)
	content, err := validateAppliedWeeklyPlan(document, "2026-08-17_08-23")
	if err != nil {
		t.Fatalf("validate canonical plan: %v", err)
	}
	if string(content) == "" || strings.Contains(string(content), `"schema"`) ||
		strings.Contains(string(content), `"week_name"`) || strings.Contains(string(content), `"scheduled_workout_id"`) {
		t.Fatalf("stored content contains authoring metadata: %s", content)
	}
}

func TestValidateAppliedWeeklyPlanRejectsMalformedNestedContent(t *testing.T) {
	base := validNestedAppliedWeeklyPlan(t)
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "run date mismatch", mutate: func(document map[string]any) {
			document["sessions"].([]any)[0].(map[string]any)["spec"].(map[string]any)["date"] = "2026-08-18"
		}},
		{name: "rest with spec", mutate: func(document map[string]any) {
			document["sessions"].([]any)[2].(map[string]any)["spec"] = map[string]any{}
		}},
		{name: "extra exercise field", mutate: func(document map[string]any) {
			exercise := document["sessions"].([]any)[1].(map[string]any)["spec"].(map[string]any)["exercises"].([]any)[0].(map[string]any)
			exercise["reps"] = float64(8)
		}},
		{name: "invalid provider id", mutate: func(document map[string]any) {
			exercise := document["sessions"].([]any)[1].(map[string]any)["spec"].(map[string]any)["exercises"].([]any)[0].(map[string]any)
			exercise["provider_id"] = "squat"
		}},
		{name: "malformed meal", mutate: func(document map[string]any) {
			meal := document["nutrition"].([]any)[0].(map[string]any)["meals"].([]any)[0].(map[string]any)
			delete(meal, "protein_g")
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := cloneAppliedWeeklyPlan(t, base)
			test.mutate(document)
			if _, err := validateAppliedWeeklyPlan(document, "2026-08-17_08-23"); err == nil {
				t.Fatal("expected malformed content to fail validation")
			}
		})
	}
}
