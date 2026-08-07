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

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

const testSub = "11111111-1111-4111-8111-111111111111"

func stringPtr(s string) *string { return &s }

// --- fakes -------------------------------------------------------------------

type fakeUserStore struct {
	profiles         map[string]*storage.UserProfile
	onboarding       map[string]*storage.UserOnboarding
	provider         map[string]string
	credentials      map[string]*storage.ProviderCredential
	devices          map[string]string
	meta             map[string]string
	upsertErr        error
	allowReplacement bool
}

func newFakeUserStore() *fakeUserStore {
	return &fakeUserStore{
		profiles:    map[string]*storage.UserProfile{},
		onboarding:  map[string]*storage.UserOnboarding{},
		provider:    map[string]string{},
		credentials: map[string]*storage.ProviderCredential{},
		devices:     map[string]string{},
		meta:        map[string]string{},
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
	for key := range f.credentials {
		if strings.HasPrefix(key, uid+"|") {
			o := f.onboarding[uid]
			if o == nil {
				o = &storage.UserOnboarding{UserID: uid}
			}
			o.WatchReady = true
			f.onboarding[uid] = o
			return nil
		}
	}
	return storage.ErrNoProviderCredential
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

func credKey(uid, provider string) string { return uid + "|" + provider }

func (f *fakeUserStore) GetCredential(_ context.Context, uid, provider string) (*storage.ProviderCredential, error) {
	return f.credentials[credKey(uid, provider)], nil
}

func (f *fakeUserStore) LatestActivityDevice(_ context.Context, uid string) (string, bool, error) {
	d, ok := f.devices[uid]
	return d, ok, nil
}

func (f *fakeUserStore) GetMeta(_ context.Context, uid, key string) (string, bool, error) {
	v, ok := f.meta[uid+"|"+key]
	return v, ok, nil
}

// DeleteCredential removes the credential and the provider binding it drives, so
// a subsequent ProviderForUser reports not-found (mirrors the real store, where
// deleting the row clears the binding).
func (f *fakeUserStore) DeleteCredential(_ context.Context, uid, provider string) error {
	delete(f.credentials, credKey(uid, provider))
	delete(f.provider, uid)
	return nil
}

func (f *fakeUserStore) ClearWatchReady(_ context.Context, uid string) error {
	o := f.onboarding[uid]
	if o == nil {
		o = &storage.UserOnboarding{UserID: uid}
	}
	o.WatchReady = false
	o.CompletedAt = nil
	o.OnboardingRunID = nil
	f.onboarding[uid] = o
	return nil
}

func (f *fakeUserStore) SetOnboardingRun(_ context.Context, uid, runID string) error {
	o := f.onboarding[uid]
	if o == nil {
		o = &storage.UserOnboarding{UserID: uid}
	}
	o.OnboardingRunID = stringPtr(runID)
	o.CompletedAt = nil
	f.onboarding[uid] = o
	return nil
}

func (f *fakeUserStore) ClaimOnboardingRun(_ context.Context, uid, runID string, _ time.Time) (bool, error) {
	o := f.onboarding[uid]
	if o == nil || o.CompletedAt != nil || (o.OnboardingRunID != nil && !f.allowReplacement) {
		return false, nil
	}
	o.OnboardingRunID = stringPtr(runID)
	o.CompletedAt = nil
	f.onboarding[uid] = o
	return true, nil
}

func (f *fakeUserStore) ClearOnboardingRun(_ context.Context, uid, runID string) error {
	o := f.onboarding[uid]
	if o != nil && o.OnboardingRunID != nil && *o.OnboardingRunID == runID {
		o.OnboardingRunID = nil
	}
	return nil
}

func (f *fakeUserStore) CompleteOnboardingRun(_ context.Context, uid, runID string) error {
	o := f.onboarding[uid]
	if o != nil && o.WatchReady && o.OnboardingRunID != nil && *o.OnboardingRunID == runID {
		now := time.Now().UTC()
		o.CompletedAt = &now
	}
	return nil
}

// fakeProviderInfo returns canned static provider metadata for GET /watch.
type fakeProviderInfo struct {
	displayName  string
	capabilities []string
	err          error
}

func (f *fakeProviderInfo) Info(string) (string, []string, error) {
	if f.err != nil {
		return "", nil, f.err
	}
	return f.displayName, f.capabilities, nil
}

type fakeProviderLogin struct {
	result      WatchLoginResult
	err         error
	gotProvider string
	gotUser     string
	gotRegion   string
	store       *fakeUserStore
}

func (f *fakeProviderLogin) Login(_ context.Context, providerName, userID, email, password, region string) (WatchLoginResult, error) {
	f.gotProvider, f.gotUser, f.gotRegion = providerName, userID, region
	if f.err != nil {
		return WatchLoginResult{}, f.err
	}
	if f.result.Success && f.store != nil {
		f.store.provider[userID] = providerName
		f.store.credentials[credKey(userID, providerName)] = &storage.ProviderCredential{UserID: userID, Provider: providerName, Secret: []byte("token")}
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

type fakeJobGetter struct{ rows map[string]*job.Job }

func (f *fakeJobGetter) Get(_ context.Context, id string) (*job.Job, error) {
	j, ok := f.rows[id]
	if !ok {
		return nil, &job.ErrNotFound{Key: id}
	}
	cp := *j
	return &cp, nil
}

type userHarness struct {
	svc          *Service
	store        *fakeUserStore
	runs         *fakeRuns
	jobs         *fakeJobGetter
	login        *fakeProviderLogin
	providerInfo *fakeProviderInfo
	authName     *fakeAuthNameSync
	key          *rsa.PrivateKey
}

func newUserHarness(t *testing.T, features FeatureConfig) *userHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	store := newFakeUserStore()
	runs := newFakeRuns()
	jobs := &fakeJobGetter{rows: map[string]*job.Job{}}
	login := &fakeProviderLogin{result: WatchLoginResult{Success: true}, store: store}
	providerInfo := &fakeProviderInfo{displayName: "高驰", capabilities: []string{"sync_hrv_detail"}}
	authName := &fakeAuthNameSync{}
	svc := NewService(Config{
		Auth:             NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		Pipelines:        runs,
		Runs:             runs,
		Jobs:             jobs,
		RunsList:         runs,
		RunsIdem:         runs,
		SyncPipelineFull: "onboarding",
		UserStore:        store,
		ProviderLogin:    login,
		ProviderInfo:     providerInfo,
		AuthNameSync:     authName,
		Features:         features,
	})
	return &userHarness{svc: svc, store: store, runs: runs, jobs: jobs, login: login, providerInfo: providerInfo, authName: authName, key: key}
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
	if cred := h.store.credentials[credKey(testSub, "coros")]; cred == nil {
		t.Error("successful login must persist a credential before readiness")
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

// --- GET watch ---------------------------------------------------------------

func TestWatch_RequiresUserTier(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		if w := h.do(method, "/api/users/me/watch", "", nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s no token: code = %d, want 401", method, w.Code)
		}
		if w := h.do(method, "/api/users/me/watch", "", internalHdr()); w.Code != http.StatusUnauthorized {
			t.Errorf("%s internal token: code = %d, want 401", method, w.Code)
		}
	}
}

func TestGetWatch_NoWatchBound(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	w := h.do(http.MethodGet, "/api/users/me/watch", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp watchInfoResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Provider != nil || resp.LoggedIn {
		t.Errorf("want unbound/not-logged-in, got %+v", resp)
	}
	if resp.Capabilities == nil || len(resp.Capabilities) != 0 {
		t.Errorf("capabilities = %v, want [] (never null)", resp.Capabilities)
	}
}

func TestGetWatch_WithData(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	email := "a@b.com"
	h.store.provider[testSub] = "coros"
	h.store.credentials[credKey(testSub, "coros")] = &storage.ProviderCredential{
		UserID: testSub, Provider: "coros", Email: &email, Secret: []byte("token"),
	}
	h.store.devices[testSub] = "COROS PACE 3"
	h.store.meta[testSub+"|"+storage.MetaKeyLastSyncTime] = "2026-05-01T10:00:00Z"
	h.providerInfo.displayName = "高驰"
	h.providerInfo.capabilities = []string{"sync_hrv_detail"}

	w := h.do(http.MethodGet, "/api/users/me/watch", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp watchInfoResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Provider == nil || *resp.Provider != "coros" {
		t.Errorf("provider = %v, want coros", resp.Provider)
	}
	if resp.ProviderDisplayName == nil || *resp.ProviderDisplayName != "高驰" {
		t.Errorf("provider_display_name = %v, want 高驰", resp.ProviderDisplayName)
	}
	if !resp.LoggedIn {
		t.Errorf("logged_in = false, want true (credential has a secret)")
	}
	if resp.Email == nil || *resp.Email != email {
		t.Errorf("email = %v, want %q", resp.Email, email)
	}
	if resp.Device == nil || *resp.Device != "COROS PACE 3" {
		t.Errorf("device = %v, want 'COROS PACE 3'", resp.Device)
	}
	if resp.LastSyncAt == nil || *resp.LastSyncAt != "2026-05-01T10:00:00Z" {
		t.Errorf("last_sync_at = %v, want the stamped time", resp.LastSyncAt)
	}
	if len(resp.Capabilities) != 1 || resp.Capabilities[0] != "sync_hrv_detail" {
		t.Errorf("capabilities = %v, want [sync_hrv_detail]", resp.Capabilities)
	}
}

func TestGetWatch_PresenceOnlyLoggedIn(t *testing.T) {
	// A credential row with no secret blob is 'not logged in' (presence-only).
	h := newUserHarness(t, FeatureConfig{})
	email := "a@b.com"
	h.store.provider[testSub] = "coros"
	h.store.credentials[credKey(testSub, "coros")] = &storage.ProviderCredential{
		UserID: testSub, Provider: "coros", Email: &email, Secret: nil,
	}
	w := h.do(http.MethodGet, "/api/users/me/watch", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp watchInfoResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.LoggedIn {
		t.Errorf("logged_in = true, want false when secret is empty")
	}
	if resp.Email == nil || *resp.Email != email {
		t.Errorf("email should still be reported: %v", resp.Email)
	}
}

// --- DELETE watch ------------------------------------------------------------

func TestDeleteWatch_NoWatchBound400(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	w := h.do(http.MethodDelete, "/api/users/me/watch", "", h.bearer(t, testSub))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %s", w.Code, w.Body.String())
	}
}

func TestDeleteWatch_WithoutOnboardingRowCreatesClearedState(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.provider[testSub] = "coros"
	h.store.credentials[credKey(testSub, "coros")] = &storage.ProviderCredential{UserID: testSub, Provider: "coros", Secret: []byte("token")}

	w := h.do(http.MethodDelete, "/api/users/me/watch", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	if cred := h.store.credentials[credKey(testSub, "coros")]; cred != nil {
		t.Errorf("credential must be deleted on disconnect")
	}
	o := h.store.onboarding[testSub]
	if o == nil || o.WatchReady || o.ProfileReady || o.OnboardingRunID != nil || o.CompletedAt != nil {
		t.Errorf("missing-row disconnect must create cleared onboarding state: %+v", o)
	}
}

func TestDeleteWatch_Success(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	email := "a@b.com"
	h.store.provider[testSub] = "coros"
	h.store.credentials[credKey(testSub, "coros")] = &storage.ProviderCredential{
		UserID: testSub, Provider: "coros", Email: &email, Secret: []byte("token"),
	}
	completed := time.Now().UTC()
	h.store.onboarding[testSub] = &storage.UserOnboarding{
		UserID: testSub, WatchReady: true, ProfileReady: true, CompletedAt: &completed,
	}

	w := h.do(http.MethodDelete, "/api/users/me/watch", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp disconnectWatchResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.OK || resp.Provider != "coros" {
		t.Errorf("resp = %+v, want {ok:true, provider:coros}", resp)
	}
	// Credential deleted.
	if h.store.credentials[credKey(testSub, "coros")] != nil {
		t.Errorf("credential must be deleted on disconnect")
	}
	o := h.store.onboarding[testSub]
	if o == nil || o.WatchReady {
		t.Errorf("watch_ready must be cleared on disconnect: %+v", o)
	}
	// Profile remains, but watch-dependent onboarding completion is cleared.
	if o != nil && !o.ProfileReady {
		t.Errorf("profile_ready must be retained on disconnect")
	}
	if o != nil && o.CompletedAt != nil {
		t.Errorf("completed_at must be cleared on disconnect")
	}
	if o != nil && o.OnboardingRunID != nil {
		t.Errorf("onboarding run must be cleared on disconnect")
	}
}

// --- onboarding completion ----------------------------------------------------

func TestOnboardingComplete_StartsFullPipelineAndReportsProgress(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true}

	w := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp onboardingCompleteResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.State != "running" || resp.Progress == nil || resp.Progress.Phase != "queued" || resp.Progress.Percent != 0 {
		t.Fatalf("response = %+v, want queued running progress", resp)
	}
	o := h.store.onboarding[testSub]
	if o.OnboardingRunID == nil {
		t.Fatal("onboarding run id was not persisted")
	}
	run, err := h.runs.Get(context.Background(), *o.OnboardingRunID)
	if err != nil || run.Name != "onboarding" || run.UserID != testSub {
		t.Fatalf("run = %+v, err = %v", run, err)
	}
}

func TestOnboardingComplete_RequiresConnectedWatchOnly(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	w := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %s", w.Code, w.Body.String())
	}
	if len(h.runs.byID) != 0 {
		t.Fatal("pipeline must not start without watch readiness")
	}
}

func TestOnboardingComplete_RejectsRequestBody(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true}
	w := h.do(http.MethodPost, "/api/users/me/onboarding/complete", `{}`, h.bearer(t, testSub))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %s", w.Code, w.Body.String())
	}
	if len(h.runs.byID) != 0 {
		t.Fatal("pipeline must not start when a body is supplied")
	}
}

func TestOnboardingComplete_PreCreateFailureReleasesClaimForImmediateRetry(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true}
	h.runs.startErr = errors.New("pipeline store unavailable")

	first := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if first.Code != http.StatusInternalServerError {
		t.Fatalf("first code = %d, want 500: %s", first.Code, first.Body.String())
	}
	if claim := h.store.onboarding[testSub].OnboardingRunID; claim != nil {
		t.Fatalf("pre-create failure must release exact claim, got %q", *claim)
	}

	h.runs.startErr = nil
	second := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if second.Code != http.StatusOK {
		t.Fatalf("retry code = %d, want 200: %s", second.Code, second.Body.String())
	}
	if len(h.runs.byID) != 1 || h.store.onboarding[testSub].OnboardingRunID == nil {
		t.Fatalf("retry must create one durable run with a claim: runs=%d claim=%v", len(h.runs.byID), h.store.onboarding[testSub].OnboardingRunID)
	}
}

func TestOnboardingComplete_FreshMissingRunClaimReturnsQueuedWithoutDuplicate(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true, OnboardingRunID: stringPtr("claimed-run")}

	w := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp onboardingCompleteResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.State != "running" || resp.Progress == nil || resp.Progress.Phase != "queued" {
		t.Fatalf("response = %+v, want queued running", resp)
	}
	if len(h.runs.byID) != 0 {
		t.Fatalf("runs = %d, want no duplicate run", len(h.runs.byID))
	}
}

func TestOnboardingComplete_PublishFailureProjectsDurableFailureAndRetainsClaim(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true}
	h.runs.startAfterCreateErr = &job.PublishFailedError{JobID: "job-1", Err: errors.New("broker unavailable")}

	first := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if first.Code != http.StatusOK {
		t.Fatalf("first code = %d, want 200: %s", first.Code, first.Body.String())
	}
	var resp onboardingCompleteResponse
	if err := json.Unmarshal(first.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.State != "failed" || resp.Progress == nil || resp.Progress.Phase != "error" {
		t.Fatalf("durable post-create failure must project terminal run state: %+v", resp)
	}
	claim := h.store.onboarding[testSub].OnboardingRunID
	if claim == nil || len(h.runs.byID) != 1 || h.runs.byID[*claim].Status != job.StatusFailed {
		t.Fatalf("durable failed start must retain failed claim/run: claim=%v runs=%d", claim, len(h.runs.byID))
	}
}

func TestOnboardingComplete_ReplacesFailedRun(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.allowReplacement = true
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true, OnboardingRunID: stringPtr("failed-run")}
	h.runs.seedRun(&job.PipelineRun{RunID: "failed-run", UserID: testSub, Name: "onboarding", Status: job.StatusFailed})

	w := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	if got := h.store.onboarding[testSub].OnboardingRunID; got == nil || *got == "failed-run" {
		t.Fatalf("onboarding_run_id = %v, want replacement run", got)
	}
	if len(h.runs.byID) != 2 {
		t.Fatalf("runs = %d, want failed plus replacement", len(h.runs.byID))
	}
}

func TestOnboardingComplete_ReplacesStaleRun(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.allowReplacement = true
	stale := time.Now().UTC().Add(-10 * time.Minute)
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true, OnboardingRunID: stringPtr("stale-run")}
	h.runs.seedRun(&job.PipelineRun{RunID: "stale-run", UserID: testSub, Name: "onboarding", Status: job.StatusRunning, UpdatedAt: stale})

	w := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	if got := h.store.onboarding[testSub].OnboardingRunID; got == nil || *got == "stale-run" {
		t.Fatalf("onboarding_run_id = %v, want replacement run", got)
	}
}

func TestOnboardingComplete_AcceptsEmptyChunkedBody(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true}
	req := httptest.NewRequest(http.MethodPost, "/api/users/me/onboarding/complete", strings.NewReader(""))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer "+h.userToken(t, testSub))
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
}

func TestOnboardingComplete_RejectsChunkedRequestBody(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true}
	req := httptest.NewRequest(http.MethodPost, "/api/users/me/onboarding/complete", strings.NewReader(`{}`))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer "+h.userToken(t, testSub))
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %s", w.Code, w.Body.String())
	}
	if len(h.runs.byID) != 0 {
		t.Fatal("pipeline must not start when a chunked body is supplied")
	}
}

func TestOnboardingComplete_ActiveRunIsSingleFlight(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true}
	first := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if first.Code != http.StatusOK {
		t.Fatalf("first code = %d: %s", first.Code, first.Body.String())
	}
	second := h.do(http.MethodPost, "/api/users/me/onboarding/complete", "", h.bearer(t, testSub))
	if second.Code != http.StatusOK {
		t.Fatalf("second code = %d: %s", second.Code, second.Body.String())
	}
	if len(h.runs.byID) != 1 {
		t.Fatalf("runs = %d, want one active run", len(h.runs.byID))
	}
}

func TestSyncStatus_MapsRunStatesAndHidesInternalErrors(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true, OnboardingRunID: stringPtr("run-1")}
	h.runs.seedRun(&job.PipelineRun{
		RunID: "run-1", UserID: testSub, Name: "onboarding", Status: job.StatusRunning,
		Steps: []job.PipelineStep{{Name: "sync", Status: job.StatusRunning, JobID: "job-1"}},
	})
	w := h.do(http.MethodGet, "/api/users/me/sync-status", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("running code = %d: %s", w.Code, w.Body.String())
	}
	var running syncStatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &running); err != nil {
		t.Fatalf("decode running: %v", err)
	}
	if running.State == nil || *running.State != "running" || running.Progress == nil || running.Progress.Phase != "sync" {
		t.Fatalf("running response = %+v", running)
	}

	h.runs.byID["run-1"].Status = job.StatusFailed
	h.runs.byID["run-1"].ErrorMessage = "mysql password leaked"
	w = h.do(http.MethodGet, "/api/users/me/sync-status", "", h.bearer(t, testSub))
	var failed syncStatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &failed); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if failed.State == nil || *failed.State != "error" || failed.Error != publicOnboardingError {
		t.Fatalf("failed response = %+v", failed)
	}
}

func TestSyncStatus_AbsentReturnsNullFields(t *testing.T) {
	for _, onboarding := range []*storage.UserOnboarding{
		nil,
		{UserID: testSub, WatchReady: true, OnboardingRunID: stringPtr("missing-run")},
	} {
		h := newUserHarness(t, FeatureConfig{})
		if onboarding != nil {
			h.store.onboarding[testSub] = onboarding
		}
		w := h.do(http.MethodGet, "/api/users/me/sync-status", "", h.bearer(t, testSub))
		if w.Code != http.StatusOK {
			t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
		}
		if got := strings.TrimSpace(w.Body.String()); got != `{"state":null,"progress":null}` {
			t.Fatalf("response = %s, want null state and progress fields", got)
		}
	}
}

func TestSyncStatus_ActiveHeartbeatPreventsStaleError(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	stale := time.Now().UTC().Add(-10 * time.Minute)
	recent := time.Now().UTC()
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true, OnboardingRunID: stringPtr("run-1")}
	h.runs.seedRun(&job.PipelineRun{RunID: "run-1", UserID: testSub, Name: "onboarding", Status: job.StatusRunning, UpdatedAt: stale, Steps: []job.PipelineStep{{Name: "sync", Status: job.StatusRunning, JobID: "job-1"}}})
	h.jobs.rows["job-1"] = &job.Job{ID: "job-1", Status: job.StatusRunning, UpdatedAt: recent, Stage: "syncing", ProgressPct: 50}
	w := h.do(http.MethodGet, "/api/users/me/sync-status", "", h.bearer(t, testSub))
	var resp syncStatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if w.Code != http.StatusOK || resp.State == nil || *resp.State != "running" || resp.Progress == nil || resp.Progress.Phase != "syncing" {
		t.Fatalf("response = %d %+v", w.Code, resp)
	}
}

func TestSyncStatus_CompletedOnboardingWithoutRunReturnsDone(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	now := time.Now().UTC()
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true, CompletedAt: &now}

	w := h.do(http.MethodGet, "/api/users/me/sync-status", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var resp syncStatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.State == nil || *resp.State != "done" || resp.Progress == nil || resp.Progress.Percent != 100 {
		t.Fatalf("response = %+v", resp)
	}
}

func TestSyncStatus_CompletedOnboardingReturnsDone(t *testing.T) {
	h := newUserHarness(t, FeatureConfig{})
	now := time.Now().UTC()
	h.store.onboarding[testSub] = &storage.UserOnboarding{UserID: testSub, WatchReady: true, CompletedAt: &now, OnboardingRunID: stringPtr("run-1")}
	h.runs.seedRun(&job.PipelineRun{RunID: "run-1", UserID: testSub, Name: "onboarding", Status: job.StatusDone})
	w := h.do(http.MethodGet, "/api/users/me/sync-status", "", h.bearer(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var resp syncStatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.State == nil || *resp.State != "done" || resp.Progress == nil || resp.Progress.Percent != 100 {
		t.Fatalf("response = %+v", resp)
	}
}
