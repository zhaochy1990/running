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

// --- fakes -------------------------------------------------------------------

// fakeRaceFavoriteStore is an in-memory RaceFavoriteStore; the offboarding
// rules live in the real store (covered against MySQL in internal/storage), so
// the fake models only what the HTTP layer needs: toggle state and the id set.
type fakeRaceFavoriteStore struct {
	favorites map[string]map[uint64]bool // user -> race -> favorited
	missing   map[uint64]bool            // race ids the store reports not found
}

func newFakeRaceFavoriteStore() *fakeRaceFavoriteStore {
	return &fakeRaceFavoriteStore{
		favorites: map[string]map[uint64]bool{},
		missing:   map[uint64]bool{},
	}
}

func (f *fakeRaceFavoriteStore) ToggleRaceFavorite(_ context.Context, userID string, raceID uint64) (bool, error) {
	if f.missing[raceID] {
		return false, storage.ErrRaceCalendarNotFound
	}
	set := f.favorites[userID]
	if set == nil {
		set = map[uint64]bool{}
		f.favorites[userID] = set
	}
	set[raceID] = !set[raceID]
	return set[raceID], nil
}

func (f *fakeRaceFavoriteStore) ListRaceFavoriteIDs(_ context.Context, userID string) ([]uint64, error) {
	var ids []uint64
	for id, on := range f.favorites[userID] {
		if on {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// fakeRacePlanStore is an in-memory RacePlanStore. It keeps one plan per
// (user, race) like the UNIQUE(user, event) row and applies the same
// offboarding layering as the real store so the list DTO path is exercised.
type fakeRacePlanStore struct {
	plans   map[string]map[uint64]*storage.RacePlan // user -> race -> plan
	races   map[uint64]*storage.RaceCalendarEvent   // the join input
	missing map[uint64]bool
	nextID  uint64
}

func newFakeRacePlanStore() *fakeRacePlanStore {
	return &fakeRacePlanStore{
		plans:   map[string]map[uint64]*storage.RacePlan{},
		races:   map[uint64]*storage.RaceCalendarEvent{},
		missing: map[uint64]bool{},
		nextID:  1,
	}
}

func (f *fakeRacePlanStore) UpsertRacePlan(_ context.Context, up storage.RacePlanUpsert) (*storage.RacePlan, error) {
	if f.missing[up.RaceEventID] {
		return nil, storage.ErrRaceCalendarNotFound
	}
	byRace := f.plans[up.UserID]
	if byRace == nil {
		byRace = map[uint64]*storage.RacePlan{}
		f.plans[up.UserID] = byRace
	}
	now := time.Now().UTC()
	cur := byRace[up.RaceEventID]
	if cur == nil {
		cur = &storage.RacePlan{
			ID: f.nextID, UserID: up.UserID, RaceEventID: up.RaceEventID,
			ItemType: up.ItemType, State: up.State,
			CreatedAt: now, UpdatedAt: now,
		}
		f.nextID++
		byRace[up.RaceEventID] = cur
	}
	cur.ItemType = up.ItemType
	cur.State = up.State
	if up.Hotel != nil {
		cur.Hotel = *up.Hotel
	}
	if up.Transit != nil {
		cur.Transit = *up.Transit
	}
	cur.UpdatedAt = now
	cp := *cur
	return &cp, nil
}

func (f *fakeRacePlanStore) DeleteRacePlan(_ context.Context, userID string, raceID uint64) error {
	if f.plans[userID][raceID] == nil {
		return storage.ErrRacePlanNotFound
	}
	delete(f.plans[userID], raceID)
	return nil
}

func (f *fakeRacePlanStore) ListRacePlans(_ context.Context, userID string) ([]storage.RacePlanWithRace, error) {
	out := []storage.RacePlanWithRace{}
	for _, plan := range f.plans[userID] {
		race := f.races[plan.RaceEventID]
		if plan.State == storage.RacePlanStateLost && (race == nil || !race.Published) {
			continue
		}
		out = append(out, storage.RacePlanWithRace{Plan: *plan, Race: race})
	}
	return out, nil
}

// --- harness -----------------------------------------------------------------

// engagementHarness wires both engagement surfaces with their fakes and an
// admin-aware verifier, so the tier guards are exercised for real.
type engagementHarness struct {
	svc   *Service
	favs  *fakeRaceFavoriteStore
	plans *fakeRacePlanStore
	key   *rsa.PrivateKey
}

func newEngagementHarness(t *testing.T) *engagementHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	favs := newFakeRaceFavoriteStore()
	plans := newFakeRacePlanStore()
	svc := NewService(Config{
		Auth:              NewAuthenticator(testToken, verifier),
		RaceFavoriteStore: favs,
		RacePlanStore:     plans,
	})
	return &engagementHarness{svc: svc, favs: favs, plans: plans, key: key}
}

func (h *engagementHarness) token(t *testing.T, audience, role string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": "11111111-2222-4333-8333-333333333333", "iss": testIssuer, "aud": audience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	if role != "" {
		claims["role"] = role
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *engagementHarness) userToken(t *testing.T) map[string]string {
	return h.token(t, testAudience, "")
}

func (h *engagementHarness) adminToken(t *testing.T) map[string]string {
	return h.token(t, testAdminAudience, "admin")
}

func (h *engagementHarness) do(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
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

// --- favorites ---------------------------------------------------------------

func TestRaceFavorites_TierGuards(t *testing.T) {
	h := newEngagementHarness(t)
	cases := []struct {
		name, method, path string
		body               any
	}{
		{"toggle", http.MethodPost, "/api/users/me/race-favorites/7/toggle", nil},
		{"list", http.MethodGet, "/api/users/me/race-favorites", nil},
	}
	for _, tc := range cases {
		if w := h.do(t, tc.method, tc.path, tc.body, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without token = %d, want 401", tc.name, w.Code)
		}
		// Internal and admin tiers are refused like every other "me" surface:
		// the middleware 403s admin, requireUser 401s internal (training-goal
		// parity).
		if w := h.do(t, tc.method, tc.path, tc.body, internalHdr()); w.Code != http.StatusUnauthorized {
			t.Errorf("%s as internal = %d, want 401", tc.name, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, tc.body, h.adminToken(t)); w.Code != http.StatusForbidden {
			t.Errorf("%s as admin = %d, want 403", tc.name, w.Code)
		}
	}
}

func TestRaceFavorites_Toggle(t *testing.T) {
	h := newEngagementHarness(t)
	h.favs.missing[9] = true

	w := h.do(t, http.MethodPost, "/api/users/me/race-favorites/7/toggle", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("toggle on = %d: %s", w.Code, w.Body.String())
	}
	var on raceFavoriteToggleResponse
	if err := json.Unmarshal(w.Body.Bytes(), &on); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !on.Favorited || on.RaceID != 7 {
		t.Fatalf("toggle on body: %+v", on)
	}
	w = h.do(t, http.MethodPost, "/api/users/me/race-favorites/7/toggle", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("toggle off = %d", w.Code)
	}
	var off raceFavoriteToggleResponse
	_ = json.Unmarshal(w.Body.Bytes(), &off)
	if off.Favorited {
		t.Fatalf("toggle off body: %+v", off)
	}

	if w := h.do(t, http.MethodPost, "/api/users/me/race-favorites/9/toggle", nil, h.userToken(t)); w.Code != http.StatusNotFound {
		t.Fatalf("toggle missing race = %d, want 404", w.Code)
	}
	if w := h.do(t, http.MethodPost, "/api/users/me/race-favorites/abc/toggle", nil, h.userToken(t)); w.Code != http.StatusBadRequest {
		t.Fatalf("toggle bad id = %d, want 400", w.Code)
	}
}

func TestRaceFavorites_List(t *testing.T) {
	h := newEngagementHarness(t)
	for _, id := range []uint64{7, 8} {
		if _, err := h.favs.ToggleRaceFavorite(context.Background(), "11111111-2222-4333-8333-333333333333", id); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	w := h.do(t, http.MethodGet, "/api/users/me/race-favorites", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", w.Code, w.Body.String())
	}
	var got raceFavoritesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.RaceIDs) != 2 {
		t.Fatalf("race_ids = %v, want 2 ids", got.RaceIDs)
	}
}

// --- plans -------------------------------------------------------------------

func TestRacePlans_TierGuards(t *testing.T) {
	h := newEngagementHarness(t)
	cases := []struct {
		name, method, path string
		body               any
	}{
		{"upsert", http.MethodPut, "/api/users/me/race-plans/7", map[string]string{"item_type": "Marathon", "state": "registered"}},
		{"delete", http.MethodDelete, "/api/users/me/race-plans/7", nil},
		{"list", http.MethodGet, "/api/users/me/race-plans", nil},
	}
	for _, tc := range cases {
		if w := h.do(t, tc.method, tc.path, tc.body, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without token = %d, want 401", tc.name, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, tc.body, internalHdr()); w.Code != http.StatusUnauthorized {
			t.Errorf("%s as internal = %d, want 401", tc.name, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, tc.body, h.adminToken(t)); w.Code != http.StatusForbidden {
			t.Errorf("%s as admin = %d, want 403", tc.name, w.Code)
		}
	}
}

func TestRacePlans_UpsertValidation(t *testing.T) {
	h := newEngagementHarness(t)
	h.plans.missing[9] = true

	w := h.do(t, http.MethodPut, "/api/users/me/race-plans/7",
		map[string]string{"item_type": "Marathon", "state": "registered"}, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("upsert = %d: %s", w.Code, w.Body.String())
	}
	var plan racePlanUpsertResponse
	if err := json.Unmarshal(w.Body.Bytes(), &plan); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if plan.ItemType != "Marathon" || plan.State != "registered" || plan.RaceID != 7 {
		t.Fatalf("upsert body: %+v", plan)
	}

	cases := []struct {
		name string
		body map[string]any
		want string
	}{
		{"missing state", map[string]any{"item_type": "Marathon"}, "state"},
		{"missing item_type", map[string]any{"state": "registered"}, "item_type"},
		{"bad item_type", map[string]any{"item_type": "超级马拉松", "state": "registered"}, "item_type"},
		{"bad state", map[string]any{"item_type": "Marathon", "state": "signed_up"}, "state"},
	}
	for _, tc := range cases {
		w := h.do(t, http.MethodPut, "/api/users/me/race-plans/7", tc.body, h.userToken(t))
		if w.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s = %d (%s), want 422", tc.name, w.Code, w.Body.String())
			continue
		}
		if !strings.Contains(w.Body.String(), tc.want) {
			t.Errorf("%s detail = %s, want field %q", tc.name, w.Body.String(), tc.want)
		}
	}

	if w := h.do(t, http.MethodPut, "/api/users/me/race-plans/9",
		map[string]string{"item_type": "Marathon", "state": "registered"}, h.userToken(t)); w.Code != http.StatusNotFound {
		t.Fatalf("upsert missing race = %d, want 404", w.Code)
	}
}

func TestRacePlans_Delete(t *testing.T) {
	h := newEngagementHarness(t)
	if w := h.do(t, http.MethodDelete, "/api/users/me/race-plans/7", nil, h.userToken(t)); w.Code != http.StatusNotFound {
		t.Fatalf("delete absent = %d, want 404", w.Code)
	}
	if _, err := h.plans.UpsertRacePlan(context.Background(), storage.RacePlanUpsert{
		UserID: "11111111-2222-4333-8333-333333333333", RaceEventID: 7,
		ItemType: "Marathon", State: storage.RacePlanStateRegistered,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if w := h.do(t, http.MethodDelete, "/api/users/me/race-plans/7", nil, h.userToken(t)); w.Code != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", w.Code)
	}
}

func TestRacePlans_ListOffboardedProjection(t *testing.T) {
	h := newEngagementHarness(t)
	uid := "11111111-2222-4333-8333-333333333333"
	city, province := "杭州市", "浙江省"
	h.plans.races[7] = &storage.RaceCalendarEvent{
		ID: 7, Name: "Hangzhou Marathon", NameCN: &city, RaceDate: "2032-11-01",
		Province: &province, Published: true,
	}
	seed := func(raceID uint64, state string) {
		t.Helper()
		if _, err := h.plans.UpsertRacePlan(context.Background(), storage.RacePlanUpsert{
			UserID: uid, RaceEventID: raceID, ItemType: "Marathon", State: state,
		}); err != nil {
			t.Fatalf("seed race=%d: %v", raceID, err)
		}
	}
	seed(7, storage.RacePlanStateWon)
	seed(8, storage.RacePlanStateRegistered) // race row absent -> offboarded

	w := h.do(t, http.MethodGet, "/api/users/me/race-plans", nil, h.userToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", w.Code, w.Body.String())
	}
	var got racePlansResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Plans) != 2 {
		t.Fatalf("plans = %d, want 2", len(got.Plans))
	}
	byRace := map[uint64]racePlanDTO{}
	for _, p := range got.Plans {
		byRace[p.RaceID] = p
	}
	live := byRace[7]
	if live.Offboarded || live.Race == nil || live.Race.NameCN == nil || *live.Race.NameCN != city {
		t.Fatalf("published plan projection wrong: %+v", live)
	}
	off := byRace[8]
	if !off.Offboarded || off.Race != nil {
		t.Fatalf("plan without race must be offboarded with null race: %+v", off)
	}
}
