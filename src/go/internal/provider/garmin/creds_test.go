package garmin

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// garthDump builds a base64 garth Client.dumps() equivalent: base64(json([o1, o2])).
func garthDump(t *testing.T, o1, o2 map[string]any) string {
	t.Helper()
	raw, err := json.Marshal([]any{o1, o2})
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func TestCredentialsFromGarthDump(t *testing.T) {
	dump := garthDump(t,
		map[string]any{"oauth_token": "OT", "oauth_token_secret": "OS", "domain": "garmin.cn"},
		map[string]any{
			"scope": "CONNECT", "jti": "j", "token_type": "Bearer",
			"access_token": "AT", "refresh_token": "RT",
			"expires_in": 3600, "expires_at": 123,
			"refresh_token_expires_in": 86400, "refresh_token_expires_at": 456,
		},
	)

	creds, err := CredentialsFromGarthDump("a@b.com", "cn", dump)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if creds.Email != "a@b.com" || creds.Region != "cn" {
		t.Errorf("email/region = %q/%q", creds.Email, creds.Region)
	}
	if creds.OAuth1.OAuthToken != "OT" || creds.OAuth1.OAuthTokenSecret != "OS" {
		t.Errorf("oauth1 = %+v", creds.OAuth1)
	}
	if creds.OAuth1.Domain != "garmin.cn" {
		t.Errorf("oauth1 domain = %q, want garmin.cn", creds.OAuth1.Domain)
	}
	if creds.OAuth2.AccessToken != "AT" || creds.OAuth2.RefreshToken != "RT" {
		t.Errorf("oauth2 = %+v", creds.OAuth2)
	}
	if creds.OAuth2.ExpiresIn != 3600 {
		t.Errorf("oauth2 expires_in = %d, want 3600", creds.OAuth2.ExpiresIn)
	}
	if !creds.LoggedIn() {
		t.Errorf("restored creds should be LoggedIn()")
	}
}

func TestCredentialsFromGarthDump_DomainFallback(t *testing.T) {
	// OAuth1 without a domain → derived from region.
	dump := garthDump(t,
		map[string]any{"oauth_token": "OT", "oauth_token_secret": "OS"},
		map[string]any{"access_token": "AT", "token_type": "Bearer"},
	)
	creds, err := CredentialsFromGarthDump("a@b.com", "cn", dump)
	if err != nil {
		t.Fatal(err)
	}
	if creds.OAuth1.Domain != "garmin.cn" {
		t.Errorf("domain fallback = %q, want garmin.cn (region cn)", creds.OAuth1.Domain)
	}
	global, _ := CredentialsFromGarthDump("a@b.com", "global",
		garthDump(t, map[string]any{"oauth_token": "OT", "oauth_token_secret": "OS"}, map[string]any{}))
	if global.OAuth1.Domain != "garmin.com" {
		t.Errorf("global domain fallback = %q, want garmin.com", global.OAuth1.Domain)
	}
}

func TestCredentialsFromGarthDump_Errors(t *testing.T) {
	cases := map[string]string{
		"bad base64":       "!!! not base64 !!!",
		"not a JSON array": base64.StdEncoding.EncodeToString([]byte(`{"oauth_token":"x"}`)),
		"too few elements": base64.StdEncoding.EncodeToString([]byte(`[{"oauth_token":"x"}]`)),
		"no oauth1 token":  base64.StdEncoding.EncodeToString([]byte(`[{},{}]`)),
	}
	for name, dump := range cases {
		if _, err := CredentialsFromGarthDump("e@x.com", "cn", dump); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}
