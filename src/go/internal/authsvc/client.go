// Package authsvc is a thin HTTP client for the in-house auth-service. Team
// methods forward the caller's complete Authorization header unchanged. The
// legacy SyncName method separately accepts a token and adds the Bearer scheme
// while mirroring a user's display name as a best-effort update (ADR 0013).
package authsvc

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

// Team is the auth-service representation of a team.
type Team struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
	OwnerUserID string  `json:"owner_user_id"`
	IsOpen      bool    `json:"is_open"`
	MemberCount int     `json:"member_count,omitempty"`
	CreatedAt   string  `json:"created_at,omitempty"`
}

// Membership is the auth-service representation of a user's membership in a team.
type Membership struct {
	TeamID   string `json:"team_id"`
	UserID   string `json:"user_id"`
	Role     string `json:"role"`
	JoinedAt string `json:"joined_at,omitempty"`
}

// Member is one team membership enriched with auth-service profile fields.
type Member struct {
	UserID      string  `json:"user_id"`
	Name        *string `json:"name"`
	DisplayName *string `json:"display_name,omitempty"`
	Email       *string `json:"email"`
	Role        string  `json:"role"`
	JoinedAt    string  `json:"joined_at,omitempty"`
}

// StatusResponse is returned by auth-service mutations that only report status.
type StatusResponse struct {
	Status string `json:"status"`
}

// MyTeam is the compact team-plus-membership shape returned by
// GET /api/users/me/teams.
type MyTeam struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	JoinedAt string `json:"joined_at,omitempty"`
}

// AuthServiceError is a caller-visible 4xx response from the auth-service.
// StatusCode and Detail are safe for the API layer to preserve when proxying.
type AuthServiceError struct {
	StatusCode int
	Detail     any
}

func (e *AuthServiceError) Error() string {
	return fmt.Sprintf("auth-service %d: %v", e.StatusCode, e.Detail)
}

// AuthServiceUnavailable reports an unconfigured client, transport failure, or
// 5xx response. StatusCode is zero unless the auth-service returned a response.
type AuthServiceUnavailable struct {
	StatusCode int
	Detail     string
	Err        error
}

func (e *AuthServiceUnavailable) Error() string {
	if e.Detail != "" {
		if e.StatusCode != 0 {
			return fmt.Sprintf("auth-service %d: %s", e.StatusCode, e.Detail)
		}
		return "auth-service unavailable: " + e.Detail
	}
	if e.Err != nil {
		return "auth-service unavailable: " + e.Err.Error()
	}
	return "auth-service unavailable"
}

func (e *AuthServiceUnavailable) Unwrap() error { return e.Err }

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
		ctx, http.MethodPatch, strings.TrimRight(c.baseURL, "/")+"/api/users/me", bytes.NewReader(body),
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

// ListTeams returns all open teams. authorizationHeader is forwarded unchanged.
func (c *Client) ListTeams(ctx context.Context, authorizationHeader string) ([]Team, error) {
	var raw json.RawMessage
	if err := c.doJSON(ctx, http.MethodGet, "/api/teams", authorizationHeader, nil, &raw); err != nil {
		return nil, err
	}
	return decodeList[Team](raw, "teams")
}

// CreateTeam creates a team. A nil description omits the optional field.
// authorizationHeader is forwarded unchanged.
func (c *Client) CreateTeam(ctx context.Context, authorizationHeader, name string, description *string) (*Team, error) {
	body := struct {
		Name        string  `json:"name"`
		Description *string `json:"description,omitempty"`
	}{Name: name, Description: description}
	var team Team
	if err := c.doJSON(ctx, http.MethodPost, "/api/teams", authorizationHeader, body, &team); err != nil {
		return nil, err
	}
	return &team, nil
}

// GetTeam returns one team. A 404 is returned as a typed AuthServiceError.
func (c *Client) GetTeam(ctx context.Context, authorizationHeader, teamID string) (*Team, error) {
	var team Team
	if err := c.doJSON(ctx, http.MethodGet, teamPath(teamID), authorizationHeader, nil, &team); err != nil {
		return nil, err
	}
	return &team, nil
}

// JoinTeam joins the current user to a team.
func (c *Client) JoinTeam(ctx context.Context, authorizationHeader, teamID string) (*Membership, error) {
	var membership Membership
	if err := c.doJSON(ctx, http.MethodPost, teamPath(teamID)+"/join", authorizationHeader, nil, &membership); err != nil {
		return nil, err
	}
	return &membership, nil
}

// LeaveTeam removes the current user from a team.
func (c *Client) LeaveTeam(ctx context.Context, authorizationHeader, teamID string) (*StatusResponse, error) {
	var status StatusResponse
	if err := c.doJSON(ctx, http.MethodPost, teamPath(teamID)+"/leave", authorizationHeader, nil, &status); err != nil {
		return nil, err
	}
	return &status, nil
}

// TransferTeamOwner transfers ownership to newOwnerUserID.
func (c *Client) TransferTeamOwner(ctx context.Context, authorizationHeader, teamID, newOwnerUserID string) (*Team, error) {
	body := struct {
		NewOwnerUserID string `json:"new_owner_user_id"`
	}{NewOwnerUserID: newOwnerUserID}
	var team Team
	if err := c.doJSON(ctx, http.MethodPost, teamPath(teamID)+"/transfer-owner", authorizationHeader, body, &team); err != nil {
		return nil, err
	}
	return &team, nil
}

// DeleteTeam dissolves a team.
func (c *Client) DeleteTeam(ctx context.Context, authorizationHeader, teamID string) error {
	return c.doJSON(ctx, http.MethodDelete, teamPath(teamID), authorizationHeader, nil, nil)
}

// ListMembers returns all memberships for a team.
func (c *Client) ListMembers(ctx context.Context, authorizationHeader, teamID string) ([]Member, error) {
	var raw json.RawMessage
	if err := c.doJSON(ctx, http.MethodGet, teamPath(teamID)+"/members", authorizationHeader, nil, &raw); err != nil {
		return nil, err
	}
	return decodeList[Member](raw, "members")
}

// ListMyTeams returns teams joined by the current user and their role in each.
func (c *Client) ListMyTeams(ctx context.Context, authorizationHeader string) ([]MyTeam, error) {
	var raw json.RawMessage
	if err := c.doJSON(ctx, http.MethodGet, "/api/users/me/teams", authorizationHeader, nil, &raw); err != nil {
		return nil, err
	}
	return decodeList[MyTeam](raw, "teams")
}

func decodeList[T any](raw json.RawMessage, key string) ([]T, error) {
	var list []T
	if err := json.Unmarshal(raw, &list); err == nil && list != nil {
		return list, nil
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, unavailableDecodeError("list response", err)
	}
	value, ok := envelope[key]
	if !ok {
		return nil, &AuthServiceUnavailable{Detail: fmt.Sprintf("malformed successful response: missing %q field", key)}
	}
	if err := json.Unmarshal(value, &list); err != nil {
		return nil, unavailableDecodeError(key+" response", err)
	}
	if list == nil {
		return nil, &AuthServiceUnavailable{Detail: fmt.Sprintf("malformed successful response: %q must be an array", key)}
	}
	return list, nil
}

func unavailableDecodeError(response string, err error) error {
	return &AuthServiceUnavailable{
		Detail: "malformed successful " + response,
		Err:    err,
	}
}

func (c *Client) doJSON(ctx context.Context, method, path, authorizationHeader string, body, result any) error {
	if strings.TrimSpace(c.baseURL) == "" {
		return &AuthServiceUnavailable{Detail: "base URL not configured"}
	}

	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("authsvc: encode %s %s: %w", method, path, err)
		}
		requestBody = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.baseURL, "/")+path, requestBody)
	if err != nil {
		return fmt.Errorf("authsvc: build %s %s: %w", method, path, err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if authorizationHeader != "" {
		req.Header.Set("Authorization", authorizationHeader)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return &AuthServiceUnavailable{Err: err}
	}
	defer func() { _ = resp.Body.Close() }()

	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody+1))
	if err != nil {
		return &AuthServiceUnavailable{Err: fmt.Errorf("read response: %w", err)}
	}
	if len(responseBody) > maxResponseBody {
		return &AuthServiceUnavailable{Detail: "response body exceeds 1 MiB"}
	}

	if resp.StatusCode >= http.StatusInternalServerError {
		return &AuthServiceUnavailable{StatusCode: resp.StatusCode, Detail: responseDetailText(responseBody)}
	}
	if resp.StatusCode >= http.StatusBadRequest {
		return &AuthServiceError{StatusCode: resp.StatusCode, Detail: responseDetail(responseBody)}
	}
	if result == nil {
		return nil
	}
	if len(responseBody) == 0 {
		return &AuthServiceUnavailable{Detail: "malformed successful response: empty body"}
	}
	if bytes.Equal(bytes.TrimSpace(responseBody), []byte("null")) {
		return &AuthServiceUnavailable{Detail: "malformed successful response: null body"}
	}
	if err := json.Unmarshal(responseBody, result); err != nil {
		return unavailableDecodeError(method+" "+path+" response", err)
	}
	return nil
}

func teamPath(teamID string) string {
	return "/api/teams/" + url.PathEscape(teamID)
}

func responseDetail(body []byte) any {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return "empty response"
	}
	var envelope struct {
		Detail json.RawMessage `json:"detail"`
	}
	if json.Unmarshal(trimmed, &envelope) == nil && len(envelope.Detail) != 0 {
		var detail any
		if json.Unmarshal(envelope.Detail, &detail) == nil {
			return detail
		}
	}
	return string(trimmed)
}

func responseDetailText(body []byte) string {
	detail := responseDetail(body)
	if text, ok := detail.(string); ok {
		return text
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		return "invalid error response"
	}
	return string(encoded)
}
