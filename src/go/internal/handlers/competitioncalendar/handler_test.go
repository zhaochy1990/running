package competitioncalendar

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/worldathletics"
)

// fakeStore records what the handler asks the storage layer to mirror.
type fakeStore struct {
	seasons []string
	events  map[string][]storage.CompetitionCalendarEvent
}

func (f *fakeStore) ReplaceCompetitionCalendarSeason(_ context.Context, source, season string, events []storage.CompetitionCalendarEvent) (storage.ReplaceCompetitionCalendarResult, error) {
	// Mirror the real store's contract: source/season are stamped on the rows.
	for i := range events {
		events[i].Source = source
		events[i].Season = season
	}
	f.seasons = append(f.seasons, season)
	if f.events == nil {
		f.events = map[string][]storage.CompetitionCalendarEvent{}
	}
	f.events[season] = append([]storage.CompetitionCalendarEvent(nil), events...)
	return storage.ReplaceCompetitionCalendarResult{Upserted: len(events)}, nil
}

// waServer serves one season of events, keyed by the season variable in the
// GraphQL body.
func waServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			{"id":7236068,"iaafId":null,"hasResults":false,"hasStartlist":false,"hasApiResults":true,"hasCompetitionInformation":true,"disciplines":"Road Running","rankingCategory":"E","competitionSubgroup":"Label","name":"A Race","venue":"Madrid (ESP)","country":"ESP","startDate":"2026-01-06","endDate":"2026-01-06","dateRange":"06 JAN 2026"}
		]}}}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newHandler(t *testing.T, srv *httptest.Server, defaults []string, st CalendarStore) job.Handler {
	t.Helper()
	return New(Config{
		Client:                worldathletics.New(worldathletics.Config{Endpoint: srv.URL, APIKey: "k", Timeout: 5 * time.Second}),
		Store:                 st,
		CompetitionGroupID:    3775,
		CompetitionSubgroupID: 0,
		DefaultSeasons:        defaults,
	})
}

func TestHandlerFetchesDefaultSeason(t *testing.T) {
	srv := waServer(t)
	st := &fakeStore{}
	h := newHandler(t, srv, nil, st)

	res, err := h(context.Background(), &job.Job{InputJSON: ""}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(st.seasons) != 1 {
		t.Fatalf("seasons mirrored = %v, want 1", st.seasons)
	}
	events := st.events[st.seasons[0]]
	if len(events) != 1 || events[0].Name != "A Race" || events[0].Source != Source {
		t.Fatalf("events = %+v", events)
	}
	var out struct {
		Seasons map[string]seasonSummary `json:"seasons"`
	}
	if err := json.Unmarshal([]byte(res), &out); err != nil {
		t.Fatalf("result not json: %v", err)
	}
	// DefaultSeason was nil, so the handler falls back to the current year.
	if _, ok := out.Seasons[time.Now().Format("2006")]; !ok {
		t.Fatalf("result seasons = %+v", out.Seasons)
	}
}

func TestHandlerUsesInputOverride(t *testing.T) {
	srv := waServer(t)
	st := &fakeStore{}
	h := newHandler(t, srv, []string{"2026"}, st)

	res, err := h(context.Background(), &job.Job{InputJSON: `{"seasons":["2026","2027"]}`}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(st.seasons) != 2 || st.seasons[0] != "2026" || st.seasons[1] != "2027" {
		t.Fatalf("seasons mirrored = %v, want [2026 2027]", st.seasons)
	}
	// 2027 returned null -> no rows passed to the store for it.
	if len(st.events["2027"]) != 0 {
		t.Fatalf("2027 events = %d, want 0", len(st.events["2027"]))
	}
	var out struct {
		Seasons map[string]seasonSummary `json:"seasons"`
	}
	_ = json.Unmarshal([]byte(res), &out)
	if out.Seasons["2027"].Fetched != 0 || out.Seasons["2026"].Upserted != 1 {
		t.Fatalf("summary = %+v", out.Seasons)
	}
}

func TestHandlerRejectsMalformedInput(t *testing.T) {
	srv := waServer(t)
	h := newHandler(t, srv, nil, &fakeStore{})

	_, err := h(context.Background(), &job.Job{InputJSON: `{not json`}, func(string, int) error { return nil })
	if _, permanent := job.AsPermanent(err); !permanent {
		t.Fatalf("err = %v, want a permanent error", err)
	}
}
