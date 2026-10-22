package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/storage"
)

// Share-link endpoint tests (devops#701), riding the workout harness so the
// public mount is exercised through the real router. The active-custom filter
// of the store is pinned against real MySQL in internal/storage.

// fakeSharedWorkoutStore mirrors the store's active-custom contract: rows that
// are not source=custom AND status=active resolve as a plain miss (nil, nil),
// exactly like GetCustomWorkout against MySQL.
type fakeSharedWorkoutStore struct {
	fakeWorkoutStore
	rows map[string]*storage.Workout
}

func (f *fakeSharedWorkoutStore) GetCustomWorkout(_ context.Context, userID, workoutID string) (*storage.Workout, error) {
	row := f.rows[workoutID]
	if row == nil || row.UserID != userID ||
		row.Source != storage.WorkoutSourceCustom || row.Status != storage.WorkoutStatusActive {
		return nil, nil
	}
	return row, nil
}

func newSharedWorkoutHarness(t *testing.T) (*mpHarness, *fakeSharedWorkoutStore) {
	t.Helper()
	h, _ := newWorkoutHarness(t)
	store := &fakeSharedWorkoutStore{rows: map[string]*storage.Workout{}}
	h.svc = NewService(Config{Auth: h.svc.auth, WorkoutStore: store})
	return h, store
}

func seedSharedWorkout(store *fakeSharedWorkoutStore, uid, wid string, mutate func(*storage.Workout)) {
	summary := "4×1km 节奏跑，组间 2min 慢跑"
	spec := `{"version":"run-workout/v1","kind":"run","name":"节奏跑"}`
	dose, dist, dur := 88.5, 8000.0, int64(3600)
	tok := "tok-1"
	row := &storage.Workout{
		WorkoutID: wid, UserID: uid, Date: "2026-02-01",
		Source: storage.WorkoutSourceCustom, Status: storage.WorkoutStatusActive,
		Kind: "run", Name: "节奏跑", Summary: &summary, SpecJSON: &spec,
		TotalDistanceM: &dist, TotalDurationS: &dur, EstimatedDose: &dose,
		SaveToken: &tok,
	}
	if mutate != nil {
		mutate(row)
	}
	store.rows[wid] = row
}

func TestSharedWorkout_AnonymousRead(t *testing.T) {
	h, store := newSharedWorkoutHarness(t)
	uid := "11111111-2222-4333-8333-333333333333"
	wid := uuid.NewString()
	seedSharedWorkout(store, uid, wid, nil)

	// Anonymous GET — no token: this is the whole point of the share link.
	w := h.do(http.MethodGet, "/api/workouts/shared/"+uid+"/"+wid, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("anonymous shared get = %d: %s", w.Code, w.Body.String())
	}
	var dto sharedWorkoutDTO
	if err := json.Unmarshal(w.Body.Bytes(), &dto); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if dto.Kind != "run" || dto.Name != "节奏跑" || dto.Date != "2026-02-01" {
		t.Fatalf("fields: %+v", dto)
	}
	if dto.Summary == nil || *dto.Summary != "4×1km 节奏跑，组间 2min 慢跑" {
		t.Fatalf("summary: %+v", dto.Summary)
	}
	if string(dto.Spec) != `{"version":"run-workout/v1","kind":"run","name":"节奏跑"}` {
		t.Fatalf("spec not verbatim: %s", dto.Spec)
	}
	if dto.TotalDistanceM == nil || *dto.TotalDistanceM != 8000 ||
		dto.TotalDurationS == nil || *dto.TotalDurationS != 3600 ||
		dto.EstimatedDose == nil || *dto.EstimatedDose != 88.5 {
		t.Fatalf("totals/dose: %+v", dto)
	}
	// #691 zero identity: the payload must not carry owner-ish fields.
	for _, leak := range []string{uid, "save_token", "tok-1", "user_id", "plan_id", "provider"} {
		if strings.Contains(w.Body.String(), leak) {
			t.Fatalf("response leaks %q: %s", leak, w.Body.String())
		}
	}
}

// Every miss is one uniform 404: the UUID pair is the access boundary, so the
// response must not hint which part failed (devops#701 anti-probe rule).
func TestSharedWorkout_UniformMisses(t *testing.T) {
	h, store := newSharedWorkoutHarness(t)
	uid := "11111111-2222-4333-8333-333333333333"
	other := "44444444-4444-4444-8444-444444444444"
	wid := uuid.NewString()
	seedSharedWorkout(store, uid, wid, nil)
	// Archived and weekly-source rows are seeded directly to pin the filter.
	archivedID, weeklyID := uuid.NewString(), uuid.NewString()
	seedSharedWorkout(store, uid, archivedID, func(r *storage.Workout) { r.Status = storage.WorkoutStatusArchived })
	seedSharedWorkout(store, uid, weeklyID, func(r *storage.Workout) {
		r.Source = storage.WorkoutSourceWeekly
		r.Status = storage.WorkoutStatusActive
	})

	for name, path := range map[string]string{
		"wrong owner":    "/api/workouts/shared/" + other + "/" + wid,
		"dead workout":   "/api/workouts/shared/" + uid + "/" + uuid.NewString(),
		"archived row":   "/api/workouts/shared/" + uid + "/" + archivedID,
		"weekly row":     "/api/workouts/shared/" + uid + "/" + weeklyID,
		"bad user uuid":  "/api/workouts/shared/not-a-uuid/" + wid,
		"bad workout id": "/api/workouts/shared/" + uid + "/nope",
	} {
		if w := h.do(http.MethodGet, path, nil); w.Code != http.StatusNotFound {
			t.Errorf("%s = %d, want uniform 404", name, w.Code)
		}
	}
}

// The per-IP window is the anti-abuse backstop: past the limit the endpoint
// answers 429 even for a valid pair.
func TestSharedWorkout_RateLimitPerIP(t *testing.T) {
	h, store := newSharedWorkoutHarness(t)
	uid := "11111111-2222-4333-8333-333333333333"
	wid := uuid.NewString()
	seedSharedWorkout(store, uid, wid, nil)

	for i := 0; i < sharedWorkoutRateLimit; i++ {
		if w := h.do(http.MethodGet, "/api/workouts/shared/"+uid+"/"+wid, nil); w.Code != http.StatusOK {
			t.Fatalf("request %d = %d, want 200", i+1, w.Code)
		}
	}
	if w := h.do(http.MethodGet, "/api/workouts/shared/"+uid+"/"+wid, nil); w.Code != http.StatusTooManyRequests {
		t.Fatalf("request over limit = %d, want 429", w.Code)
	}
}
