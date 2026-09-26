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

// fakeRaceContentStore is the in-memory RaceContentStore the city-content and
// AI-draft handler tests run against. The deep merge rules are
// integration-tested in internal/storage.
type fakeRaceContentStore struct {
	events map[uint64]storage.RaceCalendarEvent
	cities map[string]*storage.RaceCityContent
	nextID uint64
}

func newFakeRaceContentStore() *fakeRaceContentStore {
	return &fakeRaceContentStore{
		events: map[uint64]storage.RaceCalendarEvent{},
		cities: map[string]*storage.RaceCityContent{},
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

func (f *fakeRaceContentStore) UpdateRaceCalendarEvent(_ context.Context, row *storage.RaceCalendarEvent) error {
	if _, ok := f.events[row.ID]; !ok {
		return storage.ErrRaceCalendarNotFound
	}
	row.UpdatedAt = time.Now().UTC()
	f.events[row.ID] = *row
	return nil
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
	admin := h.rh.adminToken(t)
	internal := internalHdr()
	user := h.rh.token(t, testAudience, "user")

	cases := []struct {
		method, path string
		body         string
	}{
		{"POST", raceAIDraftPath(event.ID), ""},
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

// TestRaceContentAdmin_RaceAIDraftMergesClimate covers the merged ai-draft: the
// generated climate + weather windows land on the race row while the row's
// other content sections are preserved.
func TestRaceContentAdmin_RaceAIDraftMergesClimate(t *testing.T) {
	var calls atomic.Int32
	server := aiDraftServer(t, raceAIDraftLLMPayload, http.StatusOK, &calls)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)
	event := h.store.seedEvent(syncEvent())

	// The race row already carries other sections; they must survive.
	seeded := h.store.events[event.ID]
	seeded.SignupTimeline = &storage.RaceSignupTimeline{StartAt: "2030-08-01", Deadline: "2030-09-15"}
	seeded.SignupChannels = []storage.RaceSignupChannel{{Name: "官网", Type: "官网", URL: strPtrAPITest("https://example.com"), URLType: storage.RaceChannelURLTypeWeb}}
	h.store.events[event.ID] = seeded

	w := h.do(t, "POST", raceAIDraftPath(event.ID), "", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("ai-draft: got %d %s", w.Code, w.Body.String())
	}
	var got raceCalendarEventDTO
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Content == nil {
		t.Fatalf("content = %+v, want the merged sections", got.Content)
	}
	if got.Content.Climate == nil || got.Content.Climate.Summary != "干冷晴朗，昼夜温差大" || len(got.Content.WeatherWindows) != 2 {
		t.Fatalf("content = %+v, want climate + two windows", got.Content)
	}
	first := got.Content.WeatherWindows[0]
	if first.WindowStart != "09-20" || first.WindowEnd != "10-05" || first.AvgTempC == nil || *first.AvgTempC != 18.5 || first.Wind == nil || *first.Wind != "东北风3级" {
		t.Fatalf("window = %+v, want the numeric fields", first)
	}
	if got.Content.SignupTimeline == nil || got.Content.SignupTimeline.Deadline != "2030-09-15" || len(got.Content.SignupChannels) != 1 {
		t.Fatalf("content = %+v, want other sections preserved", got.Content)
	}
	if calls.Load() != 1 {
		t.Fatalf("llm calls = %d, want 1", calls.Load())
	}
}

func TestRaceContentAdmin_RaceAIDraftFillsNeverMaintainedRace(t *testing.T) {
	server := aiDraftServer(t, raceAIDraftLLMPayload, http.StatusOK, nil)
	h := aiDraftHarness(t, server, time.Second)
	admin := h.rh.adminToken(t)
	event := h.store.seedEvent(syncEvent())

	w := h.do(t, "POST", raceAIDraftPath(event.ID), "", admin)
	if w.Code != http.StatusOK {
		t.Fatalf("ai-draft: got %d %s", w.Code, w.Body.String())
	}
	var got raceCalendarEventDTO
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Content == nil {
		t.Fatalf("content = %+v, want the AI sections filled", got.Content)
	}
	if got.Content.Climate == nil || got.Content.Climate.Summary != "干冷晴朗，昼夜温差大" || len(got.Content.WeatherWindows) != 2 {
		t.Fatalf("content = %+v, want the AI sections filled", got.Content)
	}
	if got.Content.PartitionRule != nil || got.Content.SignupTimeline != nil || got.Content.SignupChannels != nil || got.Content.PacketPickup != nil {
		t.Fatalf("content = %+v, want everything but the AI sections empty", got.Content)
	}
	if got.Name != "同步赛事" {
		t.Fatalf("name = %q, want the event's own identity", got.Name)
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
			if row := h.store.events[event.ID]; row.Climate != nil {
				t.Fatalf("dirty row written on failure: %+v", row.Climate)
			}
		})
	}
}

// jsonBody encodes a body map.
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
