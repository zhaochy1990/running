package health

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthz_AllOK(t *testing.T) {
	s := New(":0", map[string]Check{
		"db":     func(context.Context) error { return nil },
		"broker": func(context.Context) error { return nil },
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Status != "ok" {
		t.Fatalf("status = %q", body.Status)
	}
	if body.Checks["db"] != "ok" || body.Checks["broker"] != "ok" {
		t.Fatalf("checks = %+v", body.Checks)
	}
}

func TestHealthz_OneFailing(t *testing.T) {
	s := New(":0", map[string]Check{
		"db":     func(context.Context) error { return nil },
		"broker": func(context.Context) error { return errors.New("connection closed") },
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	s.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	var body struct {
		Status string            `json:"status"`
		Checks map[string]string `json:"checks"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Status != "unhealthy" {
		t.Fatalf("status = %q, want unhealthy", body.Status)
	}
	if body.Checks["broker"] != "connection closed" {
		t.Fatalf("broker check = %q", body.Checks["broker"])
	}
}
