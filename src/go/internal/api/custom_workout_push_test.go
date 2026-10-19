// Tests for POST /api/users/me/custom-workouts/:workoutId/push — the
// custom-workout watch push (devops#587). Fake workout store + pusher +
// scheduled-workout store; no provider or MySQL involved. Identity, window and
// capability semantics mirror the weekly push; the identity is workout_id.
package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

const customRunSpec = `{"schema":"run-workout/v1","name":"[STRIDE] 4km×3组","date":"2026-08-12","note":null,"blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"distance_m","value":4000},"target":{"kind":"pace_s_km","low":230,"high":240},"note":null,"hr_cap_bpm":null,"rest":{"kind":"time_s","value":180}}]}]}`

func customWorkoutRow(id string, userID string) *storage.Workout {
	spec := customRunSpec
	uid := userID
	return &storage.Workout{
		WorkoutID: id, UserID: uid, Date: "2026-08-12",
		Source: storage.WorkoutSourceCustom, Kind: "run", Name: "[STRIDE] 4km×3组",
		SpecJSON: &spec,
	}
}

// newCustomPushHarness wires a workout store with one custom run owned by
// "u1", a capable pusher and a recording scheduled-workout store.
func newCustomPushHarness(t *testing.T) (*mpHarness, *fakeWorkoutStore, *fakePusher, *fakeScheduledWorkoutStore) {
	t.Helper()
	h, store := newWorkoutHarness(t)
	pusher := &fakePusher{info: provider.ProviderInfo{
		Name: "coros", DisplayName: "高驰",
		Capabilities: provider.Capabilities{
			provider.CapPushRunWorkout: true, provider.CapPushStrengthWorkout: true, provider.CapDeleteWorkout: true,
		},
	}}
	swstore := &fakeScheduledWorkoutStore{}
	h.svc = NewService(Config{
		Auth:                  h.svc.auth,
		MasterPlanStore:       h.store,
		WorkoutStore:          store,
		WorkoutPusher:         pusher,
		ScheduledWorkoutStore: swstore,
	})
	store.customs = map[string]*storage.Workout{"w-custom": customWorkoutRow("w-custom", "u1")}
	return h, store, pusher, swstore
}

func (h *mpHarness) postCustomPush(t *testing.T, sub, workoutID, query string) *httptest.ResponseRecorder {
	t.Helper()
	return h.do("POST", "/api/users/me/custom-workouts/"+workoutID+"/push"+query, h.bearer(t, sub))
}

func TestPushCustomWorkoutHappyPath(t *testing.T) {
	h, _, pusher, swstore := newCustomPushHarness(t)

	resp := h.postCustomPush(t, "u1", "w-custom", "")
	if resp.Code != http.StatusOK {
		t.Fatalf("push: %d %s", resp.Code, resp.Body.String())
	}
	if pusher.runCalls != 1 {
		t.Fatalf("runCalls = %d, want 1", pusher.runCalls)
	}
	if len(swstore.recorded) != 1 {
		t.Fatalf("recorded = %d, want 1", len(swstore.recorded))
	}
	rec := swstore.recorded[0]
	if rec.WorkoutID != "w-custom" {
		t.Fatalf("recorded WorkoutID = %q, want w-custom", rec.WorkoutID)
	}
	if rec.WeekFolder != "" || rec.PlannedDate != "" {
		t.Fatalf("custom row must not carry plan identity: %+v", rec)
	}
	if rec.PushDate != "2026-08-12" {
		t.Fatalf("PushDate = %q", rec.PushDate)
	}
}

func TestPushCustomWorkoutIdempotentReplaySupersedesPrior(t *testing.T) {
	h, _, pusher, swstore := newCustomPushHarness(t)
	pushed := int64(11)
	pushDate := "2026-08-12"
	swstore.prior = &storage.ScheduledWorkout{ID: pushed, Date: pushDate, Status: storage.ScheduledWorkoutStatusPushed}
	swstore.priorWorkoutID = "w-custom"

	resp := h.postCustomPush(t, "u1", "w-custom", "")
	if resp.Code != http.StatusOK {
		t.Fatalf("push: %d %s", resp.Code, resp.Body.String())
	}
	rec := swstore.recorded[0]
	if rec.PriorID == nil || *rec.PriorID != pushed {
		t.Fatalf("PriorID = %v, want %d (supersede prior pushed row)", rec.PriorID, pushed)
	}
	// Prior date == new date → single sweep date.
	if len(pusher.deleteCalls) != 1 {
		t.Fatalf("deleteCalls = %v, want exactly the target date", pusher.deleteCalls)
	}
}

func TestPushCustomWorkoutNotFoundAndWrongOwner(t *testing.T) {
	h, _, _, _ := newCustomPushHarness(t)

	if resp := h.postCustomPush(t, "u1", "w-missing", ""); resp.Code != http.StatusNotFound {
		t.Fatalf("missing workout: %d, want 404", resp.Code)
	}
	// 越权：w-custom 属于 u1，u2 不可见（也拿不到 403 以外的信息）。
	if resp := h.postCustomPush(t, "u2", "w-custom", ""); resp.Code != http.StatusNotFound {
		t.Fatalf("cross-user push: %d, want 404", resp.Code)
	}
}

func TestPushCustomWorkoutTargetDateWindow(t *testing.T) {
	h, _, _, _ := newCustomPushHarness(t)

	// ±7 天内合法。
	if resp := h.postCustomPush(t, "u1", "w-custom", "?target_date=2026-08-19"); resp.Code != http.StatusOK {
		t.Fatalf("within-window move: %d %s", resp.Code, resp.Body.String())
	}
	// 超窗 8 天 → 400。
	if resp := h.postCustomPush(t, "u1", "w-custom", "?target_date=2026-08-20"); resp.Code != http.StatusBadRequest {
		t.Fatalf("out-of-window move: %d, want 400", resp.Code)
	}
	// 非 ISO → 400。
	if resp := h.postCustomPush(t, "u1", "w-custom", "?target_date=08/20/2026"); resp.Code != http.StatusBadRequest {
		t.Fatalf("bad target_date: %d, want 400", resp.Code)
	}
}

func TestPushCustomWorkoutProviderCapabilityGate(t *testing.T) {
	h, _, pusher, _ := newCustomPushHarness(t)
	pusher.info = provider.ProviderInfo{Name: "garmin", DisplayName: "Garmin", Capabilities: provider.Capabilities{}}

	resp := h.postCustomPush(t, "u1", "w-custom", "")
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("capability gate: %d, want 400", resp.Code)
	}
	want := `does not support pushing run workouts`
	if !strings.Contains(resp.Body.String(), want) {
		t.Fatalf("body %q, want substring %q", resp.Body.String(), want)
	}
}

func TestPushCustomWorkoutNoSpecRejected(t *testing.T) {
	h, store, _, _ := newCustomPushHarness(t)
	noSpec := customWorkoutRow("w-nospec", "u1")
	noSpec.SpecJSON = nil
	store.customs["w-nospec"] = noSpec

	if resp := h.postCustomPush(t, "u1", "w-nospec", ""); resp.Code != http.StatusBadRequest {
		t.Fatalf("no-spec push: %d, want 400", resp.Code)
	}
}

func TestPushCustomWorkoutStrengthKindRoutesToStrengthPusher(t *testing.T) {
	h, store, pusher, _ := newCustomPushHarness(t)
	strengthSpec := `{"schema":"strength-workout/v1","name":"[STRIDE] 力量","date":"2026-08-12","note":null,"exercises":[{"canonical_id":"T01","display_name":"深蹲","sets":3,"target_kind":"reps","target_value":10,"rest_seconds":90,"note":null,"provider_id":"T01"}]}`
	row := customWorkoutRow("w-strength", "u1")
	row.Kind = "strength"
	row.SpecJSON = &strengthSpec
	store.customs["w-strength"] = row

	resp := h.postCustomPush(t, "u1", "w-strength", "")
	if resp.Code != http.StatusOK {
		t.Fatalf("strength push: %d %s", resp.Code, resp.Body.String())
	}
	if pusher.strCalls != 1 {
		t.Fatalf("strCalls = %d, want 1", pusher.strCalls)
	}
}
