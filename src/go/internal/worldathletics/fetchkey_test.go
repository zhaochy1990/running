package worldathletics

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const testAPIKey = "da2-q7toieeiobcjxbov4abq3abk5u"

// newSiteServer serves a fake WA page whose JS bundle carries the AppSync
// config pointing at a local GraphQL endpoint (gqlURL), plus a GraphQL endpoint
// that authenticates only requests bearing testAPIKey.
func newSiteServer(t *testing.T) (pageURL, gqlURL string) {
	t.Helper()
	gql := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("x-api-key") == testAPIKey {
			_, _ = w.Write([]byte(`{"data":{"__schema":{"queryType":{"name":"Query"}}}}`))
			return
		}
		_, _ = w.Write([]byte(`{"errors":[{"message":"UnauthorizedException"}]}`))
	}))
	t.Cleanup(gql.Close)

	chunk := fmt.Sprintf(
		`var c={graphql:{endpoint:%q,bearerAuthEndpoint:"https://ptibh.example/graphql",apiKey:%q},cisGraphql:{endpoint:"https://cis.example/graphql",apiKey:"da2-other"}};`,
		gql.URL, testAPIKey)

	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/calendar-results":
			_, _ = w.Write([]byte(`<html><head>` +
				`<script src="/_next/static/chunks/main.js"></script>` +
				`<script src="/_next/static/chunks/site.js"></script>` +
				`</head></html>`))
		case "/_next/static/chunks/main.js":
			_, _ = w.Write([]byte(`console.log("no config here");`))
		case "/_next/static/chunks/site.js":
			_, _ = w.Write([]byte(chunk))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(page.Close)
	return page.URL, gql.URL
}

func testClient() *Client {
	return New(Config{Timeout: 5 * time.Second})
}

func TestDiscoverAPIKey(t *testing.T) {
	pageURL, gqlURL := newSiteServer(t)
	info, err := testClient().DiscoverAPIKey(context.Background(), pageURL+"/calendar-results")
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if info.Endpoint != gqlURL || info.APIKey != testAPIKey {
		t.Fatalf("info = %+v, want endpoint %q key %q", info, gqlURL, testAPIKey)
	}
}

func TestDiscoverAPIKeyNotFound(t *testing.T) {
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html><head></head></html>`))
	}))
	t.Cleanup(page.Close)

	_, err := testClient().DiscoverAPIKey(context.Background(), page.URL)
	if !errors.Is(err, ErrAPIKeyNotFound) {
		t.Fatalf("err = %v, want ErrAPIKeyNotFound", err)
	}
}

func TestVerifyAPIKeyOK(t *testing.T) {
	_, gqlURL := newSiteServer(t)
	if err := testClient().VerifyAPIKey(context.Background(), gqlURL, testAPIKey); err != nil {
		t.Fatalf("verify valid key: %v", err)
	}
}

func TestVerifyAPIKeyRejected(t *testing.T) {
	_, gqlURL := newSiteServer(t)
	err := testClient().VerifyAPIKey(context.Background(), gqlURL, "da2-wrong-key")
	if !errors.Is(err, ErrProbeRejected) {
		t.Fatalf("err = %v, want ErrProbeRejected", err)
	}
}

func TestExtractAPIKeyInfoPicksMainGraphqlObject(t *testing.T) {
	js := `var c={graphql:{endpoint:"https://graphql-prod-4895.edge.aws.worldathletics.org/graphql",bearerAuthEndpoint:"https://ptibh.example/graphql",apiKey:"da2-q7toieeiobcjxbov4abq3abk5u"},cisGraphql:{endpoint:"https://cis.example/graphql",apiKey:"da2-other"}};`
	info, ok := extractAPIKeyInfo(js)
	if !ok {
		t.Fatal("extract failed")
	}
	if info.Endpoint != "https://graphql-prod-4895.edge.aws.worldathletics.org/graphql" || info.APIKey != testAPIKey {
		t.Fatalf("info = %+v", info)
	}
}

func TestExtractAPIKeyInfoNoMatch(t *testing.T) {
	if _, ok := extractAPIKeyInfo(`var x = 1;`); ok {
		t.Fatal("extract should fail on unrelated JS")
	}
}

func TestWithCredentials(t *testing.T) {
	c := testClient()
	c2 := c.WithCredentials("https://other.example/graphql", "da2-new")
	if c2.endpoint != "https://other.example/graphql" || c2.apiKey != "da2-new" {
		t.Fatalf("c2 = %+v", c2)
	}
	// The original client is untouched.
	if c.endpoint != "" || c.apiKey != "" {
		t.Fatalf("original client mutated: %+v", c)
	}
}
