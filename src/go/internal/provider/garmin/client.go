// client.go is the Garmin Connect API HTTP layer: it holds the OAuth token state
// for one account, attaches the OAuth2 bearer to connectapi requests, and
// transparently re-exchanges the OAuth1 token when the bearer expires (the Go
// equivalent of garth's refresh_oauth2). Read endpoints wrap connectapi with the
// paths verified against the Python garminconnect client.
package garmin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sync"
	"time"

	"github.com/zhaochy1990/stride/internal/provider"
)

// Credentials is a restorable Garmin session: the OAuth bundle plus diagnostics.
type Credentials struct {
	Email       string
	Region      string // "cn" | "global"
	OAuth1      OAuth1Token
	OAuth2      OAuth2Token
	DisplayName string
	UserName    string
}

// LoggedIn reports whether the bundle carries a usable OAuth1 token (the OAuth2
// bearer can always be re-derived from it).
func (c Credentials) LoggedIn() bool { return c.OAuth1.OAuthToken != "" }

// CredentialSaver persists credentials after login or token refresh.
type CredentialSaver func(Credentials) error

// Client talks to the Garmin Connect API for one account.
type Client struct {
	http   *http.Client
	domain string
	delay  time.Duration
	save   CredentialSaver

	mu          sync.RWMutex
	oauth1      OAuth1Token
	oauth2      OAuth2Token
	email       string
	displayName string
	userName    string
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient sets the underlying HTTP client (tests inject an httptest one).
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithRequestDelay sets the post-request rate-limit pause.
func WithRequestDelay(d time.Duration) Option { return func(c *Client) { c.delay = d } }

// WithCredentialSaver sets the persistence hook called after login/refresh.
func WithCredentialSaver(s CredentialSaver) Option { return func(c *Client) { c.save = s } }

// WithDomain overrides the Garmin domain (tests point it at an httptest host).
func WithDomain(d string) Option { return func(c *Client) { c.domain = d } }

// NewClient builds a Client seeded with creds (may be zero for a fresh Login).
func NewClient(creds Credentials, opts ...Option) *Client {
	jar, _ := cookiejar.New(nil)
	c := &Client{
		http:        &http.Client{Timeout: 30 * time.Second, Jar: jar},
		domain:      domainForRegion(creds.Region),
		delay:       500 * time.Millisecond,
		oauth1:      creds.OAuth1,
		oauth2:      creds.OAuth2,
		email:       creds.Email,
		displayName: creds.DisplayName,
		userName:    creds.UserName,
	}
	if creds.OAuth1.Domain != "" {
		c.domain = creds.OAuth1.Domain
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// Login authenticates with email + password and persists the resulting bundle.
func (c *Client) Login(ctx context.Context, email, password string) (Credentials, error) {
	oauth1, oauth2, err := c.ssoLogin(ctx, email, password)
	if err != nil {
		return Credentials{}, err
	}
	c.mu.Lock()
	c.oauth1, c.oauth2, c.email = oauth1, oauth2, email
	c.mu.Unlock()
	if err := c.ensureProfile(ctx); err != nil {
		return Credentials{}, err
	}
	creds := c.snapshot()
	if c.save != nil {
		if err := c.save(creds); err != nil {
			return creds, fmt.Errorf("garmin: persist credentials: %w", err)
		}
	}
	return creds, nil
}

// snapshot returns the current credential bundle under the read lock.
func (c *Client) snapshot() Credentials {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return Credentials{
		Email:       c.email,
		Region:      regionForDomain(c.domain),
		OAuth1:      c.oauth1,
		OAuth2:      c.oauth2,
		DisplayName: c.displayName,
		UserName:    c.userName,
	}
}

// ensureProfile fetches the social profile once to learn displayName/userName,
// which several endpoints need in their path.
func (c *Client) ensureProfile(ctx context.Context) error {
	c.mu.RLock()
	have := c.displayName != ""
	c.mu.RUnlock()
	if have {
		return nil
	}
	raw, err := c.connectapi(ctx, "/userprofile-service/socialProfile", nil)
	if err != nil {
		return err
	}
	var p struct {
		DisplayName string `json:"displayName"`
		UserName    string `json:"userName"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return fmt.Errorf("garmin: parse profile: %w", err)
	}
	c.mu.Lock()
	c.displayName, c.userName = p.DisplayName, p.UserName
	c.mu.Unlock()
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// connectapi request plumbing
// ─────────────────────────────────────────────────────────────────────────────

// connectapi issues an authenticated GET to connectapi.{domain}{path}, refreshing
// the OAuth2 bearer first if expired, and returns the raw JSON body. On a server
// 401 (revoked token / clock skew) it force-refreshes once and retries.
func (c *Client) connectapi(ctx context.Context, path string, params url.Values) (json.RawMessage, error) {
	u := "https://connectapi." + c.domain + path
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	raw, status, err := c.doGet(ctx, u)
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized {
		c.mu.RLock()
		hasOAuth1 := c.oauth1.OAuthToken != ""
		c.mu.RUnlock()
		if hasOAuth1 {
			if err := c.forceRefresh(ctx); err != nil {
				return nil, err
			}
			raw, status, err = c.doGet(ctx, u)
			if err != nil {
				return nil, err
			}
		}
	}
	if status == http.StatusNoContent {
		return json.RawMessage("null"), c.pause(ctx)
	}
	if status >= 400 {
		return nil, &APIError{Status: status, Path: path, Body: string(raw)}
	}
	if err := c.pause(ctx); err != nil {
		return nil, err
	}
	return raw, nil
}

// doGet performs one authenticated GET, ensuring a live bearer beforehand, and
// returns the body + status without interpreting it.
func (c *Client) doGet(ctx context.Context, u string) ([]byte, int, error) {
	if err := c.ensureBearer(ctx); err != nil {
		return nil, 0, err
	}
	c.mu.RLock()
	bearer := c.oauth2.authHeader()
	c.mu.RUnlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", bearer)
	req.Header.Set("User-Agent", connectUserAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("garmin: GET %s: %w", u, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, err
	}
	return raw, resp.StatusCode, nil
}

// ensureBearer re-exchanges the OAuth1 token for a fresh OAuth2 bearer when the
// current one is missing/expired. One refresher wins the write lock; late
// arrivals whose stale bearer already changed skip (mirrors the COROS barrier).
func (c *Client) ensureBearer(ctx context.Context) error {
	c.mu.RLock()
	stale := c.oauth2.AccessToken
	expired := c.oauth2.expired()
	hasOAuth1 := c.oauth1.OAuthToken != ""
	c.mu.RUnlock()
	if !expired {
		return nil
	}
	if !hasOAuth1 {
		return provider.ErrAuthRequired
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.oauth2.AccessToken != stale && !c.oauth2.expired() {
		return nil // another goroutine refreshed
	}
	return c.exchangeLocked(ctx)
}

// forceRefresh re-exchanges the OAuth1 token regardless of the local expiry — for
// the reactive path when the server rejects a bearer it thinks is still valid.
func (c *Client) forceRefresh(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.oauth1.OAuthToken == "" {
		return provider.ErrAuthRequired
	}
	return c.exchangeLocked(ctx)
}

// exchangeLocked exchanges the OAuth1 token for a fresh bearer and persists it.
// The caller must hold c.mu (write lock).
func (c *Client) exchangeLocked(ctx context.Context) error {
	tok, err := c.exchange(ctx, c.oauth1, false)
	if err != nil {
		return err
	}
	c.oauth2 = tok
	if c.save != nil {
		return c.save(Credentials{
			Email: c.email, Region: regionForDomain(c.domain),
			OAuth1: c.oauth1, OAuth2: c.oauth2,
			DisplayName: c.displayName, UserName: c.userName,
		})
	}
	return nil
}

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

// APIError is a non-2xx Garmin API response.
type APIError struct {
	Status int
	Path   string
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("garmin: GET %s -> HTTP %d", e.Path, e.Status)
}

func (c *Client) displayNameOrErr() (string, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.displayName == "" {
		return "", &AuthError{msg: "missing display name (profile not loaded)"}
	}
	return c.displayName, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Read endpoints (sync scope). Paths verified against Python garminconnect.
// ─────────────────────────────────────────────────────────────────────────────

// ListActivities returns one page of the activity list (raw JSON array).
func (c *Client) ListActivities(ctx context.Context, start, limit int) (json.RawMessage, error) {
	return c.connectapi(ctx, "/activitylist-service/activities/search/activities",
		url.Values{"start": {fmt.Sprint(start)}, "limit": {fmt.Sprint(limit)}})
}

// GetActivityDetails returns per-sample chart detail for one activity.
func (c *Client) GetActivityDetails(ctx context.Context, activityID string, maxChart, maxPoly int) (json.RawMessage, error) {
	return c.connectapi(ctx, "/activity-service/activity/"+activityID+"/details",
		url.Values{"maxChartSize": {fmt.Sprint(maxChart)}, "maxPolylineSize": {fmt.Sprint(maxPoly)}})
}

// GetActivitySplits returns the lap/split breakdown for one activity.
func (c *Client) GetActivitySplits(ctx context.Context, activityID string) (json.RawMessage, error) {
	return c.connectapi(ctx, "/activity-service/activity/"+activityID+"/splits", nil)
}

// GetActivityWeather returns weather for one activity.
func (c *Client) GetActivityWeather(ctx context.Context, activityID string) (json.RawMessage, error) {
	return c.connectapi(ctx, "/activity-service/activity/"+activityID+"/weather", nil)
}

// GetTrainingStatus returns the aggregated training status for a date.
func (c *Client) GetTrainingStatus(ctx context.Context, date string) (json.RawMessage, error) {
	return c.connectapi(ctx, "/metrics-service/metrics/trainingstatus/aggregated/"+date, nil)
}

// GetUserSummary returns the daily user summary for a date.
func (c *Client) GetUserSummary(ctx context.Context, date string) (json.RawMessage, error) {
	dn, err := c.displayNameOrErr()
	if err != nil {
		return nil, err
	}
	return c.connectapi(ctx, "/usersummary-service/usersummary/daily/"+dn,
		url.Values{"calendarDate": {date}})
}

// GetSleepData returns sleep detail for a date.
func (c *Client) GetSleepData(ctx context.Context, date string) (json.RawMessage, error) {
	dn, err := c.displayNameOrErr()
	if err != nil {
		return nil, err
	}
	return c.connectapi(ctx, "/wellness-service/wellness/dailySleepData/"+dn,
		url.Values{"date": {date}, "nonSleepBufferMinutes": {"60"}})
}

// GetHRV returns HRV detail for a date.
func (c *Client) GetHRV(ctx context.Context, date string) (json.RawMessage, error) {
	return c.connectapi(ctx, "/hrv-service/hrv/"+date, nil)
}

// GetRacePredictions returns the latest race-time predictions.
func (c *Client) GetRacePredictions(ctx context.Context) (json.RawMessage, error) {
	dn, err := c.displayNameOrErr()
	if err != nil {
		return nil, err
	}
	return c.connectapi(ctx, "/metrics-service/metrics/racepredictions/latest/"+dn, nil)
}

// GetLactateThreshold returns the latest running lactate-threshold speed + HR.
func (c *Client) GetLactateThreshold(ctx context.Context) (json.RawMessage, error) {
	return c.connectapi(ctx, "/biometric-service/biometric/latestLactateThreshold", nil)
}
