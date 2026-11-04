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

	"github.com/zhaochy1990/stride/internal/storage"
)

type fakeAddressStore struct {
	rows        []storage.UserAddress
	createRow   *storage.UserAddress
	createErr   error
	updateRow   *storage.UserAddress
	updateErr   error
	deleteErr   error
	defaultRow  *storage.UserAddress
	defaultErr  error
	lastUID     string
	lastID      uint64
	lastPatch   storage.AddressPatch
	lastInput   storage.AddressInput
	defaultCall bool
}

func (f *fakeAddressStore) ListAddresses(_ context.Context, userID string) ([]storage.UserAddress, error) {
	f.lastUID = userID
	return f.rows, nil
}

func (f *fakeAddressStore) CreateAddress(_ context.Context, userID string, in storage.AddressInput) (*storage.UserAddress, error) {
	f.lastUID, f.lastInput = userID, in
	if f.createErr != nil {
		return nil, f.createErr
	}
	return f.createRow, nil
}

func (f *fakeAddressStore) UpdateAddress(_ context.Context, userID string, id uint64, patch storage.AddressPatch) (*storage.UserAddress, error) {
	f.lastUID, f.lastID, f.lastPatch = userID, id, patch
	if f.updateErr != nil {
		return nil, f.updateErr
	}
	return f.updateRow, nil
}

func (f *fakeAddressStore) DeleteAddress(_ context.Context, userID string, id uint64) error {
	f.lastUID, f.lastID = userID, id
	return f.deleteErr
}

func (f *fakeAddressStore) SetDefaultAddress(_ context.Context, userID string, id uint64) (*storage.UserAddress, error) {
	f.lastUID, f.lastID, f.defaultCall = userID, id, true
	if f.defaultErr != nil {
		return nil, f.defaultErr
	}
	return f.defaultRow, nil
}

type addressHarness struct {
	svc   *Service
	store *fakeAddressStore
	key   *rsa.PrivateKey
}

func newAddressHarness(t *testing.T, store AddressStore) *addressHarness {
	t.Helper()
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
		AddressStore: store,
	})
	return &addressHarness{svc: svc, store: store.(*fakeAddressStore), key: key}
}

func (h *addressHarness) adminBearer(t *testing.T) map[string]string {
	t.Helper()
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "00000000-0000-4000-8000-000000000003", "iss": testIssuer, "aud": testAdminAudience,
		"role": "admin", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *addressHarness) bearer(t *testing.T, sub string) map[string]string {
	t.Helper()
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *addressHarness) do(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
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

func decodeAddressJSON(t *testing.T, w *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), dst); err != nil {
		t.Fatalf("unmarshal %s: %v", w.Body.String(), err)
	}
}

func TestAddress_FullSurface(t *testing.T) {
	now := time.Now().UTC()
	store := &fakeAddressStore{
		rows:       []storage.UserAddress{{ID: 1, ReceiverName: "张三", IsDefault: true, CreatedAt: now, UpdatedAt: now}},
		createRow:  &storage.UserAddress{ID: 2, ReceiverName: "李四", IsDefault: false, CreatedAt: now, UpdatedAt: now},
		updateRow:  &storage.UserAddress{ID: 1, ReceiverName: "王五", IsDefault: true, CreatedAt: now, UpdatedAt: now},
		defaultRow: &storage.UserAddress{ID: 1, ReceiverName: "张三", IsDefault: true, CreatedAt: now, UpdatedAt: now},
	}
	h := newAddressHarness(t, store)
	auth := h.bearer(t, testSub)

	// Anonymous → 401 on every route.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/users/me/addresses"},
		{http.MethodPost, "/api/users/me/addresses"},
		{http.MethodPatch, "/api/users/me/addresses/1"},
		{http.MethodDelete, "/api/users/me/addresses/1"},
		{http.MethodPatch, "/api/users/me/addresses/1/default"},
	} {
		if w := h.do(t, tc.method, tc.path, map[string]any{"x": 1}, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: %d, want 401", tc.method, tc.path, w.Code)
		}
	}
	// Admin tier never rides the user surface (default-deny group).
	if w := h.do(t, http.MethodGet, "/api/users/me/addresses", nil, h.adminBearer(t)); w.Code != http.StatusForbidden {
		t.Errorf("admin token on address list: %d, want 403", w.Code)
	}

	// LIST
	if w := h.do(t, http.MethodGet, "/api/users/me/addresses", nil, auth); w.Code != http.StatusOK {
		t.Fatalf("list: %d: %s", w.Code, w.Body.String())
	}
	var list addressesResponse
	decodeAddressJSON(t, h.do(t, http.MethodGet, "/api/users/me/addresses", nil, auth), &list)
	if len(list.Addresses) != 1 || list.Addresses[0].ID != 1 || !list.Addresses[0].IsDefault {
		t.Fatalf("list = %+v", list.Addresses)
	}

	// CREATE
	w := h.do(t, http.MethodPost, "/api/users/me/addresses", map[string]any{
		"receiver_name": "李四", "receiver_phone": "13900139000",
		"province": "北京市", "city": "北京市", "district": "海淀区",
		"address_detail": "知春路 1 号", "is_default": false,
	}, auth)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d: %s", w.Code, w.Body.String())
	}
	if store.lastUID != testSub || store.lastInput.ReceiverName != "李四" {
		t.Fatalf("store input = %+v (user %q)", store.lastInput, store.lastUID)
	}
	// Missing required field → 400.
	w = h.do(t, http.MethodPost, "/api/users/me/addresses", map[string]any{
		"receiver_name": "李四", "receiver_phone": "13900139000",
	}, auth)
	if w.Code != http.StatusBadRequest {
		t.Errorf("partial create: %d, want 400", w.Code)
	}
	// Limit reached → 409.
	h2 := newAddressHarness(t, &fakeAddressStore{createErr: storage.ErrAddressLimitReached})
	w = h2.do(t, http.MethodPost, "/api/users/me/addresses", map[string]any{
		"receiver_name": "x", "receiver_phone": "1", "province": "a", "city": "b",
		"district": "c", "address_detail": "d",
	}, h2.bearer(t, testSub))
	if w.Code != http.StatusConflict {
		t.Errorf("11th address: %d, want 409", w.Code)
	}

	// UPDATE
	newName := "王五"
	w = h.do(t, http.MethodPatch, "/api/users/me/addresses/1", map[string]any{"receiver_name": newName}, auth)
	if w.Code != http.StatusOK {
		t.Fatalf("update: %d: %s", w.Code, w.Body.String())
	}
	if store.lastID != 1 || store.lastPatch.ReceiverName == nil || *store.lastPatch.ReceiverName != newName {
		t.Fatalf("patch = %+v", store.lastPatch)
	}

	// SET DEFAULT
	w = h.do(t, http.MethodPatch, "/api/users/me/addresses/1/default", nil, auth)
	if w.Code != http.StatusOK {
		t.Fatalf("set default: %d: %s", w.Code, w.Body.String())
	}
	if !store.defaultCall || store.lastID != 1 {
		t.Fatalf("set default call = %+v", store)
	}

	// DELETE → 204; not-found → 404.
	w = h.do(t, http.MethodDelete, "/api/users/me/addresses/1", nil, auth)
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete: %d, want 204", w.Code)
	}
	if store.lastID != 1 || store.lastUID != testSub {
		t.Fatalf("delete call = %d %q", store.lastID, store.lastUID)
	}
	h3 := newAddressHarness(t, &fakeAddressStore{deleteErr: storage.ErrAddressNotFound})
	w = h3.do(t, http.MethodDelete, "/api/users/me/addresses/99", nil, h3.bearer(t, testSub))
	if w.Code != http.StatusNotFound {
		t.Errorf("missing delete: %d, want 404", w.Code)
	}
	h4 := newAddressHarness(t, &fakeAddressStore{updateErr: storage.ErrAddressNotFound, defaultErr: storage.ErrAddressNotFound})
	w = h4.do(t, http.MethodPatch, "/api/users/me/addresses/99", map[string]any{"city": "x"}, h4.bearer(t, testSub))
	if w.Code != http.StatusNotFound {
		t.Errorf("missing update: %d, want 404", w.Code)
	}
	w = h4.do(t, http.MethodPatch, "/api/users/me/addresses/99/default", nil, h4.bearer(t, testSub))
	if w.Code != http.StatusNotFound {
		t.Errorf("missing set-default: %d, want 404", w.Code)
	}
}
