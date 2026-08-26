// Tests for POST /api/:user/plan/sessions/:date/:sessionIndex/push — the
// watch workout-push endpoint. Uses fake pusher + fake scheduled-workout store
// so no provider or MySQL is involved.
package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

type fakePusher struct {
	info        provider.ProviderInfo
	pushRunID   string
	runCalls    int
	strCalls    int
	deleteCalls []string // (date, name) pairs, flattened
	pushErr     error
	deleteErr   error
}

func (f *fakePusher) Info(context.Context, string) (provider.ProviderInfo, error) {
	return f.info, nil
}

func (f *fakePusher) PushRunWorkout(_ context.Context, _ string, w provider.RunWorkout) (string, error) {
	f.runCalls++
	if f.pushErr != nil {
		return "", f.pushErr
	}
	f.pushRunID = w.Name
	return "R-1", nil
}

func (f *fakePusher) PushStrengthWorkout(_ context.Context, _ string, w provider.StrengthWorkout) (string, error) {
	f.strCalls++
	if f.pushErr != nil {
		return "", f.pushErr
	}
	f.pushRunID = w.Name
	return "S-1", nil
}

func (f *fakePusher) DeleteScheduledWorkout(_ context.Context, _, date, name string) (bool, error) {
	f.deleteCalls = append(f.deleteCalls, date+"\x00"+name)
	if f.deleteErr != nil {
		return false, f.deleteErr
	}
	return true, nil
}

type fakeScheduledWorkoutStore struct {
	prior    *storage.ScheduledWorkout
	nextID   int64
	recorded []storage.RecordPushedWorkoutInput
}

func (f *fakeScheduledWorkoutStore) GetLatestScheduledWorkoutForPlanSession(
	context.Context, string, string, string, int,
) (*storage.ScheduledWorkout, error) {
	return f.prior, nil
}

func (f *fakeScheduledWorkoutStore) RecordPushedScheduledWorkout(
	_ context.Context, _ string, in storage.RecordPushedWorkoutInput,
) (int64, error) {
	f.nextID++
	f.recorded = append(f.recorded, in)
	return f.nextID, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

type pushHarness struct {
	svc     *Service
	store   *fakeWeeklyPlanStore
	pusher  *fakePusher
	swstore *fakeScheduledWorkoutStore
	key     any
}

func newPushHarness(t *testing.T) *pushHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	store := &fakeWeeklyPlanStore{
		plans: map[string][]storage.WeeklyPlan{}, summaries: map[string][]storage.WeekSummary{},
		activities: map[string][]storage.Activity{},
		feedback:   map[string]storage.WeeklyFeedback{},
		now:        time.Date(2026, 8, 11, 1, 2, 3, 0, time.UTC),
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("admin verifier: %v", err)
	}
	pusher := &fakePusher{info: provider.ProviderInfo{
		Name: "coros", DisplayName: "高驰",
		Capabilities: provider.Capabilities{
			provider.CapPushRunWorkout: true, provider.CapPushStrengthWorkout: true, provider.CapDeleteWorkout: true,
		},
	}}
	swstore := &fakeScheduledWorkoutStore{}
	svc := NewService(Config{
		Auth:                  NewAuthenticator(testToken, verifier),
		WeeklyPlanStore:       store,
		WorkoutPusher:         pusher,
		ScheduledWorkoutStore: swstore,
	})
	return &pushHarness{svc: svc, store: store, pusher: pusher, swstore: swstore, key: key}
}

func (h *pushHarness) bearer(t *testing.T, sub string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *pushHarness) post(t *testing.T, user, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(resp, req)
	return resp
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

// structuredPlanContent builds a weekly-plan/v1 document with a run session
// (spec) and a strength session (spec) on consecutive days.
func structuredPlanContent(weekStart string) string {
	low, _ := provider.ParsePaceSKM("5:40")
	high, _ := provider.ParsePaceSKM("5:20")
	runSpec, _ := json.Marshal(provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "[STRIDE] Easy 10K",
		Date:   weekStart,
		Blocks: []provider.WorkoutBlock{{
			Repeat: 1,
			Steps: []provider.WorkoutStep{{
				StepKind: provider.StepWork,
				Duration: provider.DurationOfDistanceKM(10),
				Target:   provider.PaceRangeSKM(float64(low), float64(high)),
			}},
		}},
	})
	strengthSpec, _ := json.Marshal(provider.StrengthWorkout{
		Schema: provider.StrengthWorkoutSchema,
		Name:   "[STRIDE] 力量训练",
		Date:   weekStart,
		Exercises: []provider.StrengthExerciseSpec{{
			CanonicalID: "squat", DisplayName: "深蹲", Sets: 3,
			TargetKind: provider.StrengthTargetReps, TargetValue: 12, RestSeconds: 90,
		}},
	})
	nutrition := []any{}
	document := map[string]any{
		"schema": "weekly-plan/v1",
		"sessions": []any{
			map[string]any{
				"schema": "plan-session/v1", "date": weekStart, "session_index": 0,
				"kind": "run", "summary": "Easy run", "spec": json.RawMessage(runSpec),
			},
			map[string]any{
				"schema": "plan-session/v1", "date": weekStart, "session_index": 1,
				"kind": "strength", "summary": "力量", "spec": json.RawMessage(strengthSpec),
			},
			map[string]any{
				"schema": "plan-session/v1", "date": weekStart, "session_index": 2,
				"kind": "rest", "summary": "Rest", "spec": nil,
			},
		},
		"nutrition": nutrition,
	}
	raw, _ := json.Marshal(document)
	return string(raw)
}

func seedPushablePlan(h *pushHarness, userID, weekStart string) {
	content := structuredPlanContent(weekStart)
	h.store.plans[userID] = []storage.WeeklyPlan{{
		PlanID: "plan-1", UserID: userID, WeekStart: weekStart,
		ContentVersion: storage.WeeklyPlanContentStructured,
		Content:        content,
		Status:         storage.WeeklyPlanStatusActive,
		Revision:       1,
	}}
}

// structuredPlanContentStoredShape returns the same plan as
// structuredPlanContent but with each session spec's `schema` discriminator
// removed. This mirrors api.stripStoredWeeklyPlanMetadata, which strips the
// schema key from stored weekly-plan content at apply time, so push must accept
// schema-less specs.
func structuredPlanContentStoredShape(weekStart string) string {
	var doc map[string]any
	if err := json.Unmarshal([]byte(structuredPlanContent(weekStart)), &doc); err != nil {
		panic(err)
	}
	for _, item := range doc["sessions"].([]any) {
		session := item.(map[string]any)
		if spec, ok := session["spec"].(map[string]any); ok {
			delete(spec, "schema")
			session["spec"] = spec
		}
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

func TestPushPlannedSessionRunSuccess(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-a"
	weekStart := "2026-08-10" // Monday
	seedPushablePlan(h, userID, weekStart)

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body pushPlannedSessionResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.OK || body.Provider != "coros" || body.ProviderWorkoutID != "R-1" || body.PushDate != weekStart {
		t.Fatalf("body=%+v", body)
	}
	if body.ScheduledWorkoutID != 1 {
		t.Errorf("scheduled_workout_id = %d, want 1", body.ScheduledWorkoutID)
	}
	if h.pusher.runCalls != 1 || h.pusher.strCalls != 0 {
		t.Errorf("runCalls=%d strCalls=%d, want 1/0", h.pusher.runCalls, h.pusher.strCalls)
	}
	if len(h.swstore.recorded) != 1 {
		t.Fatalf("recorded = %d, want 1", len(h.swstore.recorded))
	}
	rec := h.swstore.recorded[0]
	if rec.Kind != "run" || rec.PushDate != weekStart || rec.Provider != "coros" || rec.ProviderWorkoutID != "R-1" ||
		rec.PlannedDate != weekStart || rec.SessionIndex != 0 || rec.WeekFolder != weekStart {
		t.Errorf("recorded = %+v", rec)
	}
	if rec.PriorID != nil {
		t.Errorf("PriorID = %v, want nil (no prior)", rec.PriorID)
	}
	// The delete sweep runs for the push date even without a tracked prior
	// (clears stale untracked [STRIDE] entries).
	if len(h.pusher.deleteCalls) != 1 {
		t.Errorf("deleteCalls = %v, want 1 sweep", h.pusher.deleteCalls)
	}
}

func TestPushPlannedSessionStrengthSuccess(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-b"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/1/push", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if h.pusher.strCalls != 1 {
		t.Errorf("strCalls = %d, want 1", h.pusher.strCalls)
	}
}

func TestPushPlannedSessionAcceptsStoredSpecWithoutSchema(t *testing.T) {
	// Regression: the weekly-plan apply path strips the spec.schema discriminator
	// before storage, so the push endpoint must accept schema-less stored specs
	// (previously it 400'd with "unexpected run workout schema \"\"").
	h := newPushHarness(t)
	userID := "user-push-stored"
	weekStart := "2026-08-10"
	h.store.plans[userID] = []storage.WeeklyPlan{{
		PlanID: "plan-stored", UserID: userID, WeekStart: weekStart,
		ContentVersion: storage.WeeklyPlanContentStructured,
		Content:        structuredPlanContentStoredShape(weekStart),
		Status:         storage.WeeklyPlanStatusActive,
		Revision:       1,
	}}

	// Run session spec without schema.
	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("run push status=%d body=%s", resp.Code, resp.Body.String())
	}
	if h.pusher.runCalls != 1 {
		t.Errorf("runCalls = %d, want 1", h.pusher.runCalls)
	}

	// Strength session spec without schema.
	resp = h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/1/push", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("strength push status=%d body=%s", resp.Code, resp.Body.String())
	}
	if h.pusher.strCalls != 1 {
		t.Errorf("strCalls = %d, want 1", h.pusher.strCalls)
	}
}

func TestPushPlannedSessionTargetDateMoves(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-c"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)
	target := "2026-08-11" // +1 day, within window

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push?target_date="+target, h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body pushPlannedSessionResponse
	_ = json.Unmarshal(resp.Body.Bytes(), &body)
	if body.PushDate != target {
		t.Errorf("push_date = %q, want %q", body.PushDate, target)
	}
	rec := h.swstore.recorded[0]
	if rec.PushDate != target || rec.PlannedDate != weekStart {
		t.Errorf("recorded push/planned = %q/%q", rec.PushDate, rec.PlannedDate)
	}
	// The re-serialized spec JSON must carry the moved date (watch lands right).
	if !strings.Contains(rec.SpecJSON, `"date":"`+target+`"`) {
		t.Errorf("spec_json date not moved: %s", rec.SpecJSON)
	}
	// Sweep only the target date (no prior).
	if len(h.pusher.deleteCalls) != 1 || !strings.HasPrefix(h.pusher.deleteCalls[0], target+"\x00") {
		t.Errorf("deleteCalls = %v, want target-date sweep", h.pusher.deleteCalls)
	}
}

func TestPushPlannedSessionTargetDateOutsideWindow(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-d"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push?target_date=2026-08-20", h.bearer(t, userID))
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s, want 400", resp.Code, resp.Body.String())
	}
	if h.pusher.runCalls != 0 {
		t.Errorf("push called despite window violation")
	}
}

func TestPushPlannedSessionNotFound(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-e"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/2026-09-01/0/push", h.bearer(t, userID))
	if resp.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s, want 404", resp.Code, resp.Body.String())
	}
}

func TestPushPlannedSessionNoPlanNotFound(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-f"
	weekStart := "2026-08-10"

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push", h.bearer(t, userID))
	if resp.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s, want 404 (no plan at all)", resp.Code, resp.Body.String())
	}
}

func TestPushPlannedSessionRestKindRejected(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-g"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/2/push", h.bearer(t, userID))
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s, want 400", resp.Code, resp.Body.String())
	}
	if h.pusher.runCalls != 0 {
		t.Errorf("push called for rest session")
	}
}

func TestPushPlannedSessionProviderLacksCapability(t *testing.T) {
	h := newPushHarness(t)
	h.pusher.info.Capabilities = provider.Capabilities{provider.CapPushRunWorkout: true}
	userID := "user-push-h"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/1/push", h.bearer(t, userID))
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s, want 400 (strength unsupported)", resp.Code, resp.Body.String())
	}
	if h.pusher.strCalls != 0 {
		t.Errorf("strength push called without capability")
	}
}

func TestPushPlannedSessionRePushSupersedesPrior(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-i"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)
	priorID := int64(7)
	priorDate := "2026-08-09"
	h.swstore.prior = &storage.ScheduledWorkout{
		ID: priorID, Date: priorDate, Status: storage.ScheduledWorkoutStatusPushed,
		Kind: "run", Name: "[STRIDE] Easy 10K",
	}

	// Re-push with a moved target date: prior pushed date + target date both
	// swept, prior superseded.
	target := "2026-08-12"
	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push?target_date="+target, h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	// Sweeps: target date + prior pushed date (deduped).
	if len(h.pusher.deleteCalls) != 2 {
		t.Errorf("deleteCalls = %v, want 2 sweeps (target + prior date)", h.pusher.deleteCalls)
	}
	rec := h.swstore.recorded[0]
	if rec.PriorID == nil || *rec.PriorID != priorID {
		t.Errorf("PriorID = %v, want %d", rec.PriorID, priorID)
	}
}

func TestPushPlannedSessionPushFailure502(t *testing.T) {
	h := newPushHarness(t)
	h.pusher.pushErr = context.DeadlineExceeded
	userID := "user-push-j"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push", h.bearer(t, userID))
	if resp.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s, want 502", resp.Code, resp.Body.String())
	}
	if len(h.swstore.recorded) != 0 {
		t.Errorf("push failure must not record a scheduled_workout")
	}
}

func TestPushPlannedSessionMarkdownPlanConflict(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-f2"
	weekStart := "2026-08-10"
	// Active plan exists but is legacy Markdown (no structured sessions) → 409
	// "structured plan not fresh" (mirrors Python's guard).
	h.store.plans[userID] = []storage.WeeklyPlan{{
		PlanID: "plan-md", UserID: userID, WeekStart: weekStart,
		ContentVersion: storage.WeeklyPlanContentMarkdown,
		Content:        "# week\n\nrun 10km",
		Status:         storage.WeeklyPlanStatusActive, Revision: 1,
	}}

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push", h.bearer(t, userID))
	if resp.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s, want 409", resp.Code, resp.Body.String())
	}
}

func TestPushPlannedSessionProviderLacksDeleteWithPrior(t *testing.T) {
	h := newPushHarness(t)
	h.pusher.info.Capabilities = provider.Capabilities{provider.CapPushRunWorkout: true} // no DELETE_WORKOUT
	userID := "user-push-i2"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)
	priorID := int64(5)
	h.swstore.prior = &storage.ScheduledWorkout{
		ID: priorID, Date: weekStart, Status: storage.ScheduledWorkoutStatusPushed,
		Kind: "run", Name: "[STRIDE] Easy 10K",
	}

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push", h.bearer(t, userID))
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s, want 400 (provider cannot delete prior push)", resp.Code, resp.Body.String())
	}
	if h.pusher.runCalls != 0 {
		t.Errorf("push called despite blocked re-push")
	}
}

func TestPushPlannedSessionForbiddenOtherUser(t *testing.T) {
	h := newPushHarness(t)
	userID := "user-push-k"
	weekStart := "2026-08-10"
	seedPushablePlan(h, userID, weekStart)

	resp := h.post(t, userID, "/api/"+userID+"/plan/sessions/"+weekStart+"/0/push", h.bearer(t, "someone-else"))
	if resp.Code != http.StatusForbidden {
		t.Fatalf("status=%d, want 403", resp.Code)
	}
}
