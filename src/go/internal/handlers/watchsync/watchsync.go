// Package watchsync provides the worker job handler for job type "watch_sync":
// it runs a user's watch-data sync (COROS or Garmin) inside the async-job worker.
//
// The handler resolves the provider PER USER via an injected Resolver, so a
// COROS user and a Garmin user both go through the same job type. It depends only
// on a minimal provider interface, so it is unit-tested with a fake and stays
// provider-agnostic — cmd/worker injects the registry-backed resolver.
// Design: docs/adr/0011-watch-sync-worker-handler.md.
package watchsync

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// JobType is the registered job_type for the watch sync handler.
const JobType = "watch_sync"

// Provider is the slice of a watch provider the handler needs. Both
// *coros.Provider and *garmin.Provider (via provider.Provider) satisfy it.
type Provider interface {
	IsLoggedIn(user string) (bool, error)
	SyncUser(ctx context.Context, user string, opts provider.SyncOptions) (provider.SyncResult, error)
}

// Resolver returns the provider a user is bound to (COROS or Garmin). cmd/worker
// backs it with the registry (MySQL binding first, file-based fallback).
type Resolver func(ctx context.Context, user string) (Provider, error)

// SyncMarker records post-sync bookkeeping. *storage.Store satisfies it via
// SetMeta; it is an interface so the handler stays unit-testable with a fake.
type SyncMarker interface {
	SetMeta(ctx context.Context, userID, key, value string) error
}

// New returns the watch_sync job.Handler backed by resolve. On a successful sync
// it stamps the user's last-sync time through marker (ADR 0018). jobs is the
// detail-fetch concurrency threaded into every run's SyncOptions (the adapter
// clamps it); it is an infra knob, deliberately not part of the job payload so
// external callers cannot dictate server-side concurrency.
func New(resolve Resolver, marker SyncMarker, jobs int) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.UserID

		opts, err := provider.ParseSyncOptions(j.InputJSON)
		if err != nil {
			// A malformed payload can't be fixed by retrying.
			return "", job.NewPermanentError("bad_payload", err)
		}
		opts.Jobs = jobs

		// Resolve which watch provider this user is bound to.
		prov, err := resolve(ctx, user)
		if err != nil {
			return "", err // binding lookup fault -> retryable
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
			if provider.IsInvalidRequest(err) {
				return "", job.NewPermanentError("provider_invalid_request", err)
			}
			// A deterministic write failure (e.g. a unique-index violation) recurs
			// identically on every attempt, so fail fast instead of burning the
			// whole retry budget before poisoning. (Scoped to watch_sync — the
			// costly re-page + re-fetch path; other write handlers still retry.)
			if storage.IsDeterministicWriteError(err) {
				return "", job.NewPermanentError("storage_constraint", err)
			}
			return "", err
		}

		// Stamp the last successful sync time for the watch status card
		// (GET /watch, ADR 0018). Best-effort: the synced data is already
		// persisted, so a failed meta write must never fail an otherwise-
		// successful sync.
		if marker != nil {
			_ = marker.SetMeta(ctx, user, storage.MetaKeyLastSyncTime, time.Now().UTC().Format(time.RFC3339))
		}

		out, _ := json.Marshal(struct {
			Activities int      `json:"activities"`
			Health     int      `json:"health"`
			Mode       string   `json:"mode"`
			LabelIDs   []string `json:"label_ids,omitempty"`
		}{res.Activities, res.Health, string(opts.Mode), res.ActivityLabelIDs})
		return string(out), nil
	}
}
