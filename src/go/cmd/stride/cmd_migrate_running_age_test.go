package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

type migrationStoreStub struct {
	profiles map[string]*storage.UserProfile
	writes   []string
	fail     error
}

func (s *migrationStoreStub) GetUserProfile(_ context.Context, userID string) (*storage.UserProfile, error) {
	profile := s.profiles[userID]
	if profile == nil {
		return nil, nil
	}
	copy := *profile
	return &copy, nil
}

func (s *migrationStoreStub) MigrateRunningAgeIfUnknown(_ context.Context, userID, runningAge string) (bool, error) {
	if s.fail != nil {
		return false, s.fail
	}
	profile := s.profiles[userID]
	if profile == nil || profile.RunningAgeRange != storage.RunningAgeUnknown {
		return false, nil
	}
	profile.RunningAgeRange = runningAge
	s.writes = append(s.writes, userID)
	return true, nil
}

func writeLegacyProfile(t *testing.T, dataDir, directory, runningAge string) {
	t.Helper()
	path := filepath.Join(dataDir, directory, "running_profile.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"current":{"running_age":"` + runningAge + `"}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func decodeMigrationReport(t *testing.T, output *bytes.Buffer) runningAgeMigrationReport {
	t.Helper()
	var report runningAgeMigrationReport
	if err := json.Unmarshal(output.Bytes(), &report); err != nil {
		t.Fatalf("migration output = %q: %v", output.String(), err)
	}
	return report
}

func TestRunRunningAgeMigrationAcceptsUUIDAndSlugDirectories(t *testing.T) {
	dataDir := t.TempDir()
	uuidDir := "11111111-1111-4111-8111-111111111111"
	slugUID := "22222222-2222-4222-8222-222222222222"
	writeLegacyProfile(t, dataDir, uuidDir, "lt6m")
	writeLegacyProfile(t, dataDir, "runner", "1y_3y")
	if err := os.WriteFile(filepath.Join(dataDir, ".slug_aliases.json"), []byte(`{"runner":"`+slugUID+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &migrationStoreStub{profiles: map[string]*storage.UserProfile{
		uuidDir: {UserID: uuidDir, RunningAgeRange: storage.RunningAgeUnknown},
		slugUID: {UserID: slugUID, RunningAgeRange: storage.RunningAgeUnknown},
	}}
	var output bytes.Buffer
	if err := runRunningAgeMigration(context.Background(), dataDir, false, store, &output); err != nil {
		t.Fatalf("run migration: %v", err)
	}
	if got := decodeMigrationReport(t, &output); got.Migrated != 2 || got.Skipped != 0 || got.Missing != 0 || got.Failed != 0 {
		t.Fatalf("report = %+v, want two migrated and no other results", got)
	}
	if len(store.writes) != 2 || store.profiles[uuidDir].RunningAgeRange != storage.RunningAgeLT6M || store.profiles[slugUID].RunningAgeRange != storage.RunningAge1Y3Y {
		t.Fatalf("writes = %v, profiles = %+v", store.writes, store.profiles)
	}
}

func TestRunRunningAgeMigrationReportsCountsAndMalformedSource(t *testing.T) {
	dataDir := t.TempDir()
	migrated := "11111111-1111-4111-8111-111111111111"
	skipped := "22222222-2222-4222-8222-222222222222"
	missing := "33333333-3333-4333-8333-333333333333"
	malformed := "44444444-4444-4444-8444-444444444444"
	writeLegacyProfile(t, dataDir, migrated, "6m_1y")
	writeLegacyProfile(t, dataDir, skipped, "3y_plus")
	if err := os.Mkdir(filepath.Join(dataDir, missing), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataDir, malformed), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, malformed, "running_profile.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := &migrationStoreStub{profiles: map[string]*storage.UserProfile{
		migrated: {UserID: migrated, RunningAgeRange: storage.RunningAgeUnknown},
		skipped:  {UserID: skipped, RunningAgeRange: storage.RunningAge1Y3Y},
	}}
	var output bytes.Buffer
	if err := runRunningAgeMigration(context.Background(), dataDir, false, store, &output); err != nil {
		t.Fatalf("run migration: %v", err)
	}
	got := decodeMigrationReport(t, &output)
	want := runningAgeMigrationReport{Migrated: 1, Skipped: 1, Missing: 1, Failed: 1}
	if got != want {
		t.Fatalf("report = %+v, want %+v", got, want)
	}
	if !strings.HasSuffix(output.String(), "\n") || strings.Count(output.String(), "\n") != 1 {
		t.Fatalf("output has unexpected framing: %q", output.String())
	}
	for _, secret := range []string{migrated, "6m_1y"} {
		if strings.Contains(output.String(), secret) {
			t.Fatalf("count-only output contains source content %q: %q", secret, output.String())
		}
	}
}

func TestRunRunningAgeMigrationDryRunDoesNotMutate(t *testing.T) {
	dataDir := t.TempDir()
	uid := "11111111-1111-4111-8111-111111111111"
	writeLegacyProfile(t, dataDir, uid, "6m_1y")
	store := &migrationStoreStub{profiles: map[string]*storage.UserProfile{
		uid: {UserID: uid, RunningAgeRange: storage.RunningAgeUnknown},
	}}
	var output bytes.Buffer
	if err := runRunningAgeMigration(context.Background(), dataDir, true, store, &output); err != nil {
		t.Fatalf("dry-run migration: %v", err)
	}
	if got := decodeMigrationReport(t, &output); got.Migrated != 1 {
		t.Fatalf("dry-run report = %+v, want one candidate", got)
	}
	if len(store.writes) != 0 || store.profiles[uid].RunningAgeRange != storage.RunningAgeUnknown {
		t.Fatalf("dry-run mutated store: writes=%v profile=%+v", store.writes, store.profiles[uid])
	}
}

func TestRunRunningAgeMigrationIsRepeatable(t *testing.T) {
	dataDir := t.TempDir()
	uid := "11111111-1111-4111-8111-111111111111"
	writeLegacyProfile(t, dataDir, uid, "6m_1y")
	store := &migrationStoreStub{profiles: map[string]*storage.UserProfile{
		uid: {UserID: uid, RunningAgeRange: storage.RunningAgeUnknown},
	}}
	for i, want := range []runningAgeMigrationReport{{Migrated: 1}, {Skipped: 1}} {
		var output bytes.Buffer
		if err := runRunningAgeMigration(context.Background(), dataDir, false, store, &output); err != nil {
			t.Fatalf("run %d: %v", i+1, err)
		}
		if got := decodeMigrationReport(t, &output); got != want {
			t.Fatalf("run %d report = %+v, want %+v", i+1, got, want)
		}
	}
	if len(store.writes) != 1 || store.profiles[uid].RunningAgeRange != storage.RunningAge6M1Y {
		t.Fatalf("repeat migration writes=%v profile=%+v", store.writes, store.profiles[uid])
	}
}

func TestRunRunningAgeMigrationPreservesUnknownWhenWriteFails(t *testing.T) {
	dataDir := t.TempDir()
	uid := "11111111-1111-4111-8111-111111111111"
	writeLegacyProfile(t, dataDir, uid, "6m_1y")
	store := &migrationStoreStub{
		profiles: map[string]*storage.UserProfile{uid: {UserID: uid, RunningAgeRange: storage.RunningAgeUnknown}},
		fail:     errors.New("write failed"),
	}
	var output bytes.Buffer
	if err := runRunningAgeMigration(context.Background(), dataDir, false, store, &output); err != nil {
		t.Fatalf("migration: %v", err)
	}
	if got := decodeMigrationReport(t, &output); got != (runningAgeMigrationReport{Failed: 1}) {
		t.Fatalf("report = %+v, want one failure", got)
	}
	if store.profiles[uid].RunningAgeRange != storage.RunningAgeUnknown {
		t.Fatalf("failed migration changed unknown value: %+v", store.profiles[uid])
	}
}
