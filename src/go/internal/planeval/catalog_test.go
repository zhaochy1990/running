package planeval

import (
	"encoding/json"
	"strings"
	"testing"
)

func testSnapshot(t *testing.T) map[string]any {
	t.Helper()
	return map[string]any{
		"schema": "plan-eval-runner-snapshot/v1", "snapshot_id": "fixture", "username": "runner", "generation_kind": "new_season", "event": "HM", "target_time": "1:59:59", "as_of_day": "2026-10-23",
		"constraints": map[string]any{"max_run_days_per_week": 3, "no_run_days": []string{"monday"}},
		"provenance":  map[string]any{"source": "test", "exported_at": "2026-10-24T00:00:00Z"},
		"records": map[string]any{
			"profile":     map[string]any{"userId": "runner", "displayName": "runner", "dob": nil, "sex": nil, "heightCm": nil, "weightKg": nil, "runningAgeRange": nil},
			"race_target": map[string]any{"goal_id": "g", "user_id": "runner", "status": "active", "race_date": "2027-03-21", "race_distance": "HM", "race_name": "半马目标赛", "target_finish_time": "1:59:59", "weekly_training_days": 3},
			"injuries":    []any{}, "personal_bests": []any{}, "running_calibration": nil, "race_history": []any{}, "activities": []any{}, "daily_training_load": []any{}, "daily_recovery": []any{}, "active_master_plan": nil, "sync_coverage": nil,
		},
	}
}

func TestGenerationRequestUsesSnapshotAndCorrectClock(t *testing.T) {
	doc := testSnapshot(t)
	doc["as_of"] = "2026-10-23T04:00:00Z"
	request, asOf, e := generationRequest("master_plan", string(mustJSON(doc)), "{}")
	if e != nil {
		t.Fatal(e)
	}
	var fields map[string]any
	_ = json.Unmarshal([]byte(request), &fields)
	goal := fields["goals"].([]any)[0].(map[string]any)
	if asOf != "2026-10-23T04:00:00Z" {
		t.Fatalf("exact clock lost: %s", asOf)
	}
	if goal["distance"] != "HM" || goal["target_time"] != "1:59:59" || fields["requested_as_of"] != asOf || fields["as_of"] != nil {
		t.Fatalf("request: %s", request)
	}
	availability := fields["availability"].(map[string]any)
	if availability["weekly_run_days_max"] != float64(3) {
		t.Fatalf("availability: %v", availability)
	}
	rolling, err := stampRequest(`{"master_plan_id":"plan","requested_as_of":"bad"}`, "exec", asOf, "weekly_plan_batch")
	if err != nil || strings.Contains(rolling, "requested_as_of") || !strings.Contains(rolling, `"as_of"`) {
		t.Fatalf("rolling: %s %v", rolling, err)
	}
}

func TestImportAndPathValidationPreserveMissingVsEmpty(t *testing.T) {
	doc := testSnapshot(t)
	records := doc["records"].(map[string]any)
	delete(records, "activities")
	if e := validateInput(snapshotInputSchema, string(mustJSON(doc))); e == nil || !strings.Contains(e.Detail, "activities") {
		t.Fatalf("missing activities: %v", e)
	}
	records["activities"] = []any{}
	if e := validateInput(snapshotInputSchema, string(mustJSON(doc))); e != nil {
		t.Fatal(e)
	}
	doc["generation_kind"] = "rolling_continue"
	_, _, e := generationRequest("weekly_plan_batch", string(mustJSON(doc)), "{}")
	if e == nil || !strings.Contains(e.Detail, "active_master_plan") {
		t.Fatalf("missing rolling plan: %v", e)
	}
	doc["as_of_day"] = "2026-02-30"
	if e := validateInput(snapshotInputSchema, string(mustJSON(doc))); e == nil {
		t.Fatal("invalid calendar date accepted")
	}
}

func TestGenerationRequestRejectsIncompleteStrengthAvailability(t *testing.T) {
	var preset presetScenarioFile
	_ = json.Unmarshal(presetScenarioDocument, &preset)
	var request map[string]any
	_ = json.Unmarshal(preset.Request, &request)
	request["availability"].(map[string]any)["strength_sessions_per_week"] = 1
	_, _, e := generationRequest("master_plan", string(mustJSON(testSnapshot(t))), string(mustJSON(request)))
	if e == nil || !strings.Contains(e.Detail, "strength_available_days") {
		t.Fatalf("incomplete strength accepted: %v", e)
	}
}
