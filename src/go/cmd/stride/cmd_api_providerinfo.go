package main

import (
	"sort"
	"time"

	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
)

// providerInfoAdapter satisfies api.ProviderInfo by constructing the concrete
// watch adapter via the registry and reading its static Info() (display name +
// declared capabilities). Keeping it in the command layer keeps the api package
// free of provider/registry imports (ADR 0018), mirroring providerLoginAdapter.
type providerInfoAdapter struct {
	store *storage.Store
	delay time.Duration
}

func (a providerInfoAdapter) Info(providerName string) (string, []string, error) {
	p, err := registry.Build(providerName, a.store, a.delay)
	if err != nil {
		return "", nil, err
	}
	info := p.Info()
	caps := make([]string, 0, len(info.Capabilities))
	for capName, on := range info.Capabilities {
		if on {
			caps = append(caps, string(capName))
		}
	}
	sort.Strings(caps) // deterministic order for stable responses/tests
	return info.DisplayName, caps, nil
}

var _ api.ProviderInfo = providerInfoAdapter{}
