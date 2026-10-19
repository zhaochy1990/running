package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/storage"
)

// --- fake workout store -------------------------------------------------------

type fakeWorkoutStore struct {
	sessions    []storage.Workout
	upserts     []storage.UpsertCustomWorkoutInput
	upsertRow   *storage.Workout
	listCustoms []storage.Workout
	archived    bool
}

func (f *fakeWorkoutStore) ListPlanSessions(_ context.Context, _, _, _ string) ([]storage.Workout, error) {
	return f.sessions, nil
}

func (f *fakeWorkoutStore) UpsertCustomWorkout(_ context.Context, _ string, in storage.UpsertCustomWorkoutInput) (*storage.Workout, error) {
	f.upserts = append(f.upserts, in)
	if f.upsertRow != nil {
		return f.upsertRow, nil
	}
	return &storage.Workout{WorkoutID: "w-new", UserID: "u1", Date: in.Date, Source: storage.WorkoutSourceCustom, Kind: in.Kind, Name: in.Name}, nil
}

func (f *fakeWorkoutStore) ListCustomWorkouts(_ context.Context, _, _, _ string) ([]storage.Workout, error) {
	return f.listCustoms, nil
}

func (f *fakeWorkoutStore) ArchiveCustomWorkout(_ context.Context, _, _ string) (bool, error) {
	return f.archived, nil
}

// newWorkoutHarness builds the mp harness's auth stack plus a fake workout
// store; requests go through the real router so route + auth wiring is covered.
func newWorkoutHarness(t *testing.T) (*mpHarness, *fakeWorkoutStore) {
	t.Helper()
	h := newMPHarness(t)
	store := &fakeWorkoutStore{}
	h.svc = NewService(Config{
		Auth:            h.svc.auth,
		MasterPlanStore: h.store,
		WorkoutStore:    store,
	})
	return h, store
}

func TestListPlanSessionsHandler(t *testing.T) {
	h, store := newWorkoutHarness(t)
	user := uuid.NewString()

	t.Run("three sources ordered weekly→custom→watch with dose passthrough", func(t *testing.T) {
		dose := 42.5
		weeklyIdx := 0
		// Fixture order mirrors the store's ORDER BY contract (weekly→custom→watch);
		// the SQL-level ordering itself is covered by the storage tests.
		store.sessions = []storage.Workout{
			{WorkoutID: uuid.NewString(), Date: "2026-01-19", Source: storage.WorkoutSourceWeekly, Kind: "run", Name: "weekly-row", EstimatedDose: &dose, SessionIndex: &weeklyIdx},
			{WorkoutID: uuid.NewString(), Date: "2026-01-19", Source: storage.WorkoutSourceCustom, Kind: "strength", Name: "custom-row"},
			{WorkoutID: uuid.NewString(), Date: "2026-01-19", Source: storage.WorkoutSourceWatch, Kind: "run", Name: "watch-row"},
		}
		w := h.do(http.MethodGet, "/api/users/me/plan/sessions?date_from=2026-01-19&date_to=2026-01-25", h.bearer(t, user))
		if w.Code != http.StatusOK {
			t.Fatalf("code = %d, body %s", w.Code, w.Body.String())
		}
		var resp struct {
			Sessions []planSessionDTO `json:"sessions"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if len(resp.Sessions) != 3 {
			t.Fatalf("sessions = %d, want 3", len(resp.Sessions))
		}
		first := resp.Sessions[0]
		if first.Source != storage.WorkoutSourceWeekly || first.EstimatedDose == nil || *first.EstimatedDose != 42.5 {
			t.Fatalf("first row = %+v, want weekly with dose 42.5", first)
		}
		if resp.Sessions[1].Source != storage.WorkoutSourceCustom || resp.Sessions[2].Source != storage.WorkoutSourceWatch {
			t.Fatalf("order wrong: %s, %s", resp.Sessions[1].Source, resp.Sessions[2].Source)
		}
		if resp.Sessions[2].EstimatedDose != nil {
			t.Fatalf("watch dose must be null, got %v", *resp.Sessions[2].EstimatedDose)
		}
	})

	t.Run("date params required", func(t *testing.T) {
		w := h.do(http.MethodGet, "/api/users/me/plan/sessions", h.bearer(t, user))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400", w.Code)
		}
	})

	t.Run("unauthenticated rejected", func(t *testing.T) {
		w := h.do(http.MethodGet, "/api/users/me/plan/sessions?date_from=2026-01-19&date_to=2026-01-25", nil)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("code = %d, want 401", w.Code)
		}
	})
}

func TestCustomWorkoutHandlers(t *testing.T) {
	h, store := newWorkoutHarness(t)
	user := uuid.NewString()

	validSpec := map[string]any{
		"schema": "run-workout/v1", "name": "自建节奏跑", "date": "2026-01-19", "note": nil,
		"blocks": []any{map[string]any{
			"repeat": 1,
			"steps": []any{map[string]any{
				"step_kind":  "work",
				"duration":   map[string]any{"kind": "time_s", "value": 1200},
				"target":     map[string]any{"kind": "pace_s_km", "low": 300, "high": 330},
				"note":       nil,
				"hr_cap_bpm": nil,
			}},
		}},
	}

	t.Run("upsert custom workout with valid run spec", func(t *testing.T) {
		dose := 12.5
		store.upsertRow = &storage.Workout{WorkoutID: "w-1", UserID: user, Date: "2026-01-19", Source: storage.WorkoutSourceCustom, Kind: "run", Name: "自建节奏跑", EstimatedDose: &dose}
		body := map[string]any{
			"date": "2026-01-19", "kind": "run", "name": "自建节奏跑",
			"spec": validSpec, "save_token": "token-1",
		}
		w := h.doBody(http.MethodPost, "/api/users/me/custom-workouts", h.bearer(t, user), bytes.NewReader(marshalBody(t, body)))
		if w.Code != http.StatusOK {
			t.Fatalf("code = %d, body %s", w.Code, w.Body.String())
		}
		if len(store.upserts) != 1 || store.upserts[0].SaveToken != "token-1" {
			t.Fatalf("store input = %+v", store.upserts)
		}
		var row planSessionDTO
		if err := json.Unmarshal(w.Body.Bytes(), &row); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if row.WorkoutID != "w-1" || row.Source != storage.WorkoutSourceCustom {
			t.Fatalf("row = %+v", row)
		}
	})

	t.Run("spec schema violation rejected", func(t *testing.T) {
		body := map[string]any{
			"date": "2026-01-19", "kind": "run", "name": "坏 spec",
			"spec":       map[string]any{"schema": "run-workout/v1", "name": "缺 blocks"},
			"save_token": "token-2",
		}
		w := h.doBody(http.MethodPost, "/api/users/me/custom-workouts", h.bearer(t, user), bytes.NewReader(marshalBody(t, body)))
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("code = %d, want 422, body %s", w.Code, w.Body.String())
		}
	})

	t.Run("save_token required", func(t *testing.T) {
		body := map[string]any{"date": "2026-01-19", "kind": "run", "name": "无 token"}
		w := h.doBody(http.MethodPost, "/api/users/me/custom-workouts", h.bearer(t, user), bytes.NewReader(marshalBody(t, body)))
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("code = %d, want 422", w.Code)
		}
	})

	t.Run("delete custom workout soft-archives", func(t *testing.T) {
		store.archived = true
		w := h.do(http.MethodDelete, "/api/users/me/custom-workouts/w-1", h.bearer(t, user))
		if w.Code != http.StatusNoContent {
			t.Fatalf("code = %d, want 204", w.Code)
		}
	})

	t.Run("delete unknown id is 404", func(t *testing.T) {
		store.archived = false
		w := h.do(http.MethodDelete, "/api/users/me/custom-workouts/nope", h.bearer(t, user))
		if w.Code != http.StatusNotFound {
			t.Fatalf("code = %d, want 404", w.Code)
		}
	})
}

func marshalBody(t *testing.T, body any) []byte {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return raw
}
