package main

import "testing"

// TestAppVersion locks the contract the startup log depends on: the CalVer tag
// the Dockerfile injects, or "dev" when there is no image (a local `go run`).
// A regression here would make every container log `version=dev`, which is
// exactly the case the field exists to distinguish.
func TestAppVersion(t *testing.T) {
	t.Setenv("APP_VERSION", "2026.9.313")
	if got := appVersion(); got != "2026.9.313" {
		t.Fatalf("APP_VERSION set: got %q, want %q", got, "2026.9.313")
	}

	t.Setenv("APP_VERSION", "")
	if got := appVersion(); got != "dev" {
		t.Fatalf("APP_VERSION empty: got %q, want %q", got, "dev")
	}
}
