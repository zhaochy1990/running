package registry

import (
	"context"
	"errors"
	"testing"
)

type fakeBinding struct {
	name  string
	found bool
	err   error
}

func (f fakeBinding) ProviderForUser(context.Context, string) (string, bool, error) {
	return f.name, f.found, f.err
}

func TestResolve_MySQLBindingWins(t *testing.T) {
	dir := t.TempDir()
	// File says coros, but MySQL has a garmin credential -> MySQL wins.
	writeConfig(t, dir, `{"provider":"coros"}`)
	name, err := Resolve(context.Background(), fakeBinding{name: "garmin", found: true}, dir, testUID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if name != "garmin" {
		t.Errorf("name = %q, want garmin (MySQL binding)", name)
	}
}

func TestResolve_FallsBackToFileWhenNoMySQL(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"provider":"garmin"}`)
	name, err := Resolve(context.Background(), fakeBinding{found: false}, dir, testUID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if name != "garmin" {
		t.Errorf("name = %q, want garmin (file fallback)", name)
	}
}

func TestResolve_DefaultWhenNeitherBinding(t *testing.T) {
	dir := t.TempDir() // no config file
	name, err := Resolve(context.Background(), fakeBinding{found: false}, dir, testUID)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if name != DefaultProvider {
		t.Errorf("name = %q, want %q (default)", name, DefaultProvider)
	}
}

func TestResolve_MySQLErrorPropagates(t *testing.T) {
	_, err := Resolve(context.Background(), fakeBinding{err: errors.New("db down")}, t.TempDir(), testUID)
	if err == nil {
		t.Fatal("want error when MySQL read fails")
	}
}
