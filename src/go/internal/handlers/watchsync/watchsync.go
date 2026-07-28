// Package watchsync provides the worker job handler for job type "watch_sync":
// it runs a user's watch-data sync (COROS today) inside the async-job worker.
//
// The handler depends only on a minimal provider interface, so it is unit-tested
// with a fake and stays provider-agnostic — cmd/worker injects the concrete
// coros.Provider. Design: docs/adr/0011-watch-sync-worker-handler.md.
package watchsync

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/provider"
)

// JobType is the registered job_type for the watch sync handler.
const JobType = "watch_sync"

// Provider is the slice of a watch provider the handler needs. *coros.Provider
// satisfies it.
type Provider interface {
	IsLoggedIn(user string) (bool, error)
	SyncUser(ctx context.Context, user string, opts provider.SyncOptions) (provider.SyncResult, error)
}

// New returns the watch_sync job.Handler bound to prov.
func New(prov Provider) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.PartitionKey

		opts, err := parsePayload(j.InputJSON)
		if err != nil {
			// A malformed payload can't be fixed by retrying.
			return "", job.NewPermanentError("bad_payload", err)
		}

		// Up-front login check: a missing credential is terminal (retrying can't
		// link the user's watch).
		loggedIn, err := prov.IsLoggedIn(user)
		if err != nil {
			return "", err // credential-store fault -> retryable
		}
		if !loggedIn {
			return "", job.NewPermanentError("not_logged_in",
				fmt.Errorf("user %s has no watch credentials", user))
		}

		// Bridge sync progress onto the job row (best-effort; a progress write
		// must never abort the sync).
		opts.Progress = func(pr provider.SyncProgress) {
			stage, _ := pr["phase"].(string)
			pct, _ := pr["percent"].(int)
			_ = hb(stage, pct)
		}

		res, err := prov.SyncUser(ctx, user, opts)
		if err != nil {
			// Auth failures are terminal; everything else (network, 5xx) retries,
			// resuming from the sync cursor.
			if provider.IsAuthError(err) {
				return "", job.NewPermanentError("auth_failed", err)
			}
			return "", err
		}

		out, _ := json.Marshal(struct {
			Activities int    `json:"activities"`
			Health     int    `json:"health"`
			Mode       string `json:"mode"`
		}{res.Activities, res.Health, string(opts.Mode)})
		return string(out), nil
	}
}

// payload is the optional InputJSON schema.
type payload struct {
	Mode    string `json:"mode"`
	Content string `json:"content"`
	Limit   int    `json:"limit"`
}

// parsePayload maps InputJSON onto SyncOptions. Absent/empty payload defaults to
// full + all + unlimited (ADR 0011).
func parsePayload(input string) (provider.SyncOptions, error) {
	opts := provider.SyncOptions{Mode: provider.SyncFull, Content: provider.ContentAll}
	if strings.TrimSpace(input) == "" {
		return opts, nil
	}
	var p payload
	if err := json.Unmarshal([]byte(input), &p); err != nil {
		return provider.SyncOptions{}, fmt.Errorf("watch_sync: parse payload: %w", err)
	}
	switch p.Mode {
	case "", "full":
		opts.Mode = provider.SyncFull
	case "incremental":
		opts.Mode = provider.SyncIncremental
	default:
		return provider.SyncOptions{}, fmt.Errorf("watch_sync: invalid mode %q", p.Mode)
	}
	switch p.Content {
	case "", "all":
		opts.Content = provider.ContentAll
	case "activities":
		opts.Content = provider.ContentActivities
	case "health":
		opts.Content = provider.ContentHealth
	default:
		return provider.SyncOptions{}, fmt.Errorf("watch_sync: invalid content %q", p.Content)
	}
	if p.Limit < 0 {
		return provider.SyncOptions{}, fmt.Errorf("watch_sync: limit must be >= 0, got %d", p.Limit)
	}
	opts.Limit = p.Limit
	return opts, nil
}
