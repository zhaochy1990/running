// Package registry is the wiring layer that resolves which watch data source
// (provider) a user is bound to and constructs the concrete adapter. It sits
// ABOVE the provider contract and the concrete adapters, so it may import both
// coros and garmin without an import cycle (adapters never import registry).
//
// Provider binding source of truth (ADR 0010): the per-user binding is read from
// the local data/<uid>/config.json `provider` field for now, and will migrate to
// provider_credentials.provider (MySQL) later. Legacy users with no binding
// default to coros. login writes the binding via WriteProviderName so a
// subsequent flag-less sync resolves the same source.
package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/provider/coros"
	"github.com/zhaochy1990/stride/internal/provider/garmin"
	"github.com/zhaochy1990/stride/internal/storage"
)

// DefaultProvider is the binding for users with no explicit setting — matches the
// Python registry and the `provider DEFAULT 'coros'` SQL default (all
// pre-multi-provider data is COROS).
const DefaultProvider = "coros"

// Supported reports whether name is a known provider the binary can construct.
func Supported(name string) bool {
	return name == "coros" || name == "garmin"
}

// ProviderName returns the provider a user is bound to, read from
// data/<uid>/config.json. A missing file or absent `provider` field resolves to
// DefaultProvider; a malformed file is an error (fail loud rather than silently
// syncing the wrong source).
func ProviderName(dataDir, user string) (string, error) {
	raw, err := os.ReadFile(configPath(dataDir, user))
	if os.IsNotExist(err) {
		return DefaultProvider, nil
	}
	if err != nil {
		return "", fmt.Errorf("registry: read config for %s: %w", user, err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("registry: parse config for %s: %w", user, err)
	}
	if p, ok := cfg["provider"].(string); ok && p != "" {
		if !Supported(p) {
			return "", fmt.Errorf("registry: unknown provider %q bound to user %s", p, user)
		}
		return p, nil
	}
	return DefaultProvider, nil
}

// WriteProviderName persists the user's provider binding into config.json,
// preserving any existing fields (Python coros users keep email/pwd_hash/etc. in
// the same file). Creates the file/dir if absent.
func WriteProviderName(dataDir, user, providerName string) error {
	if !Supported(providerName) {
		return fmt.Errorf("registry: refusing to bind unknown provider %q", providerName)
	}
	path := configPath(dataDir, user)
	cfg := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return fmt.Errorf("registry: parse config for %s: %w", user, err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("registry: read config for %s: %w", user, err)
	}
	cfg["provider"] = providerName
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o644)
}

// Build constructs the concrete provider adapter for providerName, wired to the
// store for both watch-data writes and the provider_credentials credential store.
func Build(providerName string, store *storage.Store, delay time.Duration) (provider.Provider, error) {
	switch providerName {
	case "coros":
		return coros.New(store, coros.NewStorageCredentialStore(store),
			coros.WithProviderRequestDelay(delay)), nil
	case "garmin":
		return garmin.New(store, garmin.NewStorageCredentialStore(store),
			garmin.WithProviderRequestDelay(delay)), nil
	default:
		return nil, fmt.Errorf("registry: unknown provider %q", providerName)
	}
}

func configPath(dataDir, user string) string {
	return filepath.Join(dataDir, user, "config.json")
}
