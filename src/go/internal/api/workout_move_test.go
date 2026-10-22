// Tests for POST /api/users/me/custom-workouts/:workoutId/move — the custom
// workout date move (devops#696). Reuses the custom-push fake harness (fake
// workout store + pusher + scheduled-workout store); no provider or MySQL
// involved. Discipline under test: DB-first date change, best-effort watch
// re-publish (sweep + push + supersede) that never fails the move.
package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

func (h *mpHarness) postCustomMove(t *testing.T, sub, workoutID, body string) *httptest.ResponseRecorder {
	t.Helper()
	return h.doBody("POST", "/api/users/me/custom-workouts/"+workoutID+"/move",
		h.bearer(t, sub), strings.NewReader(body))
}

// decodeMoveBody parses a move response into the DTO plus watch_synced.
func decodeMoveBody(t *testing.T, resp *httptest.ResponseRecorder) moveCustomWorkoutResponse {
	t.Helper()
	var got moveCustomWorkoutResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode move body %q: %v", resp.Body.String(), err)
	}
	return got
}

// pushedPriorFor wires the fake scheduled-workout store with one pushed row
// (id 11) for w-custom on date, as a successful earlier push would have left.
func pushedPriorFor(swstore *fakeScheduledWorkoutStore, date string) {
	swstore.prior = &storage.ScheduledWorkout{ID: 11, Date: date, Status: storage.ScheduledWorkoutStatusPushed}
	swstore.priorWorkoutID = "w-custom"
}

func TestMoveCustomWorkoutUnpushedOnlyUpdatesDB(t *testing.T) {
	h, store, pusher, swstore := newCustomPushHarness(t)

	resp := h.postCustomMove(t, "u1", "w-custom", `{"date":"2026-08-15"}`)
	if resp.Code != http.StatusOK {
		t.Fatalf("move: %d %s", resp.Code, resp.Body.String())
	}
	got := decodeMoveBody(t, resp)
	if got.Date != "2026-08-15" || got.WorkoutID != "w-custom" {
		t.Fatalf("dto = %+v, want date 2026-08-15 for w-custom", got.planSessionDTO)
	}
	if !got.WatchSynced {
		t.Fatalf("watch_synced = false for unpushed move; nothing on the watch needs syncing")
	}
	if got.Pushed {
		t.Fatalf("pushed = true for a never-pushed workout")
	}
	// Unpushed: no provider call, no scheduled_workout write, DB row updated.
	if pusher.runCalls != 0 || len(pusher.deleteCalls) != 0 {
		t.Fatalf("provider called for unpushed move: runCalls=%d deleteCalls=%v", pusher.runCalls, pusher.deleteCalls)
	}
	if len(swstore.recorded) != 0 {
		t.Fatalf("recorded = %d, want 0", len(swstore.recorded))
	}
	if len(store.dateUpdates) != 1 || store.dateUpdates[0] != "w-custom→2026-08-15" {
		t.Fatalf("dateUpdates = %v, want one update to 2026-08-15", store.dateUpdates)
	}
}

func TestMoveCustomWorkoutPushedRepublishesToNewDate(t *testing.T) {
	h, _, pusher, swstore := newCustomPushHarness(t)
	pushedPriorFor(swstore, "2026-08-12") // row lives on 2026-08-12

	resp := h.postCustomMove(t, "u1", "w-custom", `{"date":"2026-08-15"}`)
	if resp.Code != http.StatusOK {
		t.Fatalf("move: %d %s", resp.Code, resp.Body.String())
	}
	got := decodeMoveBody(t, resp)
	if !got.WatchSynced {
		t.Fatalf("watch_synced = false after successful re-publish (%s)", resp.Body.String())
	}
	if got.Date != "2026-08-15" || !got.Pushed {
		t.Fatalf("dto = %+v, want moved pushed row", got.planSessionDTO)
	}
	// Re-publish: one push on the new date …
	if pusher.runCalls != 1 {
		t.Fatalf("runCalls = %d, want 1", pusher.runCalls)
	}
	// … sweeping both the old and the new date.
	swept := map[string]bool{}
	for _, call := range pusher.deleteCalls {
		swept[strings.SplitN(call, "\x00", 2)[0]] = true
	}
	if !swept["2026-08-12"] || !swept["2026-08-15"] {
		t.Fatalf("sweep dates = %v, want old 2026-08-12 + new 2026-08-15", swept)
	}
	// … recording the new scheduled_workout row and superseding the prior one.
	if len(swstore.recorded) != 1 {
		t.Fatalf("recorded = %d, want 1", len(swstore.recorded))
	}
	rec := swstore.recorded[0]
	if rec.PushDate != "2026-08-15" {
		t.Fatalf("PushDate = %q, want 2026-08-15", rec.PushDate)
	}
	if rec.PriorID == nil || *rec.PriorID != 11 {
		t.Fatalf("PriorID = %v, want 11 (supersede prior pushed row)", rec.PriorID)
	}
}

func TestMoveCustomWorkoutPushedRepublishFailureIsBestEffort(t *testing.T) {
	h, store, pusher, swstore := newCustomPushHarness(t)
	pushedPriorFor(swstore, "2026-08-12")
	pusher.pushErr = errors.New("watch upstream down")

	resp := h.postCustomMove(t, "u1", "w-custom", `{"date":"2026-08-15"}`)
	if resp.Code != http.StatusOK {
		t.Fatalf("move must not fail on watch errors: %d %s", resp.Code, resp.Body.String())
	}
	got := decodeMoveBody(t, resp)
	// Date committed to the DB, watch out of sync, prior scheduled_workout untouched.
	if got.Date != "2026-08-15" {
		t.Fatalf("got.Date = %q, want 2026-08-15 (DB change survives)", got.Date)
	}
	if got.WatchSynced {
		t.Fatalf("watch_synced = true after failed re-publish")
	}
	if !got.Pushed {
		t.Fatalf("pushed = false; the prior pushed row still exists")
	}
	if store.customs["w-custom"].Date != "2026-08-15" {
		t.Fatalf("stored date = %q, want 2026-08-15", store.customs["w-custom"].Date)
	}
	if len(swstore.recorded) != 0 {
		t.Fatalf("recorded = %d, want 0 (scheduled_workout untouched on failed re-publish)", len(swstore.recorded))
	}
}

func TestMoveCustomWorkoutNotFoundBadDateSameDayNoop(t *testing.T) {
	h, store, pusher, _ := newCustomPushHarness(t)

	// Missing id and cross-user access both 404 (archived rows are absent from
	// the fake's map by construction — the archived path is covered by the
	// storage integration test).
	if resp := h.postCustomMove(t, "u1", "w-missing", `{"date":"2026-08-15"}`); resp.Code != http.StatusNotFound {
		t.Fatalf("missing workout: %d, want 404", resp.Code)
	}
	// 越权：w-custom 属于 u1，u2 只能拿到 404。
	if resp := h.postCustomMove(t, "u2", "w-custom", `{"date":"2026-08-15"}`); resp.Code != http.StatusNotFound {
		t.Fatalf("cross-user move: %d, want 404", resp.Code)
	}
	// Bad body / bad date format → 422 (missing date via binding, format via parse).
	if resp := h.postCustomMove(t, "u1", "w-custom", `{}`); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing date: %d, want 422", resp.Code)
	}
	if resp := h.postCustomMove(t, "u1", "w-custom", `{"date":"08/15/2026"}`); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad date: %d, want 422", resp.Code)
	}
	// Same-day move is a no-op: no DB write, no provider call.
	before := len(store.dateUpdates)
	resp := h.postCustomMove(t, "u1", "w-custom", `{"date":"2026-08-12"}`)
	if resp.Code != http.StatusOK {
		t.Fatalf("same-day move: %d %s", resp.Code, resp.Body.String())
	}
	got := decodeMoveBody(t, resp)
	if !got.WatchSynced {
		t.Fatalf("same-day no-op watch_synced = false; nothing is out of sync")
	}
	if len(store.dateUpdates) != before {
		t.Fatalf("same-day move wrote to the store: %v", store.dateUpdates)
	}
	if pusher.runCalls != 0 || len(pusher.deleteCalls) != 0 {
		t.Fatalf("same-day move touched the provider: runCalls=%d deleteCalls=%v", pusher.runCalls, pusher.deleteCalls)
	}
}

func TestMoveCustomWorkoutIdempotentToSameTarget(t *testing.T) {
	h, _, pusher, swstore := newCustomPushHarness(t)
	pushedPriorFor(swstore, "2026-08-12")

	// First move does the full re-publish.
	if resp := h.postCustomMove(t, "u1", "w-custom", `{"date":"2026-08-15"}`); resp.Code != http.StatusOK {
		t.Fatalf("first move: %d %s", resp.Code, resp.Body.String())
	}
	// Reflect the recorded row as the new latest pushed state (the real store
	// would now return it from GetLatestScheduledWorkoutForWorkout).
	pushedPriorFor(swstore, "2026-08-15")

	// Second move to the same date is a same-day no-op: no provider traffic.
	resp := h.postCustomMove(t, "u1", "w-custom", `{"date":"2026-08-15"}`)
	if resp.Code != http.StatusOK {
		t.Fatalf("second move: %d %s", resp.Code, resp.Body.String())
	}
	got := decodeMoveBody(t, resp)
	if !got.WatchSynced || got.Date != "2026-08-15" {
		t.Fatalf("second move response = %+v, want synced row on 2026-08-15", got)
	}
	if pusher.runCalls != 1 || len(swstore.recorded) != 1 {
		t.Fatalf("idempotent replay re-published: runCalls=%d recorded=%d", pusher.runCalls, len(swstore.recorded))
	}
}
