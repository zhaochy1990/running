package worldathletics

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *Client) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv, New(Config{Endpoint: srv.URL, APIKey: "test-key", Timeout: 5 * time.Second})
}

func validResponseBody(t *testing.T) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"data": map[string]any{
			"getMinisiteCalendarEvents": map[string]any{
				"results": []map[string]any{
					{
						"id": 7236068, "iaafId": nil, "hasResults": false, "hasStartlist": false,
						"hasApiResults": true, "hasCompetitionInformation": true,
						"disciplines": "Road Running", "rankingCategory": "E", "competitionSubgroup": "Label",
						"name":  "40. OPTIMA Dreikönigslauf in Schwäbisch Hall",
						"venue": "Schwäbisch Hall (GER)", "country": "GER",
						"startDate": "2026-01-06", "endDate": "2026-01-06", "dateRange": "06 JAN 2026",
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return body
}

func TestMinisiteCalendarParsesEventsAndSendsAPIKey(t *testing.T) {
	var gotKey string
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content-type = %q", r.Header.Get("Content-Type"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(validResponseBody(t))
	})

	events, err := c.MinisiteCalendar(context.Background(), "2026", 3775, 0)
	if err != nil {
		t.Fatalf("minisite calendar: %v", err)
	}
	if gotKey != "test-key" {
		t.Fatalf("x-api-key = %q, want test-key", gotKey)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	e := events[0]
	if e.ID != 7236068 || e.Name == "" || e.StartDate != "2026-01-06" || e.Venue != "Schwäbisch Hall (GER)" {
		t.Fatalf("event = %+v", e)
	}
	if e.IaafID != nil {
		t.Fatalf("iaaf_id = %v, want nil", *e.IaafID)
	}
	if !e.HasAPIResults || e.HasResults {
		t.Fatalf("flags = %+v", e)
	}
}

func TestMinisiteCalendarRetries503(t *testing.T) {
	var calls atomic.Int32
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"errors":[{"message":"throttled"}]}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(validResponseBody(t))
	})

	events, err := c.MinisiteCalendar(context.Background(), "2026", 3775, 0)
	if err != nil {
		t.Fatalf("minisite calendar after retry: %v", err)
	}
	if calls.Load() < 2 {
		t.Fatalf("calls = %d, want retry", calls.Load())
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
}

func TestMinisiteCalendarGraphQLErrorIsTerminal(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"errors":[{"message":"Validation error"}]}`))
	})

	_, err := c.MinisiteCalendar(context.Background(), "2026", 3775, 0)
	if err == nil || !strings.Contains(err.Error(), "Validation error") {
		t.Fatalf("err = %v, want GraphQL validation error", err)
	}
}

func TestMinisiteCalendarNullSeasonIsEmpty(t *testing.T) {
	_, c := testServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"getMinisiteCalendarEvents":null}}`))
	})

	events, err := c.MinisiteCalendar(context.Background(), "2027", 3775, 0)
	if err != nil {
		t.Fatalf("null season: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %d, want 0", len(events))
	}
}

func TestMinisiteCalendarOmitsAPIKeyWhenEmpty(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(validResponseBody(t))
	}))
	defer srv.Close()
	c := New(Config{Endpoint: srv.URL, Timeout: 5 * time.Second})

	if _, err := c.MinisiteCalendar(context.Background(), "2026", 3775, 0); err != nil {
		t.Fatalf("minisite calendar: %v", err)
	}
	if gotKey != "" {
		t.Fatalf("x-api-key = %q, want empty when unset", gotKey)
	}
}
