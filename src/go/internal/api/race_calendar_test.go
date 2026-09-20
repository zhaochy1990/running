package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeRaceCalendarStore is an in-memory RaceCalendarStore. The merge semantics
// under test live in the HTTP handlers, so the fake only needs faithful CRUD and
// filtering — the field-by-field sync merge is covered against real MySQL in
// internal/storage.
type fakeRaceCalendarStore struct {
	events []storage.RaceCalendarEvent
	items  []storage.RaceCalendarItem
	nextID uint64
}

func newFakeRaceCalendarStore() *fakeRaceCalendarStore {
	return &fakeRaceCalendarStore{nextID: 1}
}

func (f *fakeRaceCalendarStore) seedEvent(row storage.RaceCalendarEvent) storage.RaceCalendarEvent {
	row.ID = f.nextID
	f.nextID++
	if row.Month == 0 {
		row.Month, row.DayOfMonth = storage.MonthDayOf(row.RaceDate)
	}
	f.events = append(f.events, row)
	return row
}

func (f *fakeRaceCalendarStore) seedItem(row storage.RaceCalendarItem) storage.RaceCalendarItem {
	row.ID = f.nextID
	f.nextID++
	f.items = append(f.items, row)
	return row
}

func (f *fakeRaceCalendarStore) findEvent(id uint64) int {
	for i := range f.events {
		if f.events[i].ID == id {
			return i
		}
	}
	return -1
}

func (f *fakeRaceCalendarStore) findItem(id uint64) int {
	for i := range f.items {
		if f.items[i].ID == id {
			return i
		}
	}
	return -1
}

func (f *fakeRaceCalendarStore) ListRaceCalendarEvents(_ context.Context, filter storage.RaceCalendarListFilter) ([]storage.RaceCalendarEvent, int64, error) {
	var matched []storage.RaceCalendarEvent
	for _, row := range f.events {
		if filter.Year != "" && !strings.HasPrefix(row.RaceDate, filter.Year+"-") {
			continue
		}
		if filter.Month > 0 && int(row.Month) != filter.Month {
			continue
		}
		if filter.Source != "" && row.Source != filter.Source {
			continue
		}
		if filter.Keyword != "" && !strings.Contains(row.Name, filter.Keyword) &&
			(row.NameCN == nil || !strings.Contains(*row.NameCN, filter.Keyword)) {
			continue
		}
		matched = append(matched, row)
	}
	page, perPage := filter.Page, filter.PerPage
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 20
	}
	start := (page - 1) * perPage
	if start > len(matched) {
		start = len(matched)
	}
	end := start + perPage
	if end > len(matched) {
		end = len(matched)
	}
	return matched[start:end], int64(len(matched)), nil
}

func (f *fakeRaceCalendarStore) GetRaceCalendarEvent(_ context.Context, id uint64) (*storage.RaceCalendarEvent, error) {
	i := f.findEvent(id)
	if i < 0 {
		return nil, storage.ErrRaceCalendarNotFound
	}
	row := f.events[i]
	return &row, nil
}

func (f *fakeRaceCalendarStore) CreateRaceCalendarEvent(_ context.Context, row *storage.RaceCalendarEvent) error {
	for _, existing := range f.events {
		if existing.Source == row.Source && existing.Name == row.Name && existing.RaceDate == row.RaceDate {
			return storage.ErrRaceCalendarConflict
		}
	}
	row.ID = f.nextID
	f.nextID++
	if row.UpdatedAt.IsZero() {
		row.UpdatedAt = time.Now().UTC()
	}
	f.events = append(f.events, *row)
	return nil
}

func (f *fakeRaceCalendarStore) UpdateRaceCalendarEvent(_ context.Context, row *storage.RaceCalendarEvent) error {
	i := f.findEvent(row.ID)
	if i < 0 {
		return storage.ErrRaceCalendarNotFound
	}
	row.UpdatedAt = time.Now().UTC()
	f.events[i] = *row
	return nil
}

func (f *fakeRaceCalendarStore) DeleteRaceCalendarEvent(_ context.Context, id uint64) error {
	i := f.findEvent(id)
	if i < 0 {
		return storage.ErrRaceCalendarNotFound
	}
	f.events = append(f.events[:i], f.events[i+1:]...)
	kept := f.items[:0]
	for _, item := range f.items {
		if item.RaceEventID != id {
			kept = append(kept, item)
		}
	}
	f.items = kept
	return nil
}

func (f *fakeRaceCalendarStore) ListRaceCalendarItems(_ context.Context, eventID uint64) ([]storage.RaceCalendarItem, error) {
	var out []storage.RaceCalendarItem
	for _, item := range f.items {
		if item.RaceEventID == eventID {
			out = append(out, item)
		}
	}
	return out, nil
}

func (f *fakeRaceCalendarStore) GetRaceCalendarItem(_ context.Context, id uint64) (*storage.RaceCalendarItem, error) {
	i := f.findItem(id)
	if i < 0 {
		return nil, storage.ErrRaceCalendarNotFound
	}
	row := f.items[i]
	return &row, nil
}

func (f *fakeRaceCalendarStore) CreateRaceCalendarItem(_ context.Context, row *storage.RaceCalendarItem) error {
	for _, existing := range f.items {
		if existing.RaceEventID == row.RaceEventID && existing.Name == row.Name {
			return storage.ErrRaceCalendarConflict
		}
	}
	row.ID = f.nextID
	f.nextID++
	f.items = append(f.items, *row)
	return nil
}

func (f *fakeRaceCalendarStore) UpdateRaceCalendarItem(_ context.Context, row *storage.RaceCalendarItem) error {
	i := f.findItem(row.ID)
	if i < 0 {
		return storage.ErrRaceCalendarNotFound
	}
	f.items[i] = *row
	return nil
}

func (f *fakeRaceCalendarStore) DeleteRaceCalendarItem(_ context.Context, id uint64) error {
	i := f.findItem(id)
	if i < 0 {
		return storage.ErrRaceCalendarNotFound
	}
	f.items = append(f.items[:i], f.items[i+1:]...)
	return nil
}

// --- harness -----------------------------------------------------------------

type raceHarness struct {
	svc   *Service
	store *fakeRaceCalendarStore
	key   *rsa.PrivateKey
}

func newRaceHarness(t *testing.T) *raceHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	store := newFakeRaceCalendarStore()
	svc := NewService(Config{
		Auth:              NewAuthenticator(testToken, verifier),
		RaceCalendarStore: store,
	})
	return &raceHarness{svc: svc, store: store, key: key}
}

func (h *raceHarness) token(t *testing.T, audience, role string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": "33333333-3333-4333-8333-333333333333", "iss": testIssuer, "aud": audience,
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

func (h *raceHarness) adminToken(t *testing.T) map[string]string {
	return h.token(t, testAdminAudience, "admin")
}

func (h *raceHarness) do(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = strings.NewReader(string(encoded))
	} else {
		reader = strings.NewReader("")
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

func decodeRaceDTO(t *testing.T, w *httptest.ResponseRecorder) raceCalendarDetailDTO {
	t.Helper()
	var got raceCalendarDetailDTO
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
	return got
}

func syncEvent() storage.RaceCalendarEvent {
	return storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "同步赛事",
		RaceDate: "2030-10-01", Month: 10, DayOfMonth: 1, Country: "CHN",
		Province: strPtrAPITest("福建省"), City: strPtrAPITest("厦门市"),
	}
}

func strPtrAPITest(s string) *string { return &s }

func intPtrAPITest(v int) *int { return &v }

// --- tests -------------------------------------------------------------------

func TestRaceCalendarAdmin_TierGuards(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())
	item := h.store.seedItem(storage.RaceCalendarItem{RaceEventID: event.ID, Name: "全程", Type: "Marathon", Origin: storage.RaceOriginSync})

	base := fmt.Sprintf("/api/admin/races/%d", event.ID)
	cases := []struct {
		name, method, path string
		body               any
	}{
		{"list", http.MethodGet, "/api/admin/races", nil},
		{"create", http.MethodPost, "/api/admin/races", map[string]any{"name": "x", "race_date": "2030-01-01"}},
		{"detail", http.MethodGet, base, nil},
		{"update", http.MethodPatch, base, map[string]any{"city": "y"}},
		{"delete", http.MethodDelete, base, nil},
		{"create item", http.MethodPost, base + "/items", map[string]any{"name": "10公里", "type": "10Km"}},
		{"update item", http.MethodPatch, fmt.Sprintf("%s/items/%d", base, item.ID), map[string]any{"quota": 100}},
		{"delete item", http.MethodDelete, fmt.Sprintf("%s/items/%d", base, item.ID), nil},
	}
	for _, tc := range cases {
		if w := h.do(t, tc.method, tc.path, tc.body, nil); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without token = %d, want 401", tc.name, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, tc.body, internalHdr()); w.Code != http.StatusForbidden {
			t.Errorf("%s as internal = %d, want 403", tc.name, w.Code)
		}
		if w := h.do(t, tc.method, tc.path, tc.body, h.token(t, testAudience, "")); w.Code != http.StatusForbidden {
			t.Errorf("%s as user = %d, want 403", tc.name, w.Code)
		}
	}
}

func TestRaceCalendarAdmin_CreateForcesManual(t *testing.T) {
	h := newRaceHarness(t)
	body := map[string]any{
		"name": "新建赛事", "name_cn": "新建赛事中文", "race_date": "2031-03-15",
		"country": "CHN", "city": "北京市", "race_types": []string{"Marathon"},
	}
	w := h.do(t, http.MethodPost, "/api/admin/races", body, h.adminToken(t))
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", w.Code, w.Body.String())
	}
	got := decodeRaceDTO(t, w)
	if got.Origin != storage.RaceOriginManual || got.Source != storage.RaceSourceManual {
		t.Fatalf("origin/source = %q/%q, want manual/manual", got.Origin, got.Source)
	}
	if got.Month != 3 || got.DayOfMonth != 15 {
		t.Errorf("month/day = %d/%d, want 3/15", got.Month, got.DayOfMonth)
	}
	for field, source := range got.FieldSources {
		if source != "manual" {
			t.Errorf("new manual row field %s source = %q, want manual", field, source)
		}
	}
	// A duplicate business key is a 409, not a 500.
	if w := h.do(t, http.MethodPost, "/api/admin/races", body, h.adminToken(t)); w.Code != http.StatusConflict {
		t.Errorf("duplicate create = %d, want 409", w.Code)
	}
	// A bad date is refused before touching the store.
	if w := h.do(t, http.MethodPost, "/api/admin/races", map[string]any{"name": "x", "race_date": "2031-13-01"}, h.adminToken(t)); w.Code != http.StatusBadRequest {
		t.Errorf("bad date create = %d, want 400", w.Code)
	}
}

func TestRaceCalendarAdmin_UpdateMergesOverridesAndUpgradesKeys(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())

	// Override one non-key field: the row stays sync, the field is overridden.
	w := h.do(t, http.MethodPatch, fmt.Sprintf("/api/admin/races/%d", event.ID),
		map[string]any{"city": "厦门（人工）", "overrides": []string{"city"}}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("patch = %d: %s", w.Code, w.Body.String())
	}
	got := decodeRaceDTO(t, w)
	if got.Origin != storage.RaceOriginSync {
		t.Errorf("origin = %q, want sync after a non-key edit", got.Origin)
	}
	if got.City == nil || *got.City != "厦门（人工）" {
		t.Errorf("city = %v, want the edited value", got.City)
	}
	if got.FieldSources["city"] != "overridden" {
		t.Errorf("city source = %q, want overridden", got.FieldSources["city"])
	}
	if got.FieldSources["label"] != "sync" {
		t.Errorf("label source = %q, want sync", got.FieldSources["label"])
	}

	// Editing the name detaches the row.
	w = h.do(t, http.MethodPatch, fmt.Sprintf("/api/admin/races/%d", event.ID),
		map[string]any{"name": "人工改名赛事"}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("rename = %d: %s", w.Code, w.Body.String())
	}
	got = decodeRaceDTO(t, w)
	if got.Origin != storage.RaceOriginManual {
		t.Errorf("origin = %q, want manual after a name edit", got.Origin)
	}
	if got.FieldSources["name"] != "manual" || got.FieldSources["race_date"] != "manual" {
		t.Errorf("key sources = %q/%q, want manual/manual", got.FieldSources["name"], got.FieldSources["race_date"])
	}

	// An unknown override field is a 400.
	if w := h.do(t, http.MethodPatch, fmt.Sprintf("/api/admin/races/%d", event.ID),
		map[string]any{"overrides": []string{"bogus"}}, h.adminToken(t)); w.Code != http.StatusBadRequest {
		t.Errorf("bad override = %d, want 400", w.Code)
	}
	// A missing id is a 404.
	if w := h.do(t, http.MethodPatch, "/api/admin/races/999999",
		map[string]any{"city": "x"}, h.adminToken(t)); w.Code != http.StatusNotFound {
		t.Errorf("missing id = %d, want 404", w.Code)
	}
}

func TestRaceCalendarAdmin_ResetFieldsHandsBackToSync(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "待恢复赛事",
		RaceDate: "2030-11-01", Month: 11, DayOfMonth: 1, Country: "CHN",
		City: strPtrAPITest("人工城市"), AdminOverrides: []string{"city"},
	})

	w := h.do(t, http.MethodPatch, fmt.Sprintf("/api/admin/races/%d", event.ID),
		map[string]any{"reset_fields": []string{"city"}}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("reset = %d: %s", w.Code, w.Body.String())
	}
	got := decodeRaceDTO(t, w)
	if got.City != nil {
		t.Errorf("city = %v, want nil after reset", got.City)
	}
	if got.FieldSources["city"] != "sync" {
		t.Errorf("city source = %q, want sync after reset", got.FieldSources["city"])
	}
	stored := h.store.events[h.store.findEvent(event.ID)]
	if len(stored.AdminOverrides) != 0 {
		t.Errorf("admin_overrides = %v, want empty", stored.AdminOverrides)
	}
}

func TestRaceCalendarAdmin_NullClearsNullableFields(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())

	// An explicit null clears the field (absent would leave it unchanged).
	w := h.do(t, http.MethodPatch, fmt.Sprintf("/api/admin/races/%d", event.ID),
		map[string]any{"city": nil, "overrides": []string{"city"}}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("clear city = %d: %s", w.Code, w.Body.String())
	}
	got := decodeRaceDTO(t, w)
	if got.City != nil {
		t.Errorf("city = %v, want nil", got.City)
	}
	if got.FieldSources["city"] != "overridden" {
		t.Errorf("city source = %q, want overridden", got.FieldSources["city"])
	}

	// The same for a nullable item field.
	item := h.store.seedItem(storage.RaceCalendarItem{RaceEventID: event.ID, Name: "全程", Type: "Marathon", EntryFee: intPtrAPITest(12000), Origin: storage.RaceOriginSync})
	w = h.do(t, http.MethodPatch, fmt.Sprintf("/api/admin/races/%d/items/%d", event.ID, item.ID),
		map[string]any{"entry_fee": nil}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("clear fee = %d: %s", w.Code, w.Body.String())
	}
	var updated raceCalendarItemDTO
	_ = json.Unmarshal(w.Body.Bytes(), &updated)
	if updated.EntryFee != nil {
		t.Errorf("entry_fee = %v, want nil", updated.EntryFee)
	}
	if updated.Origin != storage.RaceOriginManual {
		t.Errorf("origin = %q, want manual after the edit", updated.Origin)
	}
}

func TestRaceCalendarAdmin_ListFiltersAndPagination(t *testing.T) {
	h := newRaceHarness(t)
	h.store.seedEvent(storage.RaceCalendarEvent{Source: "国际田联", Origin: storage.RaceOriginSync, Name: "Tokyo Marathon", RaceDate: "2030-03-01", Month: 3, DayOfMonth: 1, Country: "JPN"})
	h.store.seedEvent(storage.RaceCalendarEvent{Source: "中国田协", Origin: storage.RaceOriginSync, Name: "北京马拉松", NameCN: strPtrAPITest("北京马拉松"), RaceDate: "2030-10-01", Month: 10, DayOfMonth: 1, Country: "CHN"})

	w := h.do(t, http.MethodGet, "/api/admin/races?year=2030&per_page=1&page=1", nil, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", w.Code, w.Body.String())
	}
	var list raceCalendarListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if list.Total != 2 || len(list.Races) != 1 {
		t.Fatalf("total/len = %d/%d, want 2/1", list.Total, len(list.Races))
	}

	w = h.do(t, http.MethodGet, "/api/admin/races?month=10", nil, h.adminToken(t))
	list = raceCalendarListResponse{}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if list.Total != 1 || list.Races[0].Name != "北京马拉松" {
		t.Fatalf("month filter = %+v", list.Races)
	}
	w = h.do(t, http.MethodGet, "/api/admin/races?keyword=Tokyo", nil, h.adminToken(t))
	list = raceCalendarListResponse{}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if list.Total != 1 || list.Races[0].Name != "Tokyo Marathon" {
		t.Fatalf("keyword filter = %+v", list.Races)
	}
	if w := h.do(t, http.MethodGet, "/api/admin/races?year=30", nil, h.adminToken(t)); w.Code != http.StatusBadRequest {
		t.Errorf("bad year = %d, want 400", w.Code)
	}
	if w := h.do(t, http.MethodGet, "/api/admin/races?month=13", nil, h.adminToken(t)); w.Code != http.StatusBadRequest {
		t.Errorf("bad month = %d, want 400", w.Code)
	}
}

func TestRaceCalendarAdmin_ItemLifecycle(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())
	syncItem := h.store.seedItem(storage.RaceCalendarItem{RaceEventID: event.ID, Name: "全程", Type: "Marathon", Origin: storage.RaceOriginSync})
	other := h.store.seedEvent(storage.RaceCalendarEvent{Source: storage.RaceSourceManual, Origin: storage.RaceOriginManual, Name: "另一个", RaceDate: "2030-12-01", Month: 12, DayOfMonth: 1, Country: "CHN"})

	base := fmt.Sprintf("/api/admin/races/%d/items", event.ID)
	w := h.do(t, http.MethodPost, base, map[string]any{"name": "10公里", "type": "10Km", "entry_fee": 8800, "quota": 5000}, h.adminToken(t))
	if w.Code != http.StatusCreated {
		t.Fatalf("create item = %d: %s", w.Code, w.Body.String())
	}
	var created raceCalendarItemDTO
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if created.Origin != storage.RaceOriginManual || created.EntryFee == nil || *created.EntryFee != 8800 {
		t.Fatalf("created item = %+v", created)
	}

	// Editing a sync item upgrades it to manual.
	w = h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, syncItem.ID), map[string]any{"entry_fee": 20000}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("edit item = %d: %s", w.Code, w.Body.String())
	}
	var edited raceCalendarItemDTO
	_ = json.Unmarshal(w.Body.Bytes(), &edited)
	if edited.Origin != storage.RaceOriginManual {
		t.Errorf("edited item origin = %q, want manual", edited.Origin)
	}

	// An item id belonging to another race is a 404, not a cross-event edit.
	if w := h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, other.ID), map[string]any{"quota": 1}, h.adminToken(t)); w.Code != http.StatusNotFound {
		t.Errorf("cross-race item = %d, want 404", w.Code)
	}

	// Detail surfaces both items.
	w = h.do(t, http.MethodGet, fmt.Sprintf("/api/admin/races/%d", event.ID), nil, h.adminToken(t))
	got := decodeRaceDTO(t, w)
	if len(got.Items) != 2 {
		t.Errorf("detail items = %d, want 2", len(got.Items))
	}

	if w := h.do(t, http.MethodDelete, fmt.Sprintf("%s/%d", base, created.ID), nil, h.adminToken(t)); w.Code != http.StatusNoContent {
		t.Errorf("delete item = %d, want 204", w.Code)
	}
	if w := h.do(t, http.MethodDelete, fmt.Sprintf("/api/admin/races/%d", event.ID), nil, h.adminToken(t)); w.Code != http.StatusNoContent {
		t.Errorf("delete event = %d, want 204", w.Code)
	}
	if w := h.do(t, http.MethodGet, fmt.Sprintf("/api/admin/races/%d", event.ID), nil, h.adminToken(t)); w.Code != http.StatusNotFound {
		t.Errorf("detail after delete = %d, want 404", w.Code)
	}
}
