package competitioncalendar

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/worldathletics"
)

// fakeStore records what the handler asks the storage layer to mirror.
type fakeStore struct {
	years []string
	races map[string][]storage.RaceCalendarEvent
}

func (f *fakeStore) ReplaceRaceCalendarYear(_ context.Context, source, year string, races []storage.RaceCalendarEvent) (storage.ReplaceRaceCalendarResult, error) {
	// Mirror the real store's contract: source is stamped on the rows.
	for i := range races {
		races[i].Source = source
	}
	f.years = append(f.years, year)
	if f.races == nil {
		f.races = map[string][]storage.RaceCalendarEvent{}
	}
	f.races[year] = append([]storage.RaceCalendarEvent(nil), races...)
	return storage.ReplaceRaceCalendarResult{Upserted: len(races)}, nil
}

// waServer serves one year of events, keyed by the year variable in the
// GraphQL body, and records the x-api-key header each request carried.
func waServer(t *testing.T) (*httptest.Server, *string) {
	t.Helper()
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		var body struct {
			Variables struct {
				Season string `json:"season"`
			} `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		if body.Variables.Season == "2027" {
			_, _ = w.Write([]byte(`{"data":{"getMinisiteCalendarEvents":null}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":{"getMinisiteCalendarEvents":{"results":[
			{"name":"Xiamen Marathon","venue":"Xiamen (CHN)","country":"CHN","startDate":"2026-01-06","competitionSubgroup":"Gold"},
			{"name":"Boston Marathon","venue":"Boston, MA (USA)","country":"USA","startDate":"2026-04-20","competitionSubgroup":"Platinum"}
		]}}}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &gotKey
}

func newHandler(t *testing.T, srv *httptest.Server, defaults []string, st CalendarStore) job.Handler {
	t.Helper()
	return New(Config{
		Client:                worldathletics.New(worldathletics.Config{Endpoint: srv.URL, APIKey: "k", Timeout: 5 * time.Second}),
		Store:                 st,
		CompetitionGroupID:    3775,
		CompetitionSubgroupID: 0,
		DefaultYears:          defaults,
		Logger:                zap.NewNop(),
	})
}

func TestHandlerFetchesDefaultYear(t *testing.T) {
	srv, _ := waServer(t)
	st := &fakeStore{}
	h := newHandler(t, srv, nil, st)

	res, err := h(context.Background(), &job.Job{InputJSON: ""}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(st.years) != 1 {
		t.Fatalf("years mirrored = %v, want 1", st.years)
	}
	races := st.races[st.years[0]]
	if len(races) != 2 {
		t.Fatalf("races = %d, want 2", len(races))
	}
	// toRow maps venue -> country/province/city and label.
	var xiamen, boston storage.RaceCalendarEvent
	for _, r := range races {
		if r.Name == "Xiamen Marathon" {
			xiamen = r
		}
		if r.Name == "Boston Marathon" {
			boston = r
		}
	}
	if xiamen.City == nil || *xiamen.City != "厦门市" || xiamen.Province == nil || *xiamen.Province != "福建省" {
		t.Fatalf("Xiamen city/province = %v/%v, want 厦门市/福建省", deref(xiamen.City), deref(xiamen.Province))
	}
	if xiamen.Country != "CHN" || xiamen.Label == nil || *xiamen.Label != "Gold" {
		t.Fatalf("Xiamen country/label = %v/%v", xiamen.Country, deref(xiamen.Label))
	}
	if boston.City == nil || *boston.City != "Boston" || boston.Province == nil || *boston.Province != "Massachusetts" {
		t.Fatalf("Boston city/province = %v/%v, want Boston/Massachusetts", deref(boston.City), deref(boston.Province))
	}

	var out struct {
		Years map[string]yearSummary `json:"years"`
	}
	if err := json.Unmarshal([]byte(res), &out); err != nil {
		t.Fatalf("result not json: %v", err)
	}
	if _, ok := out.Years[time.Now().Format("2006")]; !ok {
		t.Fatalf("result years = %+v", out.Years)
	}
}

func TestHandlerUsesInputOverride(t *testing.T) {
	srv, _ := waServer(t)
	st := &fakeStore{}
	h := newHandler(t, srv, []string{"2026"}, st)

	res, err := h(context.Background(), &job.Job{InputJSON: `{"years":["2026","2027"]}`}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(st.years) != 2 || st.years[0] != "2026" || st.years[1] != "2027" {
		t.Fatalf("years mirrored = %v, want [2026 2027]", st.years)
	}
	if len(st.races["2027"]) != 0 {
		t.Fatalf("2027 races = %d, want 0", len(st.races["2027"]))
	}
	var out struct {
		Years map[string]yearSummary `json:"years"`
	}
	_ = json.Unmarshal([]byte(res), &out)
	if out.Years["2027"].Fetched != 0 || out.Years["2026"].Upserted != 2 {
		t.Fatalf("summary = %+v", out.Years)
	}
}

func TestHandlerRejectsMalformedInput(t *testing.T) {
	srv, _ := waServer(t)
	h := newHandler(t, srv, nil, &fakeStore{})

	_, err := h(context.Background(), &job.Job{InputJSON: `{not json`}, func(string, int) error { return nil })
	if _, permanent := job.AsPermanent(err); !permanent {
		t.Fatalf("err = %v, want a permanent error", err)
	}
}

func TestHandlerUsesDiscoveredCredentials(t *testing.T) {
	srv, gotKey := waServer(t)
	st := &fakeStore{}
	h := newHandler(t, srv, nil, st)

	in := fmt.Sprintf(`{"endpoint":%q,"api_key":"da2-discovered"}`, srv.URL)
	if _, err := h(context.Background(), &job.Job{InputJSON: in}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if *gotKey != "da2-discovered" {
		t.Fatalf("server saw x-api-key %q, want da2-discovered", *gotKey)
	}
	if len(st.races) != 1 {
		t.Fatalf("races mirrored = %d, want 1 year", len(st.races))
	}
}

func TestHandlerIgnoresPartialCredentials(t *testing.T) {
	srv, gotKey := waServer(t)
	h := newHandler(t, srv, nil, &fakeStore{})

	if _, err := h(context.Background(), &job.Job{InputJSON: `{"api_key":"da2-discovered"}`}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if *gotKey != "k" {
		t.Fatalf("server saw x-api-key %q, want configured key k (partial override ignored)", *gotKey)
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
