package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
	feedbackErr      error
	lastMasterPlanID string
	lastDateFrom     string
	lastDateTo       string
	feedback         map[string]storage.WeeklyFeedback
	now              time.Time
}

func (f *fakeWeeklyPlanStore) GetWeeklyFeedback(_ context.Context, userID, weekStart string) (*storage.WeeklyFeedback, error) {
	if f.feedbackErr != nil {
		return nil, f.feedbackErr
	}
	row, exists := f.feedback[userID+"/"+weekStart]
	if !exists {
		return nil, nil
	}
	return &row, nil
}

func (f *fakeWeeklyPlanStore) PutWeeklyFeedback(_ context.Context, userID, weekStart, content string) (storage.WeeklyFeedback, error) {
	now := f.now
	key := userID + "/" + weekStart
	row, exists := f.feedback[key]
	if !exists {
		row = storage.WeeklyFeedback{UserID: userID, WeekStart: weekStart, CreatedAt: now}
	}
	row.ContentMD = content
	row.UpdatedAt = now
	f.feedback[key] = row
	return row, nil
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
		feedback:   map[string]storage.WeeklyFeedback{},
		now:        time.Date(2026, 8, 11, 1, 2, 3, 0, time.UTC),
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
	return h.doBody(method, path, headers, nil)
}

func (h *weeklyPlanHarness) doBody(method, path string, headers map[string]string, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, body)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(resp, req)
	return resp
}

func TestPutWeeklyFeedbackCreatesNormalizedFeedback(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	resp := h.doBody(http.MethodPut, "/api/"+userID+"/weeks/2026-12-28_01-03/feedback", h.bearer(t, userID), strings.NewReader(`{"content":"  Great week!  ","legacy":true}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["success"] != true || body["week"] != "2026-12-28_01-03" || body["feedback"] != "  Great week!  " || body["has_feedback"] != true {
		t.Fatalf("body=%v", body)
	}
	if body["created_at"] != "2026-08-11T01:02:03Z" || body["updated_at"] != "2026-08-11T01:02:03Z" {
		t.Fatalf("timestamps=%v", body)
	}
}

func TestPutWeeklyFeedbackValidatesRequestAndAuthorization(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	tests := []struct {
		name, path, body string
		headers          map[string]string
		status           int
		error            string
	}{
		{"cross user", "/api/other/weeks/2026-07-27_08-02/feedback", `{"content":"x"}`, h.bearer(t, "user-a"), http.StatusForbidden, "forbidden"},
		{"bad week", "/api/user-a/weeks/2026-07-28_08-03/feedback", `{"content":"x"}`, h.bearer(t, "user-a"), http.StatusBadRequest, "invalid_week_name"},
		{"non string", "/api/user-a/weeks/2026-07-27_08-02/feedback", `{"content":42}`, h.bearer(t, "user-a"), http.StatusUnprocessableEntity, "invalid_content"},
		{"missing content", "/api/user-a/weeks/2026-07-27_08-02/feedback", `{}`, h.bearer(t, "user-a"), http.StatusUnprocessableEntity, "invalid_content"},
		{"too large utf8", "/api/user-a/weeks/2026-07-27_08-02/feedback", `{"content":"` + strings.Repeat("跑", 87382) + `"}`, h.bearer(t, "user-a"), http.StatusRequestEntityTooLarge, "weekly_feedback_too_large"},
		{"too large body", "/api/user-a/weeks/2026-07-27_08-02/feedback", `{"content":"` + strings.Repeat("x", 1024*1024) + `"}`, h.bearer(t, "user-a"), http.StatusRequestEntityTooLarge, "weekly_feedback_too_large"},
		{"too large whitespace", "/api/user-a/weeks/2026-07-27_08-02/feedback", `{"content":"` + strings.Repeat(" ", 256*1024+1) + `"}`, h.bearer(t, "user-a"), http.StatusRequestEntityTooLarge, "weekly_feedback_too_large"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resp := h.doBody(http.MethodPut, test.path, test.headers, strings.NewReader(test.body))
			if resp.Code != test.status || resp.Body.String() != `{"error":"`+test.error+`"}` {
				t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
			}
		})
	}
}

func TestPutWeeklyFeedbackClearsWhitespaceAndRefreshesUpdate(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	path := "/api/" + userID + "/weeks/2026-07-27_08-02/feedback"
	first := h.doBody(http.MethodPut, path, h.bearer(t, userID), strings.NewReader(`{"content":"first"}`))
	if first.Code != http.StatusOK {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}
	h.store.now = time.Date(2026, 8, 11, 2, 3, 4, 0, time.UTC)
	second := h.doBody(http.MethodPut, path, h.bearer(t, userID), strings.NewReader("{\"content\":\" \\n\\t \"}"))
	var body weeklyFeedbackResponse
	if err := json.Unmarshal(second.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if second.Code != http.StatusOK || body.Feedback != "" || body.HasFeedback || body.CreatedAt != "2026-08-11T01:02:03Z" || body.UpdatedAt != "2026-08-11T02:03:04Z" {
		t.Fatalf("status=%d body=%+v", second.Code, body)
	}
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

func TestWeekSummaryListReturnsPlanActivityAndFeedbackWeekUnion(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	h.store.summaries[userID] = []storage.WeekSummary{
		{PlanID: "plan", WeekStart: "2026-08-03", ContentVersion: storage.WeeklyPlanContentStructured, HasFeedback: true},
		{WeekStart: "2026-07-27", ActivityCount: 1, TotalKM: 5, TotalDurationS: 1800},
		{WeekStart: "2026-07-20", FeedbackRowExists: true, HasFeedback: true},
		{WeekStart: "2026-07-13", FeedbackRowExists: true, HasFeedback: false},
	}

	resp := h.do(http.MethodGet, "/api/"+userID+"/weeks", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	weeks := body["weeks"].([]any)
	if len(weeks) != 4 {
		t.Fatalf("weeks=%v", weeks)
	}
	for i, want := range []struct {
		folder      string
		hasPlan     bool
		hasFeedback bool
	}{
		{"2026-08-03_08-09", true, true},
		{"2026-07-27_08-02", false, false},
		{"2026-07-20_07-26", false, true},
		{"2026-07-13_07-19", false, false},
	} {
		week := weeks[i].(map[string]any)
		if week["folder"] != want.folder || week["has_plan"] != want.hasPlan || week["has_feedback"] != want.hasFeedback {
			t.Fatalf("week[%d]=%v", i, week)
		}
		if _, exists := week["feedback"]; exists {
			t.Fatalf("list leaked feedback body: %v", week)
		}
		if _, exists := week["feedback_updated_at"]; exists {
			t.Fatalf("list leaked feedback timestamp: %v", week)
		}
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
	h.store.feedback[userID+"/2026-07-27"] = storage.WeeklyFeedback{
		UserID: userID, WeekStart: "2026-07-27", ContentMD: "Weekly reflection",
		CreatedAt: time.Date(2026, 8, 3, 1, 2, 3, 0, time.UTC),
		UpdatedAt: time.Date(2026, 8, 4, 4, 5, 6, 123000000, time.UTC),
	}

	resp := h.do(http.MethodGet, "/api/"+userID+"/weeks/2026-07-27_08-02", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body struct {
		WeekName         string                 `json:"week_name"`
		DateFrom         string                 `json:"date_from"`
		DateTo           string                 `json:"date_to"`
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
	var raw map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode raw: %v", err)
	}
	if _, exists := raw["plan_source"]; exists {
		t.Fatalf("response must not include plan_source: %v", raw)
	}
	if _, exists := raw["feedback_source"]; exists {
		t.Fatalf("response must not include feedback_source: %v", raw)
	}
	if raw["feedback"] != "Weekly reflection" || raw["feedback_created_at"] != "2026-08-03T01:02:03Z" || raw["feedback_updated_at"] != "2026-08-04T04:05:06.123Z" {
		t.Fatalf("feedback=%v", raw)
	}
	if strings.Contains(raw["feedback"].(string), note) {
		t.Fatalf("sport_note leaked into weekly feedback: %v", raw)
	}
	if body.WeekName != "2026-07-27_08-02" || body.DateFrom != "2026-07-27" || body.DateTo != "2026-08-02" {
		t.Fatalf("week identity=%+v", body)
	}
	if h.store.lastDateFrom != body.DateFrom || h.store.lastDateTo != body.DateTo {
		t.Fatalf("activity bounds=%s..%s", h.store.lastDateFrom, h.store.lastDateTo)
	}
	if body.Structured.StructuredStatus != "canonical" {
		t.Fatalf("structured=%+v", body)
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

func TestWeekDetailValidatesWeekNameAndReturnsNotFoundWhenAllSourcesMissing(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	invalid := h.do(http.MethodGet, "/api/user-a/weeks/2026-07-28_08-03", h.bearer(t, "user-a"))
	if invalid.Code != http.StatusBadRequest || invalid.Body.String() != `{"error":"invalid_week_name"}` {
		t.Fatalf("invalid status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	missing := h.do(http.MethodGet, "/api/user-a/weeks/2026-07-27_08-02", h.bearer(t, "user-a"))
	if missing.Code != http.StatusNotFound || missing.Body.String() != `{"error":"week_not_found"}` {
		t.Fatalf("missing status=%d body=%s", missing.Code, missing.Body.String())
	}
}

func TestWeekDetailReturnsActivitiesWithoutActivePlan(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	distance := 5000.0
	duration := 1800.0
	h.store.activities[userID] = []storage.Activity{{
		LabelID: "run", SportType: 100,
		Date:      time.Date(2026, 7, 27, 1, 0, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}}

	resp := h.do(http.MethodGet, "/api/"+userID+"/weeks/2026-07-27_08-02", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["activity_count"] != float64(1) || body["total_km"] != 5.0 || body["total_duration_s"] != 1800.0 {
		t.Fatalf("activity-only body=%v", body)
	}
	if body["plan"] != nil || body["structured"] != nil || body["feedback"] != "" || body["feedback_created_at"] != nil || body["feedback_updated_at"] != nil {
		t.Fatalf("activity-only stable shape=%v", body)
	}
}

func TestWeekDetailReturnsFeedbackOnlyAndDistinguishesClearedRow(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	created := time.Date(2026, 8, 3, 1, 2, 3, 0, time.UTC)
	updated := time.Date(2026, 8, 4, 4, 5, 6, 0, time.UTC)
	h.store.feedback[userID+"/2026-07-27"] = storage.WeeklyFeedback{
		UserID: userID, WeekStart: "2026-07-27", ContentMD: "", CreatedAt: created, UpdatedAt: updated,
	}

	resp := h.do(http.MethodGet, "/api/"+userID+"/weeks/2026-07-27_08-02", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["plan"] != nil || body["structured"] != nil || body["feedback"] != "" || body["feedback_created_at"] != created.Format(time.RFC3339) || body["feedback_updated_at"] != updated.Format(time.RFC3339) {
		t.Fatalf("cleared feedback shape=%v", body)
	}
	if activities, ok := body["activities"].([]any); !ok || len(activities) != 0 {
		t.Fatalf("activities=%v", body["activities"])
	}
}

func TestWeekDetailReturnsNonEmptyFeedbackWithoutPlanOrActivities(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "user-a"
	h.store.feedback[userID+"/2026-07-27"] = storage.WeeklyFeedback{
		UserID: userID, WeekStart: "2026-07-27", ContentMD: "Recovered well",
		CreatedAt: time.Date(2026, 8, 3, 1, 2, 3, 0, time.UTC),
		UpdatedAt: time.Date(2026, 8, 4, 4, 5, 6, 0, time.UTC),
	}
	resp := h.do(http.MethodGet, "/api/"+userID+"/weeks/2026-07-27_08-02", h.bearer(t, userID))
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["plan"] != nil || body["structured"] != nil || body["feedback"] != "Recovered well" {
		t.Fatalf("feedback-only body=%v", body)
	}
}

func TestWeekDetailMapsFeedbackStoreFailure(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	h.store.feedbackErr = errors.New("feedback unavailable")
	resp := h.do(http.MethodGet, "/api/user-a/weeks/2026-07-27_08-02", h.bearer(t, "user-a"))
	if resp.Code != http.StatusInternalServerError || resp.Body.String() != `{"error":"internal error"}` {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
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
	if body["structured"] != nil {
		t.Fatalf("markdown response structured must be null: %v", body)
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
