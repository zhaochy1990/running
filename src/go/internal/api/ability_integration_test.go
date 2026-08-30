package api

// Integration test for the ability + race-prediction surface against a real
// MySQL database. Skipped unless STRIDE_TEST_DSN is set (e.g.
// root:root_password@tcp(127.0.0.1:3306)/stride). It runs the real ability
// compute handler for one athlete, then exercises the read endpoints.

import (
	"context"
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

	"github.com/zhaochy1990/stride/internal/handlers/compute"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// f10bc353 is the zhaochaoyi athlete (has activities + calibration HRmax=184).
const itUserID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

type fakeEnqueuer struct{ last job.EnqueueSpec }

func (f *fakeEnqueuer) Enqueue(_ context.Context, spec job.EnqueueSpec) (string, error) {
	f.last = spec
	return "job-integration-1", nil
}

func dbDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("STRIDE_TEST_DSN")
	if dsn == "" {
		t.Skip("STRIDE_TEST_DSN not set; skipping MySQL integration test")
	}
	return dsn
}

func TestAbilityEndToEnd_RealMySQL(t *testing.T) {
	dsn := dbDSN(t)
	ctx := context.Background()
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer store.Close()
	if err := store.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Run the real ability handler (full mode) → persists today's snapshot rows.
	h := compute.NewAbility(store)
	_, err = h(ctx, &job.Job{UserID: itUserID, InputJSON: `{"mode":"full"}`}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("ability handler: %v", err)
	}

	// Read back today's snapshot rows via the store.
	today := timefmtShanghaiToday()
	rows, err := store.AbilitySnapshotForDate(ctx, itUserID, today)
	if err != nil {
		t.Fatalf("snapshot read: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("expected ability_snapshot rows after full compute; got none")
	}
	hasL3Vo2 := false
	for _, r := range rows {
		if r.Level == "L3" && r.Dimension == "vo2max" && r.Value != nil {
			hasL3Vo2 = true
		}
	}
	if !hasL3Vo2 {
		t.Fatal("expected an L3 vo2max score row")
	}

	// Build the API service against the real store.
	key := mustRSAKey(t)
	svc := NewService(Config{
		Auth:                   NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		AbilityStore:           store,
		PredictionStore:        store,
		AbilityBackfillJobType: "ability",
		Enqueuer:               &fakeEnqueuer{},
	})
	router := svc.Router()
	bearer := func(sub string) map[string]string {
		return map[string]string{"Authorization": "Bearer " + itSignToken(t, key, sub)}
	}

	// /ability/current → 200 with a snapshot source.
	{
		r := httptest.NewRequest(http.MethodGet, "/api/"+itUserID+"/ability/current", nil)
		for k, v := range bearer(itUserID) {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("GET /ability/current = %d, body=%s", w.Code, body(w))
		}
		var parsed map[string]any
		json.Unmarshal(w.Body.Bytes(), &parsed)
		if src, _ := parsed["source"].(string); src != "snapshot" {
			t.Fatalf("source = %v, want snapshot", parsed["source"])
		}
	}

	// /ability/current?refresh=1 → 200 (live compute).
	{
		r := httptest.NewRequest(http.MethodGet, "/api/"+itUserID+"/ability/current?refresh=1", nil)
		for k, v := range bearer(itUserID) {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("GET /ability/current?refresh=1 = %d, body=%s", w.Code, body(w))
		}
	}

	// /race-predictions → 200 (no target_gap per decision).
	{
		r := httptest.NewRequest(http.MethodGet, "/api/"+itUserID+"/race-predictions", nil)
		for k, v := range bearer(itUserID) {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("GET /race-predictions = %d, body=%s", w.Code, body(w))
		}
		var parsed map[string]any
		json.Unmarshal(w.Body.Bytes(), &parsed)
		if _, ok := parsed["distances"]; !ok {
			t.Fatalf("race-predictions missing distances: %s", w.Body.String())
		}
		if _, has := parsed["target_gap"]; has {
			t.Fatal("target_gap should be dropped")
		}
	}

	// /ability/history → 200. /ability/weights → 200.
	if w := hit(router, http.MethodGet, "/api/"+itUserID+"/ability/history", bearer(itUserID)); w.Code != http.StatusOK {
		t.Fatalf("GET /ability/history = %d", w.Code)
	}
	if w := hit(router, http.MethodGet, "/api/"+itUserID+"/ability/weights", bearer(itUserID)); w.Code != http.StatusOK {
		t.Fatalf("GET /ability/weights = %d", w.Code)
	}

	// /ability/backfill enqueues an ability job (async).
	q := httptest.NewRequest(http.MethodPost, "/api/"+itUserID+"/ability/backfill?days=7", nil)
	for k, v := range bearer(itUserID) {
		q.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, q)
	if w.Code != http.StatusAccepted {
		t.Fatalf("POST /ability/backfill = %d, body=%s", w.Code, body(w))
	}
}

func hit(router http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, r)
	return w
}

func body(w *httptest.ResponseRecorder) string {
	b, _ := io.ReadAll(w.Body)
	return string(b)
}

func mustRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa key: %v", err)
	}
	return k
}

func itSignToken(t *testing.T, key *rsa.PrivateKey, sub string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	})
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return s
}

// timefmtShanghaiToday returns today in Shanghai as YYYY-MM-DD.
func timefmtShanghaiToday() string {
	return time.Now().In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02")
}
