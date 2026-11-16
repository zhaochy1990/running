// onboarding_sync_test.go covers the POST/GET /api/users/me/onboarding/sync
// endpoint contract (devops#1006): auth tier, master + rollout switch gating,
// the provider capability gate, retry routing, and GET's strict read-only
// behavior (the fake service records every call).
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
	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeOnboardingSyncService records calls so tests can assert what ran.
type fakeOnboardingSyncService struct {
	createOrClaim int
	retryCalls    int
	viewCalls     int
	createErr     error
	view          *onboardingsync.View
	viewErr       error
}

func (f *fakeOnboardingSyncService) CreateOrClaim(context.Context, string, string) (*storage.OnboardingSyncSession, error) {
	f.createOrClaim++
	return &storage.OnboardingSyncSession{SessionID: uuid.NewString(), ShellReady: true}, f.createErr
}

func (f *fakeOnboardingSyncService) Retry(context.Context, string) (*storage.OnboardingSyncSession, error) {
	f.retryCalls++
	if f.viewErr != nil && f.viewErr == onboardingsync.ErrNoSession {
		return nil, f.viewErr
	}
	return &storage.OnboardingSyncSession{SessionID: uuid.NewString()}, nil
}

func (f *fakeOnboardingSyncService) View(context.Context, string) (*onboardingsync.View, error) {
	f.viewCalls++
	return f.view, f.viewErr
}

type onboardingSyncHarness struct {
	svc      *Service
	sessions *fakeOnboardingSyncService
	store    *fakeUserStore
	key      *rsa.PrivateKey
}

func newOnboardingSyncHarness(t *testing.T, features FeatureConfig, provider string) *onboardingSyncHarness {
	t.Helper()
	store := newFakeUserStore()
	store.provider[testSub] = provider
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	sessions := &fakeOnboardingSyncService{
		view: &onboardingsync.View{
			SessionID: "s-1", State: storage.OnboardingSyncStateRunning,
			ShellReady: true, Provider: "coros", AnchorDay: "2026-11-16",
			Stages: []onboardingsync.StageView{{
				Stage: storage.OnboardingSyncStageRecentRaw, Status: storage.OnboardingSyncCoverageRunning,
				Readiness:  onboardingsync.ReadinessRunning,
				TargetFrom: "2026-08-18", TargetTo: "2026-11-16",
			}},
			Readiness: onboardingsync.ViewReadiness{ShellReady: true, RecentData: onboardingsync.ReadinessRunning},
		},
	}
	svc := NewService(Config{
		Auth:                  NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		UserStore:             store,
		OnboardingSyncService: sessions,
		Features:              features,
	})
	return &onboardingSyncHarness{svc: svc, sessions: sessions, store: store, key: key}
}

func (h *onboardingSyncHarness) bearer(t *testing.T, sub string) map[string]string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub,
		"iss": testIssuer,
		"aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	})
	s, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + s}
}

func (h *onboardingSyncHarness) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

func TestOnboardingSync_Gating(t *testing.T) {
	// Master switch off → the original disable semantics.
	h := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: false, OnboardingSyncSession: true}, "coros")
	if w := h.do(http.MethodPost, "/api/users/me/onboarding/sync", "", h.bearer(t, testSub)); w.Code != http.StatusForbidden {
		t.Fatalf("master off POST: code = %d, want 403", w.Code)
	}
	if w := h.do(http.MethodGet, "/api/users/me/onboarding/sync", "", h.bearer(t, testSub)); w.Code != http.StatusForbidden {
		t.Fatalf("master off GET: code = %d, want 403", w.Code)
	}

	// Rollout switch off (master on) → 403 not_enabled.
	h2 := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: true, OnboardingSyncSession: false}, "coros")
	if w := h2.do(http.MethodPost, "/api/users/me/onboarding/sync", "", h2.bearer(t, testSub)); w.Code != http.StatusForbidden {
		t.Fatalf("rollout off POST: code = %d, want 403", w.Code)
	}

	// Auth tier: no token 401, internal token 401 (me endpoints).
	h3 := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: true, OnboardingSyncSession: true}, "coros")
	if w := h3.do(http.MethodPost, "/api/users/me/onboarding/sync", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("no token: code = %d, want 401", w.Code)
	}
	if w := h3.do(http.MethodGet, "/api/users/me/onboarding/sync", "", internalHdr()); w.Code != http.StatusUnauthorized {
		t.Fatalf("internal token: code = %d, want 401", w.Code)
	}

	// Capability: no bound provider → 409 no_watch_provider, nothing claimed.
	h4 := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: true, OnboardingSyncSession: true}, "")
	if w := h4.do(http.MethodPost, "/api/users/me/onboarding/sync", "", h4.bearer(t, testSub)); w.Code != http.StatusConflict {
		t.Fatalf("no provider: code = %d, want 409", w.Code)
	}
	if h4.sessions.createOrClaim != 0 {
		t.Error("no-provider request must not reach the session service")
	}
}

func TestOnboardingSync_PostCreatesAndGetIsReadOnly(t *testing.T) {
	h := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: true, OnboardingSyncSession: true}, "coros")

	w := h.do(http.MethodPost, "/api/users/me/onboarding/sync", `{}`, h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("POST: code = %d body=%s, want 200", w.Code, w.Body.String())
	}
	var resp onboardingsync.View
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.ShellReady || resp.Readiness.RecentData != onboardingsync.ReadinessRunning {
		t.Errorf("view = %+v", resp)
	}
	if h.sessions.createOrClaim != 1 {
		t.Errorf("createOrClaim calls = %d, want 1", h.sessions.createOrClaim)
	}

	// GET is strictly read-only: only View runs, never CreateOrClaim/Retry.
	viewsBefore := h.sessions.viewCalls
	w = h.do(http.MethodGet, "/api/users/me/onboarding/sync", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("GET: code = %d, want 200", w.Code)
	}
	if h.sessions.viewCalls != viewsBefore+1 || h.sessions.createOrClaim != 1 || h.sessions.retryCalls != 0 {
		t.Errorf("GET must only view: views=%d creates=%d retries=%d",
			h.sessions.viewCalls, h.sessions.createOrClaim, h.sessions.retryCalls)
	}

	// GET before any session → 404 no_session.
	h5 := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: true, OnboardingSyncSession: true}, "coros")
	h5.sessions.viewErr = onboardingsync.ErrNoSession
	if w := h5.do(http.MethodGet, "/api/users/me/onboarding/sync", "", h5.bearer(t, testSub)); w.Code != http.StatusNotFound {
		t.Fatalf("no session GET: code = %d, want 404", w.Code)
	}
}

func TestOnboardingSync_RetryRouting(t *testing.T) {
	h := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: true, OnboardingSyncSession: true}, "coros")
	if w := h.do(http.MethodPost, "/api/users/me/onboarding/sync", `{"retry":true}`, h.bearer(t, testSub)); w.Code != http.StatusOK {
		t.Fatalf("retry POST: code = %d, want 200", w.Code)
	}
	if h.sessions.retryCalls != 1 || h.sessions.createOrClaim != 0 {
		t.Errorf("retry routing: retries=%d creates=%d, want 1/0", h.sessions.retryCalls, h.sessions.createOrClaim)
	}

	// A malformed body is rejected.
	h6 := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: true, OnboardingSyncSession: true}, "coros")
	if w := h6.do(http.MethodPost, "/api/users/me/onboarding/sync", `{`, h6.bearer(t, testSub)); w.Code != http.StatusBadRequest {
		t.Fatalf("malformed body: code = %d, want 400", w.Code)
	}
}

// The fake's View result must round-trip through the real handler unchanged —
// pin the JSON shape the clients (T10-T12) will code against.
func TestOnboardingSync_ViewJSONShape(t *testing.T) {
	h := newOnboardingSyncHarness(t, FeatureConfig{SyncDataAtOnboarding: true, OnboardingSyncSession: true}, "coros")
	w := h.do(http.MethodGet, "/api/users/me/onboarding/sync", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, key := range []string{"session_id", "state", "shell_ready", "provider", "anchor_day", "stages", "readiness"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("view JSON missing %q: %s", key, w.Body.String())
		}
	}
	rd := raw["readiness"].(map[string]any)
	for _, key := range []string{"shell_ready", "recent_data", "recent_analysis", "historical_data", "historical_analysis", "auxiliary"} {
		if _, ok := rd[key]; !ok {
			t.Errorf("readiness JSON missing %q", key)
		}
	}
}
