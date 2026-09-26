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
// under test live in the HTTP handlers, so the fake only needs faithful CRUD —
// the field-by-field sync merge is covered against real MySQL in
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
		if filter.ContentStale && !row.ContentStale {
			continue
		}
		if filter.Published != nil && row.Published != *filter.Published {
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

func (f *fakeRaceCalendarStore) MoveRaceContent(_ context.Context, sourceEventID, targetEventID uint64) error {
	si := f.findEvent(sourceEventID)
	ti := f.findEvent(targetEventID)
	if si < 0 || ti < 0 {
		return storage.ErrRaceCalendarNotFound
	}
	if sourceEventID == targetEventID {
		return storage.ErrRaceCalendarConflict
	}
	source := f.events[si]
	target := f.events[ti]
	if target.HasContent() {
		return storage.ErrRaceContentConflict
	}
	for _, item := range f.items {
		if item.RaceEventID == targetEventID && item.HasAdminData() {
			return storage.ErrRaceContentConflict
		}
	}
	target.PartitionRule = source.PartitionRule
	target.SignupTimeline = source.SignupTimeline
	target.SignupChannels = source.SignupChannels
	target.PacketPickup = source.PacketPickup
	target.Climate = source.Climate
	target.WeatherWindows = source.WeatherWindows
	target.ContentStale = false
	f.events[ti] = target
	// Carry each source item's admin data over by name, recreating the row on the
	// target when the name is not there.
	for _, item := range f.items {
		if item.RaceEventID != sourceEventID || !item.HasAdminData() {
			continue
		}
		landed := false
		for j := range f.items {
			if f.items[j].RaceEventID == targetEventID && f.items[j].Name == item.Name {
				id, origin := f.items[j].ID, f.items[j].Origin
				f.items[j] = item
				f.items[j].ID, f.items[j].RaceEventID, f.items[j].Origin = id, targetEventID, origin
				f.items[j].ContentStale = false
				landed = true
				break
			}
		}
		if !landed {
			row := item
			row.ID = f.nextID
			f.nextID++
			row.RaceEventID = targetEventID
			row.Origin = storage.RaceOriginManual
			row.ContentStale = false
			f.items = append(f.items, row)
		}
	}
	f.events = append(f.events[:si], f.events[si+1:]...)
	kept := f.items[:0]
	for _, item := range f.items {
		if item.RaceEventID != sourceEventID {
			kept = append(kept, item)
		}
	}
	f.items = kept
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

func floatPtrAPITest(v float64) *float64 { return &v }

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

	// The same for a nullable item field — and clearing it does not detach the
	// row: entry_fee is not sync-managed, so there is nothing to override and the
	// item stays on the mirror.
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
	if updated.Origin != storage.RaceOriginSync {
		t.Errorf("origin = %q, want sync (entry_fee is not sync-managed)", updated.Origin)
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

	// Editing a field the upstream never supplies (entry_fee) records no
	// override: the sync does not write that column, so the row stays on the
	// mirror and keeps the administrator's value.
	w = h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, syncItem.ID), map[string]any{"entry_fee": 20000}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("edit item = %d: %s", w.Code, w.Body.String())
	}
	var edited raceCalendarItemDTO
	_ = json.Unmarshal(w.Body.Bytes(), &edited)
	if edited.Origin != storage.RaceOriginSync {
		t.Errorf("edited item origin = %q, want sync (entry_fee is not sync-managed)", edited.Origin)
	}
	if edited.EntryFee == nil || *edited.EntryFee != 20000 {
		t.Errorf("edited entry fee = %v, want 20000", edited.EntryFee)
	}

	// Editing a sync-managed field (type) records an override and keeps the row
	// on the mirror.
	w = h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, syncItem.ID), map[string]any{"type": "HalfMarathon"}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("edit type = %d: %s", w.Code, w.Body.String())
	}
	if stored := h.store.items[h.store.findItem(syncItem.ID)]; stored.Origin != storage.RaceOriginSync ||
		len(stored.AdminOverrides) != 1 || stored.AdminOverrides[0] != "type" {
		t.Errorf("stored item = %+v, want origin=sync with a type override", stored)
	}

	// Editing the identity key detaches the row from the mirror.
	w = h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, syncItem.ID), map[string]any{"name": "全程（改）"}, h.adminToken(t))
	if w.Code != http.StatusOK {
		t.Fatalf("rename item = %d: %s", w.Code, w.Body.String())
	}
	if stored := h.store.items[h.store.findItem(syncItem.ID)]; stored.Origin != storage.RaceOriginManual {
		t.Errorf("renamed item origin = %q, want manual", stored.Origin)
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

// TestRaceCalendarAdmin_EventContentPatch covers the merged content sections on
// the race row: full-replace object, tri-state (absent untouched / null clear),
// validation, and the content_stale clear when content is emptied.
func TestRaceCalendarAdmin_EventContentPatch(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())
	base := fmt.Sprintf("/api/admin/races/%d", event.ID)
	admin := h.adminToken(t)

	// Absent content on a fresh race reads as null.
	got := decodeRaceDTO(t, h.do(t, http.MethodGet, base, nil, admin))
	if got.Content != nil || got.ContentStale {
		t.Fatalf("fresh content = %+v stale=%v, want null/false", got.Content, got.ContentStale)
	}

	// Full replace with an object.
	body := map[string]any{
		"content": map[string]any{
			"signup_timeline": map[string]any{"start_at": "2030-08-01", "deadline": "2030-09-15", "lottery": true, "lottery_result_at": "2030-09-20"},
			"signup_channels": []map[string]any{{"name": "官网", "type": "官网", "url": "https://example.com", "url_type": "web"}},
		},
	}
	w := h.do(t, http.MethodPatch, base, body, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("content patch = %d: %s", w.Code, w.Body.String())
	}
	got = decodeRaceDTO(t, w)
	if got.Content == nil || got.Content.SignupTimeline == nil || got.Content.SignupTimeline.Deadline != "2030-09-15" || len(got.Content.SignupChannels) != 1 {
		t.Fatalf("content = %+v, want the sections written", got.Content)
	}
	if got.Content.PartitionRule != nil || got.Content.Climate != nil {
		t.Fatalf("content = %+v, want absent sections cleared (full replace)", got.Content)
	}

	// Validation: a bad partition mode is a 400, not a write.
	bad := map[string]any{"content": map[string]any{"partition_rule": map[string]any{"mode": "bogus"}}}
	if w = h.do(t, http.MethodPatch, base, bad, admin); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_request") {
		t.Fatalf("bad mode = %d %s, want 400 invalid_request", w.Code, w.Body.String())
	}

	// An explicit null clears everything, including the stale flag.
	h.store.events[h.store.findEvent(event.ID)].ContentStale = true
	w = h.do(t, http.MethodPatch, base, map[string]any{"content": nil}, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("content null = %d: %s", w.Code, w.Body.String())
	}
	got = decodeRaceDTO(t, w)
	if got.Content != nil || got.ContentStale {
		t.Fatalf("after null = %+v stale=%v, want null/false", got.Content, got.ContentStale)
	}

	// An absent content key leaves the row untouched (and the flag up).
	h.store.events[h.store.findEvent(event.ID)].ContentStale = true
	w = h.do(t, http.MethodPatch, base, map[string]any{"city": "厦门（人工）"}, admin)
	got = decodeRaceDTO(t, w)
	if !got.ContentStale {
		t.Fatalf("absent content key reset content_stale, want untouched")
	}
}

// TestRaceCalendarAdmin_SignupChannelValidation pins the channel rule: a channel
// needs a name, and its url and url_type must agree — a pointer needs a kind and
// a kind needs a pointer. The point of the change is the "name only" case: a
// 公众号 entry has no page to link to, and the old rule dropped it (and its
// whole save) on the floor, which is how most Chinese races take entries.
func TestRaceCalendarAdmin_SignupChannelValidation(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())
	base := fmt.Sprintf("/api/admin/races/%d", event.ID)
	admin := h.adminToken(t)

	cases := []struct {
		name    string
		channel map[string]any
		want    int
	}{
		{"web url with web type",
			map[string]any{"name": "官网", "type": "官网", "url": "https://x.com", "url_type": "web"}, http.StatusOK},
		{"qr image with qrcode type",
			map[string]any{"name": "杭州马拉松", "type": "公众号", "url": "https://x.com/qr.png", "url_type": "qrcode"}, http.StatusOK},
		{"name only, no pointer",
			map[string]any{"name": "杭州马拉松", "type": "公众号"}, http.StatusOK},
		{"url without a type",
			map[string]any{"name": "官网", "url": "https://x.com"}, http.StatusBadRequest},
		{"type without a url",
			map[string]any{"name": "官网", "url_type": "web"}, http.StatusBadRequest},
		{"unknown url type",
			map[string]any{"name": "官网", "url": "https://x.com", "url_type": "ftp"}, http.StatusBadRequest},
		{"blank url with no type",
			map[string]any{"name": "官网", "url": "   "}, http.StatusOK},
		{"no name",
			map[string]any{"type": "官网", "url": "https://x.com", "url_type": "web"}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{"content": map[string]any{"signup_channels": []map[string]any{tc.channel}}}
			if w := h.do(t, http.MethodPatch, base, body, admin); w.Code != tc.want {
				t.Fatalf("got %d %s, want %d", w.Code, w.Body.String(), tc.want)
			}
		})
	}

	// A whitespace-only url is stored as absent, not as "".
	w := h.do(t, http.MethodPatch, base, map[string]any{
		"content": map[string]any{"signup_channels": []map[string]any{{"name": "官网", "url": "   "}}},
	}, admin)
	got := decodeRaceDTO(t, w)
	if len(got.Content.SignupChannels) != 1 {
		t.Fatalf("channels = %+v, want the channel stored", got.Content.SignupChannels)
	}
	if ch := got.Content.SignupChannels[0]; ch.URL != nil || ch.URLType != "" {
		t.Fatalf("channel = %+v, want url absent and url_type empty", ch)
	}
}

// TestRaceCalendarAdmin_PaymentDeadline covers the post-lottery payment deadline
// the timeline gained: it is a calendar date like its siblings, and absent is
// legitimate (a race with no lottery pays at signup).
func TestRaceCalendarAdmin_PaymentDeadline(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())
	base := fmt.Sprintf("/api/admin/races/%d", event.ID)
	admin := h.adminToken(t)

	timeline := func(extra map[string]any) map[string]any {
		body := map[string]any{"start_at": "2030-08-01", "deadline": "2030-09-15", "lottery": true, "lottery_result_at": "2030-09-20"}
		for k, v := range extra {
			body[k] = v
		}
		return map[string]any{"content": map[string]any{"signup_timeline": body}}
	}

	w := h.do(t, http.MethodPatch, base, timeline(map[string]any{"payment_deadline": "2030-09-30"}), admin)
	if w.Code != http.StatusOK {
		t.Fatalf("payment_deadline = %d: %s", w.Code, w.Body.String())
	}
	got := decodeRaceDTO(t, w)
	if got.Content.SignupTimeline.PaymentDeadline == nil || *got.Content.SignupTimeline.PaymentDeadline != "2030-09-30" {
		t.Fatalf("payment_deadline = %v, want 2030-09-30", got.Content.SignupTimeline.PaymentDeadline)
	}

	// A non-date is rejected rather than stored.
	for _, bad := range []string{"09/30", "2030-9-30", "2030-13-01", ""} {
		w = h.do(t, http.MethodPatch, base, timeline(map[string]any{"payment_deadline": bad}), admin)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_request") {
			t.Fatalf("payment_deadline %q = %d %s, want 400 invalid_request", bad, w.Code, w.Body.String())
		}
	}

	// Absent stays absent (no lottery ⇒ pay at signup).
	w = h.do(t, http.MethodPatch, base, timeline(nil), admin)
	got = decodeRaceDTO(t, w)
	if got.Content.SignupTimeline.PaymentDeadline != nil {
		t.Fatalf("payment_deadline = %v, want absent", *got.Content.SignupTimeline.PaymentDeadline)
	}
}

// TestRaceCalendarAdmin_ContentSource covers the content provenance field: the
// web-research script declares "WebSearch", the vocabulary is closed so a typo
// cannot invent a value, and an explicit null hands the content back to
// "administrator" without touching the content itself.
func TestRaceCalendarAdmin_ContentSource(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())
	base := fmt.Sprintf("/api/admin/races/%d", event.ID)
	admin := h.adminToken(t)

	content := map[string]any{"content": map[string]any{
		"signup_channels": []map[string]any{{"name": "杭州马拉松", "type": "公众号"}},
	}}
	withSource := func(src any) map[string]any {
		body := map[string]any{"content": content["content"]}
		if src != nil {
			body["content_source"] = src
		}
		return body
	}

	// A fresh race has no provenance.
	got := decodeRaceDTO(t, h.do(t, http.MethodGet, base, nil, admin))
	if got.ContentSource != nil {
		t.Fatalf("content_source = %q, want null on a fresh race", *got.ContentSource)
	}

	w := h.do(t, http.MethodPatch, base, withSource("WebSearch"), admin)
	if w.Code != http.StatusOK {
		t.Fatalf("content_source = %d: %s", w.Code, w.Body.String())
	}
	if got = decodeRaceDTO(t, w); got.ContentSource == nil || *got.ContentSource != "WebSearch" {
		t.Fatalf("content_source = %v, want WebSearch", got.ContentSource)
	}

	// An unknown term is a 400, not a stored value.
	w = h.do(t, http.MethodPatch, base, withSource("SomeBlog"), admin)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_content_source") {
		t.Fatalf("unknown source = %d %s, want 400 invalid_content_source", w.Code, w.Body.String())
	}

	// An absent key leaves the value alone.
	w = h.do(t, http.MethodPatch, base, withSource(nil), admin)
	if got = decodeRaceDTO(t, w); got.ContentSource == nil || *got.ContentSource != "WebSearch" {
		t.Fatalf("content_source = %v, want untouched", got.ContentSource)
	}

	// An explicit null clears it, leaving the content itself in place.
	w = h.do(t, http.MethodPatch, base, map[string]any{"content_source": nil}, admin)
	got = decodeRaceDTO(t, w)
	if got.ContentSource != nil {
		t.Fatalf("content_source = %q, want cleared", *got.ContentSource)
	}
	if got.Content == nil || len(got.Content.SignupChannels) != 1 {
		t.Fatalf("content = %+v, want the content kept when only the source is cleared", got.Content)
	}
}

// TestRaceCalendarAdmin_ItemContentLifecycle covers the per-item content
// surface: create with content, replace, untouched-absent, explicit-null
// delete, and the name rename carrying the content row.
func TestRaceCalendarAdmin_ItemContentLifecycle(t *testing.T) {
	h := newRaceHarness(t)
	event := h.store.seedEvent(syncEvent())
	admin := h.adminToken(t)
	base := fmt.Sprintf("/api/admin/races/%d/items", event.ID)

	w := h.do(t, http.MethodPost, base, map[string]any{
		"name": "全程马拉松", "type": "Marathon",
		"content": map[string]any{"distance_km": 42.195, "start_point": map[string]any{"name": "广场", "lat": 24.0, "lng": 118.0}},
	}, admin)
	if w.Code != http.StatusCreated {
		t.Fatalf("create item = %d: %s", w.Code, w.Body.String())
	}
	var created raceCalendarItemDTO
	_ = json.Unmarshal(w.Body.Bytes(), &created)
	if created.Content == nil || created.Content.DistanceKm == nil || *created.Content.DistanceKm != 42.195 || created.Content.StartPoint == nil {
		t.Fatalf("created content = %+v, want distance + start point", created.Content)
	}

	// Replace via PATCH object.
	w = h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, created.ID), map[string]any{
		"content": map[string]any{"distance_km": 42.0, "cutoffs": []map[string]any{{"point": "终点", "cutoff_at": "06:00"}}},
	}, admin)
	var replaced raceCalendarItemDTO
	_ = json.Unmarshal(w.Body.Bytes(), &replaced)
	if replaced.Content == nil || replaced.Content.DistanceKm == nil || *replaced.Content.DistanceKm != 42.0 || len(replaced.Content.Cutoffs) != 1 || replaced.Content.StartPoint != nil {
		t.Fatalf("replaced content = %+v, want full replace", replaced.Content)
	}
	// A bad cutoff clock is a 400.
	w = h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, created.ID), map[string]any{
		"content": map[string]any{"cutoffs": []map[string]any{{"point": "终点", "cutoff_at": "25:00"}}},
	}, admin)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad clock = %d %s, want 400", w.Code, w.Body.String())
	}

	// Detail shows the content on the item.
	detail := decodeRaceDTO(t, h.do(t, http.MethodGet, fmt.Sprintf("/api/admin/races/%d", event.ID), nil, admin))
	if len(detail.Items) != 1 || detail.Items[0].Content == nil || len(detail.Items[0].Content.Cutoffs) != 1 {
		t.Fatalf("detail item content = %+v", detail.Items)
	}

	// Renaming the item carries its content along (same row now).
	w = h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, created.ID), map[string]any{"name": "全程马拉松（改）"}, admin)
	var renamed raceCalendarItemDTO
	_ = json.Unmarshal(w.Body.Bytes(), &renamed)
	if renamed.Content == nil || len(renamed.Content.Cutoffs) != 1 {
		t.Fatalf("renamed content = %+v, want the content carried to the new name", renamed.Content)
	}

	// Explicit null clears the content columns.
	w = h.do(t, http.MethodPatch, fmt.Sprintf("%s/%d", base, created.ID), map[string]any{"content": nil}, admin)
	var cleared raceCalendarItemDTO
	_ = json.Unmarshal(w.Body.Bytes(), &cleared)
	if cleared.Content != nil {
		t.Fatalf("cleared content = %+v, want null", cleared.Content)
	}
	if stored := h.store.items[h.store.findItem(created.ID)]; stored.HasContent() {
		t.Fatalf("stored item = %+v, want the content columns cleared", stored)
	}
}

// TestRaceCalendarAdmin_MoveContent covers the stale-row resolution endpoint:
// 204 with the content moved and the source gone, 409 onto an occupied target.
func TestRaceCalendarAdmin_MoveContent(t *testing.T) {
	h := newRaceHarness(t)
	admin := h.adminToken(t)
	source := h.store.seedEvent(syncEvent())
	source.ContentStale = true
	source.Climate = &storage.RaceClimate{Summary: "温润多雨"}
	h.store.events[h.store.findEvent(source.ID)] = source
	h.store.seedItem(storage.RaceCalendarItem{
		RaceEventID: source.ID, Name: "全程马拉松", Type: "Marathon",
		Origin: storage.RaceOriginSync, DistanceKm: floatPtrAPITest(42.195),
	})
	target := h.store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "新名赛事",
		RaceDate: "2030-09-30", Month: 9, DayOfMonth: 30, Country: "CHN", City: strPtrAPITest("厦门市"),
	})

	path := fmt.Sprintf("/api/admin/races/%d/move-content", source.ID)
	w := h.do(t, http.MethodPost, path, map[string]any{"target_race_id": target.ID}, admin)
	if w.Code != http.StatusNoContent {
		t.Fatalf("move = %d: %s", w.Code, w.Body.String())
	}
	if h.store.findEvent(source.ID) >= 0 {
		t.Fatalf("source still exists, want deleted")
	}
	moved := h.store.events[h.store.findEvent(target.ID)]
	if moved.Climate == nil || moved.Climate.Summary != "温润多雨" || moved.ContentStale {
		t.Fatalf("target = %+v, want the content moved and the flag clear", moved)
	}
	var movedItem *storage.RaceCalendarItem
	for i := range h.store.items {
		if h.store.items[i].RaceEventID == target.ID && h.store.items[i].Name == "全程马拉松" {
			movedItem = &h.store.items[i]
		}
	}
	if movedItem == nil || movedItem.DistanceKm == nil || *movedItem.DistanceKm != 42.195 {
		t.Fatalf("target item = %+v, want the content moved over", movedItem)
	}

	// Moving onto a target that already has content is a 409 content_conflict.
	second := h.store.seedEvent(syncEvent())
	second.Climate = &storage.RaceClimate{Summary: " occupied"}
	h.store.events[h.store.findEvent(second.ID)] = second
	w = h.do(t, http.MethodPost, fmt.Sprintf("/api/admin/races/%d/move-content", target.ID), map[string]any{"target_race_id": second.ID}, admin)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "content_conflict") {
		t.Fatalf("occupied move = %d %s, want 409 content_conflict", w.Code, w.Body.String())
	}
	// Unknown ids are 404s.
	w = h.do(t, http.MethodPost, "/api/admin/races/999999/move-content", map[string]any{"target_race_id": target.ID}, admin)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown source move = %d, want 404", w.Code)
	}
}

// TestRaceCalendarAdmin_ContentStaleFilter covers the stale list filter and its
// validation.
func TestRaceCalendarAdmin_ContentStaleFilter(t *testing.T) {
	h := newRaceHarness(t)
	stale := h.store.seedEvent(syncEvent())
	stale.ContentStale = true
	h.store.events[h.store.findEvent(stale.ID)] = stale
	h.store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "正常赛事",
		RaceDate: "2030-11-01", Month: 11, DayOfMonth: 1, Country: "CHN",
	})
	admin := h.adminToken(t)

	w := h.do(t, http.MethodGet, "/api/admin/races?content_stale=1", nil, admin)
	var list raceCalendarListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || list.Total != 1 || list.Races[0].Name != "同步赛事" {
		t.Fatalf("stale filter = %d %s", w.Code, w.Body.String())
	}
	w = h.do(t, http.MethodGet, "/api/admin/races", nil, admin)
	list = raceCalendarListResponse{}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if list.Total != 2 {
		t.Fatalf("unfiltered = %d, want 2", list.Total)
	}
	if w := h.do(t, http.MethodGet, "/api/admin/races?content_stale=yes", nil, admin); w.Code != http.StatusBadRequest {
		t.Fatalf("bad content_stale = %d, want 400", w.Code)
	}
}

func TestRaceCalendarAdmin_PublishAndFilter(t *testing.T) {
	h := newRaceHarness(t)
	target := h.store.seedEvent(syncEvent())
	h.store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "未发布赛事",
		RaceDate: "2030-12-01", Month: 12, DayOfMonth: 1, Country: "CHN",
	})
	admin := h.adminToken(t)

	// Publishing is a plain PATCH of the field, and it is admin-owned: the row
	// keeps following the sync (origin unchanged, nothing added to overrides).
	path := fmt.Sprintf("/api/admin/races/%d", target.ID)
	w := h.do(t, http.MethodPatch, path, map[string]any{"published": true}, admin)
	if w.Code != http.StatusOK {
		t.Fatalf("publish = %d: %s", w.Code, w.Body.String())
	}
	var detail raceCalendarDetailDTO
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !detail.Published || detail.Origin != storage.RaceOriginSync || detail.FieldSources["name"] != "sync" {
		t.Fatalf("published = %+v, want published, sync-owned, no overrides", detail.raceCalendarEventDTO)
	}

	// A PATCH that does not mention published leaves it alone.
	if w := h.do(t, http.MethodPatch, path, map[string]any{"city": "厦门市"}, admin); w.Code != http.StatusOK {
		t.Fatalf("unrelated patch = %d: %s", w.Code, w.Body.String())
	}
	if got := h.store.events[h.store.findEvent(target.ID)]; !got.Published {
		t.Errorf("published cleared by an unrelated patch")
	}

	for _, tc := range []struct {
		query string
		want  int64
	}{
		{"published=true", 1},
		{"published=false", 1},
		{"", 2},
	} {
		w := h.do(t, http.MethodGet, "/api/admin/races?"+tc.query, nil, admin)
		if w.Code != http.StatusOK {
			t.Fatalf("list %q = %d: %s", tc.query, w.Code, w.Body.String())
		}
		var list raceCalendarListResponse
		if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if list.Total != tc.want {
			t.Errorf("list %q total = %d, want %d", tc.query, list.Total, tc.want)
		}
	}
	if w := h.do(t, http.MethodGet, "/api/admin/races?published=maybe", nil, admin); w.Code != http.StatusBadRequest {
		t.Errorf("bad published = %d, want 400", w.Code)
	}
}
