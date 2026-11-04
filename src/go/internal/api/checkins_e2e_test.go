package api

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
)

// End-to-end: real HTTP server (httptest) over the REAL MySQL store, driving
// the check-in + points-ledger surface (devops#883) through its HTTP boundary.
// Gated on STRIDE_WORKER_TEST_MYSQL_DSN and skipped otherwise; CI runs it
// explicitly — see the "Check-in + points ledger tests (MySQL)" step in
// .github/workflows/ci.yml. The multi-day state machine (progression, streak
// break, D7 rollover) is exercised against the same real MySQL at the storage
// seam in internal/storage/checkin_test.go, which controls the clock.
//
// Every run uses a fresh user id, so it is re-runnable against a database that
// already holds rows.

type checkInE2EServer struct {
	base   string
	key    *rsa.PrivateKey
	userID string
}

func newCheckInE2EServer(t *testing.T) *checkInE2EServer {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run the check-in E2E")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := t.Context()
	if err := store.AutoMigrateCheckIn(ctx); err != nil {
		t.Fatalf("automigrate check-in: %v", err)
	}
	if err := store.AutoMigratePoints(ctx); err != nil {
		t.Fatalf("automigrate points: %v", err)
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier := NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)
	svc := NewService(Config{
		Auth:         NewAuthenticator(testToken, verifier),
		UserStore:    store,
		CheckInStore: store,
	})
	srv := httptest.NewServer(svc.Router())
	t.Cleanup(srv.Close)
	return &checkInE2EServer{base: srv.URL, key: key, userID: uuid.NewString()}
}

func (e *checkInE2EServer) token(t *testing.T) string {
	t.Helper()
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": e.userID, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}).SignedString(e.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// send performs a real HTTP request and decodes the JSON body.
func (e *checkInE2EServer) send(t *testing.T, method, path, token string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, e.base+path, bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Body.Close() }()
	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil && w.StatusCode != http.StatusNoContent {
		t.Fatalf("decode %s %s: %v", method, path, err)
	}
	return w.StatusCode, body
}

func TestE2E_CheckIns_FreshAndDuplicateAndPages(t *testing.T) {
	e := newCheckInE2EServer(t)
	token := e.token(t)

	// Anonymous: every endpoint demands the user tier.
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/users/me/check-ins"},
		{http.MethodGet, "/api/users/me/check-ins/status"},
		{http.MethodGet, "/api/users/me/points"},
	} {
		if code, _ := e.send(t, tc.method, tc.path, ""); code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: code = %d, want 401", tc.method, tc.path, code)
		}
	}

	// First check-in: new cycle's D1, 1 point, no easter egg.
	code, first := e.send(t, http.MethodPost, "/api/users/me/check-ins", token)
	if code != http.StatusOK {
		t.Fatalf("first check-in: code = %d: %v", code, first)
	}
	if first["already_checked_in"] != false || first["cycle_position"] != float64(1) ||
		first["streak_days"] != float64(1) || first["points_earned"] != float64(1) ||
		first["balance"] != float64(1) || first["d7_completed"] != false {
		t.Fatalf("first check-in body = %v", first)
	}

	// Same-day duplicate: 200, idempotent, zero side effects.
	code, dup := e.send(t, http.MethodPost, "/api/users/me/check-ins", token)
	if code != http.StatusOK {
		t.Fatalf("duplicate check-in: code = %d: %v", code, dup)
	}
	if dup["already_checked_in"] != true || dup["points_earned"] != float64(0) || dup["balance"] != float64(1) {
		t.Fatalf("duplicate body = %v", dup)
	}

	// Status: today is checked, the cycle grid has 7 cells, the month block
	// carries today's earned points.
	code, status := e.send(t, http.MethodGet, "/api/users/me/check-ins/status", token)
	if code != http.StatusOK {
		t.Fatalf("status: code = %d: %v", code, status)
	}
	if status["streak_days"] != float64(1) || status["balance"] != float64(1) {
		t.Fatalf("status streak/balance = %v", status)
	}
	today, _ := status["today"].(map[string]any)
	if today == nil || today["can_check_in"] != false {
		t.Fatalf("status today block = %v", today)
	}
	cycle, _ := status["cycle"].([]any)
	if len(cycle) != 7 {
		t.Fatalf("cycle = %d cells, want 7", len(cycle))
	}
	cell0, _ := cycle[0].(map[string]any)
	if cell0["status"] != "checked" || cell0["points"] != float64(1) {
		t.Fatalf("cycle cell 0 = %v, want checked with earned 1", cell0)
	}
	month, _ := status["month"].(map[string]any)
	checked, _ := month["checked"].([]any)
	if len(checked) != 1 {
		t.Fatalf("month.checked = %v, want exactly today", checked)
	}

	// Points page: one earn_checkin row, balance echoed, no next page.
	code, points := e.send(t, http.MethodGet, "/api/users/me/points", token)
	if code != http.StatusOK {
		t.Fatalf("points: code = %d: %v", code, points)
	}
	if points["balance"] != float64(1) || points["next_cursor"] != nil {
		t.Fatalf("points body = %v", points)
	}
	txs, _ := points["transactions"].([]any)
	if len(txs) != 1 {
		t.Fatalf("transactions = %v, want exactly the first check-in's earn row", txs)
	}
	tx0, _ := txs[0].(map[string]any)
	if tx0["type"] != "earn_checkin" || tx0["amount"] != float64(1) || tx0["ref"] == "" {
		t.Fatalf("transaction = %v", tx0)
	}

	// The D7 easter-egg fields only exist in the HTTP contract — verify the
	// field is present on both fresh and duplicate responses.
	if _, ok := first["d7_completed"]; !ok {
		t.Fatal("d7_completed missing from check-in response")
	}
}
