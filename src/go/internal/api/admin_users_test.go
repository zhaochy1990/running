package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
)

// --- fakes -------------------------------------------------------------------

type fakeAdminDeleter struct {
	called    bool
	gotBearer string
	gotUser   string
	err       error
}

func (f *fakeAdminDeleter) AdminDeleteAccount(_ context.Context, adminBearer, userID string) error {
	f.called, f.gotBearer, f.gotUser = true, adminBearer, userID
	return f.err
}

type fakeCoachDeleter struct {
	called    bool
	gotBearer string
	gotUser   string
	counts    map[string]int64
	err       error
}

func (f *fakeCoachDeleter) DeleteCoachData(_ context.Context, bearer, userID string) (map[string]int64, error) {
	f.called, f.gotBearer, f.gotUser = true, bearer, userID
	return f.counts, f.err
}

type fakeDirRemover struct {
	called   bool
	gotUser  string
	removed  bool
	err      error
	onRemove func()
}

func (f *fakeDirRemover) RemoveUserDir(userID string) (bool, error) {
	f.called, f.gotUser = true, userID
	if f.onRemove != nil {
		f.onRemove()
	}
	return f.removed, f.err
}

type fakeAuditStore struct {
	starts      int
	marked      []string
	status      string
	errMessage  string
	coachCounts *string
	startErr    error
}

func (f *fakeAuditStore) StartUserDeletionAudit(_ context.Context, _ *storage.UserDeletionAudit) error {
	f.starts++
	return f.startErr
}

func (f *fakeAuditStore) MarkUserDeletionStep(_ context.Context, _, step string, _ time.Time) error {
	f.marked = append(f.marked, step)
	return nil
}

func (f *fakeAuditStore) FinishUserDeletionAudit(_ context.Context, _, status, errorMessage string, coachCountsJSON *string) error {
	f.status, f.errMessage, f.coachCounts = status, errorMessage, coachCountsJSON
	return nil
}

type codedHTTPError struct {
	status int
	code   string
}

func (e codedHTTPError) Error() string   { return "coded error " + e.code }
func (e codedHTTPError) HTTPStatus() int { return e.status }
func (e codedHTTPError) ErrorCode() string {
	return e.code
}

// --- harness -----------------------------------------------------------------

type adminDeleteHarness struct {
	svc       *Service
	store     *fakeUserStore
	adminAuth *fakeAdminDeleter
	coach     *fakeCoachDeleter
	dirs      *fakeDirRemover
	audit     *fakeAuditStore
	key       *rsa.PrivateKey
}

func newAdminDeleteHarness(t *testing.T) *adminDeleteHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	store := newFakeUserStore()
	adminAuth := &fakeAdminDeleter{}
	coach := &fakeCoachDeleter{counts: map[string]int64{"checkpoints": 3}}
	dirs := &fakeDirRemover{removed: true}
	audit := &fakeAuditStore{}
	svc := NewService(Config{
		Auth:                NewAuthenticator(testToken, verifier),
		UserStore:           store,
		AccountDeleter:      &fakeAccountDeleter{},
		AdminAccountDeleter: adminAuth,
		CoachDataDeleter:    coach,
		UserDataDirRemover:  dirs,
		DeletionAuditStore:  audit,
	})
	return &adminDeleteHarness{svc: svc, store: store, adminAuth: adminAuth, coach: coach, dirs: dirs, audit: audit, key: key}
}

func (h *adminDeleteHarness) token(t *testing.T, audience, role string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": testSub, "iss": testIssuer, "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
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

func (h *adminDeleteHarness) adminToken(t *testing.T) map[string]string {
	return h.token(t, testAdminAudience, "admin")
}

func (h *adminDeleteHarness) do(method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

const targetSub = "22222222-2222-4222-8222-222222222222"

// --- tests -------------------------------------------------------------------

func TestAdminDeleteUser_TierGuards(t *testing.T) {
	cases := []struct {
		name    string
		headers func(*adminDeleteHarness, *testing.T) map[string]string
		want    int
	}{
		{"no token", func(*adminDeleteHarness, *testing.T) map[string]string { return nil }, http.StatusUnauthorized},
		{"internal token", func(*adminDeleteHarness, *testing.T) map[string]string { return internalHdr() }, http.StatusForbidden},
		{"user token", func(h *adminDeleteHarness, t *testing.T) map[string]string { return h.token(t, testAudience, "") }, http.StatusForbidden},
		{"admin token", func(h *adminDeleteHarness, t *testing.T) map[string]string { return h.adminToken(t) }, http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newAdminDeleteHarness(t)
			w := h.do(http.MethodDelete, "/api/admin/users/"+targetSub, tc.headers(h, t))
			if w.Code != tc.want {
				t.Fatalf("code = %d, want %d (body=%s)", w.Code, tc.want, w.Body.String())
			}
			if tc.want != http.StatusNoContent && (h.adminAuth.called || h.store.deletedUser != "") {
				t.Fatal("rejected request must not touch downstream dependencies")
			}
		})
	}
}

func TestAdminDeleteUser_HappyPathOrderAndAudit(t *testing.T) {
	h := newAdminDeleteHarness(t)
	h.store.profiles[targetSub] = &storage.UserProfile{UserID: targetSub}

	w := h.do(http.MethodDelete, "/api/admin/users/"+targetSub, h.adminToken(t))
	if w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204 (body=%s)", w.Code, w.Body.String())
	}
	if !h.adminAuth.called || h.adminAuth.gotUser != targetSub || h.adminAuth.gotBearer == "" {
		t.Fatalf("admin auth delete not called correctly: %+v", h.adminAuth)
	}
	if !h.coach.called || h.coach.gotUser != targetSub {
		t.Fatalf("coach delete not called correctly: %+v", h.coach)
	}
	if h.store.deletedUser != targetSub {
		t.Fatalf("stride data not deleted: %q", h.store.deletedUser)
	}
	if !h.dirs.called || h.dirs.gotUser != targetSub {
		t.Fatalf("data dir not removed: %+v", h.dirs)
	}
	if h.audit.starts != 1 || h.audit.status != storage.DeletionStatusCompleted {
		t.Fatalf("audit = %+v, want one completed attempt", h.audit)
	}
	wantSteps := []string{storage.DeletionStepAuth, storage.DeletionStepCoach, storage.DeletionStepStride, storage.DeletionStepFiles}
	if len(h.audit.marked) != len(wantSteps) {
		t.Fatalf("marked steps = %v, want %v", h.audit.marked, wantSteps)
	}
	for i, step := range wantSteps {
		if h.audit.marked[i] != step {
			t.Fatalf("marked steps = %v, want %v", h.audit.marked, wantSteps)
		}
	}
	if h.audit.coachCounts == nil || *h.audit.coachCounts == "" {
		t.Fatal("coach deletion counts were not recorded in audit")
	}
}

func TestAdminDeleteUser_AuthRejectionLeavesDataUntouched(t *testing.T) {
	h := newAdminDeleteHarness(t)
	h.adminAuth.err = codedHTTPError{status: http.StatusConflict, code: "user_owns_teams"}

	w := h.do(http.MethodDelete, "/api/admin/users/"+targetSub, h.adminToken(t))
	if w.Code != http.StatusConflict {
		t.Fatalf("code = %d, want 409 (body=%s)", w.Code, w.Body.String())
	}
	if h.coach.called || h.store.deletedUser != "" || h.dirs.called {
		t.Fatal("a rejected identity deletion must abort before any destructive step")
	}
	if h.audit.status != storage.DeletionStatusPartial || h.audit.errMessage == "" {
		t.Fatalf("audit = %+v, want partial with error", h.audit)
	}
}

func TestAdminDeleteUser_MissingIdentityStillCleans(t *testing.T) {
	h := newAdminDeleteHarness(t)
	h.adminAuth.err = codedHTTPError{status: http.StatusNotFound, code: "user_not_found"}

	w := h.do(http.MethodDelete, "/api/admin/users/"+targetSub, h.adminToken(t))
	if w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204 (body=%s)", w.Code, w.Body.String())
	}
	if h.store.deletedUser != targetSub || !h.coach.called || !h.dirs.called {
		t.Fatal("a 404 identity must not stop the remaining cleanup")
	}
}

func TestAdminDeleteUser_CoachFailureIsPartialAndStopsBeforeStride(t *testing.T) {
	h := newAdminDeleteHarness(t)
	h.coach.err = errors.New("connection refused")

	w := h.do(http.MethodDelete, "/api/admin/users/"+targetSub, h.adminToken(t))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503 (body=%s)", w.Code, w.Body.String())
	}
	if h.store.deletedUser != "" || h.dirs.called {
		t.Fatal("coach failure must abort before STRIDE data and files are deleted")
	}
	if h.audit.status != storage.DeletionStatusPartial {
		t.Fatalf("audit status = %q, want partial", h.audit.status)
	}
	if len(h.audit.marked) != 1 || h.audit.marked[0] != storage.DeletionStepAuth {
		t.Fatalf("marked = %v, want only auth", h.audit.marked)
	}
}

func TestAdminDeleteUser_InvalidTarget(t *testing.T) {
	h := newAdminDeleteHarness(t)
	w := h.do(http.MethodDelete, "/api/admin/users/not-a-uuid", h.adminToken(t))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", w.Code)
	}
	if h.adminAuth.called {
		t.Fatal("invalid target must be rejected before any deletion")
	}
}

func TestDeleteAccount_SelfDeleteClearsCoachToo(t *testing.T) {
	h := newAdminDeleteHarness(t)
	w := h.do(http.MethodDelete, "/api/users/me", h.token(t, testAudience, ""))
	if w.Code != http.StatusNoContent {
		t.Fatalf("code = %d, want 204 (body=%s)", w.Code, w.Body.String())
	}
	if !h.coach.called || h.coach.gotUser != testSub {
		t.Fatalf("self-delete did not clear coach data: %+v", h.coach)
	}
	if h.adminAuth.called {
		t.Fatal("self-delete must use the self auth path, not the admin endpoint")
	}
	if h.store.deletedUser != testSub {
		t.Fatalf("self-delete did not clear STRIDE data: %q", h.store.deletedUser)
	}
}
