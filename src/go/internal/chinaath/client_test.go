package chinaath

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap"
)

// paginatedServer serves a two-page catalogue and records each request's
// pagination body so the test can assert the client walked the pages.
func paginatedServer(t *testing.T) (*httptest.Server, *[]pageRequest) {
	t.Helper()
	var got []pageRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req pageRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		got = append(got, req)
		w.Header().Set("Content-Type", "application/json")
		switch req.PageNo {
		case 1:
			_, _ = w.Write([]byte(`{"success":true,"code":0,"msg":"SUCCESS","data":{
				"results":[
					{"raceId":1000481059,"raceName":"2026福州马拉松","raceGrade":"A","raceTime":"2026-12-27","raceAddress":"福建省/福州市/","raceItem":"[\"全程\",\"半程\"]"},
					{"raceId":1000453031,"raceName":"2026北京昌平马拉松","raceGrade":"A","raceTime":"2026-10-25","raceAddress":"北京市/北京市/","raceItem":"[\"全程\"]"}
				],
				"pageNo":1,"pageSize":2,"pageCount":2,"totalCount":3}}`))
		default:
			// A malformed raceItem and a blank one must not fail the sync.
			_, _ = w.Write([]byte(`{"success":true,"code":0,"msg":"SUCCESS","data":{
				"results":[
					{"raceId":1,"raceName":"2026坏数据赛","raceGrade":"A","raceTime":"2026-11-01","raceAddress":"福建省/厦门市/","raceItem":"not-json"},
					{"raceId":2,"raceName":"2026空项目赛","raceGrade":"B","raceTime":"2026-11-08","raceAddress":"广东省/广州市/","raceItem":""}
				],
				"pageNo":2,"pageSize":2,"pageCount":2,"totalCount":3}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

func newTestClient(srv *httptest.Server) *Client {
	return New(Config{Endpoint: srv.URL, Timeout: 5 * time.Second, PageSize: 2}).WithLogger(zap.NewNop())
}

func TestRacesFetchesAllPagesAndParsesItems(t *testing.T) {
	srv, got := paginatedServer(t)
	c := newTestClient(srv)

	races, err := c.Races(context.Background())
	if err != nil {
		t.Fatalf("Races: %v", err)
	}
	if len(*got) != 2 || (*got)[0].PageNo != 1 || (*got)[0].PageSize != 2 || (*got)[1].PageNo != 2 {
		t.Fatalf("requests = %+v, want pages 1..2 at pageSize 2", *got)
	}
	if len(races) != 4 {
		t.Fatalf("races = %d, want 4", len(races))
	}
	if got := races[0].Items; len(got) != 2 || got[0] != "全程" || got[1] != "半程" {
		t.Fatalf("福州 items = %v, want [全程 半程]", got)
	}
	if got := races[2].Items; got != nil {
		t.Fatalf("malformed raceItem must degrade to nil, got %v", got)
	}
	if got := races[3].Items; got != nil {
		t.Fatalf("blank raceItem must degrade to nil, got %v", got)
	}
	if races[0].RaceTime != "2026-12-27" || races[0].RaceGrade != "A" {
		t.Fatalf("row fields not decoded: %+v", races[0])
	}
}

func TestRacesUpstreamErrorIsTerminal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":false,"code":500,"msg":"boom","data":null}`))
	}))
	t.Cleanup(srv.Close)
	c := newTestClient(srv)

	if _, err := c.Races(context.Background()); err == nil {
		t.Fatal("Races must fail on a success:false envelope")
	}
}

func TestRacesEmptyCatalogue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true,"code":0,"msg":"SUCCESS","data":{"results":[],"pageNo":1,"pageSize":2,"pageCount":0,"totalCount":0}}`))
	}))
	t.Cleanup(srv.Close)
	c := newTestClient(srv)

	races, err := c.Races(context.Background())
	if err != nil {
		t.Fatalf("Races on empty catalogue: %v", err)
	}
	if len(races) != 0 {
		t.Fatalf("races = %d, want 0", len(races))
	}
}
