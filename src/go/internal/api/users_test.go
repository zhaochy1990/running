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

	"github.com/zhaochy1990/stride/internal/storage"
)

const testSub = "11111111-1111-4111-8111-111111111111"

// --- fakes -------------------------------------------------------------------

type fakeUserStore struct {
	profiles   map[string]*storage.UserProfile
	onboarding map[string]*storage.UserOnboarding
	provider   map[string]string
	upsertErr  error
}

func newFakeUserStore() *fakeUserStore {
	return &fakeUserStore{
		profiles:   map[string]*storage.UserProfile{},
		onboarding: map[string]*storage.UserOnboarding{},
		provider:   map[string]string{},
	}
}

func (f *fakeUserStore) GetUserProfile(_ context.Context, uid string) (*storage.UserProfile, error) {
	return f.profiles[uid], nil
}

func (f *fakeUserStore) UpsertUserProfile(_ context.Context, p *storage.UserProfile) error {
	if f.upsertErr != nil {
		return f.upsertErr
	}
	cp := *p
	f.profiles[p.UserID] = &cp
	return nil
}

func (f *fakeUserStore) GetUserOnboarding(_ context.Context, uid string) (*storage.UserOnboarding, error) {
	return f.onboarding[uid], nil
}

func (f *fakeUserStore) SetWatchReady(_ context.Context, uid string) error {
	o := f.onboarding[uid]
	if o == nil {
		o = &storage.UserOnboarding{UserID: uid}
	}
	o.WatchReady = true
	f.onboarding[uid] = o
	return nil
}

func (f *fakeUserStore) SetProfileReady(_ context.Context, uid string) error {
	o := f.onboarding[uid]
	if o == nil {
		o = &storage.UserOnboarding{UserID: uid}
	}
	o.ProfileReady = true
	f.onboarding[uid] = o
	return nil
}

func (f *fakeUserStore) ProviderForUser(_ context.Context, uid string) (string, bool, error) {
	p, ok := f.provider[uid]
	return p, ok, nil
}

type fakeProviderLogin struct {
	result      WatchLoginResult
	err         error
	gotProvider string
	gotUser     string
	gotRegion   string
}

func (f *fakeProviderLogin) Login(_ context.Context, providerName, userID, email, password, region string) (WatchLoginResult, error) {
	f.gotProvider, f.gotUser, f.gotRegion = providerName, userID, region
	if f.err != nil {
		return WatchLoginResult{}, f.err
	}
	return f.result, nil
}

type fakeAuthNameSync struct {
	called    bool
	gotBearer string
	gotName   string
	err       error
}

func (f *fakeAuthNameSync) SyncName(_ context.Context, bearer, name string) error {
	f.called, f.gotBearer, f.gotName = true, bearer, name
	return f.err
}

// --- harness -----------------------------------------------------------------

type userHarness struct {
	svc      *Service
	store    *fakeUserStore
	login    *fakeProviderLogin
	authName *fakeAuthNameSync
	key      *rsa.PrivateKey
}

func newUserHarness(t *testing.T, features FeatureConfig) *userHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	store := newFakeUserStore()
	login := &fakeProviderLogin{result: WatchLoginResult{Success: true}}
	authName := &fakeAuthNameSync{}
	svc := NewService(Config{
		Auth:          NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		UserStore:     store,
		ProviderLogin: login,
		AuthNameSync:  authName,
		Features:      features,
	})
	return &userHarness{svc: svc, store: store, login: login, authName: authName, key: key}
}

func (h *userHarness) userToken(t *testing.T, sub string) string {
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
	return s
}

func (h *userHarness) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
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

func (h *userHarness) bearer(t *testing.T, sub string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + h.userToken(t, sub)}
}

// --- GET profile -------------------------------------------------------------

func TestGetProfile_RequiresUserTier(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	// No token → 401.
	if w := h.do(http.MethodGet, "/api/users/me/profile", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("no token: code = %d, want 401", w.Code)
	}
	// Internal token (no user id) → 401: these are "me" endpoints.
	if w := h.do(http.MethodGet, "/api/users/me/profile", "", internalHdr()); w.Code != http.StatusUnauthorized {
		t.Fatalf("internal token: code = %d, want 401", w.Code)
	}
}

func TestGetProfile_EmptyDefaults(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{SyncDataAtOnboarding: true, CoachChatMaxMessageChars: 8000})
	w := h.do(http.MethodGet, "/api/users/me/profile", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp profileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.ID != testSub {
		t.Errorf("id = %q, want %q", resp.ID, testSub)
	}
	if resp.Provider != nil {
		t.Errorf("provider = %v, want nil", *resp.Provider)
	}
	if resp.Profile != nil {
		t.Errorf("profile = %v, want nil", resp.Profile)
	}
	if resp.Onboarding.WatchReady || resp.Onboarding.ProfileReady || resp.Onboarding.CompletedAt != nil {
		t.Errorf("onboarding = %+v, want all-zero", resp.Onboarding)
	}
	if !resp.Features.SyncDataAtOnboarding || resp.Features.CoachChatMaxMessageChars != 8000 {
		t.Errorf("features = %+v, want sync=true chars=8000", resp.Features)
	}
}

func TestGetProfile_WithData(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{CoachChatUsers: map[string]bool{testSub: true}})
	h.store.profiles[testSub] = &storage.UserProfile{
		UserID: testSub, DisplayName: "Zhao", DOB: "1990-05-01", Sex: "male", HeightCm: 178, WeightKg: 70,
	}
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true, ProfileReady: true}
	h.store.provider[testSub] = "coros"

	w := h.do(http.MethodGet, "/api/users/me/profile", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp profileResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.DisplayName != "Zhao" || resp.Profile == nil || resp.Profile.HeightCm != 178 {
		t.Errorf("profile not reflected: %s", w.Body.String())
	}
	if resp.Provider == nil || *resp.Provider != "coros" {
		t.Errorf("provider = %v, want coros", resp.Provider)
	}
	if !resp.Onboarding.WatchReady || !resp.Onboarding.ProfileReady {
		t.Errorf("onboarding flags not reflected: %+v", resp.Onboarding)
	}
	if !resp.Features.CoachChat {
		t.Errorf("coach_chat membership not reflected")
	}
}

// --- POST profile ------------------------------------------------------------

const validProfileBody = `{"display_name":"Zhao","dob":"1990-05-01","sex":"male","height_cm":178,"weight_kg":70}`

func TestPostProfile_Valid(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	w := h.do(http.MethodPost, "/api/users/me/profile", validProfileBody, h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	if h.store.profiles[testSub] == nil || h.store.profiles[testSub].DisplayName != "Zhao" {
		t.Errorf("profile not persisted")
	}
	if o := h.store.onboarding[testSub]; o == nil || !o.ProfileReady {
		t.Errorf("profile_ready not set")
	}
	if !h.authName.called || h.authName.gotName != "Zhao" || h.authName.gotBearer == "" {
		t.Errorf("auth name sync not invoked with bearer+name: %+v", h.authName)
	}
}

func TestPostProfile_ValidationError422(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	// Missing sex, bad dob.
	body := `{"display_name":"Zhao","dob":"not-a-date","height_cm":178,"weight_kg":70}`
	w := h.do(http.MethodPost, "/api/users/me/profile", body, h.bearer(t, testSub))
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422: %s", w.Code, w.Body.String())
	}
	var resp validationErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Detail) == 0 {
		t.Fatalf("expected detail items, got none")
	}
	// Loc must be ["body", <json field name>].
	foundSex := false
	for _, d := range resp.Detail {
		if len(d.Loc) == 2 && d.Loc[0] == "body" && d.Loc[1] == "sex" {
			foundSex = true
		}
	}
	if !foundSex {
		t.Errorf("expected a detail for body.sex, got %+v", resp.Detail)
	}
	if h.store.profiles[testSub] != nil {
		t.Errorf("profile must not be persisted on validation failure")
	}
}

func TestPostProfile_AuthSyncFailureNonFatal(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.authName.err = errors.New("auth-service down")
	w := h.do(http.MethodPost, "/api/users/me/profile", validProfileBody, h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (best-effort sync): %s", w.Code, w.Body.String())
	}
	if h.store.profiles[testSub] == nil {
		t.Errorf("profile must be saved despite auth sync failure")
	}
}

// --- POST watch/login --------------------------------------------------------

func TestWatchLogin_Success(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.login.result = WatchLoginResult{Success: true, UserID: "coros-123", Region: "cn"}
	body := `{"provider":"coros","email":"a@b.com","password":"pw"}`
	w := h.do(http.MethodPost, "/api/users/me/watch/login", body, h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp watchLoginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.OK || resp.UserID != "coros-123" || resp.Region != "cn" {
		t.Errorf("resp = %+v", resp)
	}
	if h.login.gotProvider != "coros" || h.login.gotUser != testSub {
		t.Errorf("login called with provider=%q user=%q", h.login.gotProvider, h.login.gotUser)
	}
	if o := h.store.onboarding[testSub]; o == nil || !o.WatchReady {
		t.Errorf("watch_ready not set")
	}
}

func TestWatchLogin_GarminRegionDefault(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	body := `{"provider":"garmin","email":"a@b.com","password":"pw"}`
	if w := h.do(http.MethodPost, "/api/users/me/watch/login", body, h.bearer(t, testSub)); w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	if h.login.gotRegion != "cn" {
		t.Errorf("garmin region default = %q, want cn", h.login.gotRegion)
	}
}

func TestWatchLogin_UnknownProvider400(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	body := `{"provider":"polar","email":"a@b.com","password":"pw"}`
	if w := h.do(http.MethodPost, "/api/users/me/watch/login", body, h.bearer(t, testSub)); w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", w.Code)
	}
}

func TestWatchLogin_AuthFailure400(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.login.result = WatchLoginResult{Success: false}
	body := `{"provider":"coros","email":"a@b.com","password":"bad"}`
	w := h.do(http.MethodPost, "/api/users/me/watch/login", body, h.bearer(t, testSub))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %s", w.Code, w.Body.String())
	}
	if o := h.store.onboarding[testSub]; o != nil && o.WatchReady {
		t.Errorf("watch_ready must not be set on failed login")
	}
}
