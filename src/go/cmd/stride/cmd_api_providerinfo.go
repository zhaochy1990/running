package main

import (
	"time"

	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
)

// providerInfoAdapter satisfies api.ProviderInfo by constructing the concrete
// watch adapter via the registry and reading its static Info() (display name),
// then returning the curated user-facing capability list for the Watch card.
// Keeping it in the command layer keeps the api package free of provider/registry
// imports (ADR 0018), mirroring providerLoginAdapter.
type providerInfoAdapter struct {
	store *storage.Store
	delay time.Duration
}

// watchCapabilityLabels is the curated, user-facing "supported features" list
// shown on the Watch settings card, per provider. Chinese by product decision,
// in a fixed logical order (sync first, then push). This is DISPLAY metadata —
// deliberately decoupled from the granular provider.Capability enum (which is for
// backend feature-gating). COROS supports run + strength push; Garmin supports
// run push only (strength push is not implemented for Garmin).
var watchCapabilityLabels = map[string][]string{
	"coros":  {"同步运动数据", "同步健康数据", "推送跑步课表", "推送力量训练"},
	"garmin": {"同步运动数据", "同步健康数据", "推送跑步课表"},
}

func (a providerInfoAdapter) Info(providerName string) (string, []string, error) {
	p, err := registry.Build(providerName, a.store, a.delay)
	if err != nil {
		return "", nil, err
	}
	info := p.Info()
	caps := watchCapabilityLabels[info.Name]
	if caps == nil {
		caps = []string{}
	}
	return info.DisplayName, caps, nil
}

var _ api.ProviderInfo = providerInfoAdapter{}
