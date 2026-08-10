package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
)

type fakeWeeklyPlanStore struct {
	plans            map[string][]storage.WeeklyPlan
	summaries        map[string][]storage.WeekSummary
	activities       map[string][]storage.Activity
	listErr          error
	getErr           error
	summaryErr       error
	activitiesErr    error
	lastMasterPlanID string
	lastDateFrom     string
	lastDateTo       string
}

func (f *fakeWeeklyPlanStore) ListWeekActivities(_ context.Context, userID, dateFrom, dateTo string) ([]storage.Activity, error) {
	f.lastDateFrom = dateFrom
	f.lastDateTo = dateTo
	if f.activitiesErr != nil {
		return nil, f.activitiesErr
	}
	return f.activities[userID], nil
}

func (f *fakeWeeklyPlanStore) ListWeekSummaries(_ context.Context, userID, masterPlanID string) ([]storage.WeekSummary, error) {
	f.lastMasterPlanID = masterPlanID
	if f.summaryErr != nil {
		return nil, f.summaryErr
	}
	return f.summaries[userID], nil
}

func (f *fakeWeeklyPlanStore) ListActiveWeeklyPlans(_ context.Context, userID string) ([]storage.WeeklyPlan, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.plans[userID], nil
}

func (f *fakeWeeklyPlanStore) GetActiveWeeklyPlan(_ context.Context, userID, weekStart string) (*storage.WeeklyPlan, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	for i := range f.plans[userID] {
		if f.plans[userID][i].WeekStart == weekStart && f.plans[userID][i].Status == storage.WeeklyPlanStatusActive {
			plan := f.plans[userID][i]
			return &plan, nil
		}
	}
	return nil, nil
}

type weeklyPlanHarness struct {
	svc   *Service
	store *fakeWeeklyPlanStore
	key   *rsa.PrivateKey
}

func newWeeklyPlanHarness(t *testing.T) *weeklyPlanHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	store := &fakeWeeklyPlanStore{
		plans: map[string][]storage.WeeklyPlan{}, summaries: map[string][]storage.WeekSummary{},
		activities: map[string][]storage.Activity{},
	}
	svc := NewService(Config{
		Auth:            NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		WeeklyPlanStore: store,
	})
	return &weeklyPlanHarness{svc: svc, store: store, key: key}
}

func (h *weeklyPlanHarness) bearer(t *testing.T, sub string) map[string]string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	})
	signed, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *weeklyPlanHarness) do(method, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(resp, req)
	return resp
}

func weeklyPlanFixture(id, userID, weekStart string, contentVersion int8, content string) storage.WeeklyPlan {
	return storage.WeeklyPlan{
		PlanID: id, UserID: userID, WeekStart: weekStart,
		ContentVersion: contentVersion, Content: content,
		Status: storage.WeeklyPlanStatusActive, Revision: 3,
		CreatedAt: time.Date(2026, 7, 20, 1, 2, 3, 0, time.UTC),
		UpdatedAt: time.Date(2026, 7, 21, 4, 5, 6, 0, time.UTC),
	}
}

func TestWeeklyPlanListReturnsActiveMetadata(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	masterID := "master-1"
	newer := weeklyPlanFixture("plan-2", userID, "2026-07-27", storage.WeeklyPlanContentStructured, `{"sessions":[],"nutrition":[]}`)
	newer.MasterPlanID = &masterID
	older := weeklyPlanFixture("plan-1", userID, "2026-07-20", storage.WeeklyPlanContentMarkdown, "# Legacy")
	h.store.plans[userID] = []storage.WeeklyPlan{newer, older}

	resp := h.do(http.MethodGet, "/api/"+userID+"/plan/weeks", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body struct {
		Weeks []map[string]any `json:"weeks"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Weeks) != 2 {
		t.Fatalf("weeks=%d want 2", len(body.Weeks))
	}
	if body.Weeks[0]["plan_id"] != "plan-2" || body.Weeks[0]["week_name"] != "2026-07-27_08-02" {
		t.Fatalf("newest week=%v", body.Weeks[0])
	}
	if body.Weeks[0]["date_to"] != "2026-08-02" || body.Weeks[0]["master_plan_id"] != masterID {
		t.Fatalf("derived metadata=%v", body.Weeks[0])
	}
	if _, exists := body.Weeks[0]["content"]; exists {
		t.Fatalf("list must not include content: %v", body.Weeks[0])
	}
}

func TestWeekSummaryListSupportsMasterPlanFilter(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	masterPlanID := "3d8bb767-e441-4f5a-a617-7f4dfcbf96bc"
	h.store.summaries[userID] = []storage.WeekSummary{{
		PlanID: "week-1", WeekStart: "2026-07-27", ActivityCount: 2,
		ContentVersion: storage.WeeklyPlanContentMarkdown, Content: "# Base W1\nDetails",
		TotalKM: 12.3, TotalDurationS: 3661,
	}}

	resp := h.do(http.MethodGet, "/api/"+userID+"/weeks?master_plan="+masterPlanID, h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if h.store.lastMasterPlanID != masterPlanID {
		t.Fatalf("master plan filter=%q", h.store.lastMasterPlanID)
	}
	var body struct {
		Weeks []weekSummaryResponse `json:"weeks"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Weeks) != 1 {
		t.Fatalf("weeks=%d want 1", len(body.Weeks))
	}
	week := body.Weeks[0]
	if week.Folder != "2026-07-27_08-02" || week.DateTo != "2026-08-02" || !week.HasPlan {
		t.Fatalf("week identity=%+v", week)
	}
	if week.ActivityCount != 2 || week.TotalKM != 12.3 || week.TotalDurationFmt != "01:01:01" {
		t.Fatalf("week summary=%+v", week)
	}
	if week.HasFeedback || week.HasBodyComposition || week.PlanSource != "weekly_plan_store" {
		t.Fatalf("legacy fields=%+v", week)
	}
	if week.PlanTitle != "Base W1" {
		t.Fatalf("plan title=%q", week.PlanTitle)
	}
}

func TestWeekSummaryListRejectsEmptyMasterPlan(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	resp := h.do(http.MethodGet, "/api/user-a/weeks?master_plan=", h.bearer(t, "user-a"))
	if resp.Code != http.StatusBadRequest || resp.Body.String() != `{"error":"invalid_master_plan"}` {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestWeekSummaryListRejectsMalformedMasterPlan(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	resp := h.do(http.MethodGet, "/api/user-a/weeks?master_plan=not-a-uuid", h.bearer(t, "user-a"))
	if resp.Code != http.StatusBadRequest || resp.Body.String() != `{"error":"invalid_master_plan"}` {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestWeeklyPlanDetailPreservesContentRepresentation(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	h.store.plans[userID] = []storage.WeeklyPlan{
		weeklyPlanFixture("json-plan", userID, "2026-07-27", storage.WeeklyPlanContentStructured, `{"sessions":[],"nutrition":[],"notes_md":null}`),
		weeklyPlanFixture("md-plan", userID, "2026-07-20", storage.WeeklyPlanContentMarkdown, "# Legacy week\n"),
	}

	structured := h.do(http.MethodGet, "/api/"+userID+"/plan/weeks/2026-07-27_08-02", h.bearer(t, userID))
	if structured.Code != http.StatusOK {
		t.Fatalf("structured status=%d body=%s", structured.Code, structured.Body.String())
	}
	var jsonBody map[string]any
	if err := json.Unmarshal(structured.Body.Bytes(), &jsonBody); err != nil {
		t.Fatalf("decode structured: %v", err)
	}
	content, ok := jsonBody["content"].(map[string]any)
	if !ok || content["sessions"] == nil {
		t.Fatalf("structured content must be object: %v", jsonBody["content"])
	}

	markdown := h.do(http.MethodGet, "/api/"+userID+"/plan/weeks/2026-07-20_07-26", h.bearer(t, userID))
	if markdown.Code != http.StatusOK {
		t.Fatalf("markdown status=%d body=%s", markdown.Code, markdown.Body.String())
	}
	var markdownBody map[string]any
	if err := json.Unmarshal(markdown.Body.Bytes(), &markdownBody); err != nil {
		t.Fatalf("decode markdown: %v", err)
	}
	if markdownBody["content"] != "# Legacy week\n" {
		t.Fatalf("markdown content=%v", markdownBody["content"])
	}
}

func TestWeekDetailReturnsMigratedPlanAndActivities(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	h.store.plans[userID] = []storage.WeeklyPlan{
		weeklyPlanFixture("json-plan", userID, "2026-07-27", storage.WeeklyPlanContentStructured,
			`{"sessions":[{"date":"2026-07-27"}],"nutrition":[],"notes_md":"Build week"}`),
	}
	distanceA, distanceB := 5234.0, 1000.0
	durationA, durationB := 1800.0, 600.0
	pace := 350.0
	note := "felt good"
	name := "Morning Run"
	route := `[[0,1],[2,3]]`
	h.store.activities[userID] = []storage.Activity{
		{LabelID: "a", Name: &name, SportType: 100, Date: time.Date(2026, 7, 27, 0, 30, 0, 0, time.UTC), DistanceM: &distanceA, DurationS: &durationA, AvgPaceSKm: &pace, SportNote: &note, RouteThumbJSON: &route},
		{LabelID: "b", SportType: 402, Date: time.Date(2026, 7, 28, 0, 30, 0, 0, time.UTC), DistanceM: &distanceB, DurationS: &durationB},
	}

	resp := h.do(http.MethodGet, "/api/"+userID+"/weeks/2026-07-27_08-02", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body struct {
		WeekName         string                 `json:"week_name"`
		DateFrom         string                 `json:"date_from"`
		DateTo           string                 `json:"date_to"`
		PlanSource       string                 `json:"plan_source"`
		FeedbackSource   string                 `json:"feedback_source"`
		Activities       []map[string]any       `json:"activities"`
		TotalKM          float64                `json:"total_km"`
		TotalDurationS   float64                `json:"total_duration_s"`
		TotalDurationFmt string                 `json:"total_duration_fmt"`
		ActivityCount    int                    `json:"activity_count"`
		Structured       structuredWeekResponse `json:"structured"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.WeekName != "2026-07-27_08-02" || body.DateFrom != "2026-07-27" || body.DateTo != "2026-08-02" {
		t.Fatalf("week identity=%+v", body)
	}
	if h.store.lastDateFrom != body.DateFrom || h.store.lastDateTo != body.DateTo {
		t.Fatalf("activity bounds=%s..%s", h.store.lastDateFrom, h.store.lastDateTo)
	}
	if body.PlanSource != "weekly_plan_store" || body.FeedbackSource != "none" || body.Structured.StructuredStatus != "canonical" {
		t.Fatalf("sources/structured=%+v", body)
	}
	if body.ActivityCount != 2 || body.TotalKM != 6.2 || body.TotalDurationS != 2400 || body.TotalDurationFmt != "00:40:00" {
		t.Fatalf("totals=%+v", body)
	}
	if body.Activities[0]["date"] != "2026-07-27T08:30:00+08:00" || body.Activities[0]["pace_fmt"] != "5:50/km" {
		t.Fatalf("activity=%v", body.Activities[0])
	}
	if _, ok := body.Activities[0]["route_thumb"].([]any); !ok {
		t.Fatalf("route_thumb=%T %v", body.Activities[0]["route_thumb"], body.Activities[0]["route_thumb"])
	}
}

func TestWeekDetailValidatesWeekNameAndRequiresActivePlan(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	invalid := h.do(http.MethodGet, "/api/user-a/weeks/2026-07-28_08-03", h.bearer(t, "user-a"))
	if invalid.Code != http.StatusBadRequest || invalid.Body.String() != `{"error":"invalid_week_name"}` {
		t.Fatalf("invalid status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	missing := h.do(http.MethodGet, "/api/user-a/weeks/2026-07-27_08-02", h.bearer(t, "user-a"))
	if missing.Code != http.StatusNotFound || missing.Body.String() != `{"error":"weekly_plan_not_found"}` {
		t.Fatalf("missing status=%d body=%s", missing.Code, missing.Body.String())
	}
}

func TestWeekDetailSupportsMarkdownAndCrossYearWeek(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	h.store.plans[userID] = []storage.WeeklyPlan{
		weeklyPlanFixture("markdown-plan", userID, "2026-12-28", storage.WeeklyPlanContentMarkdown, "# Race week\n"),
	}
	resp := h.do(http.MethodGet, "/api/"+userID+"/weeks/2026-12-28_01-03", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["week_name"] != "2026-12-28_01-03" || body["date_to"] != "2027-01-03" || body["plan"] != "# Race week\n" {
		t.Fatalf("body=%v", body)
	}
	if _, ok := body["structured"]; ok {
		t.Fatalf("markdown response must not include structured: %v", body)
	}
}

func TestWeekDetailEnforcesTenantAndMapsStoreErrors(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	forbidden := h.do(http.MethodGet, "/api/other/weeks/2026-07-27_08-02", h.bearer(t, "user-a"))
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d body=%s", forbidden.Code, forbidden.Body.String())
	}

	h.store.getErr = errors.New("boom")
	getFailed := h.do(http.MethodGet, "/api/user-a/weeks/2026-07-27_08-02", h.bearer(t, "user-a"))
	if getFailed.Code != http.StatusInternalServerError {
		t.Fatalf("get status=%d body=%s", getFailed.Code, getFailed.Body.String())
	}
	h.store.getErr = nil
	h.store.plans["user-a"] = []storage.WeeklyPlan{
		weeklyPlanFixture("plan", "user-a", "2026-07-27", storage.WeeklyPlanContentStructured, `{"sessions":[],"nutrition":[]}`),
	}
	h.store.activitiesErr = errors.New("boom")
	activitiesFailed := h.do(http.MethodGet, "/api/user-a/weeks/2026-07-27_08-02", h.bearer(t, "user-a"))
	if activitiesFailed.Code != http.StatusInternalServerError {
		t.Fatalf("activities status=%d body=%s", activitiesFailed.Code, activitiesFailed.Body.String())
	}
}

func TestWeekDetailRejectsMalformedStructuredContent(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	h.store.plans["user-a"] = []storage.WeeklyPlan{
		weeklyPlanFixture("bad-plan", "user-a", "2026-07-27", storage.WeeklyPlanContentStructured, `{"sessions":[]}`),
	}
	resp := h.do(http.MethodGet, "/api/user-a/weeks/2026-07-27_08-02", h.bearer(t, "user-a"))
	if resp.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestWeeklyPlanDetailAcceptsCrossYearWeekName(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	h.store.plans[userID] = []storage.WeeklyPlan{
		weeklyPlanFixture("cross-year", userID, "2026-12-28", storage.WeeklyPlanContentStructured, `{"sessions":[],"nutrition":[]}`),
	}

	resp := h.do(http.MethodGet, "/api/"+userID+"/plan/weeks/2026-12-28_01-03", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["date_to"] != "2027-01-03" {
		t.Fatalf("date_to=%v", body["date_to"])
	}
}

func TestWeeklyPlanDetailValidatesIdentityAndTenant(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"

	invalid := h.do(http.MethodGet, "/api/"+userID+"/plan/weeks/2026-07-28_08-03", h.bearer(t, userID))
	if invalid.Code != http.StatusBadRequest || invalid.Body.String() != `{"error":"invalid_week_name"}` {
		t.Fatalf("invalid status=%d body=%s", invalid.Code, invalid.Body.String())
	}

	missing := h.do(http.MethodGet, "/api/"+userID+"/plan/weeks/2026-07-27_08-02", h.bearer(t, userID))
	if missing.Code != http.StatusNotFound || missing.Body.String() != `{"error":"weekly_plan_not_found"}` {
		t.Fatalf("missing status=%d body=%s", missing.Code, missing.Body.String())
	}

	forbidden := h.do(http.MethodGet, "/api/other/plan/weeks", h.bearer(t, userID))
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("forbidden status=%d body=%s", forbidden.Code, forbidden.Body.String())
	}
}

func TestWeeklyPlanStoreErrorsAreInternal(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	h.store.listErr = errors.New("boom")
	resp := h.do(http.MethodGet, "/api/user-a/plan/weeks", h.bearer(t, "user-a"))
	if resp.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestWeeklyPlanDetailRejectsMalformedStructuredContent(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	h.store.plans[userID] = []storage.WeeklyPlan{
		weeklyPlanFixture("bad-plan", userID, "2026-07-27", storage.WeeklyPlanContentStructured, `{"notes_md":"missing arrays"}`),
	}
	resp := h.do(http.MethodGet, "/api/"+userID+"/plan/weeks/2026-07-27_08-02", h.bearer(t, userID))
	if resp.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
}
