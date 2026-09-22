package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// --- fake store ---------------------------------------------------------------

// fakeRaceContentSnapshot is the test-local snapshot shape (mirrors the storage
// package's unexported raceContentSnapshot).
type fakeRaceContentSnapshot struct {
	Content storage.RaceContent       `json:"content"`
	Items   []storage.RaceContentItem `json:"items"`
}

// fakeRaceContentStore is the in-memory RaceContentStore the handler tests run
// against. It mirrors the storage layer's resolution rules just closely enough
// to exercise handler behavior (live link, then business key); the deep rules
// are integration-tested in internal/storage.
type fakeRaceContentStore struct {
	events   map[uint64]storage.RaceCalendarEvent
	contents map[uint64]*storage.RaceContent
	items    map[uint64][]storage.RaceContentItem
	cities   map[string]*storage.RaceCityContent
	versions map[string][]storage.RaceContentVersion
	nextID   uint64
}

func newFakeRaceContentStore() *fakeRaceContentStore {
	return &fakeRaceContentStore{
		events:   map[uint64]storage.RaceCalendarEvent{},
		contents: map[uint64]*storage.RaceContent{},
		items:    map[uint64][]storage.RaceContentItem{},
		cities:   map[string]*storage.RaceCityContent{},
		versions: map[string][]storage.RaceContentVersion{},
	}
}

func (f *fakeRaceContentStore) seedEvent(e storage.RaceCalendarEvent) storage.RaceCalendarEvent {
	f.nextID++
	e.ID = f.nextID
	f.events[e.ID] = e
	return e
}

func (f *fakeRaceContentStore) versionKey(contentType string, id uint64) string {
	return fmt.Sprintf("%s/%d", contentType, id)
}

func (f *fakeRaceContentStore) GetRaceCalendarEvent(_ context.Context, id uint64) (*storage.RaceCalendarEvent, error) {
	if e, ok := f.events[id]; ok {
		return &e, nil
	}
	return nil, storage.ErrRaceCalendarNotFound
}

func (f *fakeRaceContentStore) findByEvent(eventID uint64) *storage.RaceContent {
	for _, row := range f.contents {
		if row.RaceEventID != nil && *row.RaceEventID == eventID {
			return row
		}
	}
	e, ok := f.events[eventID]
	if !ok {
		return nil
	}
	for _, row := range f.contents {
		if row.Source == e.Source && row.RaceName == e.Name && row.RaceDate == e.RaceDate {
			return row
		}
	}
	return nil
}

func (f *fakeRaceContentStore) GetRaceContentByEvent(_ context.Context, eventID uint64) (*storage.RaceContent, []storage.RaceContentItem, error) {
	if _, ok := f.events[eventID]; !ok {
		return nil, nil, storage.ErrRaceCalendarNotFound
	}
	row := f.findByEvent(eventID)
	if row == nil {
		return nil, nil, nil
	}
	return row, f.items[row.ID], nil
}

func (f *fakeRaceContentStore) UpsertRaceContent(_ context.Context, event *storage.RaceCalendarEvent, in *storage.RaceContent, items []storage.RaceContentItem) (*storage.RaceContent, []storage.RaceContentItem, error) {
	row := f.findByEvent(event.ID)
	if row == nil {
		f.nextID++
		row = &storage.RaceContent{ID: f.nextID, Status: storage.RaceContentStatusDraft, CreatedAt: time.Now().UTC()}
		f.contents[row.ID] = row
	}
	row.RaceEventID = &event.ID
	row.Source, row.RaceName, row.RaceDate = event.Source, event.Name, event.RaceDate
	_, _ = fmt.Sscanf(event.RaceDate, "%d", &row.Year)
	row.PartitionRule, row.SignupTimeline = in.PartitionRule, in.SignupTimeline
	row.SignupChannels, row.PacketPickup = in.SignupChannels, in.PacketPickup
	row.UpdatedAt = time.Now().UTC()
	// Full replace, names re-keyed.
	f.items[row.ID] = nil
	for _, item := range items {
		f.nextID++
		item.ID, item.RaceContentID = f.nextID, row.ID
		f.items[row.ID] = append(f.items[row.ID], item)
	}
	return row, f.items[row.ID], nil
}

func (f *fakeRaceContentStore) AttachRaceContent(_ context.Context, contentID, eventID uint64) (*storage.RaceContent, []storage.RaceContentItem, error) {
	e, ok := f.events[eventID]
	if !ok {
		return nil, nil, storage.ErrRaceCalendarNotFound
	}
	row, ok := f.contents[contentID]
	if !ok {
		return nil, nil, storage.ErrRaceContentNotFound
	}
	for _, other := range f.contents {
		if other.ID != contentID && other.RaceEventID != nil && *other.RaceEventID == eventID {
			return nil, nil, storage.ErrRaceContentConflict
		}
	}
	row.RaceEventID = &eventID
	row.Source, row.RaceName, row.RaceDate = e.Source, e.Name, e.RaceDate
	return row, f.items[row.ID], nil
}

func (f *fakeRaceContentStore) ListOrphanRaceContent(_ context.Context) ([]storage.RaceContent, error) {
	var out []storage.RaceContent
	for _, row := range f.contents {
		linked := row.RaceEventID != nil
		if linked {
			_, linked = f.events[*row.RaceEventID]
		}
		if !linked {
			out = append(out, *row)
		}
	}
	return out, nil
}

func (f *fakeRaceContentStore) PublishRaceContent(_ context.Context, contentID uint64, publishedBy string) (*storage.RaceContent, []storage.RaceContentItem, int, error) {
	row, ok := f.contents[contentID]
	if !ok {
		return nil, nil, 0, storage.ErrRaceContentNotFound
	}
	version := f.mintVersion(storage.RaceContentVersionTypeRace, contentID, publishedBy)
	row.Status = storage.RaceContentStatusPublished
	return row, f.items[row.ID], version, nil
}

func (f *fakeRaceContentStore) ArchiveRaceContent(_ context.Context, contentID uint64) (*storage.RaceContent, []storage.RaceContentItem, error) {
	row, ok := f.contents[contentID]
	if !ok {
		return nil, nil, storage.ErrRaceContentNotFound
	}
	row.Status = storage.RaceContentStatusArchived
	return row, f.items[row.ID], nil
}

func (f *fakeRaceContentStore) ListRaceContentVersions(_ context.Context, contentType string, contentID uint64) ([]storage.RaceContentVersion, error) {
	return f.versions[f.versionKey(contentType, contentID)], nil
}

func (f *fakeRaceContentStore) RollbackRaceContent(_ context.Context, contentID uint64, version int) (*storage.RaceContent, []storage.RaceContentItem, error) {
	row, ok := f.contents[contentID]
	if !ok {
		return nil, nil, storage.ErrRaceContentNotFound
	}
	versions := f.versions[f.versionKey(storage.RaceContentVersionTypeRace, contentID)]
	for _, v := range versions {
		if v.Version == version {
			var snap fakeRaceContentSnapshot
			if err := json.Unmarshal([]byte(v.Snapshot), &snap); err != nil {
				return nil, nil, err
			}
			row.PartitionRule = snap.Content.PartitionRule
			row.SignupTimeline = snap.Content.SignupTimeline
			row.SignupChannels = snap.Content.SignupChannels
			row.PacketPickup = snap.Content.PacketPickup
			f.items[row.ID] = snap.Items
			return row, f.items[row.ID], nil
		}
	}
	return nil, nil, fmt.Errorf("%w: version %d not found", storage.ErrInvalidRaceContent, version)
}

func (f *fakeRaceContentStore) GetRaceCityContent(_ context.Context, city string) (*storage.RaceCityContent, error) {
	if row, ok := f.cities[city]; ok {
		return row, nil
	}
	return nil, nil
}

func (f *fakeRaceContentStore) UpsertRaceCityContent(_ context.Context, in *storage.RaceCityContent) (*storage.RaceCityContent, error) {
	row, ok := f.cities[in.City]
	if !ok {
		f.nextID++
		row = &storage.RaceCityContent{ID: f.nextID, City: in.City, Status: storage.RaceContentStatusDraft, CreatedAt: time.Now().UTC()}
		f.cities[in.City] = row
	}
	row.Province, row.Intro, row.Attractions = in.Province, in.Intro, in.Attractions
	row.Climate, row.WeatherWindows = in.Climate, in.WeatherWindows
	row.UpdatedAt = time.Now().UTC()
	return row, nil
}

func (f *fakeRaceContentStore) UpsertRaceCityContentAIDraft(_ context.Context, in *storage.RaceCityContent) (*storage.RaceCityContent, error) {
	row, ok := f.cities[in.City]
	if !ok {
		f.nextID++
		row = &storage.RaceCityContent{ID: f.nextID, City: in.City, Status: storage.RaceContentStatusDraft, CreatedAt: time.Now().UTC()}
		f.cities[in.City] = row
	}
	if row.Status != storage.RaceContentStatusDraft {
		return nil, storage.ErrRaceContentConflict
	}
	row.Intro, row.Climate = in.Intro, in.Climate
	row.UpdatedAt = time.Now().UTC()
	return row, nil
}

func (f *fakeRaceContentStore) PublishRaceCityContent(_ context.Context, city, publishedBy string) (*storage.RaceCityContent, int, error) {
	row, ok := f.cities[city]
	if !ok {
		return nil, 0, storage.ErrRaceContentNotFound
	}
	version := f.mintVersion(storage.RaceContentVersionTypeCity, row.ID, publishedBy)
	row.Status = storage.RaceContentStatusPublished
	return row, version, nil
}

func (f *fakeRaceContentStore) ArchiveRaceCityContent(_ context.Context, city string) (*storage.RaceCityContent, error) {
	row, ok := f.cities[city]
	if !ok {
		return nil, storage.ErrRaceContentNotFound
	}
	row.Status = storage.RaceContentStatusArchived
	return row, nil
}

func (f *fakeRaceContentStore) RollbackRaceCityContent(_ context.Context, city string, version int) (*storage.RaceCityContent, error) {
	row, ok := f.cities[city]
	if !ok {
		return nil, storage.ErrRaceContentNotFound
	}
	versions := f.versions[f.versionKey(storage.RaceContentVersionTypeCity, row.ID)]
	for _, v := range versions {
		if v.Version == version {
			var snap storage.RaceCityContent
			if err := json.Unmarshal([]byte(v.Snapshot), &snap); err != nil {
				return nil, err
			}
			row.Province, row.Intro, row.Attractions = snap.Province, snap.Intro, snap.Attractions
			row.Climate, row.WeatherWindows = snap.Climate, snap.WeatherWindows
			return row, nil
		}
	}
	return nil, fmt.Errorf("%w: version %d not found", storage.ErrInvalidRaceContent, version)
}

// mintVersion appends the next version snapshot for (contentType, contentID).
// The race snapshot body marshals the current aggregate (the fake shares the
// storage layer's raceContentSnapshot shape); the city snapshot marshals the row.
func (f *fakeRaceContentStore) mintVersion(contentType string, contentID uint64, publishedBy string) int {
	key := f.versionKey(contentType, contentID)
	next := 1
	for _, v := range f.versions[key] {
		if v.Version >= next {
			next = v.Version + 1
		}
	}
	var body []byte
	if contentType == storage.RaceContentVersionTypeRace {
		row := f.contents[contentID]
		b, _ := json.Marshal(fakeRaceContentSnapshot{Content: *row, Items: f.items[contentID]})
		body = b
	} else {
		b, _ := json.Marshal(f.citiesBy()[contentID])
		body = b
	}
	f.versions[key] = append(f.versions[key], storage.RaceContentVersion{
		Version: next, Snapshot: string(body), PublishedBy: publishedBy,
		PublishedAt: time.Now().UTC(),
	})
	return next
}

func (f *fakeRaceContentStore) citiesBy() map[uint64]*storage.RaceCityContent {
	out := map[uint64]*storage.RaceCityContent{}
	for _, row := range f.cities {
		out[row.ID] = row
	}
	return out
}

// --- harness -----------------------------------------------------------------

type raceContentHarness struct {
	svc   *Service
	store *fakeRaceContentStore
	rh    *raceHarness // reuses the token minting of the race-calendar harness
}

func newRaceContentHarness(t *testing.T) *raceContentHarness {
	return newRaceContentHarnessCfg(t, CityAIDraftConfig{})
}

func newRaceContentHarnessCfg(t *testing.T, ai CityAIDraftConfig) *raceContentHarness {
	t.Helper()
	h := newRaceHarness(t)
	// Rebuild the service with both stores: the harness's own service only has
	// the race-calendar store.
	store := newFakeRaceContentStore()
	svc := NewService(Config{
		Auth:              h.svc.auth,
		RaceCalendarStore: h.store,
		RaceContentStore:  store,
		CityAIDraft:       ai,
	})
	return &raceContentHarness{svc: svc, store: store, rh: h}
}

// --- tests -------------------------------------------------------------------

func TestRaceContentAdmin_TierGuards(t *testing.T) {
	h := newRaceContentHarness(t)
	event := h.store.seedEvent(syncEvent())
	base := fmt.Sprintf("/api/admin/races/%d/content", event.ID)
	admin := h.rh.adminToken(t)
	internal := internalHdr()
	user := h.rh.token(t, testAudience, "user")

	cases := []struct {
		method, path string
		body         string
	}{
		{"GET", base, ""},
		{"PUT", base, `{"packet_pickup":[{"time":"9:00","location":"会展中心"}]}`},
		{"POST", base + "/publish", ""},
		{"POST", base + "/archive", ""},
		{"GET", base + "/versions", ""},
		{"POST", base + "/versions/1/rollback", ""},
		{"GET", "/api/admin/race-content/orphans", ""},
		{"POST", "/api/admin/race-content/1/attach", `{"race_event_id":1}`},
		{"GET", "/api/admin/cities/厦门市/content", ""},
		{"PUT", "/api/admin/cities/厦门市/content", `{"intro":{"overview":"x"}}`},
		{"POST", "/api/admin/cities/厦门市/content/publish", ""},
		{"POST", "/api/admin/cities/厦门市/content/archive", ""},
		{"GET", "/api/admin/cities/厦门市/content/versions", ""},
		{"POST", "/api/admin/cities/厦门市/content/versions/1/rollback", ""},
		{"POST", "/api/admin/cities/厦门市/content/ai-draft", ""},
	}
	for _, tc := range cases {
		for _, auth := range []struct {
			name    string
			headers map[string]string
			want    int
		}{{"none", nil, http.StatusUnauthorized}, {"internal", internal, http.StatusForbidden}, {"user", user, http.StatusForbidden}, {"admin", admin, 0}} {
			w := h.do(t, tc.method, tc.path, tc.body, auth.headers)
			if auth.want == 0 {
				// Admin is allowed everywhere; only assert it is NOT a tier rejection.
				if w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden {
					t.Errorf("%s %s as %s: got %d, want non-tier-rejection", tc.method, tc.path, auth.name, w.Code)
				}
				continue
			}
			if w.Code != auth.want {
				t.Errorf("%s %s as %s: got %d, want %d", tc.method, tc.path, auth.name, w.Code, auth.want)
			}
		}
	}
}

func TestRaceContentAdmin_RaceLifecycle(t *testing.T) {
	h := newRaceContentHarness(t)
	event := h.store.seedEvent(syncEvent())
	admin := h.rh.adminToken(t)
	base := fmt.Sprintf("/api/admin/races/%d/content", event.ID)

	// Unknown race → race_not_found.
	if w := h.do(t, "GET", "/api/admin/races/999/content", "", admin); w.Code != http.StatusNotFound {
		t.Fatalf("unknown race: got %d, want 404", w.Code)
	}

	// Empty read → content:null.
	w := h.do(t, "GET", base, "", admin)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"content":null`) {
		t.Fatalf("empty read: got %d %s", w.Code, w.Body.String())
	}

	// PUT creates the aggregate with an item.
	body := map[string]any{
		"signup_timeline": map[string]any{"start_at": "2030-08-01", "deadline": "2030-09-15", "lottery": true, "lottery_result_at": "2030-09-20"},
		"signup_channels": []map[string]any{{"name": "官网", "type": "官网", "url": "https://example.com"}},
		"items": []map[string]any{
			{"item_name": "全程马拉松", "quota": 30000, "entry_fee": 200, "cutoffs": []map[string]any{{"point": "终点", "cutoff_at": "06:00"}}},
		},
	}
	w = h.do(t, "PUT", base, jsonBody(t, body), admin)
	if w.Code != http.StatusOK {
		t.Fatalf("create: got %d %s", w.Code, w.Body.String())
	}
	var created raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Content.Status != storage.RaceContentStatusDraft || len(created.Content.Items) != 1 || created.Content.Items[0].ItemName != "全程马拉松" {
		t.Fatalf("created = %+v", created.Content)
	}

	// Validation: duplicate item names and a bad clock are rejected.
	bad := map[string]any{"items": []map[string]any{
		{"item_name": "全程马拉松"}, {"item_name": "全程马拉松"},
	}}
	if w = h.do(t, "PUT", base, jsonBody(t, bad), admin); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_request") {
		t.Fatalf("duplicate items: got %d %s", w.Code, w.Body.String())
	}
	badClock := map[string]any{"items": []map[string]any{
		{"item_name": "全程马拉松", "cutoffs": []map[string]any{{"point": "终点", "cutoff_at": "25:00"}}},
	}}
	if w = h.do(t, "PUT", base, jsonBody(t, badClock), admin); w.Code != http.StatusBadRequest {
		t.Fatalf("bad clock: got %d %s", w.Code, w.Body.String())
	}

	// Publish → version 1, published status.
	w = h.do(t, "POST", base+"/publish", "", admin)
	var published raceContentPublishResponse
	if err := json.Unmarshal(w.Body.Bytes(), &published); err != nil || published.Version != 1 {
		t.Fatalf("publish: got %d %s", w.Code, w.Body.String())
	}

	// Version list.
	w = h.do(t, "GET", base+"/versions", "", admin)
	var versions raceContentVersionsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &versions); err != nil || len(versions.Versions) != 1 || versions.Versions[0].Version != 1 {
		t.Fatalf("versions: got %d %s", w.Code, w.Body.String())
	}

	// PUT again (保存即生效): clears the timeline (absent section), keeps published.
	w = h.do(t, "PUT", base, jsonBody(t, map[string]any{"items": []map[string]any{{"item_name": "全程马拉松"}}}), admin)
	var edited raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &edited); err != nil || edited.Content.Status != storage.RaceContentStatusPublished {
		t.Fatalf("edit after publish: got %d %s", w.Code, w.Body.String())
	}
	if edited.Content.SignupTimeline != nil {
		t.Fatalf("absent section = %+v, want cleared", edited.Content.SignupTimeline)
	}

	// Rollback to v1 restores the timeline.
	w = h.do(t, "POST", base+"/versions/1/rollback", "", admin)
	var rolled raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &rolled); err != nil || rolled.Content.SignupTimeline == nil {
		t.Fatalf("rollback: got %d %s", w.Code, w.Body.String())
	}

	// Archive.
	w = h.do(t, "POST", base+"/archive", "", admin)
	var archived raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &archived); err != nil || archived.Content.Status != storage.RaceContentStatusArchived {
		t.Fatalf("archive: got %d %s", w.Code, w.Body.String())
	}
}

func TestRaceContentAdmin_OrphansAndAttach(t *testing.T) {
	h := newRaceContentHarness(t)
	admin := h.rh.adminToken(t)
	event := h.store.seedEvent(syncEvent())

	// Create content, then break the link by removing the event (sync deleted it).
	body := map[string]any{"items": []map[string]any{{"item_name": "全程马拉松"}}}
	if w := h.do(t, "PUT", fmt.Sprintf("/api/admin/races/%d/content", event.ID), jsonBody(t, body), admin); w.Code != http.StatusOK {
		t.Fatalf("create: got %d %s", w.Code, w.Body.String())
	}
	delete(h.store.events, event.ID)

	w := h.do(t, "GET", "/api/admin/race-content/orphans", "", admin)
	var orphans raceContentSummariesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &orphans); err != nil || len(orphans.Contents) != 1 {
		t.Fatalf("orphans: got %d %s", w.Code, w.Body.String())
	}
	contentID := orphans.Contents[0].ID

	// Re-attach to a new event with the same identity.
	newEvent := h.store.seedEvent(syncEvent())
	w = h.do(t, "POST", fmt.Sprintf("/api/admin/race-content/%d/attach", contentID), jsonBody(t, map[string]any{"race_event_id": newEvent.ID}), admin)
	if w.Code != http.StatusOK {
		t.Fatalf("attach: got %d %s", w.Code, w.Body.String())
	}

	// The orphan list is now empty and attaching to an occupied race conflicts.
	w = h.do(t, "GET", "/api/admin/race-content/orphans", "", admin)
	orphans.Contents = nil
	if err := json.Unmarshal(w.Body.Bytes(), &orphans); err != nil || len(orphans.Contents) != 0 {
		t.Fatalf("orphans after attach: got %d %s", w.Code, w.Body.String())
	}
	second := h.store.seedEvent(storage.RaceCalendarEvent{
		Source: "中国田协", Origin: storage.RaceOriginSync, Name: "另一场赛事",
		RaceDate: "2030-11-01", Month: 11, DayOfMonth: 1, Country: "CHN",
	})
	h.do(t, "PUT", fmt.Sprintf("/api/admin/races/%d/content", second.ID), `{"items":[]}`, admin)
	w = h.do(t, "POST", fmt.Sprintf("/api/admin/race-content/%d/attach", contentID), jsonBody(t, map[string]any{"race_event_id": second.ID}), admin)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "content_conflict") {
		t.Fatalf("attach conflict: got %d %s", w.Code, w.Body.String())
	}
}

func TestRaceContentAdmin_CityLifecycle(t *testing.T) {
	h := newRaceContentHarness(t)
	admin := h.rh.adminToken(t)
	base := "/api/admin/cities/%E5%8E%A6%E9%97%A8%E5%B8%82/content" // 厦门市

	// Empty read.
	w := h.do(t, "GET", base, "", admin)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"content":null`) {
		t.Fatalf("empty read: got %d %s", w.Code, w.Body.String())
	}

	// AI draft is the二期 stub.
	w = h.do(t, "POST", base+"/ai-draft", "", admin)
	if w.Code != http.StatusNotImplemented || !strings.Contains(w.Body.String(), "ai_draft_not_configured") {
		t.Fatalf("ai-draft: got %d %s", w.Code, w.Body.String())
	}

	// PUT creates; publish mints v1; rollback restores.
	body := map[string]any{
		"province":    "福建省",
		"intro":       map[string]any{"overview": "海滨城市", "culture": "", "food": "沙茶面", "history": ""},
		"attractions": []map[string]any{{"name": "鼓浪屿", "description": "世界文化遗产"}},
		"weather_windows": []map[string]any{
			{"window_start": "01-01", "window_end": "01-15", "avg_temp_c": 12.5, "rain_probability_pct": 30},
			{"window_start": "13-01", "window_end": "01-15"}, // invalid month → 400
		},
	}
	if w = h.do(t, "PUT", base, jsonBody(t, body), admin); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid window: got %d %s", w.Code, w.Body.String())
	}
	body["weather_windows"] = []map[string]any{
		{"window_start": "01-01", "window_end": "01-15", "avg_temp_c": 12.5, "rain_probability_pct": 30},
	}
	w = h.do(t, "PUT", base, jsonBody(t, body), admin)
	var created raceCityContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.Content.Status != storage.RaceContentStatusDraft {
		t.Fatalf("create: got %d %s", w.Code, w.Body.String())
	}

	w = h.do(t, "POST", base+"/publish", "", admin)
	var published raceCityContentPublishResponse
	if err := json.Unmarshal(w.Body.Bytes(), &published); err != nil || published.Version != 1 {
		t.Fatalf("publish: got %d %s", w.Code, w.Body.String())
	}

	// Post-publish edit, then rollback to v1.
	h.do(t, "PUT", base, `{"climate":{"spring":"温和"}}`, admin)
	w = h.do(t, "POST", base+"/versions/1/rollback", "", admin)
	var rolled raceCityContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &rolled); err != nil || rolled.Content.Climate != nil || rolled.Content.Intro == nil {
		t.Fatalf("rollback: got %d %s", w.Code, w.Body.String())
	}

	// Archive, then versions still list.
	h.do(t, "POST", base+"/archive", "", admin)
	w = h.do(t, "GET", base+"/versions", "", admin)
	var versions raceContentVersionsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &versions); err != nil || len(versions.Versions) != 1 {
		t.Fatalf("versions: got %d %s", w.Code, w.Body.String())
	}

	// Unknown city publish → content_not_found.
	if w := h.do(t, "POST", "/api/admin/cities/不存在市/content/publish", "", admin); w.Code != http.StatusNotFound {
		t.Fatalf("unknown city: got %d, want 404", w.Code)
	}
}

// --- AI draft -----------------------------------------------------------------

const aiDraftCity = "/api/admin/cities/%E5%8E%A6%E9%97%A8%E5%B8%82/content/ai-draft" // 厦门市

const aiDraftPayload = `{"intro":{"overview":"海滨城市","culture":"闽南文化","food":"沙茶面","history":"经济特区"},"climate":{"spring":"温和","summer":"炎热","autumn":"凉爽","winter":"温暖"}}`

// aiDraftServer starts a fake OpenAI-compatible chat-completions server.
// content is the raw message.content string (already a JSON string when status
// is 2xx); calls, when non-nil, counts every request the server receives.
func aiDraftServer(t *testing.T, content string, status int, calls *atomic.Int32) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls != nil {
			calls.Add(1)
		}
		if r.URL.Path != "/chat/completions" {
			t.Errorf("llm path = %q, want /chat/completions", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status < 200 || status >= 300 {
			_, _ = w.Write([]byte(`{"error":"boom"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": content}}},
		})
	}))
	t.Cleanup(server.Close)
	return server
}

func aiDraftHarness(t *testing.T, server *httptest.Server, timeout time.Duration) *raceContentHarness {
	t.Helper()
	return newRaceContentHarnessCfg(t, CityAIDraftConfig{
		Endpoint: server.URL, APIKey: "test-key", Model: "city-model", Timeout: timeout,
	})
}

func TestRaceContentAdmin_AIDraftFillsIntroAndClimate(t *testing.T) {
	var calls atomic.Int32
	server := aiDraftServer(t, aiDraftPayload, http.StatusOK, &calls)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)

	// Existing draft with province + attraction + weather must keep those.
	province := "福建省"
	h.store.cities["厦门市"] = &storage.RaceCityContent{
		ID: 7, City: "厦门市", Status: storage.RaceContentStatusDraft,
		Province:       &province,
		Attractions:    []storage.CityAttraction{{Name: "鼓浪屿", Description: "世界文化遗产"}},
		WeatherWindows: []storage.CityWeatherWindow{{WindowStart: "01-01", WindowEnd: "01-15"}},
	}

	w := h.do(t, "POST", aiDraftCity, "", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("ai-draft: got %d %s", w.Code, w.Body.String())
	}
	var got raceCityContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Content == nil || got.Content.Status != storage.RaceContentStatusDraft {
		t.Fatalf("content = %+v", got.Content)
	}
	if got.Content.Intro == nil || got.Content.Intro.Overview != "海滨城市" || got.Content.Intro.Culture != "闽南文化" || got.Content.Intro.Food != "沙茶面" || got.Content.Intro.History != "经济特区" {
		t.Fatalf("intro = %+v", got.Content.Intro)
	}
	if got.Content.Climate == nil || got.Content.Climate.Spring != "温和" || got.Content.Climate.Summer != "炎热" || got.Content.Climate.Autumn != "凉爽" || got.Content.Climate.Winter != "温暖" {
		t.Fatalf("climate = %+v", got.Content.Climate)
	}
	if got.Content.Province == nil || *got.Content.Province != "福建省" {
		t.Fatalf("province = %+v, want preserved", got.Content.Province)
	}
	if len(got.Content.Attractions) != 1 || len(got.Content.WeatherWindows) != 1 {
		t.Fatalf("other sections = %+v, want preserved", got.Content)
	}
	if calls.Load() != 1 {
		t.Fatalf("llm calls = %d, want 1", calls.Load())
	}
}

func TestRaceContentAdmin_AIDraftCreatesDraftForNewCity(t *testing.T) {
	server := aiDraftServer(t, aiDraftPayload, http.StatusOK, nil)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)

	w := h.do(t, "POST", aiDraftCity, "", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("ai-draft: got %d %s", w.Code, w.Body.String())
	}
	var got raceCityContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Content == nil || got.Content.ID == 0 || got.Content.Status != storage.RaceContentStatusDraft {
		t.Fatalf("content = %+v, want a persisted draft", got.Content)
	}
	if got.Content.Intro == nil || got.Content.Climate == nil || got.Content.Province != nil || len(got.Content.Attractions) != 0 || len(got.Content.WeatherWindows) != 0 {
		t.Fatalf("content = %+v, want only intro + climate filled", got.Content)
	}
}

func TestRaceContentAdmin_AIDraftRejectsPublishedOrArchived(t *testing.T) {
	for _, status := range []string{storage.RaceContentStatusPublished, storage.RaceContentStatusArchived} {
		t.Run(status, func(t *testing.T) {
			var calls atomic.Int32
			server := aiDraftServer(t, aiDraftPayload, http.StatusOK, &calls)
			h := aiDraftHarness(t, server, time.Second)
			admin := h.rh.adminToken(t)
			h.store.cities["厦门市"] = &storage.RaceCityContent{ID: 1, City: "厦门市", Status: status}

			w := h.do(t, "POST", aiDraftCity, "", admin)
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "ai_draft_conflict") {
				t.Fatalf("got %d %s, want 409 ai_draft_conflict", w.Code, w.Body.String())
			}
			if calls.Load() != 0 {
				t.Fatalf("llm calls = %d, want 0 for %s content", calls.Load(), status)
			}
		})
	}
}

func TestRaceContentAdmin_AIDraftFailureDoesNotWrite(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		content string
	}{
		{"provider error", http.StatusInternalServerError, ""},
		{"invalid JSON", http.StatusOK, `{"intro":`},
		{"missing sections", http.StatusOK, `{"intro":{"overview":"x"}}`},
		{"unexpected field", http.StatusOK, `{"intro":{"overview":"x","culture":"y","food":"z","history":"h"},"climate":{"spring":"a","summer":"b","autumn":"c","winter":"d"},"extra":1}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := aiDraftServer(t, tc.content, tc.status, nil)
			h := aiDraftHarness(t, server, time.Second)
			admin := h.rh.adminToken(t)

			w := h.do(t, "POST", aiDraftCity, "", admin)
			if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "ai_draft_failed") {
				t.Fatalf("got %d %s, want 502 ai_draft_failed", w.Code, w.Body.String())
			}
			if row, ok := h.store.cities["厦门市"]; ok {
				t.Fatalf("dirty row written on failure: %+v", row)
			}
		})
	}
}

func TestRaceContentAdmin_AIDraftTimeoutDoesNotWrite(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(slow.Close)
	h := aiDraftHarness(t, slow, 20*time.Millisecond)
	admin := h.rh.adminToken(t)

	w := h.do(t, "POST", aiDraftCity, "", admin)
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "ai_draft_failed") {
		t.Fatalf("got %d %s, want 502 ai_draft_failed", w.Code, w.Body.String())
	}
	if row, ok := h.store.cities["厦门市"]; ok {
		t.Fatalf("dirty row written on timeout: %+v", row)
	}
}

// mustJSON encodes a body map (nil decodes to "null", never sent).
func jsonBody(t *testing.T, body any) string {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

// do issues a raw-JSON request against the harness service's router (the
// race-calendar helper takes structured bodies; these tests carry raw strings).
func (h *raceContentHarness) do(t *testing.T, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, r)
	return w
}
