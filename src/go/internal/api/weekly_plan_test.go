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
	plans   map[string][]storage.WeeklyPlan
	listErr error
	getErr  error
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
	store := &fakeWeeklyPlanStore{plans: map[string][]storage.WeeklyPlan{}}
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
