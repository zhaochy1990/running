package api

import (
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/authsvc"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/points/balances
// ─────────────────────────────────────────────────────────────────────────────

func TestAdminBalances_TierGuards(t *testing.T) {
	h := newPointsHarness(t, &fakePointsStore{})
	user := h.userToken(t, testSub)
	admin := h.adminToken(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/points/balances"},
		{http.MethodPost, "/api/admin/points/balances/00000000-0000-4000-8000-000000000001/adjustments"},
		{http.MethodGet, "/api/admin/points/balances/00000000-0000-4000-8000-000000000001/transactions"},
	} {
		if w := h.do(t, tc.method, tc.path, map[string]any{"x": 1}, user); w.Code != http.StatusForbidden {
			t.Errorf("%s %s user token: %d, want 403", tc.method, tc.path, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, map[string]any{"x": 1}, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s %s anonymous: %d, want 401", tc.method, tc.path, w.Code)
		}
	}
	// Route shape: a POST to the transactions path must not exist.
	if w := h.do(t, http.MethodPost, "/api/admin/points/balances/00000000-0000-4000-8000-000000000001/transactions", map[string]any{"x": 1}, admin); w.Code != http.StatusNotFound {
		t.Errorf("transactions POST: %d, want 404 (route absent)", w.Code)
	}
}

func TestAdminBalances_List(t *testing.T) {
	name := "赵跑者"
	uid := "00000000-0000-4000-8000-000000000001"
	other := "00000000-0000-4000-8000-000000000002"
	auth := &fakeAuthLookup{users: map[string]*authsvc.AdminUser{
		uid: {ID: uid, Name: &name},
		// other resolves without a name: deleted profile stays listable.
		other: {ID: other},
	}}
	store := &fakePointsStore{balancesPage: &storage.AdminPointBalancePage{
		Items: []storage.AdminPointBalance{
			{UserID: uid, Balance: 42, UpdatedAt: time.Date(2026, 11, 6, 2, 0, 0, 0, time.UTC), Providers: []string{"coros", "garmin"}},
			{UserID: other, Balance: -7, UpdatedAt: time.Date(2026, 11, 5, 2, 0, 0, 0, time.UTC)},
		},
		NextCursor: "next-opaque",
	}}
	h := newPointsHarnessWithAuth(t, store, auth)
	admin := h.adminToken(t)

	var resp struct {
		Balances   []adminBalanceResponse `json:"balances"`
		NextCursor *string                `json:"next_cursor"`
	}
	w := h.do(t, http.MethodGet, "/api/admin/points/balances", nil, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	decodePointsJSON(t, w, &resp)
	if len(resp.Balances) != 2 {
		t.Fatalf("balances = %d rows, want 2", len(resp.Balances))
	}
	first := resp.Balances[0]
	if first.UserID != uid || first.Name == nil || *first.Name != name {
		t.Fatalf("first row name resolution failed: %+v", first)
	}
	if len(first.Providers) != 2 || first.Providers[0] != "coros" || first.Providers[1] != "garmin" {
		t.Fatalf("double-bind providers = %v, want [coros garmin]", first.Providers)
	}
	second := resp.Balances[1]
	if second.Name != nil {
		t.Fatalf("unresolvable user name = %v, want nil (raw-id fallback)", second.Name)
	}
	if second.Balance != -7 || second.Providers == nil || len(second.Providers) != 0 {
		t.Fatalf("second row = %+v, want balance -7 with empty providers array", second)
	}
	if resp.NextCursor == nil || *resp.NextCursor != "next-opaque" {
		t.Fatalf("next_cursor = %v, want next-opaque", resp.NextCursor)
	}
	// Name resolution rode the admin bearer through the auth client.
	if auth.gotBearer == "" {
		t.Fatalf("name resolution forwarded no bearer")
	}
}

func TestAdminBalances_ListParamsAndFailures(t *testing.T) {
	uid := "00000000-0000-4000-8000-000000000001"
	admin := func(h *pointsHarness) map[string]string { return h.adminToken(t) }

	t.Run("sort and filters reach the store", func(t *testing.T) {
		store := &fakePointsStore{balancesPage: &storage.AdminPointBalancePage{}}
		h := newPointsHarness(t, store)
		h.do(t, http.MethodGet, "/api/admin/points/balances?sort=balance_desc&user_id="+uid+"&limit=5", nil, admin(h))
		if store.balancesSort != storage.PointBalanceSortBalanceDesc || store.balancesUser != uid || store.limit != 5 {
			t.Fatalf("store got sort=%s user=%s limit=%d", store.balancesSort, store.balancesUser, store.limit)
		}
	})

	t.Run("invalid sort is 400", func(t *testing.T) {
		h := newPointsHarness(t, &fakePointsStore{})
		if w := h.do(t, http.MethodGet, "/api/admin/points/balances?sort=balance", nil, admin(h)); w.Code != http.StatusBadRequest {
			t.Fatalf("sort=balance: %d, want 400", w.Code)
		}
	})

	t.Run("non-canonical user_id is 400", func(t *testing.T) {
		h := newPointsHarness(t, &fakePointsStore{})
		if w := h.do(t, http.MethodGet, "/api/admin/points/balances?user_id=not-a-uuid", nil, admin(h)); w.Code != http.StatusBadRequest {
			t.Fatalf("user_id=not-a-uuid: %d, want 400", w.Code)
		}
	})

	t.Run("user_id and phone together are 400", func(t *testing.T) {
		h := newPointsHarness(t, &fakePointsStore{})
		w := h.do(t, http.MethodGet, "/api/admin/points/balances?user_id="+uid+"&phone=13800000000", nil, admin(h))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("both filters: %d, want 400", w.Code)
		}
	})

	t.Run("phone search narrows to the exact match", func(t *testing.T) {
		auth := &fakeAuthLookup{search: []authsvc.AdminUser{
			{ID: uid, Phone: strPtr("13800000000")},
			{ID: other2, Phone: strPtr("13800000001")},
			{ID: "00000000-0000-4000-8000-000000000009", Email: strPtr("13800000000@mail.com")},
		}}
		store := &fakePointsStore{balancesPage: &storage.AdminPointBalancePage{}}
		h := newPointsHarnessWithAuth(t, store, auth)
		w := h.do(t, http.MethodGet, "/api/admin/points/balances?phone=13800000000", nil, admin(h))
		if w.Code != http.StatusOK {
			t.Fatalf("phone search: %d %s", w.Code, w.Body.String())
		}
		if auth.gotSearch != "13800000000" {
			t.Fatalf("auth search = %q", auth.gotSearch)
		}
		// The LIKE pass returns a near-miss (…01) and an email substring hit;
		// only the exact phone carries into the balances query.
		if len(store.balancesPhoneIDs) != 1 || store.balancesPhoneIDs[0] != uid {
			t.Fatalf("phone ids = %v, want the single exact match", store.balancesPhoneIDs)
		}
	})

	t.Run("phone matching nobody yields an empty page without a store call", func(t *testing.T) {
		auth := &fakeAuthLookup{search: []authsvc.AdminUser{{ID: uid, Email: strPtr("x@mail.com")}}}
		store := &fakePointsStore{}
		h := newPointsHarnessWithAuth(t, store, auth)
		var resp struct {
			Balances   []adminBalanceResponse `json:"balances"`
			NextCursor *string                `json:"next_cursor"`
		}
		w := h.do(t, http.MethodGet, "/api/admin/points/balances?phone=13800000000", nil, admin(h))
		if w.Code != http.StatusOK {
			t.Fatalf("phone miss: %d", w.Code)
		}
		decodePointsJSON(t, w, &resp)
		if len(resp.Balances) != 0 || resp.NextCursor != nil {
			t.Fatalf("empty page = %+v", resp)
		}
		if store.balancesSort != "" {
			t.Fatalf("store consulted on a phone miss")
		}
	})

	t.Run("auth outage on phone search is 503", func(t *testing.T) {
		auth := &fakeAuthLookup{searchErr: errors.New("boom")}
		h := newPointsHarnessWithAuth(t, &fakePointsStore{}, auth)
		if w := h.do(t, http.MethodGet, "/api/admin/points/balances?phone=13800000000", nil, admin(h)); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("auth outage: %d, want 503", w.Code)
		}
	})

	t.Run("phone search without an auth client is 503", func(t *testing.T) {
		h := newPointsHarness(t, &fakePointsStore{})
		if w := h.do(t, http.MethodGet, "/api/admin/points/balances?phone=13800000000", nil, admin(h)); w.Code != http.StatusServiceUnavailable {
			t.Fatalf("nil auth: %d, want 503", w.Code)
		}
	})

	t.Run("storage cursor error is 422", func(t *testing.T) {
		store := &fakePointsStore{balancesErr: &storage.PointCursorError{Message: "bad"}}
		h := newPointsHarness(t, store)
		if w := h.do(t, http.MethodGet, "/api/admin/points/balances?cursor=zzz", nil, admin(h)); w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("cursor error: %d, want 422", w.Code)
		}
	})

	t.Run("no auth client degrades names but keeps the page", func(t *testing.T) {
		store := &fakePointsStore{balancesPage: &storage.AdminPointBalancePage{
			Items: []storage.AdminPointBalance{{UserID: uid, Balance: 3, UpdatedAt: time.Now().UTC()}},
		}}
		h := newPointsHarness(t, store)
		var resp struct {
			Balances []adminBalanceResponse `json:"balances"`
		}
		w := h.do(t, http.MethodGet, "/api/admin/points/balances", nil, admin(h))
		if w.Code != http.StatusOK {
			t.Fatalf("nil auth list: %d", w.Code)
		}
		decodePointsJSON(t, w, &resp)
		if len(resp.Balances) != 1 || resp.Balances[0].Name != nil {
			t.Fatalf("nil-auth row = %+v, want nil name", resp.Balances)
		}
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/points/balances/:user_id/adjustments
// ─────────────────────────────────────────────────────────────────────────────

func TestAdminBalances_Adjust(t *testing.T) {
	uid := "00000000-0000-4000-8000-000000000001"

	okResult := &storage.PointAdjustmentResult{
		Transaction: &storage.PointTransaction{
			ID: "tx-1", UserID: uid, Type: storage.PointTypeAdjust, Amount: -30,
			Remark: strPtr("违规扣除"), CreatedAt: time.Date(2026, 11, 6, 3, 0, 0, 0, time.UTC),
		},
		Balance: -27,
	}

	t.Run("happy path deducts into the negative", func(t *testing.T) {
		store := &fakePointsStore{adjustResult: okResult}
		h := newPointsHarness(t, store)
		var resp adminPointAdjustResponse
		w := h.do(t, http.MethodPost, "/api/admin/points/balances/"+uid+"/adjustments",
			map[string]any{"amount": -30, "reason": "违规扣除"}, h.adminToken(t))
		if w.Code != http.StatusOK {
			t.Fatalf("adjust: %d %s", w.Code, w.Body.String())
		}
		decodePointsJSON(t, w, &resp)
		if resp.UserID != uid || resp.Balance != -27 {
			t.Fatalf("resp = %+v, want uid/-27", resp)
		}
		if resp.Transaction.ID != "tx-1" || resp.Transaction.Amount != -30 || resp.Transaction.Type != storage.PointTypeAdjust {
			t.Fatalf("transaction = %+v", resp.Transaction)
		}
		if store.adjustUID != uid || store.adjustAmount != -30 || store.adjustReason != "违规扣除" {
			t.Fatalf("store captures = %s/%d/%q", store.adjustUID, store.adjustAmount, store.adjustReason)
		}
	})

	t.Run("contract violations are 422", func(t *testing.T) {
		store := &fakePointsStore{adjustResult: okResult}
		h := newPointsHarness(t, store)
		for _, tc := range []struct {
			name   string
			body   map[string]any
			target string
		}{
			{"zero amount", map[string]any{"amount": 0, "reason": "r"}, "amount"},
			{"over ceiling", map[string]any{"amount": 1000001, "reason": "r"}, "amount"},
			{"under floor", map[string]any{"amount": -1000001, "reason": "r"}, "amount"},
			{"missing reason", map[string]any{"amount": 5}, "reason"},
			{"blank reason", map[string]any{"amount": 5, "reason": "  "}, "reason"},
			{"overlong reason", map[string]any{"amount": 5, "reason": string(make([]byte, 256))}, "reason"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				w := h.do(t, http.MethodPost, "/api/admin/points/balances/"+uid+"/adjustments", tc.body, h.adminToken(t))
				if w.Code != http.StatusUnprocessableEntity {
					t.Fatalf("%s: %d, want 422 (%s)", tc.name, w.Code, w.Body.String())
				}
				var verr validationErrorResponse
				decodePointsJSON(t, w, &verr)
				if len(verr.Detail) == 0 || verr.Detail[0].Loc[len(verr.Detail[0].Loc)-1] != tc.target {
					t.Fatalf("%s: detail = %+v, want loc …/%s", tc.name, verr.Detail, tc.target)
				}
			})
		}
		if store.adjustUID != "" {
			t.Fatalf("adjustment ran despite a 422 body")
		}
	})

	t.Run("padded reason rides verbatim", func(t *testing.T) {
		// The 422 contract rejects a blank reason; a reason of spaces-only is
		// blank, while surrounding whitespace on real text is accepted
		// verbatim (the ledger records what the admin typed).
		store := &fakePointsStore{adjustResult: okResult}
		h := newPointsHarness(t, store)
		w := h.do(t, http.MethodPost, "/api/admin/points/balances/"+uid+"/adjustments",
			map[string]any{"amount": 5, "reason": " 线下活动补录 "}, h.adminToken(t))
		if w.Code != http.StatusOK || store.adjustReason != " 线下活动补录 " {
			t.Fatalf("padded reason: %d (%q)", w.Code, store.adjustReason)
		}
	})

	t.Run("reason cap counts runes, not bytes (varchar(255) semantics)", func(t *testing.T) {
		store := &fakePointsStore{adjustResult: okResult}
		h := newPointsHarness(t, store)
		// 255 CJK runes are 765 bytes: under the rune cap, over the old byte
		// check — this exact shape must be accepted.
		w := h.do(t, http.MethodPost, "/api/admin/points/balances/"+uid+"/adjustments",
			map[string]any{"amount": 5, "reason": strings.Repeat("跑", 255)}, h.adminToken(t))
		if w.Code != http.StatusOK {
			t.Fatalf("255-rune reason: %d, want 200", w.Code)
		}
		// 256 runes tip over the cap.
		w = h.do(t, http.MethodPost, "/api/admin/points/balances/"+uid+"/adjustments",
			map[string]any{"amount": 5, "reason": strings.Repeat("跑", 256)}, h.adminToken(t))
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("256-rune reason: %d, want 422", w.Code)
		}
	})

	t.Run("storage validation error is 422 on amount", func(t *testing.T) {
		store := &fakePointsStore{adjustErr: &storage.PointValidationError{Message: "out of range"}}
		h := newPointsHarness(t, store)
		w := h.do(t, http.MethodPost, "/api/admin/points/balances/"+uid+"/adjustments",
			map[string]any{"amount": 3, "reason": "r"}, h.adminToken(t))
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("storage validation: %d, want 422", w.Code)
		}
	})

	t.Run("non-canonical user param is 400", func(t *testing.T) {
		h := newPointsHarness(t, &fakePointsStore{})
		w := h.do(t, http.MethodPost, "/api/admin/points/balances/abc/adjustments",
			map[string]any{"amount": 3, "reason": "r"}, h.adminToken(t))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("bad user param: %d, want 400", w.Code)
		}
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/points/balances/:user_id/transactions
// ─────────────────────────────────────────────────────────────────────────────

func TestAdminBalances_UserTransactions(t *testing.T) {
	uid := "00000000-0000-4000-8000-000000000001"
	reason := "活动补偿"
	store := &fakePointsStore{ledgerPage: &storage.PointPage{
		Items: []*storage.PointTransaction{
			{ID: "tx-1", UserID: uid, Type: storage.PointTypeAdjust, Amount: -5, Ref: "", Remark: &reason,
				CreatedAt: time.Date(2026, 11, 6, 4, 0, 0, 0, time.UTC)},
			{ID: "tx-2", UserID: uid, Type: storage.PointTypeEarnCheckin, Amount: 1,
				CreatedAt: time.Date(2026, 11, 5, 4, 0, 0, 0, time.UTC)},
		},
		Balance:    -4,
		NextCursor: "ledger-cursor",
	}}
	h := newPointsHarness(t, store)
	var resp struct {
		Balance      int                        `json:"balance"`
		Transactions []pointTransactionResponse `json:"transactions"`
		NextCursor   *string                    `json:"next_cursor"`
	}
	w := h.do(t, http.MethodGet, "/api/admin/points/balances/"+uid+"/transactions?limit=2", nil, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("transactions: %d %s", w.Code, w.Body.String())
	}
	decodePointsJSON(t, w, &resp)
	if resp.Balance != -4 || len(resp.Transactions) != 2 || resp.NextCursor == nil || *resp.NextCursor != "ledger-cursor" {
		t.Fatalf("resp = %+v", resp)
	}
	if resp.Transactions[0].Remark == nil || *resp.Transactions[0].Remark != reason {
		t.Fatalf("remark = %v, want the reason surfaced", resp.Transactions[0].Remark)
	}
	if store.uid != uid || store.limit != 2 {
		t.Fatalf("store captures = %s/%d", store.uid, store.limit)
	}

	if w := h.do(t, http.MethodGet, "/api/admin/points/balances/nope/transactions", nil, h.adminToken(t)); w.Code != http.StatusBadRequest {
		t.Fatalf("bad param: %d, want 400", w.Code)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// shared bits
// ─────────────────────────────────────────────────────────────────────────────

var other2 = "00000000-0000-4000-8000-000000000003"

func strPtr(s string) *string { return &s }
