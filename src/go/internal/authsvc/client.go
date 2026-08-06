// Package authsvc is a thin HTTP client for the in-house auth-service. The Go
// stride-api uses it to mirror a user's display name into the auth-service
// (source of truth for the name lives in stride; Auth holds a best-effort
// mirror — ADR 0013). It forwards the caller's own bearer token, exactly like
// the Python auth_service_client, so the auth-service authenticates the update
// as the end user themselves — no service credential needed.
package authsvc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Client talks to the auth-service. A zero baseURL disables it: SyncName becomes
// a no-op so deployments without the auth-service configured still work.
type Client struct {
	baseURL string
	http    *http.Client
}

// ResponseError reports a non-success response from the auth-service.
type ResponseError struct {
	StatusCode int
	Method     string
	Path       string
}

func (e *ResponseError) Error() string {
	return fmt.Sprintf("authsvc: %s %s returned %d", e.Method, e.Path, e.StatusCode)
}

func (e *ResponseError) HTTPStatus() int { return e.StatusCode }

// StatusCode returns the auth-service status carried by err, if any.
func StatusCode(err error) (int, bool) {
	var responseErr *ResponseError
	if errors.As(err, &responseErr) {
		return responseErr.StatusCode, true
	}
	return 0, false
}

// New builds a Client. baseURL is the auth-service origin (e.g.
// https://auth.example.com); empty disables the write-back. timeout bounds each
// request.
func New(baseURL string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Client{baseURL: baseURL, http: &http.Client{Timeout: timeout}}
}

// updateNameRequest is the PATCH /api/users/me body. The auth-service maps this
// onto user.Name.
type updateNameRequest struct {
	Name string `json:"name"`
}

// SyncName mirrors the display name into the auth-service via PATCH
// /api/users/me, forwarding the end user's bearer. It is best-effort by
// contract: the caller logs and swallows any error (the profile is already
// saved locally). A disabled client (empty baseURL) returns nil.
func (c *Client) SyncName(ctx context.Context, bearer, name string) error {
	if c.baseURL == "" {
		return nil
	}
	body, err := json.Marshal(updateNameRequest{Name: name})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPatch, c.baseURL+"/api/users/me", bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return &ResponseError{StatusCode: resp.StatusCode, Method: http.MethodPatch, Path: "/api/users/me"}
	}
	return nil
}

// DeleteAccount deletes the current user's identity in the auth-service. Unlike
// the best-effort name mirror, account deletion must fail when auth-service is
// not configured or unavailable so a still-loginable identity is never left
// behind after STRIDE data has been erased.
func (c *Client) DeleteAccount(ctx context.Context, bearer string) error {
	if strings.TrimSpace(c.baseURL) == "" {
		return errors.New("authsvc: base URL is not configured")
	}
	const path = "/api/users/me"
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, strings.TrimRight(c.baseURL, "/")+path, nil)
	if err != nil {
		return err
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return &ResponseError{StatusCode: resp.StatusCode, Method: http.MethodDelete, Path: path}
	}
	return nil
}
