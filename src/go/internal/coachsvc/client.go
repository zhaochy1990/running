// Package coachsvc is a thin HTTP client for the TypeScript coach service's
// account-erasure surface. The API forwards the caller's bearer unchanged; the
// coach service independently verifies it and enforces its own admin-or-self
// guard.
package coachsvc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxResponseBody = 1 << 20

// Client talks to the coach service. A zero baseURL disables it; DeleteCoachData
// then fails so a deployment that needs erasure cannot silently skip it.
type Client struct {
	baseURL string
	http    *http.Client
}

// New builds a Client. baseURL is the coach-service origin; timeout bounds each
// request.
func New(baseURL string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Client{baseURL: baseURL, http: &http.Client{Timeout: timeout}}
}

// ResponseError reports a non-success response from the coach service.
type ResponseError struct {
	StatusCode int
	Method     string
	Path       string
	Detail     string
}

func (e *ResponseError) Error() string {
	if e.Detail != "" {
		return fmt.Sprintf("coachsvc: %s %s returned %d: %s", e.Method, e.Path, e.StatusCode, e.Detail)
	}
	return fmt.Sprintf("coachsvc: %s %s returned %d", e.Method, e.Path, e.StatusCode)
}

func (e *ResponseError) HTTPStatus() int { return e.StatusCode }

// Unavailable reports an unconfigured client or transport/5xx failure.
type Unavailable struct {
	StatusCode int
	Err        error
}

func (e *Unavailable) Error() string {
	if e.Err != nil {
		return "coach service unavailable: " + e.Err.Error()
	}
	return "coach service unavailable"
}

func (e *Unavailable) Unwrap() error { return e.Err }

// HTTPStatus reports a service-unavailable status so the API maps both a
// transport failure and a 5xx to 503.
func (e *Unavailable) HTTPStatus() int {
	if e.StatusCode != 0 {
		return e.StatusCode
	}
	return http.StatusServiceUnavailable
}

// deleteResponse is the coach service's erasure result: a per-table deletion
// count map so the API can record what was actually removed in the audit row.
type deleteResponse struct {
	Deleted map[string]int64 `json:"deleted"`
}

// DeleteCoachData removes all coach-side rows for userID. bearer is forwarded
// unchanged (an admin token for admin deletion, the user's own token for
// self-deletion); the coach service authorizes it.
func (c *Client) DeleteCoachData(ctx context.Context, bearer, userID string) (map[string]int64, error) {
	if strings.TrimSpace(c.baseURL) == "" {
		return nil, errors.New("coachsvc: base URL is not configured")
	}
	path := "/api/admin/users/" + url.PathEscape(userID) + "/coach-data"
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, strings.TrimRight(c.baseURL, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Unavailable{Err: err}
	}
	defer func() { _ = resp.Body.Close() }()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody+1))
	if readErr != nil {
		return nil, &Unavailable{Err: fmt.Errorf("read response: %w", readErr)}
	}
	if len(body) > maxResponseBody {
		return nil, &Unavailable{Err: errors.New("response body exceeds 1 MiB")}
	}
	if resp.StatusCode >= http.StatusInternalServerError {
		return nil, &Unavailable{StatusCode: resp.StatusCode, Err: errors.New(detailText(body))}
	}
	if resp.StatusCode >= http.StatusBadRequest {
		return nil, &ResponseError{StatusCode: resp.StatusCode, Method: http.MethodDelete, Path: path, Detail: detailText(body)}
	}
	var out deleteResponse
	if len(bytes.TrimSpace(body)) != 0 {
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, &Unavailable{Err: fmt.Errorf("decode response: %w", err)}
		}
	}
	if out.Deleted == nil {
		out.Deleted = map[string]int64{}
	}
	return out.Deleted, nil
}

func detailText(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return ""
	}
	var envelope struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(trimmed, &envelope) == nil && envelope.Error != "" {
		return envelope.Error
	}
	return string(trimmed)
}
