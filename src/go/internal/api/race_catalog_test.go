package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// fakeRaceCatalogStore is an in-memory RaceCatalogStore. The semantics under
// test are the HTTP layer's (projection, filters, pagination envelope), so the
// fake mirrors the SQL list semantics: published-only, year window, date
// floor, exact city, item-type join.
type fakeRaceCatalogStore struct {
	events []storage.RaceCalendarEvent
	items  []storage.RaceCalendarItem
	cities map[string]*storage.RaceCityContent
	// favorites is userID -> set of favorited event ids.
	favorites map[string]map[uint64]bool
	nextID    uint64
}

func newFakeRaceCatalogStore() *fakeRaceCatalogStore {
	return &fakeRaceCatalogStore{
		cities:    map[string]*storage.RaceCityContent{},
		favorites: map[string]map[uint64]bool{},
		nextID:    1,
	}
}

func (f *fakeRaceCatalogStore) seedEvent(row storage.RaceCalendarEvent) storage.RaceCalendarEvent {
	row.ID = f.nextID
	f.nextID++
	if row.Month == 0 {
		row.Month, row.DayOfMonth = storage.MonthDayOf(row.RaceDate)
	}
	f.events = append(f.events, row)
	return row
}

func (f *fakeRaceCatalogStore) seedItem(row storage.RaceCalendarItem) storage.RaceCalendarItem {
	row.ID = f.nextID
	f.nextID++
	f.items = append(f.items, row)
	return row
}

func (f *fakeRaceCatalogStore) seedFavorite(userID string, eventID uint64) {
	set, ok := f.favorites[userID]
	if !ok {
		set = map[uint64]bool{}
		f.favorites[userID] = set
	}
	set[eventID] = true
}

func (f *fakeRaceCatalogStore) ListPublishedRaceCalendarEvents(_ context.Context, filter storage.PublishedRaceFilter) ([]storage.RaceCalendarEvent, int64, error) {
	var matched []storage.RaceCalendarEvent
	for _, row := range f.events {
		if !row.Published {
			continue
		}
		if !strings.HasPrefix(row.RaceDate, filter.Year+"-") {
			continue
		}
		if filter.FromDate != "" && row.RaceDate < filter.FromDate {
			continue
		}
		if filter.City != "" && (row.City == nil || *row.City != filter.City) {
			continue
		}
		if filter.Type != "" {
			ok := false
			for _, item := range f.items {
				if item.RaceEventID == row.ID && item.Type == filter.Type {
					ok = true
					break
				}
			}
			if !ok {
				continue
			}
		}
		matched = append(matched, row)
	}
	sort.Slice(matched, func(i, j int) bool {
		if matched[i].RaceDate != matched[j].RaceDate {
			return matched[i].RaceDate < matched[j].RaceDate
		}
		if matched[i].Name != matched[j].Name {
			return matched[i].Name < matched[j].Name
		}
		return matched[i].ID < matched[j].ID
	})
	total := int64(len(matched))
	page, perPage := filter.Page, filter.PerPage
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 20
	}
	start := (page - 1) * perPage
	if start >= len(matched) {
		return []storage.RaceCalendarEvent{}, total, nil
	}
	end := start + perPage
	if end > len(matched) {
		end = len(matched)
	}
	return matched[start:end], total, nil
}

func (f *fakeRaceCatalogStore) GetRaceCalendarEvent(_ context.Context, id uint64) (*storage.RaceCalendarEvent, error) {
	for i := range f.events {
		if f.events[i].ID == id {
			row := f.events[i]
			return &row, nil
		}
	}
	return nil, storage.ErrRaceCalendarNotFound
}

func (f *fakeRaceCatalogStore) ListRaceCalendarItems(_ context.Context, eventID uint64) ([]storage.RaceCalendarItem, error) {
	out := []storage.RaceCalendarItem{}
	for _, item := range f.items {
		if item.RaceEventID == eventID {
			out = append(out, item)
		}
	}
	return out, nil
}

func (f *fakeRaceCatalogStore) GetRaceCityContent(_ context.Context, city string) (*storage.RaceCityContent, error) {
	return f.cities[city], nil
}

func (f *fakeRaceCatalogStore) FavoritedRaceEventIDs(_ context.Context, userID string, eventIDs []uint64) (map[uint64]bool, error) {
	out := make(map[uint64]bool, len(eventIDs))
	for _, id := range eventIDs {
		if f.favorites[userID][id] {
			out[id] = true
		}
	}
	return out, nil
}

// --- harness -----------------------------------------------------------------

type raceCatalogHarness struct {
	svc   *Service
	store *fakeRaceCatalogStore
	key   *rsa.PrivateKey
}

func newRaceCatalogHarness(t *testing.T) *raceCatalogHarness {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	store := newFakeRaceCatalogStore()
	svc := NewService(Config{
		Auth:             NewAuthenticator(testToken, verifier),
		RaceCatalogStore: store,
	})
	return &raceCatalogHarness{svc: svc, store: store, key: key}
}

// userToken signs a user-tier JWT for sub. A distinct sub per test keeps the
// favorited assertions independent of call order.
func (h *raceCatalogHarness) userToken(t *testing.T, sub string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *raceCatalogHarness) adminToken(t *testing.T) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": "admin", "iss": testIssuer, "aud": testAdminAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "role": "admin",
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + signed}
}

func (h *raceCatalogHarness) get(t *testing.T, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}

func (h *raceCatalogHarness) raceDate(id uint64) string {
	for _, row := range h.store.events {
		if row.ID == id {
			return row.RaceDate
		}
	}
	return ""
}

type catalogListBody struct {
	Races []struct {
		ID        uint64   `json:"id"`
		Name      string   `json:"name"`
		RaceDate  string   `json:"race_date"`
		City      *string  `json:"city"`
		RaceTypes []string `json:"race_types"`
		Favorited bool     `json:"favorited"`
	} `json:"races"`
	Total   int64 `json:"total"`
	Page    int   `json:"page"`
	PerPage int   `json:"per_page"`
}

func decodeCatalogList(t *testing.T, w *httptest.ResponseRecorder) catalogListBody {
	t.Helper()
	var body catalogListBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode list: %v (body %s)", err, w.Body.String())
	}
	return body
}

// seedCatalogRaces seeds a standard published set: two same-day upcoming races
// (厦门 with a marathon item, 杭州 with only a half-marathon item), a past race
// in 厦门市, and an unpublished draft. Returns (upcomingID, pastID,
// hangzhouID, unpublishedID).
//
// The two upcoming races are dated TODAY, not today+N: a future offset crosses
// into the next year around New Year and silently breaks the default-scope
// assertions (the default year is the current Shanghai year), while today
// always satisfies both the 即将开跑 floor (race_date >= today) and the year
// window on every run date. The past race may fall in the previous year, so
// its test queries that race's own year.
func seedCatalogRaces(t *testing.T, store *fakeRaceCatalogStore) (uint64, uint64, uint64, uint64) {
	t.Helper()
	today := timefmt.ShanghaiToday().Format("2006-01-02")
	upcoming := store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Name: "Upcoming Race", RaceDate: today,
		Country: "CHN", City: strPtrAPITest("厦门市"), Label: strPtrAPITest("A"),
		RaceTypes: strPtrAPITest(`["Marathon"]`), Published: true,
	})
	past := store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Name: "Past Race", RaceDate: timefmt.ShanghaiToday().AddDate(0, 0, -30).Format("2006-01-02"),
		Country: "CHN", City: strPtrAPITest("厦门市"),
		RaceTypes: strPtrAPITest(`["Marathon"]`), Published: true,
	})
	hangzhou := store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Name: "Hangzhou Race", RaceDate: today,
		Country: "CHN", City: strPtrAPITest("杭州市"),
		RaceTypes: strPtrAPITest(`["HalfMarathon"]`), Published: true,
	})
	unpublished := store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Name: "Draft Race", RaceDate: today,
		Country: "CHN", City: strPtrAPITest("厦门市"), Published: false,
	})
	store.seedItem(storage.RaceCalendarItem{RaceEventID: upcoming.ID, Name: "马拉松", Type: "Marathon"})
	store.seedItem(storage.RaceCalendarItem{RaceEventID: hangzhou.ID, Name: "半程马拉松", Type: "HalfMarathon"})
	return upcoming.ID, past.ID, hangzhou.ID, unpublished.ID
}

func TestRaceCatalog_ListDefaultScopeUpcoming(t *testing.T) {
	h := newRaceCatalogHarness(t)
	upcomingID, _, hangzhouID, unpublishedID := seedCatalogRaces(t, h.store)
	headers := h.userToken(t, "11111111-1111-4111-8111-111111111111")

	w := h.get(t, "/api/race-calendar", headers)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	body := decodeCatalogList(t, w)
	// The default view is 即将开跑 in the current Shanghai year: the past race
	// is out (date floor, or the year window around New Year) and the
	// unpublished draft never surfaces.
	got := map[uint64]bool{}
	for _, r := range body.Races {
		got[r.ID] = true
	}
	if !got[upcomingID] || !got[hangzhouID] || len(body.Races) != 2 {
		t.Fatalf("expected exactly upcoming %d and %d, got %v", upcomingID, hangzhouID, body.Races)
	}
	if got[unpublishedID] {
		t.Fatalf("unpublished row %d leaked into the catalog", unpublishedID)
	}
	if body.Page != 1 || body.PerPage != 20 || body.Total != 2 {
		t.Fatalf("envelope = page %d per_page %d total %d", body.Page, body.PerPage, body.Total)
	}
}

func TestRaceCatalog_ListYearSwitchSeesHistory(t *testing.T) {
	h := newRaceCatalogHarness(t)
	_, pastID, _, unpublishedID := seedCatalogRaces(t, h.store)
	pastYear := strings.Split(h.raceDate(pastID), "-")[0]
	headers := h.userToken(t, "11111111-1111-4111-8111-111111111111")

	// scope=all over the past race's year surfaces it — the year-switching
	// history view. Depending on the run date the past race shares its year
	// with the upcoming seeds (around New Year it does not), so assert on
	// presence rather than an exact row count.
	w := h.get(t, "/api/race-calendar?scope=all&year="+pastYear, headers)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	body := decodeCatalogList(t, w)
	got := map[uint64]bool{}
	for _, r := range body.Races {
		got[r.ID] = true
	}
	if !got[pastID] {
		t.Fatalf("scope=all&year=%s should surface past race %d, got %v", pastYear, pastID, body.Races)
	}
	if got[unpublishedID] {
		t.Fatalf("unpublished row %d leaked into the history view", unpublishedID)
	}
}

func TestRaceCatalog_ListTypeFilter(t *testing.T) {
	h := newRaceCatalogHarness(t)
	upcomingID, _, hangzhouID, _ := seedCatalogRaces(t, h.store)
	headers := h.userToken(t, "11111111-1111-4111-8111-111111111111")

	w := h.get(t, "/api/race-calendar?type=Marathon", headers)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	body := decodeCatalogList(t, w)
	// The type filter resolves through the item child table: Hangzhou has only
	// a HalfMarathon item even though the event's own race_types names it.
	if len(body.Races) != 1 || body.Races[0].ID != upcomingID {
		t.Fatalf("type=Marathon expected only %d, got %v", upcomingID, body.Races)
	}
	if hangzhouID == upcomingID {
		t.Fatalf("fixture error: ids collide")
	}
}

func TestRaceCatalog_ListCityFilter(t *testing.T) {
	h := newRaceCatalogHarness(t)
	_, _, hangzhouID, _ := seedCatalogRaces(t, h.store)
	headers := h.userToken(t, "11111111-1111-4111-8111-111111111111")

	w := h.get(t, "/api/race-calendar?city="+url.QueryEscape("杭州市"), headers)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	body := decodeCatalogList(t, w)
	if len(body.Races) != 1 || body.Races[0].ID != hangzhouID {
		t.Fatalf("city filter expected only %d, got %v", hangzhouID, body.Races)
	}
}

func TestRaceCatalog_ListPagination(t *testing.T) {
	h := newRaceCatalogHarness(t)
	upcomingID, _, hangzhouID, _ := seedCatalogRaces(t, h.store)
	headers := h.userToken(t, "11111111-1111-4111-8111-111111111111")

	w := h.get(t, "/api/race-calendar?per_page=1&page=2", headers)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	body := decodeCatalogList(t, w)
	if body.Total != 2 || body.Page != 2 || body.PerPage != 1 {
		t.Fatalf("envelope = total %d page %d per_page %d", body.Total, body.Page, body.PerPage)
	}
	// Both seeds share today's date, so the tie breaks on name: the second
	// page is the later name ("Upcoming Race" > "Hangzhou Race").
	if len(body.Races) != 1 || body.Races[0].ID != upcomingID {
		t.Fatalf("page 2 expected %d, got %v", upcomingID, body.Races)
	}
	if upcomingID == hangzhouID {
		t.Fatalf("fixture error: ids collide")
	}
}

func TestRaceCatalog_ListFavoritedFlag(t *testing.T) {
	h := newRaceCatalogHarness(t)
	upcomingID, _, hangzhouID, _ := seedCatalogRaces(t, h.store)
	const user = "22222222-2222-4222-8222-222222222222"
	h.store.seedFavorite(user, upcomingID)

	w := h.get(t, "/api/race-calendar", h.userToken(t, user))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	body := decodeCatalogList(t, w)
	for _, r := range body.Races {
		if r.ID == upcomingID && !r.Favorited {
			t.Fatalf("race %d should carry favorited=true", upcomingID)
		}
		if r.ID == hangzhouID && r.Favorited {
			t.Fatalf("race %d should carry favorited=false", hangzhouID)
		}
	}
}

func TestRaceCatalog_ListAuth(t *testing.T) {
	h := newRaceCatalogHarness(t)
	seedCatalogRaces(t, h.store)

	if w := h.get(t, "/api/race-calendar", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status = %d, want 401", w.Code)
	}
	// The catalog is user-facing: an admin-dashboard token is refused by the
	// default-deny group (it reaches the same rows via /api/admin/races).
	if w := h.get(t, "/api/race-calendar", h.adminToken(t)); w.Code != http.StatusForbidden {
		t.Fatalf("admin token: status = %d, want 403", w.Code)
	}
}

func TestRaceCatalog_ListBadParams(t *testing.T) {
	h := newRaceCatalogHarness(t)
	headers := h.userToken(t, "11111111-1111-4111-8111-111111111111")

	for _, q := range []string{"?year=26", "?scope=someday"} {
		if w := h.get(t, "/api/race-calendar"+q, headers); w.Code != http.StatusBadRequest {
			t.Fatalf("query %s: status = %d, want 400 (%s)", q, w.Code, w.Body.String())
		}
	}
}

func TestRaceCatalog_Detail(t *testing.T) {
	h := newRaceCatalogHarness(t)
	upcomingID, _, _, _ := seedCatalogRaces(t, h.store)
	fee := 15000 // 分
	ascent := 180
	distance := 42.195
	// Enrich the item seedCatalogRaces already created for this event rather
	// than appending a second one.
	for i := range h.store.items {
		if h.store.items[i].RaceEventID == upcomingID {
			h.store.items[i].EntryFee = &fee
			h.store.items[i].DistanceKm = &distance
			h.store.items[i].TotalAscentM = &ascent
		}
	}

	h.store.cities["厦门市"] = &storage.RaceCityContent{
		City: "厦门市", Province: strPtrAPITest("福建省"),
		Intro: &storage.CityIntro{History: "港口城市"},
	}
	const user = "33333333-3333-4333-8333-333333333333"
	h.store.seedFavorite(user, upcomingID)

	w := h.get(t, "/api/race-calendar/"+strconv.FormatUint(upcomingID, 10), h.userToken(t, user))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// The user projection never carries admin fields.
	for _, field := range []string{"origin", "source", "published", "content_stale", "content_source", "field_sources", "admin_overrides", "updated_at"} {
		if _, ok := raw[field]; ok {
			t.Fatalf("admin field %q leaked into the user detail response", field)
		}
	}
	// Event-level sections ride along.
	for _, field := range []string{"signup_timeline", "signup_channels", "packet_pickup", "city_content", "items", "favorited"} {
		if _, ok := raw[field]; !ok {
			t.Fatalf("expected field %q in the detail response", field)
		}
	}
	if got := strings.TrimSpace(string(raw["favorited"])); got != "true" {
		t.Fatalf("favorited = %s, want true", got)
	}

	var detail struct {
		Items []struct {
			EntryFee    *int     `json:"entry_fee"`
			DistanceKm  *float64 `json:"distance_km"`
			TotalAscent *int     `json:"total_ascent_m"`
		} `json:"items"`
		CityContent *struct {
			City  string `json:"city"`
			Intro *struct {
				History string `json:"history"`
			} `json:"intro"`
		} `json:"city_content"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if len(detail.Items) != 1 || detail.Items[0].EntryFee == nil || *detail.Items[0].EntryFee != 15000 {
		t.Fatalf("item entry_fee (分) not projected: %+v", detail.Items)
	}
	if detail.Items[0].DistanceKm == nil || *detail.Items[0].DistanceKm != 42.195 {
		t.Fatalf("item distance_km not projected: %+v", detail.Items)
	}
	if detail.CityContent == nil || detail.CityContent.City != "厦门市" || detail.CityContent.Intro.History != "港口城市" {
		t.Fatalf("city content not projected: %+v", detail.CityContent)
	}
}

func TestRaceCatalog_DetailWithoutCityContent(t *testing.T) {
	h := newRaceCatalogHarness(t)
	upcomingID, _, _, _ := seedCatalogRaces(t, h.store)
	headers := h.userToken(t, "11111111-1111-4111-8111-111111111111")

	w := h.get(t, "/api/race-calendar/"+strconv.FormatUint(upcomingID, 10), headers)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	var detail struct {
		CityContent *struct {
			City string `json:"city"`
		} `json:"city_content"`
		Items []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// 厦门市 has no race_city_content row: the 出行 tab renders its 待发布
	// empty state off the null.
	if detail.CityContent != nil {
		t.Fatalf("city_content = %+v, want null", detail.CityContent)
	}
	if len(detail.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(detail.Items))
	}
}

func TestRaceCatalog_DetailNotFoundAndUnpublished(t *testing.T) {
	h := newRaceCatalogHarness(t)
	_, _, _, unpublishedID := seedCatalogRaces(t, h.store)
	headers := h.userToken(t, "11111111-1111-4111-8111-111111111111")

	// Missing and unpublished answer identically: 404 race_not_found, so an
	// unpublished row's existence is not leaked.
	if w := h.get(t, "/api/race-calendar/99999", headers); w.Code != http.StatusNotFound {
		t.Fatalf("missing: status = %d, want 404", w.Code)
	} else if !strings.Contains(w.Body.String(), "race_not_found") {
		t.Fatalf("missing: body %s", w.Body.String())
	}
	if w := h.get(t, "/api/race-calendar/"+strconv.FormatUint(unpublishedID, 10), headers); w.Code != http.StatusNotFound {
		t.Fatalf("unpublished: status = %d, want 404", w.Code)
	}
}
