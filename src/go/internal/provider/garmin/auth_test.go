package garmin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

func TestPctEncode(t *testing.T) {
	cases := map[string]string{
		"abcABC123": "abcABC123",
		"-._~":      "-._~",
		"a b":       "a%20b",
		"a+b":       "a%2Bb",
		"a/b?c=d":   "a%2Fb%3Fc%3Dd",
		"日":         "%E6%97%A5",
	}
	for in, want := range cases {
		if got := pctEncode(in); got != want {
			t.Errorf("pctEncode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOAuth1Sign_Structure(t *testing.T) {
	// 2-legged (no token).
	h := oauth1Sign(http.MethodGet, "https://connectapi.garmin.com/oauth-service/oauth/preauthorized?ticket=ST-1", nil, "CK", "CS", "", "")
	if !strings.HasPrefix(h, "OAuth ") {
		t.Fatalf("header missing OAuth prefix: %q", h)
	}
	for _, want := range []string{`oauth_consumer_key="CK"`, "oauth_signature=", "oauth_nonce=", `oauth_signature_method="HMAC-SHA1"`} {
		if !strings.Contains(h, want) {
			t.Errorf("2-legged header missing %q in %q", want, h)
		}
	}
	if strings.Contains(h, "oauth_token=") {
		t.Errorf("2-legged header should not carry oauth_token: %q", h)
	}
	// 3-legged (with resource-owner token).
	h3 := oauth1Sign(http.MethodPost, "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0", nil, "CK", "CS", "OT", "OS")
	if !strings.Contains(h3, `oauth_token="OT"`) {
		t.Errorf("3-legged header missing oauth_token: %q", h3)
	}
}

func TestProviderLogin_FullFlow(t *testing.T) {
	// Reset the process-wide consumer cache so the mock S3 handler is exercised.
	consumerMu.Lock()
	consumerCache = nil
	consumerMu.Unlock()

	creds := &captureCreds{} // not logged in
	p, _ := newTestProvider(t, garminMux(), creds)

	res, err := p.Login(context.Background(), testUID, provider.LoginCredentials{
		Email: "a@b.com", Password: "secret", Region: "global",
	})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if !res.Success {
		t.Fatalf("login not successful: %+v", res)
	}
	if creds.saved == nil {
		t.Fatal("credentials were not saved")
	}
	if creds.saved.OAuth1.OAuthToken != "OT" {
		t.Errorf("oauth1 token = %q, want OT", creds.saved.OAuth1.OAuthToken)
	}
	if creds.saved.OAuth2.AccessToken != "AT" {
		t.Errorf("oauth2 access = %q, want AT", creds.saved.OAuth2.AccessToken)
	}
	if creds.saved.OAuth2.ExpiresAt == 0 {
		t.Errorf("oauth2 expires_at not stamped")
	}
	if creds.saved.DisplayName != "dn-123" {
		t.Errorf("displayName = %q, want dn-123", creds.saved.DisplayName)
	}
	if res.UserID != "runner" {
		t.Errorf("res.UserID = %q, want runner (userName)", res.UserID)
	}
}

func TestProviderLogin_MFARejected(t *testing.T) {
	consumerMu.Lock()
	consumerCache = nil
	consumerMu.Unlock()

	mux := http.NewServeMux()
	mux.HandleFunc("/oauth_consumer.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"consumer_key":"CK","consumer_secret":"CS"}`))
	})
	mux.HandleFunc("/mobile/sso/en/sign-in", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/mobile/api/login", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"responseStatus":{"type":"MFA_REQUIRED"}}`))
	})

	creds := &captureCreds{}
	p, _ := newTestProvider(t, mux, creds)

	_, err := p.Login(context.Background(), testUID, provider.LoginCredentials{Email: "a@b.com", Password: "x", Region: "cn"})
	if err != ErrMFARequired {
		t.Fatalf("login err = %v, want ErrMFARequired", err)
	}
	if creds.saved != nil {
		t.Errorf("no credentials should be saved on MFA")
	}
}

func TestClientRegionSelectsDomain(t *testing.T) {
	c := NewClient(Credentials{Region: "cn"})
	if c.domain != "garmin.cn" {
		t.Errorf("cn domain = %q, want garmin.cn", c.domain)
	}
	c = NewClient(Credentials{Region: "global"})
	if c.domain != "garmin.com" {
		t.Errorf("global domain = %q, want garmin.com", c.domain)
	}
}

// ensure the mock server type is referenced (helps go vet on unused in some setups)
var _ = httptest.NewServer
