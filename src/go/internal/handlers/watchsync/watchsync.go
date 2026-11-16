// Package watchsync provides the worker job handler for job type "watch_sync":
// it runs a user's watch-data sync (COROS or Garmin) inside the async-job worker.
//
// The handler resolves the provider PER USER via an injected Resolver, so a
// COROS user and a Garmin user both go through the same job type. It depends only
// on a minimal provider interface, so it is unit-tested with a fake and stays
// provider-agnostic — cmd/worker injects the registry-backed resolver.
//
// Activity write isolation (devops#1005): when a SessionManager is wired (the
// worker's write-isolation flag), the handler begins a per-user session —
// binding revision + execution lease — and threads it into the sync context;
// every activity publish then goes through the fenced immutable path in
// storage. A nil SessionManager keeps the legacy unfenced behaviour (the
// default until the rollout drains the old fixed-key writers).
// Design: docs/adr/0011-watch-sync-worker-handler.md.
package watchsync

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// JobType is the registered job_type for the watch sync handler.
const JobType = "watch_sync"

// Provider is the slice of a watch provider the handler needs. Both
// *coros.Provider and *garmin.Provider (via provider.Provider) satisfy it.
// Info names the provider — the binding identity the isolation session
// records (devops#1005).
type Provider interface {
	Info() provider.ProviderInfo
	IsLoggedIn(user string) (bool, error)
	SyncUser(ctx context.Context, user string, opts provider.SyncOptions) (provider.SyncResult, error)
}

// Resolver returns the provider a user is bound to (COROS or Garmin). cmd/worker
// backs it with the registry (MySQL binding first, file-based fallback).
type Resolver func(ctx context.Context, user string) (Provider, error)

// SessionManager is the write-isolation seam (devops#1005), satisfied by
// *storage.Store. Begin starts the per-user session (ensuring the binding
// row, acquiring the execution lease) whose value rides in the sync context;
// the handler renews on a TTL/3 cadence while the sync runs and releases
// when it ends.
type SessionManager interface {
	BeginWatchSyncSession(ctx context.Context, userID, providerName, holder string, ttl time.Duration) (*storage.PublishSession, error)
	RenewWatchExecLease(ctx context.Context, userID, holder string, token int64, ttl time.Duration) error
	ReleaseWatchExecLease(ctx context.Context, userID, holder string, token int64) error
}

// SyncMarker records post-sync bookkeeping. *storage.Store satisfies it via
// SetMeta; it is an interface so the handler stays unit-testable with a fake.
type SyncMarker interface {
	SetMeta(ctx context.Context, userID, key, value string) error
}

// RecentGapCheck is the devops#1010 AC3 seam: while a user's first-sync
// session is unfinished, the ordinary INCREMENTAL sync must check the
// session's recent activity window for credential gaps — the incremental
// cursor stops at the first already-stored activity, which an earlier failed
// window fetch could leave masking a hole. The seam returns the session's
// recent activities window (Shanghai days); ok=false (no session, session
// finished, or provider mismatch) means the incremental runs unchanged.
// Implemented by *onboardingsync.Service.
type RecentGapCheck interface {
	UnfinishedRecentActivityWindow(ctx context.Context, userID, providerName string) (provider.DayWindow, bool)
}

// New returns the watch_sync job.Handler backed by resolve. On a successful sync
// it stamps the user's last-sync time through marker (ADR 0018). jobs is the
// detail-fetch concurrency threaded into every run's SyncOptions (the adapter
// clamps it); it is an infra knob, deliberately not part of the job payload so
// external callers cannot dictate server-side concurrency.
//
// sessions may be nil (write isolation off — the default): the handler then
// runs the sync exactly as before. When non-nil, leaseTTL must be positive
// (storage.DefaultWatchExecLeaseTTL is the recommended value).
func New(resolve Resolver, marker SyncMarker, jobs int) job.Handler {
	return newHandler(resolve, marker, jobs, nil, 0, nil)
}

// NewIsolated additionally wires the per-user write-isolation session.
func NewIsolated(resolve Resolver, marker SyncMarker, jobs int, sessions SessionManager, leaseTTL time.Duration) job.Handler {
	return newHandler(resolve, marker, jobs, sessions, leaseTTL, nil)
}

// NewIsolatedWithGapCheck is NewIsolated plus the recent-window gap check
// (devops#1010 AC3). gapCheck may be nil (feature off / tests).
func NewIsolatedWithGapCheck(resolve Resolver, marker SyncMarker, jobs int, sessions SessionManager, leaseTTL time.Duration, gapCheck RecentGapCheck) job.Handler {
	return newHandler(resolve, marker, jobs, sessions, leaseTTL, gapCheck)
}

func newHandler(resolve Resolver, marker SyncMarker, jobs int, sessions SessionManager, leaseTTL time.Duration, gapCheck RecentGapCheck) job.Handler {
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

		// --- write-isolation session (devops#1005) -------------------------
		//
		// Begin the per-user session and thread it through the sync context;
		// storage's publish path picks it up from ctx. Lease contention
		// (another worker mid-sync for this user) fails with a retryable
		// error — the job backs off and the winner finishes first. A renew
		// goroutine extends the lease every TTL/3 while the sync runs; losing
		// the renewal means a takeover happened, and the next publish's fence
		// check is what actually refuses the write (renewal failure alone
		// does not abort the sync — the fence is authoritative).
		if sessions != nil {
			if leaseTTL <= 0 {
				leaseTTL = storage.DefaultWatchExecLeaseTTL
			}
			sess, err := sessions.BeginWatchSyncSession(ctx, user, prov.Info().Name, j.ID, leaseTTL)
			if err != nil {
				return "", err // ErrLeaseHeld or a store fault -> retryable
			}
			ctx = storage.WithPublishSession(ctx, sess)
			stopRenew := make(chan struct{})
			go func() {
				t := time.NewTicker(leaseTTL / 3)
				defer t.Stop()
				for {
					select {
					case <-stopRenew:
						return
					case <-ctx.Done():
						return
					case <-t.C:
						_ = sessions.RenewWatchExecLease(context.WithoutCancel(ctx), user, sess.Holder, sess.LeaseToken, leaseTTL)
					}
				}
			}()
			defer func() {
				close(stopRenew)
				_ = sessions.ReleaseWatchExecLease(context.WithoutCancel(ctx), user, sess.Holder, sess.LeaseToken)
			}()
		}

		// Bridge sync progress onto the job row (best-effort; a progress write
		// must never abort the sync).
		opts.Progress = func(pr provider.SyncProgress) {
			stage, _ := pr["phase"].(string)
			pct, _ := pr["percent"].(int)
			_ = hb(stage, pct)
		}

		// --- recent-window gap check (devops#1010 AC3) ----------------------
		//
		// While the user's first-sync session is unfinished, the incremental
		// cursor's stop-at-first-existing rule could mask holes an earlier
		// failed window fetch left inside the recent window. One bounded
		// existence-skipping range chunk over the session's recent activities
		// window (the backfill contract — already-stored rows re-download
		// nothing) heals what it can; best-effort by design, the session's own
		// executor remains the reliable healer. Full syncs scan the whole
		// window anyway and need no extra pass.
		if gapCheck != nil && opts.Mode == provider.SyncIncremental {
			if bs, ok := prov.(provider.BackfillSyncer); ok {
				if win, ok := gapCheck.UnfinishedRecentActivityWindow(ctx, user, prov.Info().Name); ok {
					budget := provider.BackfillBudget{
						MaxActivityFetches: 100,
						Soft:               3 * time.Minute,
					}
					if _, err := bs.SyncBackfillRange(ctx, user, provider.BackfillRangeOptions{
						Activities: &win, Budget: budget, Jobs: jobs,
					}, opts.Progress); err != nil {
						// Log and continue with the normal incremental: the
						// vendor hiccup must not fail the user's whole sync,
						// and the session executor retries the window anyway.
						logging.Default().Warn("watchsync: recent-window gap check chunk failed",
							zap.String("user", user), zap.Error(err))
					}
				}
			}
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
			// A fence refusal (stale lease token or superseded binding) is
			// retryable by design: the retry re-begins the session and
			// re-publishes under the CURRENT binding/lease — that is exactly
			// the recovery the isolation guarantees (devops#1005).
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
			Activities              int      `json:"activities"`
			Health                  int      `json:"health"`
			Mode                    string   `json:"mode"`
			LabelIDs                []string `json:"label_ids,omitempty"`
			HealthDates             []string `json:"health_dates,omitempty"`
			ScheduleSessions        int      `json:"schedule_sessions,omitempty"`
			ScheduleSkippedStrength int      `json:"schedule_skipped_strength,omitempty"`
			ScheduleSkippedStride   int      `json:"schedule_skipped_stride,omitempty"`
			ScheduleSkippedInvalid  int      `json:"schedule_skipped_invalid,omitempty"`
		}{res.Activities, res.Health, string(opts.Mode), res.ActivityLabelIDs, res.HealthDates,
			res.ScheduleSessions, res.ScheduleSkippedStrength, res.ScheduleSkippedStride, res.ScheduleSkippedInvalid})
		return string(out), nil
	}
}
