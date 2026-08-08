package authsvc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDeleteAccount(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/api/users/me" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := New(server.URL+"/", time.Second)
	if err := client.DeleteAccount(context.Background(), "token"); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	if gotAuth != "Bearer token" {
		t.Fatalf("authorization = %q, want bearer token", gotAuth)
	}
}

func TestDeleteAccount_ResponseErrorExposesStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	}))
	defer server.Close()

	err := New(server.URL, time.Second).DeleteAccount(context.Background(), "token")
	if status, ok := StatusCode(err); !ok || status != http.StatusConflict {
		t.Fatalf("StatusCode(%v) = %d, %v; want 409, true", err, status, ok)
	}
}

func TestDeleteAccount_RequiresConfiguredBaseURL(t *testing.T) {
	if err := New("", time.Second).DeleteAccount(context.Background(), "token"); err == nil {
		t.Fatal("DeleteAccount with empty base URL returned nil")
	}
}

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return New(server.URL+"/", time.Second)
}

func assertRequest(t *testing.T, r *http.Request, method, path, authorizationHeader string) {
	t.Helper()
	if r.Method != method {
		t.Fatalf("method = %q, want %q", r.Method, method)
	}
	if r.URL.EscapedPath() != path {
		t.Fatalf("path = %q, want %q", r.URL.EscapedPath(), path)
	}
	if got := r.Header.Get("Authorization"); got != authorizationHeader {
		t.Fatalf("Authorization = %q, want %q", got, authorizationHeader)
	}
}

func decodeBody[T any](t *testing.T, r *http.Request) T {
	t.Helper()
	var value T
	if err := json.NewDecoder(r.Body).Decode(&value); err != nil {
		t.Fatalf("decode request body: %v", err)
	}
	return value
}

func TestSyncNamePreservesExistingBehavior(t *testing.T) {
	t.Run("disabled is no-op", func(t *testing.T) {
		if err := New("", time.Second).SyncName(context.Background(), "token", "Runner"); err != nil {
			t.Fatalf("SyncName() error = %v", err)
		}
	})

	t.Run("patches user and forwards bearer", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			assertRequest(t, r, http.MethodPatch, "/api/users/me", "Bearer  token")
			if got := r.Header.Get("Content-Type"); got != "application/json" {
				t.Fatalf("Content-Type = %q", got)
			}
			body := decodeBody[map[string]string](t, r)
			if body["name"] != "Runner" {
				t.Fatalf("name = %q", body["name"])
			}
			w.WriteHeader(http.StatusNoContent)
		})

		if err := client.SyncName(context.Background(), " token ", "Runner"); err != nil {
			t.Fatalf("SyncName() error = %v", err)
		}
	})

	t.Run("non-success keeps legacy error", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "no", http.StatusBadGateway)
		})
		err := client.SyncName(context.Background(), "token", "Runner")
		if got, want := err.Error(), "authsvc: PATCH /api/users/me returned 502"; got != want {
			t.Fatalf("error = %q, want %q", got, want)
		}
	})
}

func TestListTeams(t *testing.T) {
	for _, tc := range []struct {
		name     string
		response string
	}{
		{name: "envelope", response: `{"teams":[{"id":"team-1","name":"STRIDE","owner_user_id":"user-1","is_open":true,"member_count":3}]}`},
		{name: "bare array compatibility", response: `[{"id":"team-1","name":"STRIDE","owner_user_id":"user-1","is_open":true,"member_count":3}]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				assertRequest(t, r, http.MethodGet, "/api/teams", "Bearer jwt")
				if got := r.Header.Get("Accept"); got != "application/json" {
					t.Fatalf("Accept = %q", got)
				}
				_, _ = io.WriteString(w, tc.response)
			})
			teams, err := client.ListTeams(context.Background(), "Bearer jwt")
			if err != nil {
				t.Fatalf("ListTeams() error = %v", err)
			}
			if len(teams) != 1 || teams[0].ID != "team-1" || teams[0].MemberCount != 3 {
				t.Fatalf("teams = %#v", teams)
			}
		})
	}
}

func TestCreateTeam(t *testing.T) {
	t.Run("with description", func(t *testing.T) {
		description := "Marathon runners"
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			assertRequest(t, r, http.MethodPost, "/api/teams", "Bearer jwt")
			if got := r.Header.Get("Content-Type"); got != "application/json" {
				t.Fatalf("Content-Type = %q", got)
			}
			body := decodeBody[map[string]any](t, r)
			if body["name"] != "Sub-3" || body["description"] != description {
				t.Fatalf("body = %#v", body)
			}
			_, _ = io.WriteString(w, `{"id":"team-1","name":"Sub-3","description":"Marathon runners","owner_user_id":"user-1","is_open":true}`)
		})
		team, err := client.CreateTeam(context.Background(), "Bearer jwt", "Sub-3", &description)
		if err != nil {
			t.Fatalf("CreateTeam() error = %v", err)
		}
		if team.ID != "team-1" || team.Description == nil || *team.Description != description {
			t.Fatalf("team = %#v", team)
		}
	})

	t.Run("omits nil description", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			body := decodeBody[map[string]any](t, r)
			if _, ok := body["description"]; ok {
				t.Fatalf("body unexpectedly includes description: %#v", body)
			}
			_, _ = io.WriteString(w, `{"id":"team-1","name":"Sub-3","owner_user_id":"user-1","is_open":true}`)
		})
		if _, err := client.CreateTeam(context.Background(), "Bearer jwt", "Sub-3", nil); err != nil {
			t.Fatalf("CreateTeam() error = %v", err)
		}
	})
}

func TestGetTeamEscapesID(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		assertRequest(t, r, http.MethodGet, "/api/teams/team%2Fwith%20space", "Bearer jwt")
		_, _ = io.WriteString(w, `{"id":"team/with space","name":"STRIDE","owner_user_id":"user-1","is_open":true}`)
	})
	team, err := client.GetTeam(context.Background(), "Bearer jwt", "team/with space")
	if err != nil {
		t.Fatalf("GetTeam() error = %v", err)
	}
	if team.ID != "team/with space" {
		t.Fatalf("team ID = %q", team.ID)
	}
}

func TestMembershipMutations(t *testing.T) {
	t.Run("join returns membership", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			assertRequest(t, r, http.MethodPost, "/api/teams/team-1/join", "Bearer jwt")
			_, _ = io.WriteString(w, `{"team_id":"team-1","user_id":"user-1","role":"member","joined_at":"2026-01-01T00:00:00Z"}`)
		})
		membership, err := client.JoinTeam(context.Background(), "Bearer jwt", "team-1")
		if err != nil {
			t.Fatalf("JoinTeam() error = %v", err)
		}
		if membership.TeamID != "team-1" || membership.UserID != "user-1" || membership.Role != "member" {
			t.Fatalf("membership = %#v", membership)
		}
	})

	t.Run("leave returns status", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			assertRequest(t, r, http.MethodPost, "/api/teams/team-1/leave", "Bearer jwt")
			_, _ = io.WriteString(w, `{"status":"left"}`)
		})
		status, err := client.LeaveTeam(context.Background(), "Bearer jwt", "team-1")
		if err != nil {
			t.Fatalf("LeaveTeam() error = %v", err)
		}
		if status.Status != "left" {
			t.Fatalf("status = %#v", status)
		}
	})

	t.Run("transfer owner returns team", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			assertRequest(t, r, http.MethodPost, "/api/teams/team-1/transfer-owner", "Bearer jwt")
			body := decodeBody[map[string]string](t, r)
			if body["new_owner_user_id"] != "user-2" {
				t.Fatalf("body = %#v", body)
			}
			_, _ = io.WriteString(w, `{"id":"team-1","name":"STRIDE","owner_user_id":"user-2","is_open":true}`)
		})
		team, err := client.TransferTeamOwner(context.Background(), "Bearer jwt", "team-1", "user-2")
		if err != nil {
			t.Fatalf("TransferTeamOwner() error = %v", err)
		}
		if team.ID != "team-1" || team.OwnerUserID != "user-2" {
			t.Fatalf("team = %#v", team)
		}
	})
}

func TestDeleteTeam(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		assertRequest(t, r, http.MethodDelete, "/api/teams/team-1", "Bearer jwt")
		w.WriteHeader(http.StatusNoContent)
	})
	if err := client.DeleteTeam(context.Background(), "Bearer jwt", "team-1"); err != nil {
		t.Fatalf("DeleteTeam() error = %v", err)
	}
}

func TestListMembersAndMyTeams(t *testing.T) {
	t.Run("members", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			assertRequest(t, r, http.MethodGet, "/api/teams/team-1/members", "Bearer jwt")
			_, _ = io.WriteString(w, `{"members":[{"user_id":"user-1","name":"Alice","display_name":"Runner Alice","email":"alice@example.com","role":"owner","joined_at":"2026-01-01T00:00:00Z"}]}`)
		})
		members, err := client.ListMembers(context.Background(), "Bearer jwt", "team-1")
		if err != nil {
			t.Fatalf("ListMembers() error = %v", err)
		}
		if len(members) != 1 || members[0].DisplayName == nil || *members[0].DisplayName != "Runner Alice" || members[0].Role != "owner" {
			t.Fatalf("members = %#v", members)
		}
	})

	t.Run("members preserve nullable profile fields", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, `[{"user_id":"user-1","name":null,"display_name":null,"email":null,"role":"member"}]`)
		})
		members, err := client.ListMembers(context.Background(), "Bearer jwt", "team-1")
		if err != nil {
			t.Fatalf("ListMembers() error = %v", err)
		}
		if len(members) != 1 || members[0].Name != nil || members[0].DisplayName != nil || members[0].Email != nil {
			t.Fatalf("members = %#v", members)
		}
	})

	t.Run("my teams bare array", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
			assertRequest(t, r, http.MethodGet, "/api/users/me/teams", "Bearer jwt")
			_, _ = io.WriteString(w, `[{"id":"team-1","name":"STRIDE","role":"captain","joined_at":"2026-01-01T00:00:00Z"}]`)
		})
		teams, err := client.ListMyTeams(context.Background(), "Bearer jwt")
		if err != nil {
			t.Fatalf("ListMyTeams() error = %v", err)
		}
		if len(teams) != 1 || teams[0].Role != "captain" {
			t.Fatalf("teams = %#v", teams)
		}
	})
}

func TestAuthorizationHeaderForwardingIsExact(t *testing.T) {
	const authorizationHeader = "Bearer abc"
	client := New("https://auth.example", time.Second)
	client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		values := r.Header.Values("Authorization")
		if len(values) != 1 || values[0] != authorizationHeader {
			t.Fatalf("Authorization values = %#v, want [%q]", values, authorizationHeader)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"teams":[]}`)),
			Header:     make(http.Header),
		}, nil
	})
	if _, err := client.ListTeams(context.Background(), authorizationHeader); err != nil {
		t.Fatalf("ListTeams() error = %v", err)
	}
}

func TestEmptyBearerOmitsAuthorization(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if _, ok := r.Header["Authorization"]; ok {
			t.Fatalf("Authorization header should be absent: %#v", r.Header)
		}
		_, _ = io.WriteString(w, `{"teams":[]}`)
	})
	if _, err := client.ListTeams(context.Background(), ""); err != nil {
		t.Fatalf("ListTeams() error = %v", err)
	}
}

func TestTypedErrors(t *testing.T) {
	t.Run("4xx detail string", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"detail":"owner required"}`)
		})
		_, err := client.JoinTeam(context.Background(), "Bearer jwt", "team-1")
		var authErr *AuthServiceError
		if !errors.As(err, &authErr) {
			t.Fatalf("error type = %T, want *AuthServiceError", err)
		}
		if authErr.StatusCode != http.StatusForbidden || authErr.Detail != "owner required" {
			t.Fatalf("error = %#v", authErr)
		}
	})

	t.Run("4xx structured detail", func(t *testing.T) {
		for _, tc := range []struct {
			name     string
			response string
			assert   func(*testing.T, any)
		}{
			{
				name:     "object",
				response: `{"detail":{"field":"name"}}`,
				assert: func(t *testing.T, detail any) {
					t.Helper()
					object, ok := detail.(map[string]any)
					if !ok || object["field"] != "name" {
						t.Fatalf("detail = %#v, want object", detail)
					}
				},
			},
			{
				name:     "array",
				response: `{"detail":[{"field":"name"}]}`,
				assert: func(t *testing.T, detail any) {
					t.Helper()
					array, ok := detail.([]any)
					if !ok || len(array) != 1 {
						t.Fatalf("detail = %#v, want array", detail)
					}
				},
			},
		} {
			t.Run(tc.name, func(t *testing.T) {
				client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusUnprocessableEntity)
					_, _ = io.WriteString(w, tc.response)
				})
				_, err := client.CreateTeam(context.Background(), "Bearer jwt", "", nil)
				var authErr *AuthServiceError
				if !errors.As(err, &authErr) || authErr.StatusCode != http.StatusUnprocessableEntity {
					t.Fatalf("error = %#v", err)
				}
				tc.assert(t, authErr.Detail)
			})
		}
	})

	t.Run("4xx plain text fallback", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, "bad request")
		})
		_, err := client.CreateTeam(context.Background(), "Bearer jwt", "", nil)
		var authErr *AuthServiceError
		if !errors.As(err, &authErr) || authErr.Detail != "bad request" {
			t.Fatalf("error = %#v", err)
		}
	})

	t.Run("5xx unavailable", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, "upstream down")
		})
		_, err := client.ListMembers(context.Background(), "Bearer jwt", "team-1")
		var unavailable *AuthServiceUnavailable
		if !errors.As(err, &unavailable) {
			t.Fatalf("error type = %T, want *AuthServiceUnavailable", err)
		}
		if unavailable.StatusCode != http.StatusBadGateway || unavailable.Detail != "upstream down" {
			t.Fatalf("error = %#v", unavailable)
		}
	})

	t.Run("disabled client unavailable", func(t *testing.T) {
		_, err := New("  ", time.Second).ListTeams(context.Background(), "Bearer jwt")
		var unavailable *AuthServiceUnavailable
		if !errors.As(err, &unavailable) || unavailable.StatusCode != 0 {
			t.Fatalf("error = %#v", err)
		}
	})

	t.Run("transport failure unavailable and unwraps", func(t *testing.T) {
		transportErr := errors.New("dial failed")
		client := New("https://auth.example", time.Second)
		client.http.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, transportErr
		})
		_, err := client.ListTeams(context.Background(), "Bearer jwt")
		var unavailable *AuthServiceUnavailable
		if !errors.As(err, &unavailable) || !errors.Is(err, transportErr) {
			t.Fatalf("error = %#v", err)
		}
	})
}

func TestMalformedSuccessResponseIsUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name     string
		response string
	}{
		{name: "empty body", response: ""},
		{name: "invalid JSON", response: "not-json"},
		{name: "missing list field", response: `{}`},
		{name: "null list", response: `{"teams":null}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, tc.response)
			})
			_, err := client.ListTeams(context.Background(), "Bearer jwt")
			var unavailable *AuthServiceUnavailable
			if !errors.As(err, &unavailable) {
				t.Fatalf("error type = %T, want *AuthServiceUnavailable", err)
			}
			if !strings.Contains(unavailable.Error(), "malformed successful") {
				t.Fatalf("error = %q, want malformed successful response", unavailable.Error())
			}
		})
	}

	for _, response := range []string{"not-json", "null"} {
		t.Run("object response "+response, func(t *testing.T) {
			client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, response)
			})
			_, err := client.GetTeam(context.Background(), "Bearer jwt", "team-1")
			var unavailable *AuthServiceUnavailable
			if !errors.As(err, &unavailable) {
				t.Fatalf("error type = %T, want *AuthServiceUnavailable", err)
			}
		})
	}
}

func TestContextCancellation(t *testing.T) {
	started := make(chan struct{})
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := client.ListTeams(ctx, "Bearer jwt")
		done <- err
	}()
	<-started
	cancel()
	err := <-done
	var unavailable *AuthServiceUnavailable
	if !errors.As(err, &unavailable) || !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %#v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
