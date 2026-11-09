// wxpay_e2e_test.go walks the shipping-fee checkout over the HTTP seam
// (devops#904). Two layers:
//
//   - TestWxpayNotifyContract: a fake gateway + fake store, no database — the
//     notify endpoint's full HTTP contract (verification failure, unknown
//     order, non-success state, amount mismatch, paid transition, replay
//     no-op), always executed by the plain `go test ./...` CI leg.
//   - TestE2E_WxpayFeeCheckoutFlow / TestE2E_WxpayInertGate503: the REAL
//     MySQL store + a fake gateway drive fee-charged redeem → prepay →
//     notify end to end (and the inert 503 gate). CI runs them via the
//     Points-shop MySQL step (the TestE2E_Wxpay regex); without
//     STRIDE_WORKER_TEST_MYSQL_DSN they skip.
package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/wxpay"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

// fakeWxPayGateway stands in for *wxpay.Client: canned prepay parameters and a
// scripted notify answer. prepayTradeNo records the merchant order number the
// handler handed the gateway — the value the real client would send upstream.
type fakeWxPayGateway struct {
	prepayCalls   int
	prepayTradeNo string
	prepayErr     error
	notify        *wxpay.NotifyPayment
	notifyErr     error
}

func (f *fakeWxPayGateway) Configured() bool { return true }

func (f *fakeWxPayGateway) PrepayPaymentParams(_ context.Context, outTradeNo, _ string, _ int64, _ string) (*wxpay.PaymentParams, error) {
	if f.prepayErr != nil {
		return nil, f.prepayErr
	}
	f.prepayCalls++
	f.prepayTradeNo = outTradeNo
	return &wxpay.PaymentParams{
		TimeStamp: "1793947500", NonceStr: "nonce-str",
		Package: "prepay_id=" + outTradeNo, SignType: "RSA", PaySign: "paysign",
	}, nil
}

func (f *fakeWxPayGateway) ParseNotify(_ context.Context, _ *http.Request) (*wxpay.NotifyPayment, error) {
	if f.notifyErr != nil {
		return nil, f.notifyErr
	}
	return f.notify, nil
}

// fakeWxPayStore satisfies the notify handler's storage port without MySQL.
type fakeWxPayStore struct {
	order       *storage.PointRedemption
	lookupErr   error
	paidOK      bool
	paidErr     error
	paidCalls   int
	paidLastRef string
}

func (f *fakeWxPayStore) GetUserRedemption(_ context.Context, _, _ string) (*storage.PointRedemption, error) {
	if f.order == nil {
		return nil, storage.ErrPointRedemptionNotFound
	}
	return f.order, nil
}

func (f *fakeWxPayStore) GetRedemptionByOutTradeNo(_ context.Context, _ string) (*storage.PointRedemption, error) {
	if f.lookupErr != nil {
		return nil, f.lookupErr
	}
	return f.order, nil
}

func (f *fakeWxPayStore) MarkRedemptionPaid(_ context.Context, outTradeNo string, _ time.Time) (bool, error) {
	f.paidCalls++
	f.paidLastRef = outTradeNo
	return f.paidOK, f.paidErr
}

// ─────────────────────────────────────────────────────────────────────────────
// Notify HTTP contract (no database)
// ─────────────────────────────────────────────────────────────────────────────

func wxpayNotifyServer(t *testing.T, gateway *fakeWxPayGateway, store *fakeWxPayStore) *httptest.Server {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	svc := NewService(Config{
		Auth:       NewAuthenticator(testToken, mustVerifier(t, key)),
		WxPayStore: store,
		WxPay:      gateway,
	})
	srv := httptest.NewServer(svc.Router())
	t.Cleanup(srv.Close)
	return srv
}

func TestWxpayNotifyContract(t *testing.T) {
	order := &storage.PointRedemption{ID: "order-1", ShippingFeeSnapshot: 800}

	t.Run("verification failure answers 401 FAIL", func(t *testing.T) {
		gw := &fakeWxPayGateway{notifyErr: errors.New("bad signature")}
		srv := wxpayNotifyServer(t, gw, &fakeWxPayStore{order: order})
		code, body := postJSON(t, srv.URL+"/api/wxpay/notify")
		if code != http.StatusUnauthorized || body["code"] != "FAIL" {
			t.Fatalf("got %d %v", code, body)
		}
	})

	t.Run("unknown order acknowledges without transition", func(t *testing.T) {
		gw := &fakeWxPayGateway{notify: &wxpay.NotifyPayment{OutTradeNo: "ghost", TradeState: wxpay.TradeStateSuccess, PaidFen: 800}}
		store := &fakeWxPayStore{}
		srv := wxpayNotifyServer(t, gw, store)
		code, body := postJSON(t, srv.URL+"/api/wxpay/notify")
		if code != http.StatusOK || body["code"] != "SUCCESS" {
			t.Fatalf("got %d %v", code, body)
		}
		if store.paidCalls != 0 {
			t.Fatalf("a ghost order must not drive a transition (calls=%d)", store.paidCalls)
		}
	})

	t.Run("non-success state acknowledges without transition", func(t *testing.T) {
		gw := &fakeWxPayGateway{notify: &wxpay.NotifyPayment{OutTradeNo: "order-1", TradeState: "CLOSED", PaidFen: 800}}
		store := &fakeWxPayStore{order: order}
		srv := wxpayNotifyServer(t, gw, store)
		code, _ := postJSON(t, srv.URL+"/api/wxpay/notify")
		if code != http.StatusOK {
			t.Fatalf("got %d", code)
		}
		if store.paidCalls != 0 {
			t.Fatalf("CLOSED state must not drive a transition (calls=%d)", store.paidCalls)
		}
	})

	t.Run("amount mismatch refuses with FAIL", func(t *testing.T) {
		gw := &fakeWxPayGateway{notify: &wxpay.NotifyPayment{OutTradeNo: "order-1", TradeState: wxpay.TradeStateSuccess, PaidFen: 900}}
		store := &fakeWxPayStore{order: order, paidOK: true}
		srv := wxpayNotifyServer(t, gw, store)
		code, body := postJSON(t, srv.URL+"/api/wxpay/notify")
		if code != http.StatusInternalServerError || body["code"] != "FAIL" {
			t.Fatalf("got %d %v", code, body)
		}
		if store.paidCalls != 0 {
			t.Fatalf("a mismatched amount must never mark paid (calls=%d)", store.paidCalls)
		}
	})

	t.Run("success marks paid; replay is a 200 no-op", func(t *testing.T) {
		gw := &fakeWxPayGateway{notify: &wxpay.NotifyPayment{OutTradeNo: "order-1", TradeState: wxpay.TradeStateSuccess, PaidFen: 800}}
		store := &fakeWxPayStore{order: order}
		srv := wxpayNotifyServer(t, gw, store)

		// First delivery: the transition fails (simulate the claim racing the
		// sweep... inverted here — store reports not-transitioned=false but no
		// error, the replay path).
		store.paidOK = false
		code, body := postJSON(t, srv.URL+"/api/wxpay/notify")
		if code != http.StatusOK || body["code"] != "SUCCESS" {
			t.Fatalf("replay-shape first delivery: got %d %v", code, body)
		}
		// Real transition.
		store.paidOK = true
		code, body = postJSON(t, srv.URL+"/api/wxpay/notify")
		if code != http.StatusOK || body["code"] != "SUCCESS" || store.paidLastRef != "order-1" {
			t.Fatalf("paid delivery: got %d %v ref=%s", code, body, store.paidLastRef)
		}
	})

	t.Run("storage error answers 500 FAIL for retry", func(t *testing.T) {
		gw := &fakeWxPayGateway{notify: &wxpay.NotifyPayment{OutTradeNo: "order-1", TradeState: wxpay.TradeStateSuccess, PaidFen: 800}}
		store := &fakeWxPayStore{order: order, paidOK: false, paidErr: errors.New("db down")}
		srv := wxpayNotifyServer(t, gw, store)
		code, body := postJSON(t, srv.URL+"/api/wxpay/notify")
		if code != http.StatusInternalServerError || body["code"] != "FAIL" {
			t.Fatalf("got %d %v", code, body)
		}
	})
}

func mustVerifier(t *testing.T, key *rsa.PrivateKey) *JWTVerifier {
	t.Helper()
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	return verifier
}

// postAuthedJSON fires one bearer-authenticated JSON request ({openid}) and
// decodes the envelope.
func postAuthedJSON(t *testing.T, url, token string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url,
		bytes.NewReader([]byte(`{"openid":"oX-test-openid"}`)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Body.Close() }()
	var body map[string]any
	_ = json.NewDecoder(w.Body).Decode(&body)
	return w.StatusCode, body
}

// postJSON fires one unauthenticated JSON request and decodes the envelope.
func postJSON(t *testing.T, url string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, url, bytes.NewReader([]byte(`{"id":"evt"}`)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	w, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Body.Close() }()
	var body map[string]any
	_ = json.NewDecoder(w.Body).Decode(&body)
	return w.StatusCode, body
}

func TestWxpayPrepayGate(t *testing.T) {
	// The gate is the order STATUS, not the payment state: a swept
	// (cancelled) order keeps payment_state=pending and must still be refused,
	// while a parked pending order pays (five parameters come back).
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	gateway := &fakeWxPayGateway{}
	signed := func(sub string) string {
		t.Helper()
		claims := jwt.MapClaims{
			"sub": sub, "iss": testIssuer, "aud": testAudience,
			"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
		}
		token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(key)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		return token
	}
	srvFor := func(order *storage.PointRedemption) *httptest.Server {
		t.Helper()
		svc := NewService(Config{
			Auth:       NewAuthenticator(testToken, mustVerifier(t, key)),
			WxPayStore: &fakeWxPayStore{order: order},
			WxPay:      gateway,
		})
		srv := httptest.NewServer(svc.Router())
		t.Cleanup(srv.Close)
		return srv
	}

	pending := &storage.PointRedemption{ID: uuid.NewString(), UserID: "user-1", Status: storage.RedemptionStatusPendingPayment, PaymentState: storage.PaymentStatePending, ShippingFeeSnapshot: 800}
	code, body := postAuthedJSON(t, srvFor(pending).URL+"/api/users/me/points/redemptions/"+pending.ID+"/pay", signed("user-1"))
	if code != http.StatusOK {
		t.Fatalf("pending order must pay: %d %v", code, body)
	}
	for _, k := range []string{"timeStamp", "nonceStr", "package", "signType", "paySign"} {
		if v, _ := body[k].(string); v == "" {
			t.Fatalf("prepay response missing %s: %v", k, body)
		}
	}
	// The value sent upstream is the id-derived trade number — a 32-character
	// hyphen-free string WeChat accepts (the raw UUID failed PARAM_ERROR,
	// devops#904) — not the raw order id.
	if gateway.prepayTradeNo != wxpay.OutTradeNoFromOrderID(pending.ID) {
		t.Fatalf("prepay out_trade_no = %q, want the id-derived %q", gateway.prepayTradeNo, wxpay.OutTradeNoFromOrderID(pending.ID))
	}
	if len(gateway.prepayTradeNo) != 32 || strings.Contains(gateway.prepayTradeNo, "-") {
		t.Fatalf("prepay out_trade_no %q must be 32 hyphen-free characters", gateway.prepayTradeNo)
	}

	cancelled := &storage.PointRedemption{ID: "order-c", UserID: "user-1", Status: storage.RedemptionStatusCancelled, PaymentState: storage.PaymentStatePending, ShippingFeeSnapshot: 800}
	code, body = postAuthedJSON(t, srvFor(cancelled).URL+"/api/users/me/points/redemptions/order-c/pay", signed("user-1"))
	if code != http.StatusConflict || body["error"] != "payment_not_pending" {
		t.Fatalf("cancelled order must refuse prepay: %d %v", code, body)
	}
	if gateway.prepayCalls != 1 {
		t.Fatalf("a refused order must never reach the gateway (calls=%d)", gateway.prepayCalls)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// E2E with the real store (MySQL-gated)
// ─────────────────────────────────────────────────────────────────────────────

func newWxpayE2E(t *testing.T) (*pointsE2EServer, *storage.Store, *fakeWxPayGateway) {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run the wxpay E2E")
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
	if err := store.AutoMigrateAddresses(ctx); err != nil {
		t.Fatalf("automigrate addresses: %v", err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	gateway := &fakeWxPayGateway{}
	svc := NewService(Config{
		Auth:         NewAuthenticator(testToken, mustVerifier(t, key)),
		PointsStore:  store,
		WxPayStore:   store,
		WxPay:        gateway,
		AddressStore: store,
	})
	srv := httptest.NewServer(svc.Router())
	t.Cleanup(srv.Close)
	return &pointsE2EServer{base: srv.URL, key: key, userID: uuid.NewString()}, store, gateway
}

func TestE2E_WxpayFeeCheckoutFlow(t *testing.T) {
	server, store, gateway := newWxpayE2E(t)
	user, admin := server.userToken(t), server.adminToken(t)

	// Admin seeds one jzsh_fee product charging 800 fen outside 江浙沪.
	code, created := server.send(t, "POST", "/api/admin/points/products", admin, map[string]any{
		"name": "fee测试商品", "points_price": 1, "stock": 5,
		"shipping_policy": "jzsh_fee", "shipping_fee": 800, "status": "active",
	})
	if code != http.StatusCreated {
		t.Fatalf("create product: %d %v", code, created)
	}
	productID := int(created["id"].(float64))

	// The user earns points and seeds a 山东 address.
	if got := earnPoints(t, store, server.userID, 1); got < 1 {
		t.Fatalf("balance = %d", got)
	}
	code, addr := server.send(t, "POST", "/api/users/me/addresses", user, map[string]any{
		"receiver_name": "王五", "receiver_phone": "13700137000",
		"province": "山东省", "city": "济南市", "district": "历下区", "address_detail": "泉城路 1 号",
	})
	if code != http.StatusCreated {
		t.Fatalf("create address: %d %v", code, addr)
	}

	code, redeemed := server.send(t, "POST", "/api/users/me/points/redemptions", user, map[string]any{
		"product_id": productID, "address_id": addr["id"], "idempotency_key": "wx-e2e-key-1",
	})
	if code != http.StatusOK {
		t.Fatalf("redeem: %d %v", code, redeemed)
	}
	order := redeemed["order"].(map[string]any)
	if order["status"] != "pending_payment" || order["payment_state"] != "pending" {
		t.Fatalf("fee order state wrong: %v", order)
	}
	if order["shipping_fee_snapshot"].(float64) != 800 || order["shipping_policy_snapshot"] != "jzsh_fee" {
		t.Fatalf("fee snapshot wrong: %v", order)
	}
	orderID := order["id"].(string)

	// Prepay returns exactly the five wx.requestPayment parameters.
	code, prepay := server.send(t, "POST", fmt.Sprintf("/api/users/me/points/redemptions/%s/pay", orderID), user, map[string]any{
		"openid": "oX-test-openid",
	})
	if code != http.StatusOK {
		t.Fatalf("prepay: %d %v", code, prepay)
	}
	for _, k := range []string{"timeStamp", "nonceStr", "package", "signType", "paySign"} {
		if v, _ := prepay[k].(string); v == "" {
			t.Fatalf("prepay response missing %s: %v", k, prepay)
		}
	}
	if gateway.prepayCalls != 1 {
		t.Fatalf("prepay calls = %d", gateway.prepayCalls)
	}
	// The merchant order number sent upstream is the id-derived 32-character
	// trade number (devops#904), and it equals what creation stored — the
	// exact value the notify below echoes back.
	if gateway.prepayTradeNo != wxpay.OutTradeNoFromOrderID(orderID) ||
		len(gateway.prepayTradeNo) != 32 || strings.Contains(gateway.prepayTradeNo, "-") {
		t.Fatalf("prepay out_trade_no = %q, want the 32-char id-derived %q", gateway.prepayTradeNo, wxpay.OutTradeNoFromOrderID(orderID))
	}

	// The verified SUCCESS callback moves the order pending → paid; a replay
	// is a 200 no-op that must not change anything. The callback carries the
	// trade number WeChat knows: the derived value the prepay sent.
	gateway.notify = &wxpay.NotifyPayment{OutTradeNo: wxpay.OutTradeNoFromOrderID(orderID), TradeState: wxpay.TradeStateSuccess, PaidFen: 800}
	code, ack := server.send(t, "POST", "/api/wxpay/notify", "", map[string]any{"id": "evt-1"})
	if code != http.StatusOK || ack["code"] != "SUCCESS" {
		t.Fatalf("notify: %d %v", code, ack)
	}
	code, list := server.send(t, "GET", "/api/users/me/points/redemptions", user, nil)
	if code != http.StatusOK {
		t.Fatalf("list: %d %v", code, list)
	}
	items := list["redemptions"].([]any)
	first := items[0].(map[string]any)
	if first["payment_state"] != "paid" || first["status"] != "pending_shipment" || first["paid_at"] == nil {
		t.Fatalf("paid order wrong: %v", first)
	}
	code, _ = server.send(t, "POST", "/api/wxpay/notify", "", map[string]any{"id": "evt-1-replay"})
	if code != http.StatusOK {
		t.Fatalf("replay notify: %d", code)
	}
	code, list = server.send(t, "GET", "/api/users/me/points/redemptions", user, nil)
	if code != http.StatusOK {
		t.Fatalf("list after replay: %d %v", code, list)
	}
	first = list["redemptions"].([]any)[0].(map[string]any)
	if first["payment_state"] != "paid" {
		t.Fatalf("replay must not change state: %v", first)
	}
}

func TestE2E_WxpayInertGate503(t *testing.T) {
	// The base harness builds the service WITHOUT WxPay (module inert): a
	// fee-charged redeem must answer 503 payment_unavailable with zero points
	// deducted, and the pay endpoint must be unmounted (404).
	server, store := newPointsE2EServer(t)
	user, admin := server.userToken(t), server.adminToken(t)

	code, created := server.send(t, "POST", "/api/admin/points/products", admin, map[string]any{
		"name": "惰性商品", "points_price": 1, "stock": 5,
		"shipping_policy": "jzsh_fee", "shipping_fee": 800, "status": "active",
	})
	if code != http.StatusCreated {
		t.Fatalf("create product: %d %v", code, created)
	}
	productID := int(created["id"].(float64))
	before := earnPoints(t, store, server.userID, 1)
	if before < 1 {
		t.Fatalf("balance = %d", before)
	}
	code, addr := server.send(t, "POST", "/api/users/me/addresses", user, map[string]any{
		"receiver_name": "赵六", "receiver_phone": "13600136000",
		"province": "山东省", "city": "济南市", "district": "历下区", "address_detail": "泉城路 2 号",
	})
	if code != http.StatusCreated {
		t.Fatalf("create address: %d %v", code, addr)
	}

	code, rejected := server.send(t, "POST", "/api/users/me/points/redemptions", user, map[string]any{
		"product_id": productID, "address_id": addr["id"], "idempotency_key": "wx-inert-key",
	})
	if code != http.StatusServiceUnavailable || rejected["error"] != "payment_unavailable" {
		t.Fatalf("inert gate: %d %v", code, rejected)
	}
	// Zero deduction proof: a subsequent free redeem reports the untouched
	// balance (minus only its own price).
	code, free := server.send(t, "POST", "/api/admin/points/products", admin, map[string]any{
		"name": "免邮商品", "points_price": 1, "stock": 5, "status": "active",
	})
	if code != http.StatusCreated {
		t.Fatalf("create free product: %d %v", code, free)
	}
	freeID := int(free["id"].(float64))
	code, freeRedeem := server.send(t, "POST", "/api/users/me/points/redemptions", user, map[string]any{
		"product_id": freeID, "address_id": addr["id"], "idempotency_key": "wx-inert-key-free",
	})
	if code != http.StatusOK {
		t.Fatalf("free redeem: %d %v", code, freeRedeem)
	}
	if got := freeRedeem["balance"].(float64); got != float64(before-1) {
		t.Fatalf("balance = %v, want %d (the gate must deduct nothing)", got, before-1)
	}
	// The pay endpoint stays unmounted while the module is inert; the route
	// answers gin's plain-text 404, so this check skips the JSON decoder.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		server.base+"/api/users/me/points/redemptions/some-id/pay", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+user)
	w, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Body.Close()
	if w.StatusCode != http.StatusNotFound {
		t.Fatalf("pay endpoint must 404 while inert, got %d", w.StatusCode)
	}
}
