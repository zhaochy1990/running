package main

import (
	"context"
	"time"

	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
)

// workoutPushAdapter satisfies api.WorkoutPusher by resolving the user's bound
// watch provider via the registry (MySQL credential binding first, file-based
// config.json fallback — ADR 0010/0011) and delegating to the concrete adapter.
// Keeping it in the command layer keeps the api package free of provider/registry
// imports (ADR 0013/0018), mirroring providerLoginAdapter / providerInfoAdapter.
type workoutPushAdapter struct {
	store   *storage.Store
	delay   time.Duration
	dataDir string
}

func (a workoutPushAdapter) build(ctx context.Context, user string) (provider.Provider, provider.ProviderInfo, error) {
	name, err := registry.Resolve(ctx, a.store, a.dataDir, user)
	if err != nil {
		return nil, provider.ProviderInfo{}, err
	}
	p, err := registry.Build(name, a.store, a.delay)
	if err != nil {
		return nil, provider.ProviderInfo{}, err
	}
	return p, p.Info(), nil
}

func (a workoutPushAdapter) Info(ctx context.Context, user string) (provider.ProviderInfo, error) {
	_, info, err := a.build(ctx, user)
	return info, err
}

func (a workoutPushAdapter) PushRunWorkout(ctx context.Context, user string, w provider.RunWorkout) (string, error) {
	p, _, err := a.build(ctx, user)
	if err != nil {
		return "", err
	}
	return p.PushRunWorkout(ctx, user, w)
}

func (a workoutPushAdapter) PushStrengthWorkout(ctx context.Context, user string, w provider.StrengthWorkout) (string, error) {
	p, _, err := a.build(ctx, user)
	if err != nil {
		return "", err
	}
	return p.PushStrengthWorkout(ctx, user, w)
}

func (a workoutPushAdapter) DeleteScheduledWorkout(ctx context.Context, user, date, name string) (bool, error) {
	p, _, err := a.build(ctx, user)
	if err != nil {
		return false, err
	}
	return p.DeleteScheduledWorkout(ctx, user, date, name)
}

var _ api.WorkoutPusher = workoutPushAdapter{}
