package main

import (
	"context"
	"time"

	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
)

// watchRequestDelay is the COROS/Garmin per-request rate-limit pause (matches the
// provider default and the worker's constant).
const watchRequestDelay = 500 * time.Millisecond

// providerLoginAdapter satisfies api.ProviderLogin by constructing the concrete
// watch adapter via the registry and calling Login. Keeping it in cmd/api keeps
// the api package free of provider/registry imports (ADR 0013).
type providerLoginAdapter struct {
	store *storage.Store
	delay time.Duration
}

func (a providerLoginAdapter) Login(
	ctx context.Context, providerName, userID, email, password, region string,
) (api.WatchLoginResult, error) {
	p, err := registry.Build(providerName, a.store, a.delay)
	if err != nil {
		return api.WatchLoginResult{}, err
	}
	res, err := p.Login(ctx, userID, provider.LoginCredentials{
		Email:    email,
		Password: password,
		Region:   region,
	})
	if err != nil {
		return api.WatchLoginResult{}, err
	}
	return api.WatchLoginResult{
		Success: res.Success,
		UserID:  res.UserID,
		Region:  res.Region,
		Message: res.Message,
	}, nil
}

// toUserSet turns a config allow-list into an O(1) membership set.
func toUserSet(ids []string) map[string]bool {
	m := make(map[string]bool, len(ids))
	for _, id := range ids {
		if id != "" {
			m[id] = true
		}
	}
	return m
}
