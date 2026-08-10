package api

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
)

// End-to-end: a real HTTP server (httptest) backed by the REAL MySQL store and
// the migrated master_plan data, driven over real HTTP. Gated on
// STRIDE_WORKER_TEST_MYSQL_DSN (the same local docker MySQL the storage tests +
// the migration target). Skipped otherwise.
//
// Real-user UUIDs from src/migration/src/users.js (already committed; they are
// JWT subs, not secrets): a v2 (structured) user, a v1 (markdown) user, and a
// second v2 user that also has a lingering markdown blob (migrated as v2, so it
// has NO active markdown row).
const (
	e2eV2User     = "bef8d1fe-c617-4cc4-9e6f-bf6a8ce79ba9" // dehua — active structured plan
	e2eV1User     = "5ee229a6-cdc1-4260-84d3-71ec622126c2" // pan   — markdown overview only
	e2eV2SlugUser = "ba103cff-ad2c-4f9e-9920-983337544a2c" // gaohan — structured, slug goal_id
)

type e2eServer struct {
	base string
	key  *rsa.PrivateKey
}

func newE2EServer(t *testing.T) *e2eServer {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run the master-plan E2E")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.AutoMigrateMasterPlan(t.Context()); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	svc := NewService(Config{
		Auth:            NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		MasterPlanStore: store,
	})
	srv := httptest.NewServer(svc.Router())
	t.Cleanup(srv.Close)
	return &e2eServer{base: srv.URL, key: key}
}

func (e *e2eServer) token(t *testing.T, sub string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	})
	s, err := tok.SignedString(e.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// get performs a real HTTP GET; sub=="" means no Authorization header.
func (e *e2eServer) get(t *testing.T, path, sub string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, e.base+path, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if sub != "" {
		req.Header.Set("Authorization", "Bearer "+e.token(t, sub))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

func TestE2E_MasterPlanCurrent(t *testing.T) {
	e := newE2EServer(t)

	code, body := e.get(t, "/api/users/me/master-plan/current", e2eV2User)
	if code != http.StatusOK {
		t.Fatalf("v2 current: code=%d body=%s", code, body)
	}
	var envelope map[string]any
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if envelope["content_version"] != float64(2) || envelope["revision"] == nil {
		t.Fatalf("unexpected structured envelope: %v", envelope)
	}
	doc, ok := envelope["plan"].(map[string]any)
	if !ok {
		t.Fatalf("structured plan is not an object")
	}
	for _, k := range []string{"goal", "phases", "milestones", "weeks", "current_phase_id", "current_week_number", "next_milestone"} {
		if _, ok := doc[k]; !ok {
			t.Errorf("v2 plan missing key %q", k)
		}
	}
	if _, present := doc["weekly_key_sessions"]; present {
		t.Errorf("weekly_key_sessions must be dropped")
	}

	if code, _ := e.get(t, "/api/users/me/master-plan/current", e2eV2SlugUser); code != http.StatusOK {
		t.Errorf("v2 slug-goal current: code=%d, want 200", code)
	}

	code, body = e.get(t, "/api/users/me/master-plan/current", e2eV1User)
	if code != http.StatusOK {
		t.Fatalf("v1 current: code=%d body=%s", code, body)
	}
	_ = json.Unmarshal(body, &envelope)
	if envelope["content_version"] != float64(1) || envelope["revision"] != nil {
		t.Fatalf("unexpected markdown envelope: %v", envelope)
	}
	if text, ok := envelope["plan"].(string); !ok || text == "" {
		t.Errorf("v1 markdown plan is empty")
	}

	if code, _ := e.get(t, "/api/users/me/master-plan/current", ""); code != http.StatusUnauthorized {
		t.Errorf("no-auth current: code=%d, want 401", code)
	}
}
