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
	"fmt"
	"net/http"
	"time"
)

// Client talks to the auth-service. A zero baseURL disables it: SyncName becomes
// a no-op so deployments without the auth-service configured still work.
type Client struct {
	baseURL string
	http    *http.Client
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
		return fmt.Errorf("authsvc: PATCH /api/users/me returned %d", resp.StatusCode)
	}
	return nil
}
