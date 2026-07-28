package provider

import (
	"context"
	"errors"
	"testing"
)

// stubProvider is a minimal concrete adapter: it embeds BaseProvider (inheriting
// the optional methods) and implements only the required ones. Its existence
// proves the compile-time contract, and the var _ below asserts it.
type stubProvider struct {
	BaseProvider
	caps Capabilities
}

func newStub(caps Capabilities) *stubProvider {
	return &stubProvider{BaseProvider: BaseProvider{Name: "stub"}, caps: caps}
}

func (s *stubProvider) Info() ProviderInfo {
	return ProviderInfo{Name: "stub", DisplayName: "Stub", Regions: []string{"global"}, Capabilities: s.caps}
}
func (s *stubProvider) IsLoggedIn(string) (bool, error) { return true, nil }
func (s *stubProvider) Login(context.Context, string, LoginCredentials) (LoginResult, error) {
	return LoginResult{Success: true}, nil
}
func (s *stubProvider) SyncUser(context.Context, string, SyncOptions) (SyncResult, error) {
	return SyncResult{}, nil
}
func (s *stubProvider) ResyncActivity(context.Context, string, string) (bool, error) {
	return true, nil
}

var _ Provider = (*stubProvider)(nil)

func TestSyncContentHas(t *testing.T) {
	tests := []struct {
		name    string
		content SyncContent
		domain  SyncContent
		want    bool
	}{
		{"all has activities", ContentAll, ContentActivities, true},
		{"all has health", ContentAll, ContentHealth, true},
		{"activities only lacks health", ContentActivities, ContentHealth, false},
		{"health only lacks activities", ContentHealth, ContentActivities, false},
		{"zero has nothing", 0, ContentActivities, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.content.Has(tt.domain); got != tt.want {
				t.Errorf("(%b).Has(%b) = %v, want %v", tt.content, tt.domain, got, tt.want)
			}
		})
	}
}

func TestCapabilitiesHas(t *testing.T) {
	caps := Capabilities{CapSyncHRVDetail: true}
	if !caps.Has(CapSyncHRVDetail) {
		t.Error("expected CapSyncHRVDetail to be present")
	}
	if caps.Has(CapPushRunWorkout) {
		t.Error("did not expect CapPushRunWorkout")
	}
	if (Capabilities(nil)).Has(CapSyncHRVDetail) {
		t.Error("nil Capabilities should report false")
	}
}

func TestBaseProviderOptionalMethodsReturnFeatureNotSupported(t *testing.T) {
	p := newStub(nil)
	ctx := context.Background()

	assertUnsupported := func(t *testing.T, err error, want Capability) {
		t.Helper()
		var fns *FeatureNotSupported
		if !errors.As(err, &fns) {
			t.Fatalf("expected *FeatureNotSupported, got %v", err)
		}
		if fns.Provider != "stub" {
			t.Errorf("provider = %q, want %q", fns.Provider, "stub")
		}
		if fns.Capability != want {
			t.Errorf("capability = %q, want %q", fns.Capability, want)
		}
	}

	_, err := p.PushRunWorkout(ctx, "u", RunWorkout{})
	assertUnsupported(t, err, CapPushRunWorkout)

	_, err = p.PushStrengthWorkout(ctx, "u", StrengthWorkout{})
	assertUnsupported(t, err, CapPushStrengthWorkout)

	_, err = p.DeleteScheduledWorkout(ctx, "u", "2026-01-01", "")
	assertUnsupported(t, err, CapDeleteWorkout)

	_, err = p.QuerySchedule(ctx, "u", "2026-01-01", "2026-01-07")
	assertUnsupported(t, err, CapQuerySchedule)

	_, err = p.QueryExercises(ctx, "u", "run")
	assertUnsupported(t, err, CapExerciseCatalog)

	_, err = p.AddCustomExercise(ctx, "u", map[string]any{})
	assertUnsupported(t, err, CapCustomExercise)
}

func TestBaseProviderLogoutIsNoOp(t *testing.T) {
	p := newStub(nil)
	if err := p.Logout(context.Background(), "u"); err != nil {
		t.Errorf("Logout = %v, want nil", err)
	}
}

func TestRequireCapability(t *testing.T) {
	withHRV := newStub(Capabilities{CapSyncHRVDetail: true})
	if err := RequireCapability(withHRV, CapSyncHRVDetail); err != nil {
		t.Errorf("declared capability should pass, got %v", err)
	}

	err := RequireCapability(withHRV, CapPushRunWorkout)
	var fns *FeatureNotSupported
	if !errors.As(err, &fns) {
		t.Fatalf("expected *FeatureNotSupported, got %v", err)
	}
	if fns.Provider != "stub" || fns.Capability != CapPushRunWorkout {
		t.Errorf("got {%q,%q}, want {stub,push_run_workout}", fns.Provider, fns.Capability)
	}
}

func TestFeatureNotSupportedError(t *testing.T) {
	err := &FeatureNotSupported{Provider: "coros", Capability: CapPushStrengthWorkout}
	want := `"coros" does not support "push_strength_workout"`
	if got := err.Error(); got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}
