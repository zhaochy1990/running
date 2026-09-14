package coachsvc

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDeleteCoachData_ForwardsBearerAndDecodesCounts(t *testing.T) {
	var gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deleted":{"checkpoints":4,"store":2}}`))
	}))
	defer server.Close()

	counts, err := New(server.URL, time.Second).DeleteCoachData(context.Background(), "bearer", "11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("DeleteCoachData: %v", err)
	}
	if gotPath != "/api/admin/users/11111111-1111-4111-8111-111111111111/coach-data" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer bearer" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if counts["checkpoints"] != 4 || counts["store"] != 2 {
		t.Fatalf("counts = %v", counts)
	}
}

func TestDeleteCoachData_Unavailable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	_, err := New(server.URL, time.Second).DeleteCoachData(context.Background(), "b", "u")
	var unavailable *Unavailable
	if !errors.As(err, &unavailable) || unavailable.HTTPStatus() < 500 {
		t.Fatalf("5xx err = %v, want Unavailable >=500", err)
	}
}

func TestDeleteCoachData_Rejected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"forbidden"}`))
	}))
	defer server.Close()

	_, err := New(server.URL, time.Second).DeleteCoachData(context.Background(), "b", "u")
	var responseErr *ResponseError
	if !errors.As(err, &responseErr) || responseErr.HTTPStatus() != http.StatusForbidden {
		t.Fatalf("4xx err = %v, want ResponseError 403", err)
	}
}

func TestDeleteCoachData_RequiresBaseURL(t *testing.T) {
	if _, err := New("", time.Second).DeleteCoachData(context.Background(), "b", "u"); err == nil {
		t.Fatal("empty base URL must fail")
	}
}
