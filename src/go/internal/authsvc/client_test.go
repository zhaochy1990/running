package authsvc

import (
	"context"
	"net/http"
	"net/http/httptest"
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
