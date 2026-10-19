package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// Deep write-path validation (#589): key_sessions[].workout_structure must pass
// the P1-generated lenient run-workout schema, and phase/milestone/week
// references must resolve. Both apply seams (admin apply + user
// apply-from-content) share validateAppliedMasterPlan.

// lenientStructure is P1-shaped LLM output: no schema discriminator, no note /
// hr_cap_bpm, plus a noise key the lenient layer must tolerate.
var lenientStructure = map[string]any{
	"name": "有氧间歇 3×4km",
	"date": "2026-06-03",
	"blocks": []any{map[string]any{
		"repeat": 3,
		"steps": []any{map[string]any{
			"step_kind": "work",
			"duration":  map[string]any{"kind": "distance_m", "value": 4000},
			"target":    map[string]any{"kind": "pace_s_km", "low": 240, "high": 230},
			"rest":      map[string]any{"kind": "time_s", "value": 180},
		}},
	}},
	"title": "model noise key",
}

// withKeySession injects one key session carrying the given workout_structure
// into week 1 of the sample plan.
func withKeySession(t *testing.T, goalID string, structure any) map[string]any {
	t.Helper()
	content := mustAppliedContent(t, goalID)
	weeks, ok := content["weeks"].([]any)
	if !ok || len(weeks) == 0 {
		t.Fatalf("sample plan has no weeks")
	}
	week, ok := weeks[0].(map[string]any)
	if !ok {
		t.Fatalf("week 0 is not an object")
	}
	week["key_sessions"] = []any{map[string]any{
		"type":              "interval",
		"distance_km":       12.0,
		"duration_min":      nil,
		"intensity":         "3×4km @ 3:50-4:00/km",
		"purpose":           nil,
		"workout_structure": structure,
	}}
	return content
}

var maliciousStructure = map[string]any{
	"name": "x", "date": "2026-06-03",
	"blocks": []any{map[string]any{"repeat": 1, "steps": []any{map[string]any{
		"step_kind": "sprint", "duration": map[string]any{"kind": "time_s", "value": 60},
		"target": map[string]any{"kind": "open", "low": nil, "high": nil},
	}}}},
}

func TestDeepValidateWorkoutStructure(t *testing.T) {
	t.Run("lenient P1 structure is accepted on both apply seams", func(t *testing.T) {
		h := newMPHarness(t)
		admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")
		user := h.bearer(t, uuid.NewString())

		userID := uuid.NewString()
		w := doApply(t, h, admin, userID, applyRequestBody(withKeySession(t, uuid.NewString(), lenientStructure), false, nil, nil))
		if w.Code != http.StatusCreated {
			t.Fatalf("admin apply code = %d, want 201 (%s)", w.Code, w.Body.String())
		}

		body := map[string]any{"content": withKeySession(t, uuid.NewString(), lenientStructure), "apply_token": uuid.NewString()}
		if w := doApplyFromContent(t, h, user, body); w.Code != http.StatusCreated {
			t.Fatalf("apply-from-content code = %d, want 201 (%s)", w.Code, w.Body.String())
		}
	})

	cases := []struct {
		name      string
		structure any
	}{
		{"unknown step_kind", map[string]any{
			"name": "x", "date": "2026-06-03",
			"blocks": []any{map[string]any{"repeat": 1, "steps": []any{map[string]any{
				"step_kind": "sprint", "duration": map[string]any{"kind": "time_s", "value": 60},
				"target": map[string]any{"kind": "open", "low": nil, "high": nil},
			}}}},
		}},
		{"non-positive duration", map[string]any{
			"name": "x", "date": "2026-06-03",
			"blocks": []any{map[string]any{"repeat": 1, "steps": []any{map[string]any{
				"step_kind": "work", "duration": map[string]any{"kind": "time_s", "value": -5},
				"target": map[string]any{"kind": "open", "low": nil, "high": nil},
			}}}},
		}},
		{"target with string bounds", map[string]any{
			"name": "x", "date": "2026-06-03",
			"blocks": []any{map[string]any{"repeat": 1, "steps": []any{map[string]any{
				"step_kind": "work", "duration": map[string]any{"kind": "time_s", "value": 60},
				"target": map[string]any{"kind": "hr_bpm", "low": "140", "high": 150},
			}}}},
		}},
		{"empty blocks", map[string]any{"name": "x", "date": "2026-06-03", "blocks": []any{}}},
		{"workout_structure is a string", "3×4km"},
	}
	for _, tc := range cases {
		t.Run("malicious spec rejected: "+tc.name, func(t *testing.T) {
			h := newMPHarness(t)
			admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")
			user := h.bearer(t, uuid.NewString())

			w := doApply(t, h, admin, uuid.NewString(), applyRequestBody(withKeySession(t, uuid.NewString(), tc.structure), false, nil, nil))
			if w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("admin apply code = %d, want 422 (%s)", w.Code, w.Body.String())
			}
			body := map[string]any{"content": withKeySession(t, uuid.NewString(), tc.structure), "apply_token": uuid.NewString()}
			if w := doApplyFromContent(t, h, user, body); w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("apply-from-content code = %d, want 422 (%s)", w.Code, w.Body.String())
			}
		})
	}

	t.Run("update endpoint rejects a malicious spec too", func(t *testing.T) {
		h := newMPHarness(t)
		admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")
		userID, goalID := uuid.NewString(), uuid.NewString()
		first := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if first.Code != http.StatusCreated {
			t.Fatalf("seed code = %d (%s)", first.Code, first.Body.String())
		}
		var seed applyMasterPlanResponse
		if err := json.Unmarshal(first.Body.Bytes(), &seed); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		current, err := h.store.GetCurrentMasterPlan(t.Context(), userID)
		if err != nil || current == nil {
			t.Fatalf("get current: %+v err=%v", current, err)
		}
		body := map[string]any{
			"content":                  withKeySession(t, goalID, maliciousStructure),
			"expected_active_plan_id":  current.PlanID,
			"expected_active_revision": *current.Revision,
		}
		w := doUpdate(t, h, admin, userID, body)
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("update code = %d, want 422 (%s)", w.Code, w.Body.String())
		}
	})
}

func TestDeepValidateRelationalInvariants(t *testing.T) {
	mutate := func(t *testing.T, fn func(content map[string]any)) map[string]any {
		t.Helper()
		content := mustAppliedContent(t, uuid.NewString())
		fn(content)
		return content
	}

	cases := []struct {
		name string
		fn   func(map[string]any)
	}{
		{"week references unknown phase", func(c map[string]any) {
			weeks := c["weeks"].([]any)
			weeks[0].(map[string]any)["phase_id"] = "ghost-phase"
		}},
		{"milestone references unknown phase", func(c map[string]any) {
			milestones := c["milestones"].([]any)
			milestones[0].(map[string]any)["phase_id"] = "ghost-phase"
		}},
		{"phase references unknown milestone", func(c map[string]any) {
			phases := c["phases"].([]any)
			phases[0].(map[string]any)["milestone_ids"] = []any{"ghost-milestone"}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newMPHarness(t)
			admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")
			w := doApply(t, h, admin, uuid.NewString(), applyRequestBody(mutate(t, tc.fn), false, nil, nil))
			if w.Code != http.StatusUnprocessableEntity {
				t.Fatalf("code = %d, want 422 (%s)", w.Code, w.Body.String())
			}
		})
	}

	t.Run("consistent references are accepted", func(t *testing.T) {
		h := newMPHarness(t)
		admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")
		w := doApply(t, h, admin, uuid.NewString(), applyRequestBody(mustAppliedContent(t, uuid.NewString()), false, nil, nil))
		if w.Code != http.StatusCreated {
			t.Fatalf("code = %d, want 201 (%s)", w.Code, w.Body.String())
		}
	})
}
