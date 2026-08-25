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

	"golang.org/x/time/rate"

	"github.com/zhaochy1990/stride/internal/httpx"
	"github.com/zhaochy1990/stride/internal/provider"
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

// isTokenCode reports whether a COROS result code signals a stale/misrouted
// token that a relogin (not a blind retry) must resolve. These are handled by
// request's refresh path and are deliberately NOT treated as retryable codes.
func isTokenCode(code string) bool {
	return code == resultTokenInvalid || code == resultTokenExpired || code == resultWrongRegion
}

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

// Retryable marks a COROS application-level failure as worth re-issuing. COROS
// answers HTTP 200 with a business result code; a non-success code that is not a
// token/region code (those are handled by request's one-shot relogin, never
// surfaced here) is treated as transient — server busy / throttling — and
// retried, bounded by the client's retry attempts. Every COROS endpoint used by
// the sync is an idempotent read, so a retry is side-effect-free; a genuinely
// terminal code just costs the (bounded) attempts before it surfaces. The httpx
// retry layer consults this via the Retryable() interface.
func (e *APIError) Retryable() bool { return e.Code != "1031" }

// Unwrap marks COROS 1031 (Parameter input error) as deterministic. Unknown
// business codes remain transient because COROS also uses them for throttling.
func (e *APIError) Unwrap() error {
	if e.Code == "1031" {
		return provider.ErrInvalidRequest
	}
	return nil
}

// AuthError is a login / re-login failure.
type AuthError struct{ msg string }

func (e *AuthError) Error() string { return "coros: " + e.msg }

// Unwrap ties AuthError to the provider-level sentinel so callers can classify
// any COROS auth failure with errors.Is(err, provider.ErrAuthRequired) without
// importing this package.
func (e *AuthError) Unwrap() error { return provider.ErrAuthRequired }

// Client talks to the COROS API for one account.
type Client struct {
	http          *http.Client
	bases         map[string]string
	delay         time.Duration
	retryAttempts uint
	retryDelay    time.Duration
	save          CredentialSaver

	// limiter is a shared token bucket gating the sync read endpoints so N
	// concurrent detail-fetch workers stay under one aggregate request ceiling
	// (see EnableRateLimit). nil = no limiting (single-shot uses, tests). It is
	// installed once before any worker goroutine starts, so reads need no lock.
	limiter *rate.Limiter

	mu    sync.RWMutex // guards creds (token + region mutate on refresh)
	creds Credentials
}

// Option configures a Client.
type Option func(*Client)

// WithBases overrides the region → base-URL map (used by tests).
func WithBases(m map[string]string) Option { return func(c *Client) { c.bases = m } }

// WithHTTPClient sets the underlying HTTP client.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithRequestDelay sets the base per-request spacing. It seeds the shared
// token-bucket limiter (see EnableRateLimit): the aggregate request ceiling is
// jobs/delay. Default 500ms; 0 disables rate limiting (tests).
func WithRequestDelay(d time.Duration) Option { return func(c *Client) { c.delay = d } }

// WithCredentialSaver sets the persistence hook called after login/refresh.
func WithCredentialSaver(s CredentialSaver) Option { return func(c *Client) { c.save = s } }

// WithRetry overrides the request retry policy (attempts + base backoff) applied
// uniformly to every COROS call: transient transport failures, HTTP 429/5xx, and
// non-terminal COROS result codes. Tests use it to drop the backoff to zero.
func WithRetry(attempts uint, delay time.Duration) Option {
	return func(c *Client) { c.retryAttempts, c.retryDelay = attempts, delay }
}

// NewClient builds a Client seeded with creds (may be zero for a fresh Login).
func NewClient(creds Credentials, opts ...Option) *Client {
	c := &Client{
		http:          defaultHTTPClient(),
		bases:         DefaultBases,
		delay:         500 * time.Millisecond,
		retryAttempts: httpx.DefaultAttempts,
		retryDelay:    httpx.DefaultBaseDelay,
		creds:         creds,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// defaultHTTPClient builds the HTTP client used for real COROS traffic. It
// clones the stdlib default transport and raises MaxIdleConnsPerHost well above
// the parallel-fetch worker count so concurrent detail requests reuse pooled
// keep-alive connections instead of paying a fresh TCP+TLS handshake each
// (Go's default MaxIdleConnsPerHost is 2, which throttles a parallel sync).
func defaultHTTPClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConns = 100
	tr.MaxIdleConnsPerHost = 32
	tr.IdleConnTimeout = 90 * time.Second
	return &http.Client{Timeout: 30 * time.Second, Transport: tr}
}

// EnableRateLimit installs a shared token-bucket limiter sized for jobs
// concurrent detail fetches. The aggregate request rate is capped at
// jobs/delay (burst jobs) — the same throughput the reference Python sync
// reaches with jobs workers each pausing `delay` between requests, but enforced
// as one ceiling across every goroutine sharing this client. It gates the
// logical request only; in-place transient retries and a token-refresh re-issue
// may briefly exceed it, so it is a near-hard ceiling, not an absolute one. A
// non-positive delay or jobs disables limiting. Call once before spawning the
// fetch workers.
func (c *Client) EnableRateLimit(jobs int) {
	if c.delay <= 0 || jobs < 1 {
		c.limiter = nil
		return
	}
	c.limiter = rate.NewLimiter(rate.Every(c.delay/time.Duration(jobs)), jobs)
}

// waitLimit blocks until the shared limiter admits one request (or ctx is done).
// A nil limiter admits immediately.
func (c *Client) waitLimit(ctx context.Context) error {
	if c.limiter == nil {
		return nil
	}
	return c.limiter.Wait(ctx)
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
		map[string]any{"account": email, "accountType": 2, "pwd": hash}, "", false, false)
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
		env, err := c.doParams(ctx, http.MethodGet, base+"/account/query", nil, token, false, false)
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
		map[string]any{"account": c.creds.Email, "accountType": 2, "pwd": c.creds.PwdHash}, "", false, false)
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
// envelope's data payload. Transient failures (transport, HTTP 429/5xx, and
// non-terminal COROS result codes) are retried inside doParams → send; a token
// code is handled here by a one-shot relogin.
func (c *Client) request(ctx context.Context, method, path string, params url.Values, yf bool) (json.RawMessage, error) {
	token, region := c.currentToken()
	if token == "" {
		return nil, &AuthError{msg: "not logged in; run login"}
	}
	// Rate-limit BEFORE issuing (shared across all concurrent workers) rather
	// than sleeping AFTER: while one worker waits for a token the others keep
	// their requests in flight, so no wall-clock time is spent idle.
	if err := c.waitLimit(ctx); err != nil {
		return nil, err
	}
	env, err := c.doParams(ctx, method, c.base(region)+path, params, token, yf, true)
	if err != nil {
		return nil, err
	}
	if isTokenCode(env.code()) {
		if err := c.refresh(ctx, token); err != nil {
			return nil, err
		}
		token, region = c.currentToken()
		env, err = c.doParams(ctx, method, c.base(region)+path, params, token, yf, true)
		if err != nil {
			return nil, err
		}
	}
	if code := env.code(); code != "" && code != resultSuccess {
		return nil, &APIError{Code: code, Message: string(env.Message)}
	}
	return env.Data, nil
}

func (c *Client) doParams(ctx context.Context, method, rawURL string, params url.Values, token string, yf, classifyCodes bool) (apiEnvelope, error) {
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
	return c.send(req, classifyCodes)
}

func (c *Client) doJSON(ctx context.Context, rawURL string, body any, token string, yf, classifyCodes bool) (apiEnvelope, error) {
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
	// The training/workout endpoints require the per-user yfheader; the auth
	// endpoints (login/relogin) do not.
	if yf {
		req.Header.Set("yfheader", fmt.Sprintf(`{"userId":"%s"}`, c.userID()))
	}
	// The auth endpoints (login/relogin) inspect the result code themselves and
	// must keep returning a permanent AuthError on failure, so they opt OUT of
	// COROS-code retry (classifyCodes=false); a wrong password must not be
	// retried or reclassified as a transient APIError.
	return c.send(req, classifyCodes)
}

// send issues one request through the shared retry policy so transient transport
// failures (a mid-body "unexpected EOF", a reset, a timeout), HTTP 429/5xx, and —
// when classifyCodes is set — non-terminal COROS result codes are all retried in
// place with exponential backoff, uniformly for every endpoint. classifyCodes is
// true only for the authenticated request path (idempotent reads); it is false
// for the auth endpoints, which evaluate the result code themselves.
func (c *Client) send(req *http.Request, classifyCodes bool) (apiEnvelope, error) {
	var env apiEnvelope
	err := httpx.DoN(req.Context(), c.retryAttempts, c.retryDelay, func() error {
		// Reset the body for a retry (POST via doJSON); GET has none.
		if req.GetBody != nil {
			b, e := req.GetBody()
			if e != nil {
				return e
			}
			req.Body = b
		}
		return c.sendOnce(req, &env, classifyCodes)
	})
	return env, err
}

func (c *Client) sendOnce(req *http.Request, env *apiEnvelope, classifyCodes bool) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("coros: %s %s: %w", req.Method, req.URL.Path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("coros: read %s: %w", req.URL.Path, err) // %w keeps io.ErrUnexpectedEOF retryable
	}
	if resp.StatusCode >= 400 {
		return &httpx.StatusError{Code: resp.StatusCode, Body: string(raw)}
	}
	if err := json.Unmarshal(raw, env); err != nil {
		return fmt.Errorf("coros: decode %s: %w", req.URL.Path, err)
	}
	// COROS reports application-level failures as HTTP 200 + a business result
	// code. On the request path, surface a retryable *APIError for any
	// non-success, non-token code so the retry loop above covers COROS's own
	// transient failures (e.g. throttling) the same way it covers 5xx. Token /
	// region codes return nil so request() can run its one-shot relogin instead
	// (a blind retry with the same stale token would be pointless).
	if classifyCodes {
		if code := env.code(); code != "" && code != resultSuccess && !isTokenCode(code) {
			return &APIError{Code: code, Message: string(env.Message)}
		}
	}
	return nil
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

// ─────────────────────────────────────────────────────────────────────────────
// Workout / training-schedule endpoints (push scope)
// ─────────────────────────────────────────────────────────────────────────────

// postJSON issues an authenticated POST with a JSON body and the per-user
// yfheader (required by the training/workout endpoints), transparently
// refreshing the token once on expiry/invalid/wrong-region, and returns the
// response envelope's data payload.
//
// Unlike the read path (request), COROS business codes are NOT blindly retried:
// schedule/update and exercise/add are writes, so a non-success answer surfaces
// immediately instead of being re-sent (a re-send could double-apply a workout
// the user already received). Transport failures and HTTP 429/5xx still go
// through the shared retry policy inside send.
func (c *Client) postJSON(ctx context.Context, path string, body any) (json.RawMessage, error) {
	token, region := c.currentToken()
	if token == "" {
		return nil, &AuthError{msg: "not logged in; run login"}
	}
	if err := c.waitLimit(ctx); err != nil {
		return nil, err
	}
	env, err := c.doJSON(ctx, c.base(region)+path, body, token, true, false)
	if err != nil {
		return nil, err
	}
	if isTokenCode(env.code()) {
		if err := c.refresh(ctx, token); err != nil {
			return nil, err
		}
		token, region = c.currentToken()
		env, err = c.doJSON(ctx, c.base(region)+path, body, token, true, false)
		if err != nil {
			return nil, err
		}
	}
	if code := env.code(); code != "" && code != resultSuccess {
		return nil, &APIError{Code: code, Message: string(env.Message)}
	}
	return env.Data, nil
}

// QuerySchedule returns the training schedule for a date range (data payload).
// COROS dates are YYYYMMDD.
func (c *Client) QuerySchedule(ctx context.Context, startDate, endDate string) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, "/training/schedule/query",
		url.Values{"startDate": {startDate}, "endDate": {endDate}, "supportRestExercise": {"1"}}, false)
}

// CalculateWorkout POSTs a program to the calculate endpoint (data payload).
func (c *Client) CalculateWorkout(ctx context.Context, program, entity map[string]any) (json.RawMessage, error) {
	return c.postJSON(ctx, "/training/program/calculate", program)
}

// UpdateSchedule pushes entities + programs onto the watch schedule (data payload).
func (c *Client) UpdateSchedule(ctx context.Context, entities, programs, versionObjects []any, pbVersion int) (json.RawMessage, error) {
	return c.postJSON(ctx, "/training/schedule/update", map[string]any{
		"entities":       entities,
		"programs":       programs,
		"versionObjects": versionObjects,
		"pbVersion":      pbVersion,
	})
}

// DeleteScheduledWorkout removes one schedule entity (status=3 delete). The
// entity fields come from QuerySchedule; planID is the schedule plan id.
func (c *Client) DeleteScheduledWorkout(ctx context.Context, entity map[string]any, planID string) (json.RawMessage, error) {
	return c.postJSON(ctx, "/training/schedule/update", map[string]any{
		"versionObjects": []any{map[string]any{
			"id":            firstNonEmpty(entity, "idInPlan", "planProgramId"),
			"labelId":       firstNonEmpty(entity, "id", ""),
			"planProgramId": firstNonEmpty(entity, "planProgramId", "idInPlan"),
			"planId":        planID,
			"status":        3,
		}},
		"pbVersion": 2,
	})
}

// QueryExercises returns the exercise library for a sport type (data payload).
// sportType: 4=strength (default), 1=running.
func (c *Client) QueryExercises(ctx context.Context, sportType int) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, "/training/exercise/query",
		url.Values{"userId": {c.userID()}, "sportType": {fmt.Sprint(sportType)}}, true)
}

// AddExercise creates a custom exercise in the library and returns the created
// exercise payload (carrying the new id).
func (c *Client) AddExercise(ctx context.Context, exercise map[string]any) (json.RawMessage, error) {
	return c.postJSON(ctx, "/training/exercise/add", exercise)
}
