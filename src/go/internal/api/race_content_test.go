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

// fakeRaceContentStore is the in-memory RaceContentStore the handler tests run
// against. It mirrors the storage layer's resolution rules just closely enough
// to exercise handler behavior (live link, then business key); the deep rules
// are integration-tested in internal/storage.
type fakeRaceContentStore struct {
	events   map[uint64]storage.RaceCalendarEvent
	contents map[uint64]*storage.RaceContent
	items    map[uint64][]storage.RaceContentItem
	cities   map[string]*storage.RaceCityContent
	nextID   uint64
}

func newFakeRaceContentStore() *fakeRaceContentStore {
	return &fakeRaceContentStore{
		events:   map[uint64]storage.RaceCalendarEvent{},
		contents: map[uint64]*storage.RaceContent{},
		items:    map[uint64][]storage.RaceContentItem{},
		cities:   map[string]*storage.RaceCityContent{},
	}
}

func (f *fakeRaceContentStore) seedEvent(e storage.RaceCalendarEvent) storage.RaceCalendarEvent {
	f.nextID++
	e.ID = f.nextID
	f.events[e.ID] = e
	return e
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
		row = &storage.RaceContent{ID: f.nextID, CreatedAt: time.Now().UTC()}
		f.contents[row.ID] = row
	}
	row.RaceEventID = &event.ID
	row.Source, row.RaceName, row.RaceDate = event.Source, event.Name, event.RaceDate
	_, _ = fmt.Sscanf(event.RaceDate, "%d", &row.Year)
	row.PartitionRule, row.SignupTimeline = in.PartitionRule, in.SignupTimeline
	row.SignupChannels, row.PacketPickup = in.SignupChannels, in.PacketPickup
	row.Climate, row.WeatherWindows = in.Climate, in.WeatherWindows
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

// UpsertRaceContentAIDraft merges an AI climate draft into a race's content,
// leaving the other sections and the items alone (the deep merge rules are
// integration-tested in the storage package).
func (f *fakeRaceContentStore) UpsertRaceContentAIDraft(_ context.Context, event *storage.RaceCalendarEvent, in *storage.RaceContent) (*storage.RaceContent, []storage.RaceContentItem, error) {
	row := f.findByEvent(event.ID)
	if row == nil {
		f.nextID++
		row = &storage.RaceContent{ID: f.nextID, CreatedAt: time.Now().UTC()}
		f.contents[row.ID] = row
	}
	row.RaceEventID = &event.ID
	row.Source, row.RaceName, row.RaceDate = event.Source, event.Name, event.RaceDate
	_, _ = fmt.Sscanf(event.RaceDate, "%d", &row.Year)
	row.Climate, row.WeatherWindows = in.Climate, in.WeatherWindows
	row.UpdatedAt = time.Now().UTC()
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
		row = &storage.RaceCityContent{ID: f.nextID, City: in.City, CreatedAt: time.Now().UTC()}
		f.cities[in.City] = row
	}
	row.Province, row.Intro, row.Attractions = in.Province, in.Intro, in.Attractions
	row.UpdatedAt = time.Now().UTC()
	return row, nil
}

func (f *fakeRaceContentStore) UpsertRaceCityContentAIDraft(_ context.Context, in *storage.RaceCityContent) (*storage.RaceCityContent, error) {
	row, ok := f.cities[in.City]
	if !ok {
		f.nextID++
		row = &storage.RaceCityContent{ID: f.nextID, City: in.City, CreatedAt: time.Now().UTC()}
		f.cities[in.City] = row
	}
	row.Intro = in.Intro
	row.UpdatedAt = time.Now().UTC()
	return row, nil
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
		{"POST", base + "/ai-draft", ""},
		{"GET", "/api/admin/race-content/orphans", ""},
		{"POST", "/api/admin/race-content/1/attach", `{"race_event_id":1}`},
		{"GET", "/api/admin/cities/厦门市/content", ""},
		{"PUT", "/api/admin/cities/厦门市/content", `{"intro":{"overview":"x"}}`},
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

func TestRaceContentAdmin_RaceContent(t *testing.T) {
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
	if len(created.Content.Items) != 1 || created.Content.Items[0].ItemName != "全程马拉松" {
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

	// PUT again replaces the aggregate outright (保存即生效): the absent
	// timeline section is cleared and a GET reflects the edit immediately.
	w = h.do(t, "PUT", base, jsonBody(t, map[string]any{"items": []map[string]any{{"item_name": "全程马拉松"}}}), admin)
	var edited raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &edited); err != nil {
		t.Fatalf("edit: got %d %s", w.Code, w.Body.String())
	}
	if edited.Content.SignupTimeline != nil {
		t.Fatalf("absent section = %+v, want cleared", edited.Content.SignupTimeline)
	}
	w = h.do(t, "GET", base, "", admin)
	var reread raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &reread); err != nil || reread.Content == nil || reread.Content.SignupTimeline != nil {
		t.Fatalf("reread: got %d %s", w.Code, w.Body.String())
	}
}

// TestRaceContentAdmin_RaceClimateRoundTrip covers the race-level climate
// sections (moved from city level): the PUT round-trips climate + weather
// windows through the JSON body, malformed windows and percents are 400, and a
// PUT without them clears them (full-replace semantics).
func TestRaceContentAdmin_RaceClimateRoundTrip(t *testing.T) {
	h := newRaceContentHarness(t)
	admin := h.rh.adminToken(t)
	event := h.store.seedEvent(syncEvent())
	base := fmt.Sprintf("/api/admin/races/%d/content", event.ID)

	body := map[string]any{
		"climate": map[string]any{"summary": "干冷晴朗，昼夜温差大"},
		"weather_windows": []map[string]any{
			{"window_start": "12-25", "window_end": "01-10", "avg_temp_c": 2.5, "temp_high_c": 9, "temp_low_c": -3, "rain_probability_pct": 20, "humidity_pct": 45, "wind": "东北风3级"},
		},
		"items": []map[string]any{{"item_name": "全程马拉松"}},
	}
	w := h.do(t, "PUT", base, jsonBody(t, body), admin)
	if w.Code != http.StatusOK {
		t.Fatalf("create: got %d %s", w.Code, w.Body.String())
	}
	var created raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.Content.Climate == nil || created.Content.Climate.Summary != "干冷晴朗，昼夜温差大" || len(created.Content.WeatherWindows) != 1 {
		t.Fatalf("created = %+v, want climate + one window round-tripped", created.Content)
	}
	window := created.Content.WeatherWindows[0]
	if window.WindowStart != "12-25" || window.WindowEnd != "01-10" || window.AvgTempC == nil || *window.AvgTempC != 2.5 ||
		window.RainProbabilityPct == nil || *window.RainProbabilityPct != 20 || window.Wind == nil || *window.Wind != "东北风3级" {
		t.Fatalf("window = %+v, want the fields preserved", window)
	}

	// Validation: a window outside MM-DD and an out-of-range percent are 400s.
	badWindow := map[string]any{"weather_windows": []map[string]any{{"window_start": "13-01", "window_end": "01-15"}}}
	if w = h.do(t, "PUT", base, jsonBody(t, badWindow), admin); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_request") {
		t.Fatalf("invalid window: got %d %s", w.Code, w.Body.String())
	}
	badPct := map[string]any{"weather_windows": []map[string]any{{"window_start": "12-25", "window_end": "01-10", "rain_probability_pct": 101}}}
	if w = h.do(t, "PUT", base, jsonBody(t, badPct), admin); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_request") {
		t.Fatalf("invalid percent: got %d %s", w.Code, w.Body.String())
	}

	// A PUT without the climate sections clears them (full-replace semantics).
	w = h.do(t, "PUT", base, jsonBody(t, map[string]any{"items": []map[string]any{{"item_name": "全程马拉松"}}}), admin)
	if w.Code != http.StatusOK {
		t.Fatalf("clear: got %d %s", w.Code, w.Body.String())
	}
	var cleared raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &cleared); err != nil || cleared.Content.Climate != nil || len(cleared.Content.WeatherWindows) != 0 {
		t.Fatalf("cleared = %+v %s, want climate sections emptied", cleared.Content, w.Body.String())
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

func TestRaceContentAdmin_CityContent(t *testing.T) {
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

	// PUT creates the aggregate. (Weather windows moved to race level — they are
	// no longer part of the city payload.)
	body := map[string]any{
		"province":    "福建省",
		"intro":       map[string]any{"overview": "海滨城市", "culture": "", "food": "沙茶面", "history": ""},
		"attractions": []map[string]any{{"name": "鼓浪屿", "description": "世界文化遗产"}},
	}
	w = h.do(t, "PUT", base, jsonBody(t, body), admin)
	var created raceCityContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || created.Content.Intro == nil || created.Content.Intro.Overview != "海滨城市" {
		t.Fatalf("create: got %d %s", w.Code, w.Body.String())
	}

	// A later PUT replaces it outright (保存即生效).
	w = h.do(t, "PUT", base, `{"intro":{"overview":"改概览"}}`, admin)
	var edited raceCityContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &edited); err != nil || edited.Content.Intro == nil || edited.Content.Intro.Overview != "改概览" {
		t.Fatalf("edit: got %d %s", w.Code, w.Body.String())
	}
	if edited.Content.Attractions != nil {
		t.Fatalf("absent section = %+v, want cleared", edited.Content.Attractions)
	}
}

// --- AI draft -----------------------------------------------------------------

const aiDraftCity = "/api/admin/cities/%E5%8E%A6%E9%97%A8%E5%B8%82/content/ai-draft" // 厦门市

const aiDraftPayload = `{"overview":"海滨城市","culture":"闽南文化","food":"沙茶面","history":"经济特区"}`

const raceAIDraftLLMPayload = `{"summary":"干冷晴朗，昼夜温差大","weather_windows":[{"window_start":"09-20","window_end":"10-05","avg_temp_c":18.5,"temp_high_c":24,"temp_low_c":14,"rain_probability_pct":30,"humidity_pct":65,"wind":"东北风3级"},{"window_start":"10-01","window_end":"10-15","avg_temp_c":17,"temp_high_c":23,"temp_low_c":13}]}`

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

func TestRaceContentAdmin_AIDraftFillsIntro(t *testing.T) {
	var calls atomic.Int32
	server := aiDraftServer(t, aiDraftPayload, http.StatusOK, &calls)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)

	// Existing draft with province + attraction must keep those.
	province := "福建省"
	h.store.cities["厦门市"] = &storage.RaceCityContent{
		ID: 7, City: "厦门市",
		Province:    &province,
		Attractions: []storage.CityAttraction{{Name: "鼓浪屿", Description: "世界文化遗产"}},
	}

	w := h.do(t, "POST", aiDraftCity, "", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("ai-draft: got %d %s", w.Code, w.Body.String())
	}
	var got raceCityContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Content == nil {
		t.Fatalf("content = %+v", got.Content)
	}
	if got.Content.Intro == nil || got.Content.Intro.Overview != "海滨城市" || got.Content.Intro.Culture != "闽南文化" || got.Content.Intro.Food != "沙茶面" || got.Content.Intro.History != "经济特区" {
		t.Fatalf("intro = %+v", got.Content.Intro)
	}
	if got.Content.Province == nil || *got.Content.Province != "福建省" {
		t.Fatalf("province = %+v, want preserved", got.Content.Province)
	}
	if len(got.Content.Attractions) != 1 {
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
	if got.Content == nil || got.Content.ID == 0 {
		t.Fatalf("content = %+v, want a persisted aggregate", got.Content)
	}
	if got.Content.Intro == nil || got.Content.Province != nil || len(got.Content.Attractions) != 0 {
		t.Fatalf("content = %+v, want only the intro filled", got.Content)
	}
}

func TestRaceContentAdmin_AIDraftFailureDoesNotWrite(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		content string
	}{
		{"provider error", http.StatusInternalServerError, ""},
		{"invalid JSON", http.StatusOK, `{"overview":`},
		{"missing sections", http.StatusOK, `{"overview":"x"}`},
		{"unexpected field", http.StatusOK, `{"overview":"x","culture":"y","food":"z","history":"h","extra":1}`},
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

// --- race AI draft -------------------------------------------------------------

// raceAIDraftPath builds the race ai-draft route for one event.
func raceAIDraftPath(eventID uint64) string {
	return fmt.Sprintf("/api/admin/races/%d/content/ai-draft", eventID)
}

func TestRaceContentAdmin_RaceAIDraftMergesClimate(t *testing.T) {
	var calls atomic.Int32
	server := aiDraftServer(t, raceAIDraftLLMPayload, http.StatusOK, &calls)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)
	event := h.store.seedEvent(syncEvent())

	// Existing draft with other sections + items must keep those.
	seeded, _, err := h.store.UpsertRaceContent(context.Background(), &event, &storage.RaceContent{
		SignupTimeline: &storage.RaceSignupTimeline{StartAt: "2030-08-01", Deadline: "2030-09-15"},
	}, []storage.RaceContentItem{{ItemName: "全程马拉松", Quota: intPtrAPITest(30000)}})
	if err != nil {
		t.Fatalf("seed content: %v", err)
	}

	w := h.do(t, "POST", raceAIDraftPath(event.ID), "", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("ai-draft: got %d %s", w.Code, w.Body.String())
	}
	var got raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Content == nil || got.Content.ID != seeded.ID {
		t.Fatalf("content = %+v, want the seeded aggregate updated", got.Content)
	}
	if got.Content.Climate == nil || got.Content.Climate.Summary != "干冷晴朗，昼夜温差大" || len(got.Content.WeatherWindows) != 2 {
		t.Fatalf("content = %+v, want climate + two windows", got.Content)
	}
	first := got.Content.WeatherWindows[0]
	if first.WindowStart != "09-20" || first.WindowEnd != "10-05" || first.AvgTempC == nil || *first.AvgTempC != 18.5 || first.Wind == nil || *first.Wind != "东北风3级" {
		t.Fatalf("window = %+v, want the numeric fields", first)
	}
	if got.Content.SignupTimeline == nil || got.Content.SignupTimeline.Deadline != "2030-09-15" {
		t.Fatalf("signup_timeline = %+v, want other sections preserved", got.Content.SignupTimeline)
	}
	if len(got.Content.Items) != 1 || got.Content.Items[0].ItemName != "全程马拉松" || got.Content.Items[0].Quota == nil || *got.Content.Items[0].Quota != 30000 {
		t.Fatalf("items = %+v, want the seeded item untouched", got.Content.Items)
	}
	if calls.Load() != 1 {
		t.Fatalf("llm calls = %d, want 1", calls.Load())
	}
}

func TestRaceContentAdmin_RaceAIDraftCreatesDraftForNeverMaintainedRace(t *testing.T) {
	server := aiDraftServer(t, raceAIDraftLLMPayload, http.StatusOK, nil)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)
	event := h.store.seedEvent(syncEvent())

	w := h.do(t, "POST", raceAIDraftPath(event.ID), "", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("ai-draft: got %d %s", w.Code, w.Body.String())
	}
	var got raceContentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Content == nil || got.Content.ID == 0 {
		t.Fatalf("content = %+v, want a persisted aggregate", got.Content)
	}
	if got.Content.Climate == nil || got.Content.Climate.Summary != "干冷晴朗，昼夜温差大" || len(got.Content.WeatherWindows) != 2 {
		t.Fatalf("content = %+v, want the AI sections filled", got.Content)
	}
	if got.Content.PartitionRule != nil || got.Content.SignupTimeline != nil || got.Content.SignupChannels != nil || got.Content.PacketPickup != nil || len(got.Content.Items) != 0 {
		t.Fatalf("content = %+v, want everything but the AI sections empty", got.Content)
	}
	if got.Content.RaceName != "同步赛事" || got.Content.Year != 2030 {
		t.Fatalf("identity = %q/%d, want the event's business key", got.Content.RaceName, got.Content.Year)
	}
}

func TestRaceContentAdmin_RaceAIDraftUnknownRace(t *testing.T) {
	server := aiDraftServer(t, raceAIDraftLLMPayload, http.StatusOK, nil)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)

	w := h.do(t, "POST", raceAIDraftPath(999), "", admin)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "race_not_found") {
		t.Fatalf("got %d %s, want 404 race_not_found", w.Code, w.Body.String())
	}
}

func TestRaceContentAdmin_RaceAIDraftMissingCity(t *testing.T) {
	var calls atomic.Int32
	server := aiDraftServer(t, raceAIDraftLLMPayload, http.StatusOK, &calls)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)
	event := syncEvent()
	event.City = nil
	seeded := h.store.seedEvent(event)

	w := h.do(t, "POST", raceAIDraftPath(seeded.ID), "", admin)
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "race_city_missing") {
		t.Fatalf("got %d %s, want 400 race_city_missing", w.Code, w.Body.String())
	}
	if calls.Load() != 0 {
		t.Fatalf("llm calls = %d, want 0", calls.Load())
	}
}

func TestRaceContentAdmin_RaceAIDraftNotConfigured(t *testing.T) {
	h := newRaceContentHarness(t) // empty CityAIDraftConfig
	admin := h.rh.adminToken(t)
	event := h.store.seedEvent(syncEvent())

	w := h.do(t, "POST", raceAIDraftPath(event.ID), "", admin)
	if w.Code != http.StatusNotImplemented || !strings.Contains(w.Body.String(), "ai_draft_not_configured") {
		t.Fatalf("got %d %s, want 501 ai_draft_not_configured", w.Code, w.Body.String())
	}
}

func TestRaceContentAdmin_RaceAIDraftFailureDoesNotWrite(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		content string
	}{
		{"provider error", http.StatusInternalServerError, ""},
		{"invalid JSON", http.StatusOK, `{"summary":`},
		{"missing summary", http.StatusOK, `{"weather_windows":[{"window_start":"09-20","window_end":"10-05"},{"window_start":"10-01","window_end":"10-15"}]}`},
		{"too few windows", http.StatusOK, `{"summary":"干冷","weather_windows":[{"window_start":"09-20","window_end":"10-05"}]}`},
		{"bad window date", http.StatusOK, `{"summary":"干冷","weather_windows":[{"window_start":"13-01","window_end":"10-05"},{"window_start":"10-01","window_end":"10-15"}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := aiDraftServer(t, tc.content, tc.status, nil)
			h := aiDraftHarness(t, server, time.Second)
			admin := h.rh.adminToken(t)
			event := h.store.seedEvent(syncEvent())

			w := h.do(t, "POST", raceAIDraftPath(event.ID), "", admin)
			if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "ai_draft_failed") {
				t.Fatalf("got %d %s, want 502 ai_draft_failed", w.Code, w.Body.String())
			}
			if row := h.store.findByEvent(event.ID); row != nil {
				t.Fatalf("dirty row written on failure: %+v", row)
			}
		})
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
