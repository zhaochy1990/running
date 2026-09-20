package chinaathcalendar

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/chinaath"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeStore records what the handler asks the storage layer to mirror.
type fakeStore struct {
	years []string
	races map[string][]storage.RaceCalendarEvent
}

func (f *fakeStore) ReplaceRaceCalendarYear(_ context.Context, source, year string, races []storage.RaceCalendarEvent) (storage.ReplaceRaceCalendarResult, error) {
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

// catalogueServer serves a three-race catalogue: two current-ish years and one
// historical row the mirror must ignore.
func catalogueServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"code":0,"msg":"SUCCESS","data":{"results":[
			{"raceId":1000453005,"raceName":"2026厦门环东半程马拉松","raceGrade":"A","raceTime":"2026-12-20","raceAddress":"福建省/厦门市/","raceItem":"[\"半程\"]"},
			{"raceId":1000481059,"raceName":"2026福州马拉松","raceGrade":"A","raceTime":"2026-12-27","raceAddress":"福建省/福州市/","raceItem":"[\"全程\",\"半程\"]"},
			{"raceId":1,"raceName":"2018历史赛","raceGrade":"C","raceTime":"2018-04-29","raceAddress":"北京市/北京市/朝阳区","raceItem":"[\"全程\"]"},
			{"raceId":2,"raceName":"2026坏日期赛","raceGrade":"","raceTime":"bad","raceAddress":"","raceItem":"not-json"}
		],"pageNo":1,"pageSize":100,"pageCount":1,"totalCount":3}}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newHandler(t *testing.T, srv *httptest.Server, defaults []string, st CalendarStore) job.Handler {
	t.Helper()
	return New(Config{
		Client:       chinaath.New(chinaath.Config{Endpoint: srv.URL, Timeout: 5 * time.Second, PageSize: 2}),
		Store:        st,
		DefaultYears: defaults,
		Logger:       zap.NewNop(),
	})
}

func TestHandlerMirrorsRequestedYearsOnly(t *testing.T) {
	clientSrv := catalogueServer(t)
	st := &fakeStore{}
	h := newHandler(t, clientSrv, []string{"2026"}, st)

	_, err := h(context.Background(), &job.Job{InputJSON: ""}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(st.years) != 1 || st.years[0] != "2026" {
		t.Fatalf("years mirrored = %v, want [2026]", st.years)
	}
	races := st.races["2026"]
	// 2026-12-20, 2026-12-27, and the "bad" date row (len("bad") < 4 is false —
	// "bad" has 3 chars, so it is skipped) — hence 2 rows.
	if len(races) != 2 {
		t.Fatalf("2026 rows = %d, want 2 (the 2018 and bad-date rows are excluded)", len(races))
	}
	for _, r := range races {
		if r.Source != "中国田协" {
			t.Fatalf("row source = %q, want 中国田协", r.Source)
		}
	}
}

func TestHandlerToRowMapping(t *testing.T) {
	clientSrv := catalogueServer(t)
	st := &fakeStore{}
	h := newHandler(t, clientSrv, []string{"2026"}, st)

	_, err := h(context.Background(), &job.Job{InputJSON: ""}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}

	var fuzhou, xiamen storage.RaceCalendarEvent
	for _, r := range st.races["2026"] {
		switch r.Name {
		case "2026福州马拉松":
			fuzhou = r
		case "2026厦门环东半程马拉松":
			xiamen = r
		}
	}
	if fuzhou.Name == "" {
		t.Fatal("福州 row missing")
	}
	if fuzhou.NameCN == nil || *fuzhou.NameCN != fuzhou.Name {
		t.Fatalf("福州 name_cn = %v, want the Chinese race name", fuzhou.NameCN)
	}
	if fuzhou.RaceDate != "2026-12-27" || fuzhou.Country != "CHN" {
		t.Fatalf("福州 date/country = %v/%v", fuzhou.RaceDate, fuzhou.Country)
	}
	if fuzhou.Province == nil || *fuzhou.Province != "福建省" || fuzhou.City == nil || *fuzhou.City != "福州市" {
		t.Fatalf("福州 province/city = %v/%v, want 福建省/福州市", deref(fuzhou.Province), deref(fuzhou.City))
	}
	if fuzhou.Label == nil || *fuzhou.Label != "A" {
		t.Fatalf("福州 label = %v, want A", deref(fuzhou.Label))
	}
	if fuzhou.RaceTypes == nil || *fuzhou.RaceTypes != `["Marathon","HalfMarathon"]` {
		t.Fatalf("福州 race_types = %v, want [\"Marathon\",\"HalfMarathon\"]", deref(fuzhou.RaceTypes))
	}
	if xiamen.RaceTypes == nil || *xiamen.RaceTypes != `["HalfMarathon"]` {
		t.Fatalf("厦门 race_types = %v, want [\"HalfMarathon\"]", deref(xiamen.RaceTypes))
	}
}

func TestHandlerDefaultsToCurrentAndNextYear(t *testing.T) {
	clientSrv := catalogueServer(t)
	st := &fakeStore{}
	h := newHandler(t, clientSrv, nil, st)

	_, err := h(context.Background(), &job.Job{InputJSON: ""}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	y := time.Now().In(time.FixedZone("CST", 8*3600)).Year()
	thisYear, nextYear := strconv.Itoa(y), strconv.Itoa(y+1)
	if len(st.years) != 1 || st.years[0] != thisYear {
		t.Fatalf("years mirrored = %v, want [%s] (next year %s is absent from the catalogue and skipped)", st.years, thisYear, nextYear)
	}
}

func TestHandlerInputYearOverride(t *testing.T) {
	clientSrv := catalogueServer(t)
	st := &fakeStore{}
	h := newHandler(t, clientSrv, []string{"2026"}, st)

	_, err := h(context.Background(), &job.Job{InputJSON: `{"years":["2018"]}`}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(st.years) != 1 || st.years[0] != "2018" {
		t.Fatalf("years = %v, want [2018]", st.years)
	}
	if len(st.races["2018"]) != 1 || st.races["2018"][0].Name != "2018历史赛" {
		t.Fatalf("2018 rows = %+v", st.races["2018"])
	}
}

func TestHandlerRejectsMalformedInput(t *testing.T) {
	clientSrv := catalogueServer(t)
	st := &fakeStore{}
	h := newHandler(t, clientSrv, []string{"2026"}, st)

	_, err := h(context.Background(), &job.Job{InputJSON: `{oops}`}, func(string, int) error { return nil })
	if _, permanent := job.AsPermanent(err); !permanent {
		t.Fatalf("err = %v, want a permanent error", err)
	}
}

func TestHandlerResultJSON(t *testing.T) {
	clientSrv := catalogueServer(t)
	st := &fakeStore{}
	h := newHandler(t, clientSrv, []string{"2026"}, st)

	res, err := h(context.Background(), &job.Job{InputJSON: ""}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	var out struct {
		Years map[string]yearSummary `json:"years"`
	}
	if err := json.Unmarshal([]byte(res), &out); err != nil {
		t.Fatalf("result not json: %v", err)
	}
	sum := out.Years["2026"]
	if sum.Fetched != 4 || sum.Upserted != 2 || sum.Deleted != 0 {
		t.Fatalf("2026 summary = %+v, want fetched=4 upserted=2 deleted=0", sum)
	}
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
