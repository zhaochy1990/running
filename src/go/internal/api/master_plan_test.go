package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// --- fake master-plan store --------------------------------------------------

type fakeMasterPlanStore struct {
	current    map[string]*storage.MasterPlan
	currentUID string
	running    map[int]storage.RunningWeekSummary
	dose       map[int]storage.TrainingDoseWeekSummary
	currentErr error
	actualsErr error
}

func newFakeMasterPlanStore() *fakeMasterPlanStore {
	return &fakeMasterPlanStore{current: map[string]*storage.MasterPlan{}}
}

func (f *fakeMasterPlanStore) GetCurrentMasterPlan(_ context.Context, uid string) (*storage.MasterPlan, error) {
	f.currentUID = uid
	if f.currentErr != nil {
		return nil, f.currentErr
	}
	return f.current[uid], nil
}

func (f *fakeMasterPlanStore) RunningWeekSummaries(_ context.Context, _ string, _ []storage.WeekWindow) (map[int]storage.RunningWeekSummary, error) {
	if f.actualsErr != nil {
		return nil, f.actualsErr
	}
	if f.running == nil {
		return map[int]storage.RunningWeekSummary{}, nil
	}
	return f.running, nil
}

func (f *fakeMasterPlanStore) TrainingDoseWeekSummaries(_ context.Context, _ string, _ []storage.WeekWindow) (map[int]storage.TrainingDoseWeekSummary, error) {
	if f.actualsErr != nil {
		return nil, f.actualsErr
	}
	if f.dose == nil {
		return map[int]storage.TrainingDoseWeekSummary{}, nil
	}
	return f.dose, nil
}

// --- harness -----------------------------------------------------------------

type mpHarness struct {
	svc   *Service
	store *fakeMasterPlanStore
	key   *rsa.PrivateKey
}

func newMPHarness(t *testing.T) *mpHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	store := newFakeMasterPlanStore()
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	svc := NewService(Config{
		Auth:            NewAuthenticator(testToken, verifier),
		MasterPlanStore: store,
	})
	return &mpHarness{svc: svc, store: store, key: key}
}

func (h *mpHarness) bearer(t *testing.T, sub string) map[string]string {
	return h.bearerWithClaims(t, sub, testAudience, "")
}

func (h *mpHarness) bearerWithClaims(t *testing.T, sub, audience, role string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	claims["aud"] = audience
	if role != "" {
		claims["role"] = role
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	s, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + s}
}

func (h *mpHarness) do(method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

// samplePlanJSON is a two-week structured plan used by the pure builder tests.
// Dates are fixed so the derived fields are deterministic against a fixed today.
const samplePlanJSON = `{
  "plan_id": "p1", "user_id": "u1", "status": "active",
  "goal": {"goal_id": "g1", "distance": "FM", "target_time": "3:30:00"},
  "start_date": "2026-06-01", "end_date": "2026-06-14", "total_weeks": 2,
  "phases": [{"id": "ph1", "name": "Base", "start_date": "2026-06-01", "end_date": "2026-06-14", "focus": "base", "weekly_distance_km_low": 40, "weekly_distance_km_high": 55, "key_session_types": [], "milestone_ids": ["m0", "m1"], "is_completed": false}],
  "milestones": [
    {"id": "m0", "type": "test_run", "date": "2026-05-01", "phase_id": "ph1", "target": "done", "completed_actual": "ok"},
    {"id": "m1", "type": "long_run", "date": "2026-06-20", "phase_id": "ph1", "target": "30K 节奏跑", "completed_actual": null}
  ],
  "weeks": [
    {"week_index": 1, "week_start": "2026-06-01", "phase_id": "ph1", "target_weekly_km_low": 40, "target_weekly_km_high": 50, "key_sessions": [], "is_recovery_week": false, "is_taper_week": false},
    {"week_index": 2, "week_start": "2026-06-08", "phase_id": "ph1", "target_weekly_km_low": 45, "target_weekly_km_high": 55, "key_sessions": [], "is_recovery_week": false, "is_taper_week": false}
  ],
  "weekly_key_sessions": [{"week_index": 1, "week_start": "2026-06-01"}],
  "training_principles": ["渐进超负荷"], "generated_by": "gpt-4.1", "version": 1,
  "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-20T00:00:00Z"
}`

func mustDate(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatalf("parse date: %v", err)
	}
	return d
}

// --- pure builder: happy path ------------------------------------------------

func TestBuildCurrentResponse_DerivedFields(t *testing.T) {
	today := mustDate(t, "2026-06-10") // Wed of week 2
	resp, windows, weekFinished, err := buildCurrentResponse(&storage.MasterPlan{Content: samplePlanJSON}, today)
	if err != nil {
		t.Fatalf("build: %v", err)
	}

	// windows: week1 finished (full), week2 clamped to today; weekFinished reflects it.
	if len(windows) != 2 {
		t.Fatalf("windows = %d, want 2", len(windows))
	}
	var win2 *storage.WeekWindow
	for i := range windows {
		if windows[i].Index == 2 {
			win2 = &windows[i]
		}
	}
	if win2 == nil || win2.To != "2026-06-10" {
		t.Errorf("week2 window To = %v, want 2026-06-10 (clamped to today)", win2)
	}
	if !weekFinished[1] || weekFinished[2] {
		t.Errorf("weekFinished = %v, want week1 true / week2 false", weekFinished)
	}

	if resp["current_phase_id"] != "ph1" {
		t.Errorf("current_phase_id = %v, want ph1", resp["current_phase_id"])
	}
	if resp["current_week_number"] != 2 {
		t.Errorf("current_week_number = %v, want 2", resp["current_week_number"])
	}
	nm, ok := resp["next_milestone"].(map[string]any)
	if !ok {
		t.Fatalf("next_milestone missing/wrong type: %v", resp["next_milestone"])
	}
	if nm["id"] != "m1" || nm["days_until"] != 10 {
		t.Errorf("next_milestone = %v, want m1 / 10 days", nm)
	}

	// weekly_key_sessions is dropped; passthrough fields survive.
	if _, present := resp["weekly_key_sessions"]; present {
		t.Errorf("weekly_key_sessions should be dropped from the response")
	}
	if resp["plan_id"] != "p1" || resp["generated_by"] != "gpt-4.1" {
		t.Errorf("passthrough fields lost: %v", resp)
	}

	weeks, _ := resp["weeks"].([]map[string]any)
	if len(weeks) != 2 {
		t.Fatalf("weeks = %d, want 2", len(weeks))
	}
	w1, w2 := weeks[0], weeks[1]
	if w1["planned_distance_km"] != 50.0 || w2["planned_distance_km"] != 55.0 {
		t.Errorf("planned_distance_km = %v / %v, want 50 / 55", w1["planned_distance_km"], w2["planned_distance_km"])
	}
	if w1["is_completed"] != true || w2["is_completed"] != false {
		t.Errorf("is_completed = %v / %v, want true / false", w1["is_completed"], w2["is_completed"])
	}
	// no-data actuals present on every row
	for _, w := range weeks {
		if w["actual_training_dose_status"] != "unknown" || w["actual_run_count"] != 0 {
			t.Errorf("expected no-data actuals, got %v", w)
		}
	}
}

// --- pure builder: week expansion (synthetic started lead-in weeks) ----------

func TestBuildCurrentResponse_ExpandsStartedWeeks(t *testing.T) {
	// total_weeks=3, only week 3 explicit; weeks 1&2 are before/at today so they
	// synthesize; the phase spans the whole plan.
	plan := `{
      "plan_id": "p", "user_id": "u", "status": "active", "goal": {"goal_id": "g", "target_time": "x"},
      "start_date": "2026-06-01", "end_date": "2026-06-21", "total_weeks": 3,
      "phases": [{"id": "ph1", "name": "Base", "start_date": "2026-06-01", "end_date": "2026-06-21", "focus": "base", "weekly_distance_km_low": 30, "weekly_distance_km_high": 40, "key_session_types": [], "milestone_ids": [], "is_completed": false}],
      "milestones": [], "weeks": [
        {"week_index": 3, "week_start": "2026-06-15", "phase_id": "ph1", "target_weekly_km_low": 30, "target_weekly_km_high": 40, "key_sessions": []}
      ], "training_principles": [], "generated_by": "x", "version": 1,
      "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z"
    }`
	today := mustDate(t, "2026-06-10") // within week 2
	resp, _, _, err := buildCurrentResponse(&storage.MasterPlan{Content: plan}, today)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	weeks, _ := resp["weeks"].([]map[string]any)
	if len(weeks) != 3 {
		t.Fatalf("expanded weeks = %d, want 3 (2 synthetic + 1 explicit)", len(weeks))
	}
	if asInt(weeks[0]["week_index"]) != 1 || asInt(weeks[2]["week_index"]) != 3 {
		t.Errorf("week ordering wrong: %v", weeks)
	}
	// synthetic weeks carry null planned km; explicit week 3 carries 40.
	if weeks[0]["planned_distance_km"] != nil {
		t.Errorf("synthetic week1 planned should be nil, got %v", weeks[0]["planned_distance_km"])
	}
	if weeks[2]["planned_distance_km"] != 40.0 {
		t.Errorf("week3 planned = %v, want 40", weeks[2]["planned_distance_km"])
	}
}

// --- pure builder: edge (empty plan, outside range) --------------------------

func TestBuildCurrentResponse_EmptyAndOutOfRange(t *testing.T) {
	plan := `{"plan_id": "p", "user_id": "u", "status": "active", "goal": {"goal_id": "g", "target_time": "x"},
      "start_date": "2026-06-01", "end_date": "2026-06-14", "total_weeks": 2,
      "phases": [], "milestones": [], "weeks": [], "training_principles": [], "generated_by": "x", "version": 1,
      "created_at": "2026-05-01T00:00:00Z", "updated_at": "2026-05-01T00:00:00Z"}`
	today := mustDate(t, "2026-01-01") // before the plan
	resp, _, _, err := buildCurrentResponse(&storage.MasterPlan{Content: plan}, today)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if resp["current_phase_id"] != nil {
		t.Errorf("current_phase_id = %v, want nil", resp["current_phase_id"])
	}
	if resp["current_week_number"] != nil {
		t.Errorf("current_week_number = %v, want nil", resp["current_week_number"])
	}
	if resp["next_milestone"] != nil {
		t.Errorf("next_milestone = %v, want nil", resp["next_milestone"])
	}
	if weeks, _ := resp["weeks"].([]map[string]any); len(weeks) != 0 {
		t.Errorf("weeks = %d, want 0", len(weeks))
	}
}

func TestBuildCurrentResponse_InvalidJSON(t *testing.T) {
	if _, _, _, err := buildCurrentResponse(&storage.MasterPlan{Content: "{not json"}, time.Now()); err == nil {
		t.Fatalf("expected error for invalid plan JSON")
	}
}

func TestBuildCurrentResponse_RejectsMalformedNestedContent(t *testing.T) {
	for _, content := range []string{
		strings.Replace(samplePlanJSON, `"start_date": "2026-06-01"`, `"start_date": "2026-06-01T00:00:00Z"`, 1),
		strings.Replace(samplePlanJSON, `"name": "Base"`, `"name": null`, 1),
		strings.Replace(samplePlanJSON, `"week_index": 1`, `"week_index": 0`, 1),
		strings.Replace(samplePlanJSON, `"type": "long_run"`, `"type": null`, 1),
	} {
		if _, _, _, err := buildCurrentResponse(&storage.MasterPlan{Content: content}, time.Now()); err == nil {
			t.Fatalf("expected malformed structured content to be rejected: %s", content)
		}
	}
}

// --- handler: GET /master-plan/current ---------------------------------------

func TestMasterPlanRouteSkippedWithoutStore(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	svc := NewService(Config{Auth: NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience))})
	w := httptest.NewRecorder()
	svc.Router().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/users/me/master-plan/current", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404 when store is not configured", w.Code)
	}
}

func TestGetCurrent_RequiresUserTier(t *testing.T) {
	h := newMPHarness(t)
	const path = "/api/users/me/master-plan/current"
	if w := h.do(http.MethodGet, path, nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no token: code = %d, want 401", w.Code)
	}
	if w := h.do(http.MethodGet, path, internalHdr()); w.Code != http.StatusUnauthorized {
		t.Errorf("internal token: code = %d, want 401", w.Code)
	}
}

func TestGetCurrentForUser_AuthorizesUserAdminAndInternalCallers(t *testing.T) {
	h := newMPHarness(t)
	userID := uuid.NewString()
	otherUserID := uuid.NewString()
	path := "/api/users/" + userID + "/master-plan/current"

	tests := []struct {
		name    string
		headers map[string]string
		want    int
	}{
		{name: "no token", want: http.StatusUnauthorized},
		{name: "user reads self", headers: h.bearer(t, userID), want: http.StatusNotFound},
		{name: "user cannot read another user", headers: h.bearer(t, otherUserID), want: http.StatusForbidden},
		{name: "admin reads any user", headers: h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin"), want: http.StatusNotFound},
		{name: "admin audience requires admin role", headers: h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "user"), want: http.StatusUnauthorized},
		{name: "admin role on user audience has user scope", headers: h.bearerWithClaims(t, otherUserID, testAudience, "admin"), want: http.StatusForbidden},
		{name: "internal reads any user", headers: internalHdr(), want: http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h.store.currentUID = ""
			w := h.do(http.MethodGet, path, tt.headers)
			if w.Code != tt.want {
				t.Fatalf("code = %d, want %d: %s", w.Code, tt.want, w.Body.String())
			}
			if tt.want == http.StatusNotFound && h.store.currentUID != userID {
				t.Fatalf("store user = %q, want %q", h.store.currentUID, userID)
			}
		})
	}
}

func TestGetCurrentForUser_RejectsInvalidUserID(t *testing.T) {
	h := newMPHarness(t)
	w := h.do(http.MethodGet, "/api/users/not-a-uuid/master-plan/current", internalHdr())
	if w.Code != http.StatusBadRequest || w.Body.String() != `{"error":"user must be a UUID"}` {
		t.Fatalf("response = %d %s", w.Code, w.Body.String())
	}
	if h.store.currentUID != "" {
		t.Fatalf("store called for invalid user %q", h.store.currentUID)
	}
}

func TestGetCurrent_NotFound(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	w := h.do(http.MethodGet, "/api/users/me/master-plan/current", h.bearer(t, uid))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", w.Code)
	}
}

func TestGetCurrent_StructuredEnvelope(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	planID, goalID := uuid.NewString(), uuid.NewString()
	revision := int64(4)
	now := time.Now().UTC()
	h.store.current[uid] = &storage.MasterPlan{
		PlanID: planID, UserID: uid, ContentVersion: storage.MasterPlanContentStructured,
		Content: samplePlanJSON, GoalID: goalID, Status: storage.MasterPlanStatusActive,
		Revision: &revision, CreatedAt: now, UpdatedAt: now,
	}

	w := h.do(http.MethodGet, "/api/users/me/master-plan/current", h.bearer(t, uid))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body["content_version"] != float64(2) || body["plan_id"] != planID || body["goal_id"] != goalID || body["revision"] != float64(4) {
		t.Fatalf("wrong envelope: %v", body)
	}
	doc, ok := body["plan"].(map[string]any)
	if !ok {
		t.Fatalf("plan is not an object: %T", body["plan"])
	}
	for _, k := range []string{"goal", "phases", "weeks", "current_phase_id", "current_week_number", "next_milestone"} {
		if _, ok := doc[k]; !ok {
			t.Errorf("structured plan missing key %q", k)
		}
	}
	for _, k := range []string{"plan_id", "user_id", "status", "version", "created_at", "updated_at", "weekly_key_sessions"} {
		if _, present := doc[k]; present {
			t.Errorf("resource metadata %q must not be nested in plan", k)
		}
	}
	goal := doc["goal"].(map[string]any)
	if goal["goal_id"] != goalID {
		t.Errorf("nested goal_id = %v, want row goal %s", goal["goal_id"], goalID)
	}
}

func TestGetCurrent_MarkdownEnvelope(t *testing.T) {
	h := newMPHarness(t)
	uid, planID, goalID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	now := time.Now().UTC()
	h.store.current[uid] = &storage.MasterPlan{
		PlanID: planID, UserID: uid, ContentVersion: storage.MasterPlanContentMarkdown,
		Content: "# 训练总纲\n基础期", GoalID: goalID, Status: storage.MasterPlanStatusActive,
		CreatedAt: now, UpdatedAt: now,
	}
	w := h.do(http.MethodGet, "/api/users/me/master-plan/current", h.bearer(t, uid))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["content_version"] != float64(1) || body["revision"] != nil || body["plan"] != "# 训练总纲\n基础期" {
		t.Fatalf("wrong markdown envelope: %v", body)
	}
}

func TestGetCurrent_StoreError(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	h.store.currentErr = errors.New("boom")
	w := h.do(http.MethodGet, "/api/users/me/master-plan/current", h.bearer(t, uid))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500", w.Code)
	}
}

func TestGetCurrent_InvalidRowsAre500(t *testing.T) {
	now := time.Now().UTC()
	revision := int64(1)
	cases := []struct {
		name string
		row  *storage.MasterPlan
	}{
		{name: "empty markdown", row: &storage.MasterPlan{ContentVersion: storage.MasterPlanContentMarkdown, Content: ""}},
		{name: "invalid json", row: &storage.MasterPlan{ContentVersion: storage.MasterPlanContentStructured, Content: "{", Revision: &revision}},
		{name: "missing goal", row: &storage.MasterPlan{ContentVersion: storage.MasterPlanContentStructured, Content: `{"start_date":"2026-01-01","end_date":"2026-01-07","total_weeks":1,"phases":[],"milestones":[],"weeks":[]}`, Revision: &revision}},
		{name: "missing revision", row: &storage.MasterPlan{ContentVersion: storage.MasterPlanContentStructured, Content: samplePlanJSON}},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			h := newMPHarness(t)
			uid := uuid.NewString()
			tt.row.PlanID = uuid.NewString()
			tt.row.UserID = uid
			tt.row.GoalID = uuid.NewString()
			tt.row.Status = storage.MasterPlanStatusActive
			tt.row.CreatedAt = now
			tt.row.UpdatedAt = now
			h.store.current[uid] = tt.row
			w := h.do(http.MethodGet, "/api/users/me/master-plan/current", h.bearer(t, uid))
			if w.Code != http.StatusInternalServerError {
				t.Fatalf("code = %d, want 500 (%s)", w.Code, w.Body.String())
			}
		})
	}
}

func TestLegacyTrainingPlanRouteIsRemoved(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	w := h.do(http.MethodGet, "/api/"+uid+"/training-plan", h.bearer(t, uid))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", w.Code)
	}
}

// --- actuals: formatPace + overlay ------------------------------------------

func TestFormatPace(t *testing.T) {
	if got := formatPace(nil); got != "" {
		t.Errorf("nil -> %q, want empty", got)
	}
	zero := 0
	if got := formatPace(&zero); got != "" {
		t.Errorf("0 -> %q, want empty", got)
	}
	p := 314
	if got := formatPace(&p); got != "5:14" {
		t.Errorf("314 -> %q, want 5:14", got)
	}
	q := 65
	if got := formatPace(&q); got != "1:05" {
		t.Errorf("65 -> %q, want 1:05", got)
	}
}

func TestOverlayActuals(t *testing.T) {
	rows := []map[string]any{
		{"week_index": 1, "actual_training_dose_status": "unknown", "actual_run_count": 0, "actual_avg_pace_fmt": ""},
		{"week_index": 2, "actual_training_dose_status": "unknown", "actual_run_count": 0, "actual_avg_pace_fmt": ""},
	}
	pace, hr, d1, d2 := 300, 150, 420.0, 300.0
	run := map[int]storage.RunningWeekSummary{
		1: {RunCount: 4, DistanceKm: 42.5, TotalDurationS: 12600, AvgPaceSKm: &pace, AvgHR: &hr},
	}
	dose := map[int]storage.TrainingDoseWeekSummary{
		1: {Dose: &d1, Coverage: 1.0, Status: "complete"},
		2: {Dose: &d2, Coverage: 0.7, Status: "complete"},
	}
	overlayActuals(rows, run, dose, map[int]bool{1: true, 2: false})

	// week1: finished + complete stays complete; running overlaid.
	if rows[0]["actual_training_dose_status"] != "complete" {
		t.Errorf("week1 dose status = %v, want complete", rows[0]["actual_training_dose_status"])
	}
	if rows[0]["actual_run_count"] != 4 || rows[0]["actual_avg_pace_fmt"] != "5:00" {
		t.Errorf("week1 running not overlaid: %v", rows[0])
	}
	// week2: complete but NOT finished -> downgraded to partial; no run summary so
	// running fields stay at their defaults.
	if rows[1]["actual_training_dose_status"] != "partial" {
		t.Errorf("week2 dose status = %v, want partial (open week)", rows[1]["actual_training_dose_status"])
	}
	if rows[1]["actual_run_count"] != 0 {
		t.Errorf("week2 has no run summary; run_count should stay 0, got %v", rows[1]["actual_run_count"])
	}
}

// currentWeekPlan builds a one-week plan whose single week starts on the Monday
// of the current Shanghai week, so today falls in week 1 deterministically.
func currentWeekPlan(t *testing.T) string {
	t.Helper()
	today := timefmt.ShanghaiToday()
	daysSinceMon := (int(today.Weekday()) + 6) % 7 // Mon->0 ... Sun->6
	mon := today.AddDate(0, 0, -daysSinceMon).Format("2006-01-02")
	end := today.AddDate(0, 0, 6-daysSinceMon).Format("2006-01-02")
	return `{"plan_id":"p","user_id":"u","status":"active","goal":{"goal_id":"g","target_time":"x"},
      "start_date":"` + mon + `","end_date":"` + end + `","total_weeks":1,
      "phases":[{"id":"ph1","name":"Base","start_date":"` + mon + `","end_date":"` + end + `","focus":"base","weekly_distance_km_low":40,"weekly_distance_km_high":50,"key_session_types":[],"milestone_ids":[],"is_completed":false}],
      "milestones":[],"weeks":[{"week_index":1,"week_start":"` + mon + `","phase_id":"ph1","target_weekly_km_low":40,"target_weekly_km_high":50,"key_sessions":[]}],
      "training_principles":[],"generated_by":"x","version":1,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`
}

func TestGetCurrent_OverlaysActualsThroughHandler(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	revision := int64(1)
	now := time.Now().UTC()
	h.store.current[uid] = &storage.MasterPlan{PlanID: uuid.NewString(), UserID: uid, ContentVersion: storage.MasterPlanContentStructured, Content: currentWeekPlan(t), GoalID: uuid.NewString(), Status: storage.MasterPlanStatusActive, Revision: &revision, CreatedAt: now, UpdatedAt: now}
	pace := 330
	h.store.running = map[int]storage.RunningWeekSummary{1: {RunCount: 3, DistanceKm: 31.2, TotalDurationS: 10800, AvgPaceSKm: &pace}}
	dose := 245.0
	h.store.dose = map[int]storage.TrainingDoseWeekSummary{1: {Dose: &dose, Coverage: 0.85, Status: "complete"}}

	w := h.do(http.MethodGet, "/api/users/me/master-plan/current", h.bearer(t, uid))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	plan, _ := body["plan"].(map[string]any)
	weeks, _ := plan["weeks"].([]any)
	if len(weeks) == 0 {
		t.Fatalf("no weeks in response")
	}
	wk1, _ := weeks[0].(map[string]any)
	if wk1["actual_run_count"].(float64) != 3 || wk1["actual_avg_pace_fmt"] != "5:30" {
		t.Errorf("week1 running actuals not overlaid through the handler: %v", wk1)
	}
	if wk1["actual_training_dose"].(float64) != 245.0 {
		t.Errorf("week1 dose not overlaid: %v", wk1["actual_training_dose"])
	}
	// current (unfinished) week: a "complete" dose is reported as "partial".
	if wk1["actual_training_dose_status"] != "partial" {
		t.Errorf("open week dose status = %v, want partial", wk1["actual_training_dose_status"])
	}
}

func TestGetCurrent_ActualsErrorIs500(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	revision := int64(1)
	now := time.Now().UTC()
	h.store.current[uid] = &storage.MasterPlan{PlanID: uuid.NewString(), UserID: uid, ContentVersion: storage.MasterPlanContentStructured, Content: currentWeekPlan(t), GoalID: uuid.NewString(), Status: storage.MasterPlanStatusActive, Revision: &revision, CreatedAt: now, UpdatedAt: now}
	h.store.actualsErr = errors.New("db down")
	w := h.do(http.MethodGet, "/api/users/me/master-plan/current", h.bearer(t, uid))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500 when actuals fetch fails", w.Code)
	}
}
