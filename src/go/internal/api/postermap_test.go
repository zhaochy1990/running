package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/tencentlbs"
)

// posterMapStub satisfies PosterMapFetcher and records the last request.
type posterMapStub struct {
	configured bool
	png        []byte
	err        error
	lastReq    tencentlbs.StaticMapRequest
	lastCtxOK  bool
}

func (s *posterMapStub) Configured() bool { return s.configured }

func (s *posterMapStub) FetchStaticMap(ctx context.Context, req tencentlbs.StaticMapRequest) ([]byte, error) {
	s.lastReq = req
	s.lastCtxOK = ctx != nil
	return s.png, s.err
}

// newPosterMapTestService builds the smallest Service that mounts the poster
// proxy: auth with a fresh RSA key (the harness in api_test.go does not
// expose PosterMap wiring).
func newPosterMapTestService(t *testing.T, fetch PosterMapFetcher) (*Service, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	svc := NewService(Config{
		Auth:      NewAuthenticator(testToken, NewJWTVerifierFromKey(&key.PublicKey, testIssuer, testAudience)),
		PosterMap: fetch,
	})
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "user-1",
		"iss": testIssuer,
		"aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	})
	signed, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return svc, signed
}

func posterMapBody() string {
	return `{
		"width": 492, "height": 260, "scale": 2,
		"paths": [
			{"color": "0xffffffff", "weight": 19, "points": [[31.2166, 121.5434], [31.2246, 121.55529]]},
			{"color": "0x00a85a", "weight": 13, "points": [[31.2166, 121.5434], [31.2246, 121.55529]]}
		],
		"markers": [
			{"size": "small", "color": "green", "lat": 31.2166, "lng": 121.5434},
			{"size": "small", "color": "red", "lat": 31.2246, "lng": 121.55529}
		]
	}`
}

func TestPosterMapProxy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	png := []byte{0x89, 'P', 'N', 'G'}

	t.Run("happy path streams png", func(t *testing.T) {
		stub := &posterMapStub{configured: true, png: png}
		svc, tok := newPosterMapTestService(t, stub)
		r := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/users/me/poster/map", strings.NewReader(posterMapBody()))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		svc.Router().ServeHTTP(r, req)
		if r.Code != http.StatusOK {
			t.Fatalf("code %d body %s", r.Code, r.Body.String())
		}
		if got := r.Header().Get("Content-Type"); got != "image/png" {
			t.Fatalf("content-type %q", got)
		}
		if r.Body.Bytes() == nil || r.Body.Len() != len(png) {
			t.Fatalf("png bytes not streamed: %d", r.Body.Len())
		}
		if len(stub.lastReq.Paths) != 2 || stub.lastReq.Paths[0].Weight != 19 {
			t.Fatalf("spec not forwarded: %+v", stub.lastReq)
		}
		if !stub.lastCtxOK {
			t.Fatal("request context not forwarded")
		}
	})

	t.Run("unconfigured key answers 503 map_proxy_not_configured", func(t *testing.T) {
		// The exact degradation signal the miniprogram matches on — until
		// STRIDE_WORKER_TENCENT_LBS_API_KEY lands (devops#949).
		for _, fetch := range []PosterMapFetcher{nil, &posterMapStub{configured: false}} {
			svc, tok := newPosterMapTestService(t, fetch)
			r := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/users/me/poster/map", strings.NewReader(posterMapBody()))
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer "+tok)
			svc.Router().ServeHTTP(r, req)
			if r.Code != http.StatusServiceUnavailable {
				t.Fatalf("code %d, want 503", r.Code)
			}
			var body errorResponse
			if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil || body.Error != "map_proxy_not_configured" {
				t.Fatalf("body %s", r.Body.String())
			}
		}
	})

	t.Run("requires user tier", func(t *testing.T) {
		svc, _ := newPosterMapTestService(t, &posterMapStub{configured: true, png: png})
		r := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/users/me/poster/map", strings.NewReader(posterMapBody()))
		req.Header.Set("Content-Type", "application/json")
		svc.Router().ServeHTTP(r, req)
		if r.Code != http.StatusUnauthorized {
			t.Fatalf("code %d, want 401", r.Code)
		}
	})

	t.Run("invalid spec 400", func(t *testing.T) {
		svc, tok := newPosterMapTestService(t, &posterMapStub{configured: true, png: png})
		r := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/users/me/poster/map", strings.NewReader(`{"scale": 9}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		svc.Router().ServeHTTP(r, req)
		// Bind succeeds (valid JSON); the provider-limit validation in the
		// handler answers 400 before anything is forwarded upstream.
		if r.Code != http.StatusBadRequest {
			t.Fatalf("code %d, want 400", r.Code)
		}
		var body errorResponse
		if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil || body.Error != "invalid_map_request" {
			t.Fatalf("body %s", r.Body.String())
		}
	})

	t.Run("garbage body 400", func(t *testing.T) {
		svc, tok := newPosterMapTestService(t, &posterMapStub{configured: true, png: png})
		r := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/users/me/poster/map", strings.NewReader(`not-json`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		svc.Router().ServeHTTP(r, req)
		if r.Code != http.StatusBadRequest {
			t.Fatalf("code %d, want 400", r.Code)
		}
	})

	t.Run("upstream failure 502", func(t *testing.T) {
		svc, tok := newPosterMapTestService(t, &posterMapStub{configured: true, err: context.DeadlineExceeded})
		r := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/users/me/poster/map", strings.NewReader(posterMapBody()))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		svc.Router().ServeHTTP(r, req)
		if r.Code != http.StatusBadGateway {
			t.Fatalf("code %d, want 502", r.Code)
		}
		var body errorResponse
		if err := json.Unmarshal(r.Body.Bytes(), &body); err != nil || body.Error != "map_proxy_upstream_error" {
			t.Fatalf("body %s", r.Body.String())
		}
	})
}
