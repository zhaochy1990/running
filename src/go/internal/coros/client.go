// client.go is the COROS Training Hub API client (unofficial endpoints). Go port
// of coros_sync.client.
//
// COROS issues a single valid access token per account, so concurrent detail
// fetches must NOT each re-login on expiry (that overwrites each other's token →
// a re-login storm). The token is guarded by an RWMutex: requests read it under
// RLock; exactly one refresher takes the write lock, and any others that queued
// behind it observe the token already changed and skip their own re-login. This
// is the Go equivalent of the Python _token_ready barrier.
package coros

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// DefaultBases are the region-routed COROS API roots.
var DefaultBases = map[string]string{
	"global": "https://teamapi.coros.com",
	"cn":     "https://teamcnapi.coros.com",
	"eu":     "https://teameuapi.coros.com",
}

// COROS result/apiCode values.
const (
	resultSuccess      = "0000"
	resultTokenInvalid = "0101"
	resultTokenExpired = "0102"
	resultWrongRegion  = "1019"
)

// Credentials is a COROS login credential set. PwdHash is the MD5 the login
// endpoint accepts directly; AccessToken is the current bearer.
type Credentials struct {
	Email       string
	PwdHash     string
	AccessToken string
	Region      string
	UserID      string
}

// CredentialSaver persists credentials after a successful login or token
// refresh (e.g. into the provider_credentials store).
type CredentialSaver func(Credentials) error

// APIError is a non-success COROS response envelope.
type APIError struct {
	Code    string
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("coros: [%s] %s", e.Code, e.Message) }

// AuthError is a login / re-login failure.
type AuthError struct{ msg string }

func (e *AuthError) Error() string { return "coros: " + e.msg }

// Client talks to the COROS API for one account.
type Client struct {
	http  *http.Client
	bases map[string]string
	delay time.Duration
	save  CredentialSaver

	mu    sync.RWMutex // guards creds (token + region mutate on refresh)
	creds Credentials
}

// Option configures a Client.
type Option func(*Client)

// WithBases overrides the region → base-URL map (used by tests).
func WithBases(m map[string]string) Option { return func(c *Client) { c.bases = m } }

// WithHTTPClient sets the underlying HTTP client.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithRequestDelay sets the post-request rate-limit pause (default 500ms).
func WithRequestDelay(d time.Duration) Option { return func(c *Client) { c.delay = d } }

// WithCredentialSaver sets the persistence hook called after login/refresh.
func WithCredentialSaver(s CredentialSaver) Option { return func(c *Client) { c.save = s } }

// NewClient builds a Client seeded with creds (may be zero for a fresh Login).
func NewClient(creds Credentials, opts ...Option) *Client {
	c := &Client{
		http:  &http.Client{Timeout: 30 * time.Second},
		bases: DefaultBases,
		delay: 500 * time.Millisecond,
		creds: creds,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// HashPassword returns the MD5 hex digest COROS login expects as pwd.
func HashPassword(password string) string {
	sum := md5.Sum([]byte(password))
	return hex.EncodeToString(sum[:])
}

// ─────────────────────────────────────────────────────────────────────────────
// Response envelope
// ─────────────────────────────────────────────────────────────────────────────

type apiEnvelope struct {
	Result  string          `json:"result"`
	APICode string          `json:"apiCode"`
	Message json.RawMessage `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func (e apiEnvelope) code() string {
	if e.Result != "" {
		return e.Result
	}
	return e.APICode
}

// flexString unmarshals a JSON string or number into a string (COROS userId is
// sometimes numeric, sometimes a string).
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*f = flexString(s)
		return nil
	}
	*f = flexString(strings.TrimSpace(string(b)))
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

// Login authenticates with email + password, detects the account region, stores
// the resulting credentials, and calls the CredentialSaver.
func (c *Client) Login(ctx context.Context, email, password string) (Credentials, error) {
	hash := HashPassword(password)
	env, err := c.doJSON(ctx, c.bases["global"]+"/account/login",
		map[string]any{"account": email, "accountType": 2, "pwd": hash}, "")
	if err != nil {
		return Credentials{}, err
	}
	if env.code() != resultSuccess {
		return Credentials{}, &AuthError{msg: "login failed: " + string(env.Message)}
	}
	var d struct {
		AccessToken string     `json:"accessToken"`
		UserID      flexString `json:"userId"`
	}
	if err := json.Unmarshal(env.Data, &d); err != nil {
		return Credentials{}, fmt.Errorf("coros: decode login data: %w", err)
	}
	region := c.detectRegion(ctx, d.AccessToken)
	creds := Credentials{Email: email, PwdHash: hash, AccessToken: d.AccessToken, Region: region, UserID: string(d.UserID)}

	c.mu.Lock()
	c.creds = creds
	c.mu.Unlock()
	if c.save != nil {
		if err := c.save(creds); err != nil {
			return creds, fmt.Errorf("coros: persist credentials: %w", err)
		}
	}
	return creds, nil
}

// detectRegion probes each base with the token; the base that does not return
// WRONG_REGION wins. Falls back to "global".
func (c *Client) detectRegion(ctx context.Context, token string) string {
	for region, base := range c.bases {
		env, err := c.doParams(ctx, http.MethodGet, base+"/account/query", nil, token, false)
		if err != nil {
			continue
		}
		if env.code() != resultWrongRegion {
			return region
		}
	}
	return "global"
}

// relogin re-authenticates with the stored pwd_hash, reusing the stored region.
// The caller must hold c.mu (write lock).
func (c *Client) relogin(ctx context.Context) error {
	if c.creds.Email == "" || c.creds.PwdHash == "" {
		return &AuthError{msg: "no stored credentials; run login"}
	}
	env, err := c.doJSON(ctx, c.bases["global"]+"/account/login",
		map[string]any{"account": c.creds.Email, "accountType": 2, "pwd": c.creds.PwdHash}, "")
	if err != nil {
		return err
	}
	if env.code() != resultSuccess {
		return &AuthError{msg: "auto re-login failed; run login"}
	}
	var d struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(env.Data, &d); err != nil {
		return fmt.Errorf("coros: decode relogin data: %w", err)
	}
	region := c.creds.Region
	if region == "" {
		region = c.detectRegion(ctx, d.AccessToken)
	}
	c.creds.AccessToken = d.AccessToken
	c.creds.Region = region
	if c.save != nil {
		return c.save(c.creds)
	}
	return nil
}

// refresh coordinates a single re-login across concurrent workers: the winner of
// the write lock re-logins; late arrivals whose stale token already changed skip.
func (c *Client) refresh(ctx context.Context, stale string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.creds.AccessToken != stale {
		return nil // another goroutine already refreshed
	}
	return c.relogin(ctx)
}

func (c *Client) currentToken() (token, region string) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.creds.AccessToken, c.creds.Region
}

func (c *Client) userID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.creds.UserID
}

func (c *Client) base(region string) string {
	if b, ok := c.bases[region]; ok {
		return b
	}
	return c.bases["global"]
}

// ─────────────────────────────────────────────────────────────────────────────
// Request plumbing
// ─────────────────────────────────────────────────────────────────────────────

// request issues an authenticated query-param request, transparently refreshing
// the token once on expiry/invalid/wrong-region, and returns the response
// envelope's data payload.
func (c *Client) request(ctx context.Context, method, path string, params url.Values, yf bool) (json.RawMessage, error) {
	token, region := c.currentToken()
	if token == "" {
		return nil, &AuthError{msg: "not logged in; run login"}
	}
	env, err := c.doParams(ctx, method, c.base(region)+path, params, token, yf)
	if err != nil {
		return nil, err
	}
	switch env.code() {
	case resultTokenExpired, resultTokenInvalid, resultWrongRegion:
		if err := c.refresh(ctx, token); err != nil {
			return nil, err
		}
		token, region = c.currentToken()
		env, err = c.doParams(ctx, method, c.base(region)+path, params, token, yf)
		if err != nil {
			return nil, err
		}
	}
	if code := env.code(); code != "" && code != resultSuccess {
		return nil, &APIError{Code: code, Message: string(env.Message)}
	}
	if err := c.pause(ctx); err != nil {
		return nil, err
	}
	return env.Data, nil
}

// pause applies the rate-limit delay, respecting ctx cancellation.
func (c *Client) pause(ctx context.Context) error {
	if c.delay <= 0 {
		return nil
	}
	t := time.NewTimer(c.delay)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (c *Client) doParams(ctx context.Context, method, rawURL string, params url.Values, token string, yf bool) (apiEnvelope, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return apiEnvelope{}, err
	}
	if params != nil {
		req.URL.RawQuery = params.Encode()
	}
	req.Header.Set("accesstoken", token)
	if yf {
		req.Header.Set("yfheader", fmt.Sprintf(`{"userId":"%s"}`, c.userID()))
	}
	return c.send(req)
}

func (c *Client) doJSON(ctx context.Context, rawURL string, body any, token string) (apiEnvelope, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return apiEnvelope{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader(buf))
	if err != nil {
		return apiEnvelope{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("accesstoken", token)
	}
	return c.send(req)
}

func (c *Client) send(req *http.Request) (apiEnvelope, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		return apiEnvelope{}, fmt.Errorf("coros: %s %s: %w", req.Method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return apiEnvelope{}, err
	}
	if resp.StatusCode >= 400 {
		return apiEnvelope{}, &APIError{Code: fmt.Sprintf("HTTP %d", resp.StatusCode), Message: string(raw)}
	}
	var env apiEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return apiEnvelope{}, fmt.Errorf("coros: decode %s: %w", req.URL.Path, err)
	}
	return env, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Read endpoints (sync scope)
// ─────────────────────────────────────────────────────────────────────────────

// ListActivities returns one page of the activity list (data payload).
func (c *Client) ListActivities(ctx context.Context, page, size int) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, "/activity/query",
		url.Values{"size": {fmt.Sprint(size)}, "pageNumber": {fmt.Sprint(page)}}, false)
}

// GetActivityDetail returns the full detail payload for one activity. COROS uses
// POST with query params (not a JSON body) for this endpoint.
func (c *Client) GetActivityDetail(ctx context.Context, labelID string, sportType int) (json.RawMessage, error) {
	return c.request(ctx, http.MethodPost, "/activity/detail/query",
		url.Values{"labelId": {labelID}, "sportType": {fmt.Sprint(sportType)}}, false)
}

// GetAnalyse returns the training-analysis / daily-health payload.
func (c *Client) GetAnalyse(ctx context.Context) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, "/analyse/query", nil, false)
}

// GetDashboard returns the dashboard summary payload (incl. HRV list).
func (c *Client) GetDashboard(ctx context.Context) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, "/dashboard/query", nil, false)
}

// GetDashboardDetail returns the current-week dashboard record payload.
func (c *Client) GetDashboardDetail(ctx context.Context) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, "/dashboard/detail/query", nil, false)
}
