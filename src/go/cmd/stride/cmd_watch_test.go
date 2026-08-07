package main

import (
	"context"
	"testing"
)

type watchBindingStub struct {
	name  string
	found bool
}

func (s watchBindingStub) ProviderForUser(context.Context, string) (string, bool, error) {
	return s.name, s.found, nil
}

func TestResolveWatchProviderNamePrefersStoreBinding(t *testing.T) {
	name, err := resolveWatchProviderName(context.Background(), watchBindingStub{name: "garmin", found: true}, t.TempDir(), "user")
	if err != nil {
		t.Fatalf("resolve provider: %v", err)
	}
	if name != "garmin" {
		t.Fatalf("provider = %q, want garmin", name)
	}
}
