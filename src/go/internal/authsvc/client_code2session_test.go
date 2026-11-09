package authsvc

// Tests for WeChatCode2Session against a fake auth-service internal endpoint
// (devops#904/#905 prepay fix): request shape (path, X-Internal-Token, body),
// the success path, and the failure taxonomy (4xx typed, 5xx/transport/
// malformed unavailable, unconfigured client).

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWeChatCode2Session_Success(t *testing.T) {
	var gotPath, gotToken, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotToken = r.URL.Path, r.Header.Get("X-Internal-Token")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"openid":"oX-resolved"}`))
	}))
	defer server.Close()

	openid, err := New(server.URL+"/", time.Second).WeChatCode2Session(context.Background(), "internal-secret", "wx-login-code")
	if err != nil {
		t.Fatalf("WeChatCode2Session: %v", err)
	}
	if openid != "oX-resolved" {
		t.Fatalf("openid = %q, want oX-resolved", openid)
	}
	if gotPath != "/api/internal/wechat/code2session" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotToken != "internal-secret" {
		t.Fatalf("X-Internal-Token = %q", gotToken)
	}
	var sent struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal([]byte(gotBody), &sent); err != nil || sent.Code != "wx-login-code" {
		t.Fatalf("body = %q (%v), want the wx.login code", gotBody, err)
	}
}

func TestWeChatCode2Session_Auth4xxIsTyped(t *testing.T) {
	// The auth-service maps WeChat's 40029 to 400 wechat_invalid_code: a
	// stale code must surface as a typed AuthServiceError, not unavailable.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"wechat_invalid_code","message":"Invalid WeChat code"}`))
	}))
	defer server.Close()

	openid, err := New(server.URL, time.Second).WeChatCode2Session(context.Background(), "t", "stale")
	if err == nil || openid != "" {
		t.Fatalf("stale code must fail, got openid=%q err=%v", openid, err)
	}
	var authErr *AuthServiceError
	if !errors.As(err, &authErr) || authErr.StatusCode != http.StatusBadRequest {
		t.Fatalf("err = %v, want AuthServiceError 400", err)
	}
	var unavailable *AuthServiceUnavailable
	if errors.As(err, &unavailable) {
		t.Fatalf("a 4xx must not be AuthServiceUnavailable: %v", err)
	}
}

func TestWeChatCode2Session_FailureShapes(t *testing.T) {
	cases := []struct {
		name string
		run  func(t *testing.T)
	}{
		{"unconfigured client", func(t *testing.T) {
			// Empty baseURL: the authsvc pattern reports unavailable (not a
			// panic or silent success), so prepay fails closed.
			_, err := New("", time.Second).WeChatCode2Session(context.Background(), "t", "c")
			if err == nil {
				t.Fatal("empty base URL returned nil")
			}
		}},
		{"auth-service 5xx", func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
			}))
			defer server.Close()
			_, err := New(server.URL, time.Second).WeChatCode2Session(context.Background(), "t", "c")
			var unavailable *AuthServiceUnavailable
			if !errors.As(err, &unavailable) {
				t.Fatalf("err = %v, want AuthServiceUnavailable", err)
			}
		}},
		{"transport failure", func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
			url := server.URL
			server.Close() // dead endpoint
			_, err := New(url, time.Second).WeChatCode2Session(context.Background(), "t", "c")
			var unavailable *AuthServiceUnavailable
			if !errors.As(err, &unavailable) {
				t.Fatalf("err = %v, want AuthServiceUnavailable", err)
			}
		}},
		{"malformed success body", func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"openid":""}`)) // 200 without an openid
			}))
			defer server.Close()
			_, err := New(server.URL, time.Second).WeChatCode2Session(context.Background(), "t", "c")
			var unavailable *AuthServiceUnavailable
			if !errors.As(err, &unavailable) || !strings.Contains(err.Error(), "openid") {
				t.Fatalf("err = %v, want unavailable (missing openid)", err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, tc.run)
	}
}
