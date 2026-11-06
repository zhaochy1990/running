package api

import (
	"bytes"
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

// ─────────────────────────────────────────────────────────────────────────────
// Fake store
// ─────────────────────────────────────────────────────────────────────────────

type fakePointsStore struct {
	products       []storage.PointProductListing
	redeemResult   *storage.RedemptionResult
	redeemErr      error
	page           *storage.RedemptionPage
	pageErr        error
	adminProducts  []storage.PointProductListing
	adminCreateRow *storage.PointProduct
	patchResult    *storage.PointProduct
	patchErr       error
	skuCreate      *storage.PointProductSku
	skuCreateErr   error
	skuPatch       *storage.PointProductSku
	skuPatchErr    error
	skuDeleted     bool
	skuDeleteErr   error
	adminPage      *storage.AdminRedemptionPage
	adminPageErr   error
	shipResult     *storage.PointRedemption
	shipErr        error

	// last-call captures
	uid, cursor, adminStatus, shipID, shipTracking string
	limit, lastPatchID                             int
	lastSkuProductID, lastSkuID                    uint64
	req                                            storage.RedemptionRequest
	patch                                          storage.ProductPatch
	skuPatchBody                                   storage.SkuPatch
}

func (f *fakePointsStore) ListActiveProducts(_ context.Context, userID string) ([]storage.PointProductListing, error) {
	f.uid = userID
	return f.products, nil
}

func (f *fakePointsStore) CreateRedemption(_ context.Context, userID string, req storage.RedemptionRequest) (*storage.RedemptionResult, error) {
	f.uid, f.req = userID, req
	if f.redeemErr != nil {
		return nil, f.redeemErr
	}
	return f.redeemResult, nil
}

func (f *fakePointsStore) ListUserRedemptions(_ context.Context, userID, cursor string, limit int) (*storage.RedemptionPage, error) {
	f.uid, f.cursor, f.limit = userID, cursor, limit
	if f.pageErr != nil {
		return nil, f.pageErr
	}
	return f.page, nil
}

func (f *fakePointsStore) AdminListProducts(context.Context) ([]storage.PointProductListing, error) {
	return f.adminProducts, nil
}

func (f *fakePointsStore) AdminCreateProduct(_ context.Context, row *storage.PointProduct) error {
	row.ID, row.CreatedAt, row.UpdatedAt = 7, time.Now().UTC(), time.Now().UTC()
	f.adminCreateRow = row
	return nil
}

func (f *fakePointsStore) AdminPatchProduct(_ context.Context, id uint64, patch storage.ProductPatch) (*storage.PointProduct, error) {
	f.lastPatchID = int(id)
	f.patch = patch
	if f.patchErr != nil {
		return nil, f.patchErr
	}
	return f.patchResult, nil
}

func (f *fakePointsStore) AdminListRedemptions(_ context.Context, status, cursor string, limit int) (*storage.AdminRedemptionPage, error) {
	f.adminStatus, f.cursor, f.limit = status, cursor, limit
	if f.adminPageErr != nil {
		return nil, f.adminPageErr
	}
	return f.adminPage, nil
}

func (f *fakePointsStore) AdminShipRedemption(_ context.Context, id, trackingNo string, _ time.Time) (*storage.PointRedemption, error) {
	f.shipID, f.shipTracking = id, trackingNo
	if f.shipErr != nil {
		return nil, f.shipErr
	}
	return f.shipResult, nil
}

func (f *fakePointsStore) AdminCreateProductSku(_ context.Context, productID uint64, row *storage.PointProductSku) error {
	f.lastSkuProductID = productID
	if f.skuCreateErr != nil {
		return f.skuCreateErr
	}
	row.ID, row.ProductID, row.CreatedAt, row.UpdatedAt = 42, productID, time.Now().UTC(), time.Now().UTC()
	f.skuCreate = row
	return nil
}

func (f *fakePointsStore) AdminPatchProductSku(_ context.Context, productID, skuID uint64, patch storage.SkuPatch) (*storage.PointProductSku, error) {
	f.lastSkuProductID, f.lastSkuID, f.skuPatchBody = productID, skuID, patch
	if f.skuPatchErr != nil {
		return nil, f.skuPatchErr
	}
	return f.skuPatch, nil
}

func (f *fakePointsStore) AdminDeleteProductSku(_ context.Context, productID, skuID uint64) error {
	f.lastSkuProductID, f.lastSkuID = productID, skuID
	if f.skuDeleteErr != nil {
		return f.skuDeleteErr
	}
	f.skuDeleted = true
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

type pointsHarness struct {
	svc    *Service
	store  *fakePointsStore
	images *fakeFeedbackImages
	key    *rsa.PrivateKey
}

func newPointsHarness(t *testing.T, store PointsStore) *pointsHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	images := newFakeFeedbackImages()
	svc := NewService(Config{
		Auth:           NewAuthenticator(testToken, verifier),
		PointsStore:    store,
		FeedbackImages: images,
	})
	return &pointsHarness{svc: svc, store: store.(*fakePointsStore), images: images, key: key}
}

func (h *pointsHarness) token(t *testing.T, audience, sub string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	if audience == testAdminAudience {
		claims["role"] = "admin"
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *pointsHarness) userToken(t *testing.T, sub string) map[string]string {
	return h.token(t, testAudience, sub)
}

func (h *pointsHarness) adminToken(t *testing.T) map[string]string {
	return h.token(t, testAdminAudience, "00000000-0000-4000-8000-000000000002")
}

func (h *pointsHarness) do(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	reader := strings.NewReader("")
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = strings.NewReader(string(encoded))
	}
	r := httptest.NewRequest(method, path, reader)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

func decodePointsJSON(t *testing.T, w *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), dst); err != nil {
		t.Fatalf("unmarshal %s: %v", w.Body.String(), err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

func TestPoints_TierGuards(t *testing.T) {
	h := newPointsHarness(t, &fakePointsStore{})
	user := h.userToken(t, testSub)
	admin := h.adminToken(t)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/users/me/points/products"},
		{http.MethodPost, "/api/users/me/points/redemptions"},
		{http.MethodGet, "/api/users/me/points/redemptions"},
	} {
		if w := h.do(t, tc.method, tc.path, nil, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: %d, want 401", tc.method, tc.path, w.Code)
		}
		// Admin tier never rides the user surface (default-deny group).
		if w := h.do(t, tc.method, tc.path, map[string]any{"x": 1}, admin); w.Code != http.StatusForbidden {
			t.Errorf("%s %s admin token: %d, want 403", tc.method, tc.path, w.Code)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/points/products"},
		{http.MethodPost, "/api/admin/points/products"},
		{http.MethodPatch, "/api/admin/points/products/1"},
		{http.MethodPost, "/api/admin/points/products/1/skus"},
		{http.MethodPatch, "/api/admin/points/products/1/skus/2"},
		{http.MethodDelete, "/api/admin/points/products/1/skus/2"},
		{http.MethodGet, "/api/admin/points/redemptions"},
		{http.MethodPatch, "/api/admin/points/redemptions/x/ship"},
	} {
		if w := h.do(t, tc.method, tc.path, map[string]any{"x": 1}, user); w.Code != http.StatusForbidden {
			t.Errorf("%s %s user token: %d, want 403", tc.method, tc.path, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, map[string]any{"x": 1}, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: %d, want 401", tc.method, tc.path, w.Code)
		}
	}
	// #850: the admin surface has no DELETE — the route must not exist.
	if w := h.do(t, http.MethodDelete, "/api/admin/points/products/1", nil, admin); w.Code != http.StatusNotFound {
		t.Errorf("admin product DELETE: %d, want 404 (route absent)", w.Code)
	}
}

func TestPoints_ListProducts(t *testing.T) {
	desc := "desc"
	store := &fakePointsStore{products: []storage.PointProductListing{
		{Product: storage.PointProduct{ID: 3, Name: "毛巾", Description: &desc, PointsPrice: 50, Stock: 4, PerUserLimit: 2}, RedeemedCount: 1},
	}}
	h := newPointsHarness(t, store)
	w := h.do(t, http.MethodGet, "/api/users/me/points/products", nil, h.userToken(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var got productsResponse
	decodePointsJSON(t, w, &got)
	if len(got.Products) != 1 || got.Products[0].ID != 3 || got.Products[0].RedeemedCount != 1 ||
		got.Products[0].PerUserLimit != 2 || got.Products[0].Description == nil || *got.Products[0].Description != desc {
		t.Fatalf("products = %+v", got.Products)
	}
	if store.uid != testSub {
		t.Fatalf("store got user %q", store.uid)
	}
}

func TestPoints_CreateRedemption(t *testing.T) {
	tracking := ""
	store := &fakePointsStore{redeemResult: &storage.RedemptionResult{
		Order:   &storage.PointRedemption{ID: "order-1", ProductID: 3, ProductName: "毛巾", PointsCost: 50, Status: storage.RedemptionStatusPendingShipment, ReceiverName: "张三", TrackingNo: &tracking},
		Balance: 50,
	}}
	h := newPointsHarness(t, store)
	w := h.do(t, http.MethodPost, "/api/users/me/points/redemptions",
		map[string]any{"product_id": 3, "address_id": 9, "idempotency_key": "k1"},
		h.userToken(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var got redemptionCreateResponse
	decodePointsJSON(t, w, &got)
	if got.Order.ID != "order-1" || got.Order.Status != "pending_shipment" || got.Balance != 50 || got.Replayed {
		t.Fatalf("body = %+v", got)
	}
	if store.uid != testSub || store.req.ProductID != 3 || store.req.AddressID != 9 || store.req.IdempotencyKey != "k1" {
		t.Fatalf("store call = user %q req %+v", store.uid, store.req)
	}

	// Business rejections map onto the #850 codes with their status.
	for _, tc := range []struct {
		err    error
		status int
	}{
		{&storage.RedemptionError{Code: storage.RedemptionProductInactive}, http.StatusConflict},
		{&storage.RedemptionError{Code: storage.RedemptionOutOfStock}, http.StatusConflict},
		{&storage.RedemptionError{Code: storage.RedemptionLimitReached}, http.StatusConflict},
		{&storage.RedemptionError{Code: storage.RedemptionInsufficientPoints}, http.StatusConflict},
		{&storage.RedemptionError{Code: storage.RedemptionAddressNotFound}, http.StatusNotFound},
	} {
		h2 := newPointsHarness(t, &fakePointsStore{redeemErr: tc.err})
		w2 := h2.do(t, http.MethodPost, "/api/users/me/points/redemptions",
			map[string]any{"product_id": 3, "address_id": 9, "idempotency_key": "k"},
			h2.userToken(t, testSub))
		if w2.Code != tc.status {
			t.Errorf("err %v: code = %d, want %d", tc.err, w2.Code, tc.status)
		}
		var env struct {
			Error string `json:"error"`
		}
		decodePointsJSON(t, w2, &env)
		var wantCode *storage.RedemptionError
		if !errors.As(tc.err, &wantCode) {
			t.Fatalf("test bug: %v is not a RedemptionError", tc.err)
		}
		if env.Error != string(wantCode.Code) {
			t.Errorf("envelope = %q, want %q", env.Error, wantCode.Code)
		}
	}

	// Malformed bodies.
	h3 := newPointsHarness(t, &fakePointsStore{})
	for _, body := range []map[string]any{
		{"address_id": 9, "idempotency_key": "k"},                                      // no product
		{"product_id": 3, "address_id": 9},                                             // no key
		{"product_id": 3, "address_id": 9, "idempotency_key": strings.Repeat("x", 65)}, // >64
	} {
		w3 := h3.do(t, http.MethodPost, "/api/users/me/points/redemptions", body, h3.userToken(t, testSub))
		if w3.Code != http.StatusBadRequest {
			t.Errorf("body %v: code = %d, want 400", body, w3.Code)
		}
	}
}

func TestPoints_ListRedemptions_Pagination(t *testing.T) {
	store := &fakePointsStore{page: &storage.RedemptionPage{
		Items:      []*storage.PointRedemption{{ID: "o2"}, {ID: "o1"}},
		NextCursor: "next",
	}}
	h := newPointsHarness(t, store)
	w := h.do(t, http.MethodGet, "/api/users/me/points/redemptions?limit=2", nil, h.userToken(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	var got redemptionsResponse
	decodePointsJSON(t, w, &got)
	if len(got.Redemptions) != 2 || got.NextCursor == nil || *got.NextCursor != "next" {
		t.Fatalf("body = %+v", got)
	}
	if store.limit != 2 || store.uid != testSub {
		t.Fatalf("store call = %+v", store)
	}

	// Non-integer limit → 422, storage cursor error → 422.
	w = h.do(t, http.MethodGet, "/api/users/me/points/redemptions?limit=abc", nil, h.userToken(t, testSub))
	if w.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad limit: %d, want 422", w.Code)
	}
	h2 := newPointsHarness(t, &fakePointsStore{pageErr: &storage.PointCursorError{Message: "bad cursor"}})
	w = h2.do(t, http.MethodGet, "/api/users/me/points/redemptions?cursor=x", nil, h2.userToken(t, testSub))
	if w.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad cursor: %d, want 422", w.Code)
	}
}

func TestPoints_AdminProducts(t *testing.T) {
	store := &fakePointsStore{
		adminProducts: []storage.PointProductListing{{Product: storage.PointProduct{ID: 1, Name: "p", PointsPrice: 1, Status: storage.PointProductStatusActive}}},
		patchResult:   &storage.PointProduct{ID: 1, Name: "p2", PointsPrice: 2, Status: storage.PointProductStatusInactive},
	}
	h := newPointsHarness(t, store)
	admin := h.adminToken(t)

	w := h.do(t, http.MethodGet, "/api/admin/points/products", nil, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("list code = %d: %s", w.Code, w.Body.String())
	}

	// No status on create → defaults to draft (devops#896: pre-publication).
	w = h.do(t, http.MethodPost, "/api/admin/points/products",
		map[string]any{"name": "新品", "points_price": 100, "stock": 5, "per_user_limit": 2}, admin)
	if w.Code != http.StatusCreated {
		t.Fatalf("create code = %d: %s", w.Code, w.Body.String())
	}
	if store.adminCreateRow.Status != storage.PointProductStatusDraft {
		t.Fatalf("default status = %q, want draft", store.adminCreateRow.Status)
	}

	// Every closed-enum status is accepted explicitly.
	for _, status := range []string{
		storage.PointProductStatusDraft, storage.PointProductStatusActive, storage.PointProductStatusInactive,
	} {
		if w := h.do(t, http.MethodPost, "/api/admin/points/products",
			map[string]any{"name": "新品", "points_price": 100, "status": status}, admin); w.Code != http.StatusCreated {
			t.Fatalf("create status %q: %d", status, w.Code)
		}
		if store.adminCreateRow.Status != status {
			t.Fatalf("create status %q stored as %q", status, store.adminCreateRow.Status)
		}
	}

	stock := 9
	w = h.do(t, http.MethodPatch, "/api/admin/points/products/1",
		map[string]any{"stock": 9, "status": "inactive"}, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("patch code = %d: %s", w.Code, w.Body.String())
	}
	if store.lastPatchID != 1 || store.patch.Stock == nil || *store.patch.Stock != stock || store.patch.Status == nil || *store.patch.Status != "inactive" {
		t.Fatalf("patch call = id %d patch %+v", store.lastPatchID, store.patch)
	}

	// Validation failures: binding violations → 400 (bindRaceCalendarJSON),
	// unknown statuses → 400 invalid_status (handler-layer closed enum, same
	// convention as the admin redemption list's status filter).
	w = h.do(t, http.MethodPost, "/api/admin/points/products",
		map[string]any{"name": "x", "points_price": 0}, admin)
	if w.Code != http.StatusBadRequest {
		t.Errorf("price 0: %d, want 400", w.Code)
	}
	for _, bad := range []struct{ method, path string }{
		{http.MethodPost, "/api/admin/points/products"},
		{http.MethodPatch, "/api/admin/points/products/1"},
	} {
		w := h.do(t, bad.method, bad.path,
			map[string]any{"name": "x", "points_price": 5, "status": "bogus"}, admin)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s bogus status: %d, want 400", bad.method, w.Code)
			continue
		}
		var env struct {
			Error string `json:"error"`
		}
		decodePointsJSON(t, w, &env)
		if env.Error != "invalid_status" {
			t.Errorf("envelope = %q, want invalid_status", env.Error)
		}
	}
	// Missing id → 404.
	h2 := newPointsHarness(t, &fakePointsStore{patchErr: storage.ErrPointProductNotFound})
	w = h2.do(t, http.MethodPatch, "/api/admin/points/products/99",
		map[string]any{"stock": 1}, h2.adminToken(t))
	if w.Code != http.StatusNotFound {
		t.Errorf("missing id: %d, want 404", w.Code)
	}
}

func TestPoints_ProductImageUpload(t *testing.T) {
	h := newPointsHarness(t, &fakePointsStore{})
	admin, user := h.adminToken(t), h.userToken(t, testSub)
	png := append([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}, make([]byte, 64)...)

	doUpload := func(t *testing.T, headers map[string]string, payload []byte) *httptest.ResponseRecorder {
		t.Helper()
		raw, ct := multipartImageBody(payload)
		r := httptest.NewRequest(http.MethodPost, "/api/admin/points/product-images", bytes.NewReader(raw))
		r.Header.Set("Content-Type", ct)
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.svc.Router().ServeHTTP(w, r)
		return w
	}

	// Anonymous → 401; a user JWT is refused by the admin-tier guard on the
	// bare-engine chain (admin only, never the other way around).
	if w := doUpload(t, nil, png); w.Code != http.StatusUnauthorized {
		t.Errorf("anonymous upload: %d, want 401", w.Code)
	}
	if w := doUpload(t, user, png); w.Code != http.StatusForbidden {
		t.Errorf("user upload: %d, want 403", w.Code)
	}

	// Bucket not configured → 503 cos_not_configured (same envelope as feedback).
	h.images.configured = false
	if w := doUpload(t, admin, png); w.Code != http.StatusServiceUnavailable {
		t.Errorf("unconfigured upload: %d, want 503", w.Code)
	}
	h.images.configured = true

	// Oversize → 413 (the shared 10MB feedback-contract boundary); non-image →
	// 415 (same codes as feedback).
	if w := doUpload(t, admin, append(png, make([]byte, feedbackImageMaxBytes-len(png)+1)...)); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversize upload: %d, want 413", w.Code)
	}
	if w := doUpload(t, admin, []byte("just text, definitely not an image")); w.Code != http.StatusUnsupportedMediaType {
		t.Errorf("text upload: %d, want 415", w.Code)
	}

	// Happy path: global points/products/ namespace (admin content, no per-user
	// scope) plus the public URL round-trip.
	w := doUpload(t, admin, png)
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d (body=%s)", w.Code, w.Body.String())
	}
	var resp productImageUploadResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !strings.HasPrefix(resp.CosKey, "points/products/") || !strings.HasSuffix(resp.CosKey, ".png") {
		t.Fatalf("key = %q", resp.CosKey)
	}
	if resp.URL == "" || resp.URL != h.images.PublicURL(resp.CosKey) {
		t.Fatalf("url = %q, want the bucket public URL of %q", resp.URL, resp.CosKey)
	}
	if len(h.images.uploaded[resp.CosKey]) != len(png) {
		t.Fatal("uploaded bytes must round-trip")
	}
}

func TestPoints_AdminRedemptionsAndShip(t *testing.T) {
	store := &fakePointsStore{
		adminPage:  &storage.AdminRedemptionPage{Items: []*storage.PointRedemption{{ID: "o1", UserID: testSub, Status: storage.RedemptionStatusPendingShipment}}},
		shipResult: &storage.PointRedemption{ID: "o1", UserID: testSub, Status: storage.RedemptionStatusShipped},
	}
	h := newPointsHarness(t, store)
	admin := h.adminToken(t)

	w := h.do(t, http.MethodGet, "/api/admin/points/redemptions?status=pending_shipment&limit=10", nil, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("list code = %d: %s", w.Code, w.Body.String())
	}
	var got adminRedemptionsResponse
	decodePointsJSON(t, w, &got)
	if len(got.Redemptions) != 1 || got.Redemptions[0].UserID != testSub {
		t.Fatalf("body = %+v", got)
	}
	if store.adminStatus != "pending_shipment" || store.limit != 10 {
		t.Fatalf("store call = %+v", store)
	}

	w = h.do(t, http.MethodPatch, "/api/admin/points/redemptions/o1/ship",
		map[string]any{"tracking_no": "SF123"}, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("ship code = %d: %s", w.Code, w.Body.String())
	}
	if store.shipID != "o1" || store.shipTracking != "SF123" {
		t.Fatalf("ship call = %q %q", store.shipID, store.shipTracking)
	}

	// Missing tracking_no → 400; missing order → 404; bad status filter → 422.
	w = h.do(t, http.MethodPatch, "/api/admin/points/redemptions/o1/ship", map[string]any{}, admin)
	if w.Code != http.StatusBadRequest {
		t.Errorf("no tracking_no: %d, want 400", w.Code)
	}
	h2 := newPointsHarness(t, &fakePointsStore{shipErr: storage.ErrPointRedemptionNotFound})
	w = h2.do(t, http.MethodPatch, "/api/admin/points/redemptions/zz/ship",
		map[string]any{"tracking_no": "SF"}, h2.adminToken(t))
	if w.Code != http.StatusNotFound {
		t.Errorf("missing order: %d, want 404", w.Code)
	}
	// Unknown status filter → 400 invalid_status before the store is reached
	// (same envelope as the roadmap admin tab).
	w = h.do(t, http.MethodGet, "/api/admin/points/redemptions?status=bogus", nil, admin)
	if w.Code != http.StatusBadRequest {
		t.Errorf("bad status filter: %d, want 400", w.Code)
	}
	var env struct {
		Error string `json:"error"`
	}
	decodePointsJSON(t, w, &env)
	if env.Error != "invalid_status" {
		t.Errorf("envelope = %q, want invalid_status", env.Error)
	}
}

// TestPoints_AdminSkuCRUD walks the SKU-row surface (devops#909): create /
// patch / delete round-trips, the 404 mapping for foreign or missing rows,
// and the handler-layer spec_mode enum check.
func TestPoints_AdminSkuCRUD(t *testing.T) {
	store := &fakePointsStore{
		skuPatch: &storage.PointProductSku{ID: 42, ProductID: 1, SpecValue: "XL", Stock: 8},
	}
	h := newPointsHarness(t, store)
	admin := h.adminToken(t)

	// Create: 201 with the full projection, product id taken from the path.
	w := h.do(t, http.MethodPost, "/api/admin/points/products/1/skus",
		map[string]any{"spec_value": "XL", "stock": 8, "sort_order": 2}, admin)
	if w.Code != http.StatusCreated {
		t.Fatalf("create code = %d: %s", w.Code, w.Body.String())
	}
	var created adminSkuResponse
	decodePointsJSON(t, w, &created)
	if created.ID != 42 || created.ProductID != 1 || created.SpecValue != "XL" || created.Stock != 8 {
		t.Fatalf("created = %+v", created)
	}
	if store.lastSkuProductID != 1 || store.skuCreate.SpecValue != "XL" || store.skuCreate.SortOrder != 2 {
		t.Fatalf("store create call = %+v", store.skuCreate)
	}

	// Patch: absolute stock rides SkuPatch verbatim.
	w = h.do(t, http.MethodPatch, "/api/admin/points/products/1/skus/42",
		map[string]any{"stock": 8}, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("patch code = %d: %s", w.Code, w.Body.String())
	}
	if store.lastSkuProductID != 1 || store.lastSkuID != 42 ||
		store.skuPatchBody.Stock == nil || *store.skuPatchBody.Stock != 8 {
		t.Fatalf("store patch call = id %d/%d patch %+v", store.lastSkuProductID, store.lastSkuID, store.skuPatchBody)
	}

	// Delete: 204, scoped to (product, sku).
	w = h.do(t, http.MethodDelete, "/api/admin/points/products/1/skus/42", nil, admin)
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete code = %d", w.Code)
	}
	if store.lastSkuProductID != 1 || store.lastSkuID != 42 || !store.skuDeleted {
		t.Fatalf("store delete call = %d/%d deleted=%v", store.lastSkuProductID, store.lastSkuID, store.skuDeleted)
	}

	// Validation: empty spec_value → 400.
	w = h.do(t, http.MethodPost, "/api/admin/points/products/1/skus",
		map[string]any{"stock": 1}, admin)
	if w.Code != http.StatusBadRequest {
		t.Errorf("empty spec_value: %d, want 400", w.Code)
	}

	// Missing product / sku → 404 with the right envelope.
	h2 := newPointsHarness(t, &fakePointsStore{skuCreateErr: storage.ErrPointProductNotFound})
	w = h2.do(t, http.MethodPost, "/api/admin/points/products/99/skus",
		map[string]any{"spec_value": "M"}, h2.adminToken(t))
	if w.Code != http.StatusNotFound {
		t.Errorf("missing product: %d, want 404", w.Code)
	}
	h3 := newPointsHarness(t, &fakePointsStore{skuPatchErr: storage.ErrPointProductSkuNotFound})
	w = h3.do(t, http.MethodPatch, "/api/admin/points/products/1/skus/42",
		map[string]any{"stock": 1}, h3.adminToken(t))
	if w.Code != http.StatusNotFound {
		t.Errorf("missing sku: %d, want 404", w.Code)
	}
	var env struct {
		Error string `json:"error"`
	}
	decodePointsJSON(t, w, &env)
	if env.Error != "sku_not_found" {
		t.Errorf("envelope = %q, want sku_not_found", env.Error)
	}
}

// TestPoints_SpecModeEnum checks the third closed enum (devops#909): unknown
// spec_mode tokens answer 400 invalid_spec_mode on create and PATCH, the
// defaults fill single.
func TestPoints_SpecModeEnum(t *testing.T) {
	store := &fakePointsStore{
		patchResult: &storage.PointProduct{ID: 1},
	}
	h := newPointsHarness(t, store)
	admin := h.adminToken(t)

	for _, mode := range []string{storage.ProductSpecModeSingle, storage.ProductSpecModeBySku} {
		w := h.do(t, http.MethodPost, "/api/admin/points/products",
			map[string]any{"name": "新品", "points_price": 5, "spec_mode": mode}, admin)
		if w.Code != http.StatusCreated {
			t.Fatalf("create spec_mode %q: %d", mode, w.Code)
		}
		if store.adminCreateRow.SpecMode != mode {
			t.Fatalf("create spec_mode %q stored as %q", mode, store.adminCreateRow.SpecMode)
		}
	}
	// Absent spec_mode defaults to single (the stock behaviour).
	w := h.do(t, http.MethodPost, "/api/admin/points/products",
		map[string]any{"name": "新品", "points_price": 5}, admin)
	if w.Code != http.StatusCreated || store.adminCreateRow.SpecMode != storage.ProductSpecModeSingle {
		t.Fatalf("default spec_mode = %q, want single", store.adminCreateRow.SpecMode)
	}
	// PATCH passes the enum through.
	w = h.do(t, http.MethodPatch, "/api/admin/points/products/1",
		map[string]any{"spec_mode": "by_sku"}, admin)
	if w.Code != http.StatusOK || store.patch.SpecMode == nil || *store.patch.SpecMode != storage.ProductSpecModeBySku {
		t.Fatalf("patch spec_mode = %+v", store.patch.SpecMode)
	}
	// Unknown tokens → 400 invalid_spec_mode.
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodPost, "/api/admin/points/products"},
		{http.MethodPatch, "/api/admin/points/products/1"},
	} {
		w := h.do(t, tc.method, tc.path,
			map[string]any{"name": "x", "points_price": 5, "spec_mode": "bogus"}, admin)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s bogus spec_mode: %d, want 400", tc.method, w.Code)
			continue
		}
		var env struct {
			Error string `json:"error"`
		}
		decodePointsJSON(t, w, &env)
		if env.Error != "invalid_spec_mode" {
			t.Errorf("envelope = %q, want invalid_spec_mode", env.Error)
		}
	}
}

// TestPoints_ListProductsSkuWire checks the by_sku card wire shape
// (devops#909): skus rendered for by_sku (stock = the SKU sum), absent for
// single, sku_label only on orders that carry it.
func TestPoints_ListProductsSkuWire(t *testing.T) {
	store := &fakePointsStore{products: []storage.PointProductListing{
		{Product: storage.PointProduct{
			ID: 5, Name: "背心", PointsPrice: 50, Stock: 99, SpecMode: storage.ProductSpecModeBySku,
		}, Skus: []storage.PointProductSku{
			{ID: 11, ProductID: 5, SpecValue: "S", Stock: 0},
			{ID: 12, ProductID: 5, SpecValue: "M", Stock: 4},
		}},
		{Product: storage.PointProduct{
			ID: 6, Name: "毛巾", PointsPrice: 20, Stock: 7, SpecMode: storage.ProductSpecModeSingle,
		}},
	}}
	h := newPointsHarness(t, store)
	w := h.do(t, http.MethodGet, "/api/users/me/points/products", nil, h.userToken(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d: %s", w.Code, w.Body.String())
	}
	raw := w.Body.String()
	// by_sku card: stock is the SKU sum, the skus array is present.
	if !strings.Contains(raw, `"spec_mode":"by_sku"`) {
		t.Fatal("by_sku card missing spec_mode")
	}
	var got productsResponse
	decodePointsJSON(t, w, &got)
	bySku, single := got.Products[0], got.Products[1]
	if bySku.Stock != 4 || len(bySku.Skus) != 2 || bySku.Skus[0].ID != 11 || bySku.Skus[0].Stock != 0 {
		t.Fatalf("by_sku card = %+v (want stock 4 = sku sum)", bySku)
	}
	// single card: legacy wire shape — no skus field, stock unchanged.
	if single.SpecMode != storage.ProductSpecModeSingle || single.Stock != 7 {
		t.Fatalf("single card = %+v", single)
	}
	if strings.Count(raw, `"skus":`) != 1 {
		t.Fatal("exactly the by_sku card must carry a skus field")
	}

	// Order wire: sku_label present when the order carries it, null/absent
	// otherwise.
	label := "M"
	store2 := &fakePointsStore{page: &storage.RedemptionPage{
		Items: []*storage.PointRedemption{
			{ID: "o-by-sku", SkuLabel: &label},
			{ID: "o-legacy"},
		},
	}}
	h2 := newPointsHarness(t, store2)
	w = h2.do(t, http.MethodGet, "/api/users/me/points/redemptions", nil, h2.userToken(t, testSub))
	if w.Code != http.StatusOK {
		t.Fatalf("orders code = %d: %s", w.Code, w.Body.String())
	}
	var orders redemptionsResponse
	decodePointsJSON(t, w, &orders)
	if orders.Redemptions[0].SkuLabel == nil || *orders.Redemptions[0].SkuLabel != "M" {
		t.Fatalf("by_sku order label = %+v", orders.Redemptions[0].SkuLabel)
	}
	if orders.Redemptions[1].SkuLabel != nil {
		t.Fatal("legacy order must render sku_label null")
	}
}
