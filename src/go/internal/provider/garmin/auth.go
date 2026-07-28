// auth.go is the Go hand-port of garth's Garmin SSO flow (ADR 0009): OAuth1 →
// OAuth2 via the mobile SSO endpoints, no third-party Garmin SDK. The OAuth1
// consumer key/secret are fetched at runtime from the same public S3 URL garth
// uses (cached in-process). Cloudflare is cleared by sending the Android UA on
// the OAuth endpoints and browser-like Sec-Fetch headers on the SSO endpoints.
//
// MFA is NOT supported in v1: a login that returns MFA_REQUIRED fails fast with
// ErrMFARequired (see sso login). Token refresh re-exchanges the stored OAuth1
// token for a fresh OAuth2 bearer — no re-login needed.
package garmin

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	clientID         = "GCM_ANDROID_DARK"
	oauthConsumerURL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json"
	oauthUserAgent   = "com.garmin.android.apps.connectmobile"
	connectUserAgent = "GCM-iOS-5.22.1.4"
	ssoUserAgent     = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
	exchangeAudience = "GARMIN_CONNECT_MOBILE_ANDROID_DI"
	ssoStatusSuccess = "SUCCESSFUL"
	ssoStatusMFA     = "MFA_REQUIRED"
)

// ErrMFARequired is returned when Garmin demands a 2FA code. v1 does not support
// interactive MFA (ADR 0009) — the account must have 2FA disabled.
var ErrMFARequired = errors.New("garmin: MFA required — not supported in v1")

// AuthError is a login / token-exchange failure.
type AuthError struct{ msg string }

func (e *AuthError) Error() string { return "garmin: " + e.msg }

// domainForRegion maps a compact region code to garth's `domain` parameter.
func domainForRegion(region string) string {
	if region == "cn" {
		return "garmin.cn"
	}
	return "garmin.com"
}

// regionForDomain is the inverse used when persisting credentials.
func regionForDomain(domain string) string {
	if domain == "garmin.cn" {
		return "cn"
	}
	return "global"
}

// ─────────────────────────────────────────────────────────────────────────────
// Token types (garth OAuth1Token / OAuth2Token)
// ─────────────────────────────────────────────────────────────────────────────

// OAuth1Token is the long-lived Garmin OAuth1 access token.
type OAuth1Token struct {
	OAuthToken       string `json:"oauth_token"`
	OAuthTokenSecret string `json:"oauth_token_secret"`
	MFAToken         string `json:"mfa_token,omitempty"`
	Domain           string `json:"domain,omitempty"`
}

// OAuth2Token is the short-lived Garmin OAuth2 bearer obtained by exchanging the
// OAuth1 token.
type OAuth2Token struct {
	Scope                 string `json:"scope"`
	Jti                   string `json:"jti"`
	TokenType             string `json:"token_type"`
	AccessToken           string `json:"access_token"`
	RefreshToken          string `json:"refresh_token"`
	ExpiresIn             int64  `json:"expires_in"`
	ExpiresAt             int64  `json:"expires_at"`
	RefreshTokenExpiresIn int64  `json:"refresh_token_expires_in"`
	RefreshTokenExpiresAt int64  `json:"refresh_token_expires_at"`
}

func (t OAuth2Token) expired() bool { return t.AccessToken == "" || t.ExpiresAt < time.Now().Unix() }

// authHeader renders the Authorization header value, e.g. "Bearer <access>".
func (t OAuth2Token) authHeader() string {
	tt := t.TokenType
	if tt == "" {
		tt = "bearer"
	}
	return titleCase(tt) + " " + t.AccessToken
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + strings.ToLower(s[1:])
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth1 consumer credentials (fetched from S3 like garth, cached in-process)
// ─────────────────────────────────────────────────────────────────────────────

type consumerCreds struct {
	Key    string `json:"consumer_key"`
	Secret string `json:"consumer_secret"`
}

var (
	consumerMu    sync.Mutex
	consumerCache *consumerCreds
)

// getConsumer returns the shared OAuth1 consumer key/secret, fetching them once
// from the public S3 URL (same source garth uses) and caching for the process.
func getConsumer(ctx context.Context, hc *http.Client) (consumerCreds, error) {
	consumerMu.Lock()
	defer consumerMu.Unlock()
	if consumerCache != nil {
		return *consumerCache, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, oauthConsumerURL, nil)
	if err != nil {
		return consumerCreds{}, err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return consumerCreds{}, fmt.Errorf("garmin: fetch oauth consumer: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return consumerCreds{}, err
	}
	var c consumerCreds
	if err := json.Unmarshal(body, &c); err != nil {
		return consumerCreds{}, fmt.Errorf("garmin: decode oauth consumer: %w", err)
	}
	if c.Key == "" || c.Secret == "" {
		return consumerCreds{}, &AuthError{msg: "empty oauth consumer credentials"}
	}
	consumerCache = &c
	return c, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// SSO login flow
// ─────────────────────────────────────────────────────────────────────────────

// ssoLogin runs the SSO sign-in → login → ticket → OAuth1 → OAuth2 dance and
// returns the resulting token pair. It fails with ErrMFARequired if Garmin asks
// for a 2FA code (unsupported in v1).
func (c *Client) ssoLogin(ctx context.Context, email, password string) (OAuth1Token, OAuth2Token, error) {
	ssoBase := "https://sso." + c.domain
	serviceURL := "https://mobile.integration." + c.domain + "/gcm/android"

	// 1. Prime cookies with the sign-in page.
	if _, err := c.ssoRequest(ctx, http.MethodGet, ssoBase+"/mobile/sso/en/sign-in",
		url.Values{"clientId": {clientID}}, nil, "none"); err != nil {
		return OAuth1Token{}, OAuth2Token{}, err
	}

	// 2. Submit credentials.
	loginParams := url.Values{
		"clientId": {clientID},
		"locale":   {"en-US"},
		"service":  {serviceURL},
	}
	body, _ := json.Marshal(map[string]any{
		"username":     email,
		"password":     password,
		"rememberMe":   false,
		"captchaToken": "",
	})
	raw, err := c.ssoRequest(ctx, http.MethodPost, ssoBase+"/mobile/api/login", loginParams, body, "")
	if err != nil {
		return OAuth1Token{}, OAuth2Token{}, err
	}
	var lr struct {
		ResponseStatus struct {
			Type string `json:"type"`
		} `json:"responseStatus"`
		ServiceTicketID string `json:"serviceTicketId"`
	}
	if err := json.Unmarshal(raw, &lr); err != nil {
		return OAuth1Token{}, OAuth2Token{}, fmt.Errorf("garmin: parse login response: %w", err)
	}
	switch lr.ResponseStatus.Type {
	case ssoStatusSuccess:
		// proceed
	case ssoStatusMFA:
		return OAuth1Token{}, OAuth2Token{}, ErrMFARequired
	default:
		return OAuth1Token{}, OAuth2Token{}, &AuthError{msg: "SSO login failed: " + lr.ResponseStatus.Type}
	}
	if lr.ServiceTicketID == "" {
		return OAuth1Token{}, OAuth2Token{}, &AuthError{msg: "SSO login returned no service ticket"}
	}

	// Best-effort: sets a Cloudflare LB cookie for backend pinning (garth does
	// the same and ignores failures).
	_, _ = c.ssoRequest(ctx, http.MethodGet, ssoBase+"/portal/sso/embed", nil, nil, "same-origin")

	// 3. Exchange the ticket for an OAuth1 token, then for an OAuth2 bearer.
	oauth1, err := c.getOAuth1Token(ctx, lr.ServiceTicketID, serviceURL)
	if err != nil {
		return OAuth1Token{}, OAuth2Token{}, err
	}
	oauth2, err := c.exchange(ctx, oauth1, true)
	if err != nil {
		return OAuth1Token{}, OAuth2Token{}, err
	}
	return oauth1, oauth2, nil
}

// ssoRequest issues a browser-like request to the SSO host (Cloudflare-safe
// headers) and returns the raw body. secFetchSite is the Sec-Fetch-Site value.
func (c *Client) ssoRequest(ctx context.Context, method, rawURL string, params url.Values, body []byte, secFetchSite string) ([]byte, error) {
	u := rawURL
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	var rdr io.Reader
	if body != nil {
		rdr = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", ssoUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Sec-Fetch-Dest", "document")
	if secFetchSite != "" {
		req.Header.Set("Sec-Fetch-Site", secFetchSite)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("garmin: sso %s: %w", method, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		return nil, &AuthError{msg: fmt.Sprintf("sso %s -> HTTP %d", method, resp.StatusCode)}
	}
	return raw, nil
}

// getOAuth1Token exchanges an SSO service ticket for an OAuth1 access token. The
// request is a 2-legged OAuth1 GET signed with the consumer key/secret only.
func (c *Client) getOAuth1Token(ctx context.Context, ticket, loginURL string) (OAuth1Token, error) {
	cons, err := getConsumer(ctx, c.http)
	if err != nil {
		return OAuth1Token{}, err
	}
	base := "https://connectapi." + c.domain + "/oauth-service/oauth/preauthorized"
	q := url.Values{
		"ticket":             {ticket},
		"login-url":          {loginURL},
		"accepts-mfa-tokens": {"true"},
	}
	rawURL := base + "?" + q.Encode()
	authHeader := oauth1Sign(http.MethodGet, rawURL, nil, cons.Key, cons.Secret, "", "")

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return OAuth1Token{}, err
	}
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("User-Agent", oauthUserAgent)
	resp, err := c.http.Do(req)
	if err != nil {
		return OAuth1Token{}, fmt.Errorf("garmin: oauth1 preauthorized: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return OAuth1Token{}, &AuthError{msg: fmt.Sprintf("oauth1 preauthorized -> HTTP %d", resp.StatusCode)}
	}
	// Response is a form-encoded query string: oauth_token=...&oauth_token_secret=...
	parsed, err := url.ParseQuery(string(raw))
	if err != nil {
		return OAuth1Token{}, fmt.Errorf("garmin: parse oauth1 token: %w", err)
	}
	tok := OAuth1Token{
		OAuthToken:       parsed.Get("oauth_token"),
		OAuthTokenSecret: parsed.Get("oauth_token_secret"),
		MFAToken:         parsed.Get("mfa_token"),
		Domain:           c.domain,
	}
	if tok.OAuthToken == "" || tok.OAuthTokenSecret == "" {
		return OAuth1Token{}, &AuthError{msg: "oauth1 preauthorized returned no token"}
	}
	return tok, nil
}

// exchange trades an OAuth1 token for an OAuth2 bearer. It is a 3-legged OAuth1
// POST signed with the consumer + resource-owner (OAuth1) token/secret. login=true
// adds the mobile audience (garth's login exchange).
func (c *Client) exchange(ctx context.Context, oauth1 OAuth1Token, login bool) (OAuth2Token, error) {
	cons, err := getConsumer(ctx, c.http)
	if err != nil {
		return OAuth2Token{}, err
	}
	rawURL := "https://connectapi." + c.domain + "/oauth-service/oauth/exchange/user/2.0"
	form := url.Values{}
	if login {
		form.Set("audience", exchangeAudience)
	}
	if oauth1.MFAToken != "" {
		form.Set("mfa_token", oauth1.MFAToken)
	}
	authHeader := oauth1Sign(http.MethodPost, rawURL, form, cons.Key, cons.Secret, oauth1.OAuthToken, oauth1.OAuthTokenSecret)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, strings.NewReader(form.Encode()))
	if err != nil {
		return OAuth2Token{}, err
	}
	req.Header.Set("Authorization", authHeader)
	req.Header.Set("User-Agent", oauthUserAgent)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return OAuth2Token{}, fmt.Errorf("garmin: oauth2 exchange: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return OAuth2Token{}, &AuthError{msg: fmt.Sprintf("oauth2 exchange -> HTTP %d", resp.StatusCode)}
	}
	var tok OAuth2Token
	if err := json.Unmarshal(raw, &tok); err != nil {
		return OAuth2Token{}, fmt.Errorf("garmin: parse oauth2 token: %w", err)
	}
	now := time.Now().Unix()
	tok.ExpiresAt = now + tok.ExpiresIn
	tok.RefreshTokenExpiresAt = now + tok.RefreshTokenExpiresIn
	if tok.AccessToken == "" {
		return OAuth2Token{}, &AuthError{msg: "oauth2 exchange returned no access token"}
	}
	return tok, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 1.0a HMAC-SHA1 signer (self-contained; no external OAuth library)
// ─────────────────────────────────────────────────────────────────────────────

// oauth1Sign builds an OAuth 1.0a Authorization header for method+rawURL. Query
// params (from the URL) and bodyParams (form-encoded body, if any) are folded
// into the signature base string per RFC 5849. token/tokenSecret are empty for a
// 2-legged (consumer-only) request.
func oauth1Sign(method, rawURL string, bodyParams url.Values, consumerKey, consumerSecret, token, tokenSecret string) string {
	u, _ := url.Parse(rawURL)
	baseURL := u.Scheme + "://" + u.Host + u.Path

	oauthParams := map[string]string{
		"oauth_consumer_key":     consumerKey,
		"oauth_nonce":            nonce(),
		"oauth_signature_method": "HMAC-SHA1",
		"oauth_timestamp":        strconv.FormatInt(time.Now().Unix(), 10),
		"oauth_version":          "1.0",
	}
	if token != "" {
		oauthParams["oauth_token"] = token
	}

	// Collect all params (query + body + oauth) as encoded (key, value) pairs and
	// sort by encoded key, then encoded value (RFC 5849 §3.4.1.3.2).
	type kv struct{ k, v string }
	var pairs []kv
	add := func(k, v string) { pairs = append(pairs, kv{pctEncode(k), pctEncode(v)}) }
	for k, vs := range u.Query() {
		for _, v := range vs {
			add(k, v)
		}
	}
	for k, vs := range bodyParams {
		for _, v := range vs {
			add(k, v)
		}
	}
	for k, v := range oauthParams {
		add(k, v)
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	paramParts := make([]string, len(pairs))
	for i, p := range pairs {
		paramParts[i] = p.k + "=" + p.v
	}
	paramString := strings.Join(paramParts, "&")

	baseString := strings.ToUpper(method) + "&" + pctEncode(baseURL) + "&" + pctEncode(paramString)
	signingKey := pctEncode(consumerSecret) + "&" + pctEncode(tokenSecret)

	mac := hmac.New(sha1.New, []byte(signingKey))
	mac.Write([]byte(baseString))
	oauthParams["oauth_signature"] = base64.StdEncoding.EncodeToString(mac.Sum(nil))

	// Header contains only oauth_* params, sorted for determinism.
	keys := make([]string, 0, len(oauthParams))
	for k := range oauthParams {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, pctEncode(k)+"=\""+pctEncode(oauthParams[k])+"\"")
	}
	return "OAuth " + strings.Join(parts, ", ")
}

// pctEncode percent-encodes per RFC 3986 (unreserved = A-Za-z0-9-._~), which is
// stricter than url.QueryEscape (that leaves +, encodes space as +, etc.).
func pctEncode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
			(ch >= '0' && ch <= '9') || ch == '-' || ch == '.' || ch == '_' || ch == '~' {
			b.WriteByte(ch)
		} else {
			b.WriteString(fmt.Sprintf("%%%02X", ch))
		}
	}
	return b.String()
}

func nonce() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}
