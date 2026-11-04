package api

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
)

// End-to-end: real HTTP server (httptest) over the REAL MySQL store, driving
// the points shop / redemption / address-book surface (devops#884) through its
// HTTP boundary. Gated on STRIDE_WORKER_TEST_MYSQL_DSN and skipped otherwise;
// CI runs it explicitly — see the "Points-shop + address book tests (MySQL)"
// step in .github/workflows/ci.yml. The transaction-level concurrency proofs
// (limit bypass, oversell) live in internal/storage/points_test.go; this file
// walks the wire contract end to end, including idempotent replay and the
// terminal ship transition.
//
// Every run uses fresh user ids and new products, so it is re-runnable against
// a database that already holds rows. Points are earned through the real
// check-in state machine (7 consecutive days pay 11 points) instead of raw
// SQL seeding — the api package has no back door into the store.

type pointsE2EServer struct {
	base   string
	key    *rsa.PrivateKey
	userID string
}

func newPointsE2EServer(t *testing.T) (*pointsE2EServer, *storage.Store) {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run the points-shop E2E")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := t.Context()
	if err := store.AutoMigratePoints(ctx); err != nil {
		t.Fatalf("automigrate points: %v", err)
	}
	if err := store.AutoMigrateAddresses(ctx); err != nil {
		t.Fatalf("automigrate addresses: %v", err)
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	svc := NewService(Config{
		Auth:         NewAuthenticator(testToken, verifier),
		PointsStore:  store,
		AddressStore: store,
	})
	srv := httptest.NewServer(svc.Router())
	t.Cleanup(srv.Close)
	return &pointsE2EServer{base: srv.URL, key: key, userID: uuid.NewString()}, store
}

// e2eShanghai mirrors the storage package's fixed UTC+8 day boundary (the
// storage zone is unexported; Asia/Shanghai has had no DST since 1991).
var e2eShanghai = time.FixedZone("Asia/Shanghai", 8*3600)

// earnPoints checks in on `days` consecutive Shanghai days through the real
// state machine: a full week pays 11 (a day outside a fresh cycle pays 1).
func earnPoints(t *testing.T, store *storage.Store, uid string, days int) int {
	t.Helper()
	base := time.Date(2026, 6, 1, 9, 0, 0, 0, e2eShanghai)
	balance := 0
	for i := 0; i < days; i++ {
		res, err := store.CreateCheckIn(t.Context(), uid, base.AddDate(0, 0, i))
		if err != nil {
			t.Fatalf("check-in day %d: %v", i+1, err)
		}
		balance = res.Balance
	}
	return balance
}

func (e *pointsE2EServer) token(t *testing.T, audience, sub string) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	if audience == testAdminAudience {
		claims["role"] = "admin"
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(e.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

func (e *pointsE2EServer) userToken(t *testing.T) string { return e.token(t, testAudience, e.userID) }

func (e *pointsE2EServer) adminToken(t *testing.T) string {
	return e.token(t, testAdminAudience, "00000000-0000-4000-8000-000000000004")
}

// send performs a real HTTP request with a JSON body and decodes the response.
func (e *pointsE2EServer) send(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	payload := []byte("{}")
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		payload = encoded
	}
	req, err := http.NewRequestWithContext(t.Context(), method, e.base+path, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Body.Close() }()
	var resp map[string]any
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil && w.StatusCode != http.StatusNoContent {
		t.Fatalf("decode %s %s: %v", method, path, err)
	}
	return w.StatusCode, resp
}

func TestE2E_PointsShop_RedeemShipAndReplay(t *testing.T) {
	e, store := newPointsE2EServer(t)
	user := e.userToken(t)
	admin := e.adminToken(t)
	// 7 check-in days pay 11 points; the E2E product costs 5.
	if balance := earnPoints(t, store, e.userID, 7); balance != 11 {
		t.Fatalf("seed balance = %d, want 11", balance)
	}

	// Admin creates a product through the wire.
	code, created := e.send(t, http.MethodPost, "/api/admin/points/products", admin, map[string]any{
		"name": "E2E 勋章", "points_price": 5, "stock": 3, "per_user_limit": 2, "sort_order": 1,
	})
	if code != http.StatusCreated {
		t.Fatalf("admin create: %d: %v", code, created)
	}
	productID := int(created["id"].(float64))
	if created["status"] != "active" {
		t.Fatalf("created status = %v, want active", created["status"])
	}

	// The shop shows it with redeemed_count 0.
	code, shop := e.send(t, http.MethodGet, "/api/users/me/points/products", user, nil)
	if code != http.StatusOK {
		t.Fatalf("shop: %d: %v", code, shop)
	}
	products, _ := shop["products"].([]any)
	found := false
	for _, p := range products {
		row, _ := p.(map[string]any)
		if int(row["id"].(float64)) == productID {
			found = true
			if row["redeemed_count"] != float64(0) || row["per_user_limit"] != float64(2) || row["stock"] != float64(3) {
				t.Fatalf("shop row = %v", row)
			}
		}
	}
	if !found {
		t.Fatalf("product %d missing from shop: %v", productID, products)
	}

	// No address yet → the redeem call answers address_not_found.
	code, miss := e.send(t, http.MethodPost, "/api/users/me/points/redemptions", user, map[string]any{
		"product_id": productID, "address_id": 99999999, "idempotency_key": "e2e-k0",
	})
	if code != http.StatusNotFound || miss["error"] != "address_not_found" {
		t.Fatalf("missing address: %d %v", code, miss)
	}

	// Create an address (first entry auto-defaults), then redeem.
	code, addr := e.send(t, http.MethodPost, "/api/users/me/addresses", user, map[string]any{
		"receiver_name": "赵四", "receiver_phone": "13700137000",
		"province": "浙江省", "city": "杭州市", "district": "西湖区", "address_detail": "文三路 2 号",
	})
	if code != http.StatusCreated {
		t.Fatalf("create address: %d: %v", code, addr)
	}
	if addr["is_default"] != true {
		t.Fatalf("first address must auto-default: %v", addr)
	}
	addressID := int(addr["id"].(float64))

	code, redeem1 := e.send(t, http.MethodPost, "/api/users/me/points/redemptions", user, map[string]any{
		"product_id": productID, "address_id": addressID, "idempotency_key": "e2e-k1",
	})
	if code != http.StatusOK {
		t.Fatalf("redeem 1: %d: %v", code, redeem1)
	}
	if redeem1["balance"] != float64(6) || redeem1["replayed"] != false {
		t.Fatalf("redeem 1 body = %v", redeem1)
	}
	order, _ := redeem1["order"].(map[string]any)
	orderID, _ := order["id"].(string)
	if order["status"] != "pending_shipment" || order["points_cost"] != float64(5) || order["receiver_name"] != "赵四" {
		t.Fatalf("order = %v", order)
	}

	// Same key replays the same order with zero side effects.
	code, replay := e.send(t, http.MethodPost, "/api/users/me/points/redemptions", user, map[string]any{
		"product_id": productID, "address_id": addressID, "idempotency_key": "e2e-k1",
	})
	if code != http.StatusOK {
		t.Fatalf("replay: %d: %v", code, replay)
	}
	replayOrder, _ := replay["order"].(map[string]any)
	if replay["replayed"] != true || replayOrder["id"] != orderID || replay["balance"] != float64(6) {
		t.Fatalf("replay body = %v (want order %s, balance 6)", replay, orderID)
	}

	// Second redeem is allowed (count 1 < limit 2, balance 6 ≥ 5 → 1 left);
	// the third hits per_user_limit.
	code, redeem2 := e.send(t, http.MethodPost, "/api/users/me/points/redemptions", user, map[string]any{
		"product_id": productID, "address_id": addressID, "idempotency_key": "e2e-k2",
	})
	if code != http.StatusOK {
		t.Fatalf("redeem 2: %d: %v", code, redeem2)
	}
	code, limit := e.send(t, http.MethodPost, "/api/users/me/points/redemptions", user, map[string]any{
		"product_id": productID, "address_id": addressID, "idempotency_key": "e2e-k3",
	})
	if code != http.StatusConflict || limit["error"] != "limit_reached" {
		t.Fatalf("third redeem: %d %v, want 409 limit_reached", code, limit)
	}

	// User order list: two newest-first orders.
	code, mine := e.send(t, http.MethodGet, "/api/users/me/points/redemptions", user, nil)
	if code != http.StatusOK {
		t.Fatalf("my orders: %d: %v", code, mine)
	}
	rows, _ := mine["redemptions"].([]any)
	if len(rows) != 2 {
		t.Fatalf("my orders = %v, want 2", rows)
	}

	// Ship the first order; the response is the admin projection carrying the
	// terminal state.
	code, shipped := e.send(t, http.MethodPatch, "/api/admin/points/redemptions/"+orderID+"/ship", admin, map[string]any{"tracking_no": "E2E-SF-1"})
	if code != http.StatusOK {
		t.Fatalf("ship: %d: %v", code, shipped)
	}
	if shipped["status"] != "shipped" || shipped["tracking_no"] != "E2E-SF-1" || shipped["user_id"] != e.userID {
		t.Fatalf("ship body = %v", shipped)
	}

	// Repeat ship is idempotent: stored state, original tracking number.
	code, again := e.send(t, http.MethodPatch, "/api/admin/points/redemptions/"+orderID+"/ship", admin, map[string]any{"tracking_no": "E2E-OTHER"})
	if code != http.StatusOK || again["tracking_no"] != "E2E-SF-1" || again["status"] != "shipped" {
		t.Fatalf("re-ship: %d %v, want stored E2E-SF-1/shipped", code, again)
	}

	// The user's list now shows shipped + tracking.
	code, mine2 := e.send(t, http.MethodGet, "/api/users/me/points/redemptions", user, nil)
	rows2, _ := mine2["redemptions"].([]any)
	for _, r := range rows2 {
		row, _ := r.(map[string]any)
		if row["id"] == orderID && (row["status"] != "shipped" || row["tracking_no"] != "E2E-SF-1" || row["shipped_at"] == nil) {
			t.Fatalf("order row after ship = %v", row)
		}
	}

	// Deleting the address never touches the shipped order's snapshot.
	code, _ = e.send(t, http.MethodDelete, "/api/users/me/addresses/"+strconv.Itoa(addressID), user, nil)
	if code != http.StatusNoContent {
		t.Fatalf("delete address: %d", code)
	}
	code, mine3 := e.send(t, http.MethodGet, "/api/users/me/points/redemptions", user, nil)
	rows3, _ := mine3["redemptions"].([]any)
	if code != http.StatusOK || len(rows3) != 2 {
		t.Fatalf("orders after address delete = %d rows (code %d), want 2 (snapshot intact)", len(rows3), code)
	}
}

func TestE2E_PointsShop_ConcurrentSameKey(t *testing.T) {
	e, store := newPointsE2EServer(t)
	user := e.userToken(t)
	if balance := earnPoints(t, store, e.userID, 7); balance != 11 {
		t.Fatalf("seed balance = %d, want 11", balance)
	}

	code, created := e.send(t, http.MethodPost, "/api/admin/points/products", e.adminToken(t), map[string]any{
		"name": "E2E 并发品", "points_price": 5, "stock": 10,
	})
	if code != http.StatusCreated {
		t.Fatalf("admin create: %d: %v", code, created)
	}
	productID := int(created["id"].(float64))
	code, addr := e.send(t, http.MethodPost, "/api/users/me/addresses", user, map[string]any{
		"receiver_name": "钱五", "receiver_phone": "13600136000",
		"province": "江苏省", "city": "南京市", "district": "玄武区", "address_detail": "中山东路 3 号",
	})
	if code != http.StatusCreated {
		t.Fatalf("create address: %d: %v", code, addr)
	}
	addressID := int(addr["id"].(float64))

	// Six parallel double-clicks with the SAME idempotency key: every call
	// answers 200 (one winner + replays), exactly one order exists, and the
	// balance reflects a single deduction (11 - 5 = 6).
	const clicks = 6
	results := make([]map[string]any, clicks)
	codes := make([]int, clicks)
	var wg sync.WaitGroup
	for i := 0; i < clicks; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, b := e.send(t, http.MethodPost, "/api/users/me/points/redemptions", user, map[string]any{
				"product_id": productID, "address_id": addressID, "idempotency_key": "same-click",
			})
			codes[i], results[i] = c, b
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("same-key click %d: code %d, want 200 (replay): %v", i, c, results[i])
		}
		if results[i]["balance"] != float64(6) {
			t.Fatalf("click %d balance = %v, want 6 (single deduction)", i, results[i]["balance"])
		}
	}
	code, mine := e.send(t, http.MethodGet, "/api/users/me/points/redemptions", user, nil)
	rows, _ := mine["redemptions"].([]any)
	if code != http.StatusOK || len(rows) != 1 {
		t.Fatalf("orders after same-key storm = %d rows (code %d), want exactly 1", len(rows), code)
	}
}
