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
	"github.com/zhaochy1990/stride/internal/worldathletics"
)

const keyTestAPIKey = "da2-q7toieeiobcjxbov4abq3abk5u"

// keySiteServer serves a fake WA page whose chunk embeds a GraphQL endpoint
// (local). If rejectProbe is true the endpoint rejects every key, so discovery
// succeeds but verification fails.
func keySiteServer(t *testing.T, rejectProbe bool) (pageURL, gqlURL string) {
	t.Helper()
	gql := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if rejectProbe || r.Header.Get("x-api-key") != keyTestAPIKey {
			_, _ = w.Write([]byte(`{"errors":[{"message":"UnauthorizedException"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":{"__schema":{"queryType":{"name":"Query"}}}}`))
	}))
	t.Cleanup(gql.Close)

	chunk := fmt.Sprintf(`var c={graphql:{endpoint:%q,apiKey:%q}};`, gql.URL, keyTestAPIKey)
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			_, _ = w.Write([]byte(`<html><script src="/_next/static/chunks/site.js"></script></html>`))
		case "/_next/static/chunks/site.js":
			_, _ = w.Write([]byte(chunk))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(page.Close)
	return page.URL, gql.URL
}

func TestKeyFetcherReturnsDiscoveredCredentials(t *testing.T) {
	pageURL, gqlURL := keySiteServer(t, false)
	client := worldathletics.New(worldathletics.Config{Timeout: 5 * time.Second})
	h := NewKeyFetcher(client, pageURL+"/page", zap.NewNop())

	res, err := h(context.Background(), &job.Job{}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	var got struct {
		Endpoint string `json:"endpoint"`
		APIKey   string `json:"api_key"`
	}
	if err := json.Unmarshal([]byte(res), &got); err != nil {
		t.Fatalf("result not json: %v", err)
	}
	if got.Endpoint != gqlURL || got.APIKey != keyTestAPIKey {
		t.Fatalf("result = %+v, want endpoint %q key %q", got, gqlURL, keyTestAPIKey)
	}
}

func TestKeyFetcherProbeRejectedIsPermanent(t *testing.T) {
	pageURL, _ := keySiteServer(t, true)
	client := worldathletics.New(worldathletics.Config{Timeout: 5 * time.Second})
	h := NewKeyFetcher(client, pageURL+"/page", zap.NewNop())

	_, err := h(context.Background(), &job.Job{}, func(string, int) error { return nil })
	if _, perm := job.AsPermanent(err); !perm {
		t.Fatalf("err = %v, want a permanent error", err)
	}
}
