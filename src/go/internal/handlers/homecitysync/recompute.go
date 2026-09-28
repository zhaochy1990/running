// Package homecitysync recomputes every user's resident city
// (internal/homecity) from the activity store and persists the latest result
// plus a change-history row. It is the single step of the internal
// homecity_recompute pipeline started daily by the cron workflow; the same
// RecomputeAll backs `stride homecity --write` for operator-triggered runs.
//
// The recompute is a full scan by design: 12 users × 15k activities resolve in
// well under a second, the upserts are idempotent, and a periodic snapshot
// needs no per-user dirty tracking to stay correct. If the user population
// grows large enough that the scan matters, narrow it to users with activity
// changes since their last computed_at — the storage reads already take a
// user list.
package homecitysync

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/homecity"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// JobType is the internal recompute job; the catalog also exposes it as the
// single-step homecity_recompute pipeline.
const JobType = "homecity_recompute"

// progressEvery bounds heartbeat writes: one per user would cost more reporting
// than recomputing that user.
const progressEvery = 100

// Store is the slice of storage the recompute needs.
type Store interface {
	ListActivityUserIDs(ctx context.Context) ([]string, error)
	ListActivityStartSignals(ctx context.Context, userID string) ([]storage.ActivityStartSignal, error)
	PutUserHomeCity(ctx context.Context, userID string, res homecity.Result, computedAt time.Time) (storage.HomeCityChangeReason, error)
}

// Summary is the recompute's result JSON (and the CLI's write-mode report).
type Summary struct {
	Users       int `json:"users"`
	Persisted   int `json:"persisted"`
	CityChanges int `json:"city_changes"`
	Unknown     int `json:"unknown"` // users with insufficient evidence
	Skipped     int `json:"skipped"` // users whose signals failed to load
}

// New returns the job handler for the homecity_recompute step.
func New(store Store) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		summary, err := RecomputeAll(ctx, store, hb)
		if err != nil {
			return "", err
		}
		encoded, err := json.Marshal(summary)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	}
}

// RecomputeAll detects and persists the resident city for every user with
// activities. Per-user failures skip and count rather than fail the run: one
// unreadable user must not stop the other users' snapshots from refreshing.
func RecomputeAll(ctx context.Context, store Store, hb job.Heartbeat) (Summary, error) {
	summary := Summary{}
	userIDs, err := store.ListActivityUserIDs(ctx)
	if err != nil {
		return summary, fmt.Errorf("homecitysync: list users: %w", err)
	}
	summary.Users = len(userIDs)

	now := time.Now().UTC()
	for i, uid := range userIDs {
		if ctx.Err() != nil {
			return summary, ctx.Err()
		}
		signals, err := store.ListActivityStartSignals(ctx, uid)
		if err != nil {
			summary.Skipped++
			continue
		}
		detectorInput := make([]homecity.ActivitySignal, len(signals))
		for k, s := range signals {
			detectorInput[k] = homecity.ActivitySignal{Name: s.Name, StartGPSLat: s.StartGPSLat, StartGPSLon: s.StartGPSLon, Time: s.Date}
		}
		res := homecity.Detect(detectorInput, homecity.DefaultOptions(now))
		reason, err := store.PutUserHomeCity(ctx, uid, res, now)
		if err != nil {
			summary.Skipped++
			continue
		}
		summary.Persisted++
		if reason != "" {
			summary.CityChanges++
		}
		if res.City == "" {
			summary.Unknown++
		}
		if hb != nil && (i+1)%progressEvery == 0 {
			if err := hb("recompute", 100*(i+1)/len(userIDs)); err != nil {
				return summary, err
			}
		}
	}
	return summary, nil
}
