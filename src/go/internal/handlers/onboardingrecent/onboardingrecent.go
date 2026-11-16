// Package onboardingrecent provides the worker job handler for job type
// "onboarding_recent_sync" (devops#1008, epic devops#1004 T04): it executes
// one first-sync session's recent stage — the COROS recent-range channels
// (90-day activities / 28-day health / dashboard) — and returns the
// onboardingsync.StageResult coverage contract the reconcile sweep persists.
//
// The handler is the stage executor T02's orchestration dispatches: it reads
// the session's authoritative work items, skips items whose complete-fetch
// credential already exists (a retry reuses done work, never re-pulls), runs
// the rest through the provider's RecentSyncer, and records each item's
// terminal outcome (done+credential / gap). A per-user write-isolation session
// (binding revision + execution lease, devops#1005) fences every activity
// publish exactly like a watch_sync run; a stale lease or rebind surfaces as a
// retryable error whose retry re-begins the session under the CURRENT binding.
package onboardingrecent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// JobType is the registered job_type (mirrors catalog.JobTypeOnboardingRecentSync;
// kept local so the package is self-contained like watchsync).
const JobType = "onboarding_recent_sync"

// Work-item kinds (the claim transaction creates them).
const (
	kindActivities = "activities"
	kindHealth     = "health"
	kindDashboard  = "dashboard"
)

// ErrProviderNotRangeCapable reports that the user's bound provider does not
// (yet) implement the recent-range contract — Garmin until its T03 executor
// ships. Retrying cannot fix it; the permanent failure marks the session
// failed so the rollout gate keeps such providers off the new path.
var ErrProviderNotRangeCapable = errors.New("onboardingrecent: bound provider does not implement the recent-range contract")

// Provider is the slice of a watch provider the executor needs.
type Provider interface {
	Info() provider.ProviderInfo
	IsLoggedIn(user string) (bool, error)
	SyncRecentRange(ctx context.Context, user string, opts provider.RecentRangeOptions, progress provider.ProgressCallback) (provider.RecentRangeReport, error)
}

// Resolver returns the provider a user is bound to; the cmd-layer wiring
// type-asserts provider.RecentSyncer and reports ErrProviderNotRangeCapable
// for adapters without the contract.
type Resolver func(ctx context.Context, user string) (Provider, error)

// Store is the session persistence the executor needs (satisfied by
// *storage.Store).
type Store interface {
	GetOnboardingSyncSessionByID(ctx context.Context, sessionID string) (*storage.OnboardingSyncSession, error)
	ListOnboardingSyncWorkItems(ctx context.Context, sessionID, stage string) ([]*storage.OnboardingSyncWorkItem, error)
	MarkOnboardingSyncWorkItem(ctx context.Context, id int64, status string, credential string, errMsg *string) error
	// ResetFailedOnboardingSyncWorkItems re-arms failed items to pending so a
	// job-level auto-retry can mark them terminal (item marks only transition
	// out of pending).
	ResetFailedOnboardingSyncWorkItems(ctx context.Context, sessionID, stage string) (int64, error)
}

// SessionManager is the write-isolation seam (devops#1005), satisfied by
// *storage.Store; identical to watchsync's.
type SessionManager interface {
	BeginWatchSyncSession(ctx context.Context, userID, providerName, holder string, ttl time.Duration) (*storage.PublishSession, error)
	RenewWatchExecLease(ctx context.Context, userID, holder string, token int64, ttl time.Duration) error
	ReleaseWatchExecLease(ctx context.Context, userID, holder string, token int64) error
}

// Config wires the handler.
type Config struct {
	Resolve  Resolver
	Store    Store
	Sessions SessionManager
	// Jobs is the detail-fetch concurrency (infra knob, like watchsync's).
	Jobs int
	// LeaseTTL for the per-user execution lease; 0 = storage default.
	LeaseTTL time.Duration
}

// New returns the onboarding_recent_sync job.Handler.
func New(cfg Config) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		var in struct {
			SessionID string `json:"session_id"`
			Stage     string `json:"stage"`
		}
		if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
			return "", job.NewPermanentError("bad_payload", err)
		}
		if in.SessionID == "" || in.Stage != storage.OnboardingSyncStageRecentRaw {
			return "", job.NewPermanentError("bad_payload",
				fmt.Errorf("onboardingrecent: unexpected stage input session=%q stage=%q", in.SessionID, in.Stage))
		}

		sess, err := cfg.Store.GetOnboardingSyncSessionByID(ctx, in.SessionID)
		if err != nil {
			return "", err
		}
		if sess == nil {
			return "", job.NewPermanentError("session_gone",
				fmt.Errorf("onboardingrecent: session %s not found", in.SessionID))
		}
		if sess.State == storage.OnboardingSyncStateSuperseded {
			// A rebind isolated this session; its writes must never run.
			return "", job.NewPermanentError("session_superseded",
				fmt.Errorf("onboardingrecent: session %s superseded by a rebind", in.SessionID))
		}

		prov, err := cfg.Resolve(ctx, sess.UserID)
		if err != nil {
			if errors.Is(err, ErrProviderNotRangeCapable) {
				return "", job.NewPermanentError("provider_not_capable", err)
			}
			return "", err
		}
		if name := prov.Info().Name; name != sess.Provider {
			return "", job.NewPermanentError("provider_mismatch",
				fmt.Errorf("onboardingrecent: session provider %q but user bound to %q", sess.Provider, name))
		}

		loggedIn, err := prov.IsLoggedIn(sess.UserID)
		if err != nil {
			return "", err
		}
		if !loggedIn {
			return "", job.NewPermanentError("not_logged_in",
				fmt.Errorf("user %s has no watch credentials", sess.UserID))
		}

		// --- write-isolation session (same contract as watchsync) -----------
		ttl := cfg.LeaseTTL
		if ttl <= 0 {
			ttl = storage.DefaultWatchExecLeaseTTL
		}
		ps, err := cfg.Sessions.BeginWatchSyncSession(ctx, sess.UserID, prov.Info().Name, j.ID, ttl)
		if err != nil {
			return "", err // ErrLeaseHeld or a store fault -> retryable
		}
		ctx = storage.WithPublishSession(ctx, ps)
		stopRenew := make(chan struct{})
		go func() {
			t := time.NewTicker(ttl / 3)
			defer t.Stop()
			for {
				select {
				case <-stopRenew:
					return
				case <-ctx.Done():
					return
				case <-t.C:
					_ = cfg.Sessions.RenewWatchExecLease(context.WithoutCancel(ctx), sess.UserID, ps.Holder, ps.LeaseToken, ttl)
				}
			}
		}()
		defer func() {
			close(stopRenew)
			_ = cfg.Sessions.ReleaseWatchExecLease(context.WithoutCancel(ctx), sess.UserID, ps.Holder, ps.LeaseToken)
		}()

		// --- run the stage's unfinished work items --------------------------
		items, err := cfg.Store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage)
		if err != nil {
			return "", err
		}
		// Job-level auto-retries re-run this handler without the session-level
		// retry's reset; re-arm failed items here so their terminal marks can
		// land (marks only transition out of pending). Done/gap items are
		// untouched — done credentials are reused, gaps stay gaps.
		if _, err := cfg.Store.ResetFailedOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage); err != nil {
			return "", err
		}
		items, err = cfg.Store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage)
		if err != nil {
			return "", err
		}

		opts := provider.RecentRangeOptions{Jobs: cfg.Jobs}
		byKind := map[string]*storage.OnboardingSyncWorkItem{}
		for _, it := range items {
			byKind[it.Kind] = it
			if it.Status == storage.OnboardingSyncItemDone || it.Status == storage.OnboardingSyncItemGap {
				continue
			}
			w := provider.DayWindow{From: it.RangeFrom, To: it.RangeTo}
			switch it.Kind {
			case kindActivities:
				opts.Activities = &w
			case kindHealth:
				opts.Health = &w
			case kindDashboard:
				opts.Dashboard = &w
			default:
				return "", job.NewPermanentError("bad_work_item",
					fmt.Errorf("onboardingrecent: unknown work item kind %q", it.Kind))
			}
		}
		if opts.Activities == nil && opts.Health == nil && opts.Dashboard == nil {
			// Every item already terminal: re-report the stage coverage from
			// the persisted outcomes (idempotent completion, e.g. a crash
			// between job-done and the sweep's completion observation).
			return stageResultFromItems(in.Stage, items), nil
		}

		progress := func(pr provider.SyncProgress) {
			stage, _ := pr["phase"].(string)
			pct, _ := pr["percent"].(int)
			_ = hb(stage, pct)
		}
		rep, syncErr := prov.SyncRecentRange(ctx, sess.UserID, opts, progress)

		// Record every channel that reached a terminal outcome; an absent
		// channel with a failed run stays re-runnable for the retry.
		channels := []struct {
			kind string
			rep  *provider.RangeChannelReport
		}{
			{kindActivities, rep.Activities},
			{kindHealth, rep.Health},
			{kindDashboard, rep.Dashboard},
		}
		for _, ch := range channels {
			it := byKind[ch.kind]
			if it == nil || ch.rep == nil {
				continue
			}
			status, credential := storage.OnboardingSyncItemDone, ch.rep.Credential
			var msg *string
			if ch.rep.Status == provider.RangeChannelGap {
				status = storage.OnboardingSyncItemGap
				m := gapReason(ch.rep.Gaps)
				msg = &m
			}
			if err := cfg.Store.MarkOnboardingSyncWorkItem(ctx, it.ID, status, credential, msg); err != nil {
				return "", fmt.Errorf("onboardingrecent: record %s outcome: %w", ch.kind, err)
			}
		}

		if syncErr != nil {
			// The run's unfinished items carry the failure reason for
			// observability; the job retry (or an explicit session retry)
			// re-runs them — recorded-done items above are never re-fetched.
			msg := syncErr.Error()
			for _, ch := range channels {
				if ch.rep != nil {
					continue
				}
				if it := byKind[ch.kind]; it != nil {
					_ = cfg.Store.MarkOnboardingSyncWorkItem(ctx, it.ID, storage.OnboardingSyncItemFailed, "", &msg)
				}
			}
			switch {
			case provider.IsAuthError(syncErr):
				return "", job.NewPermanentError("auth_failed", syncErr)
			case provider.IsInvalidRequest(syncErr):
				return "", job.NewPermanentError("provider_invalid_request", syncErr)
			default:
				// Network / throttling / fence refusal: retryable. A fence
				// refusal re-begins the isolation session on the retry and
				// re-publishes under the CURRENT binding — the isolation
				// guarantee (devops#1005).
				return "", syncErr
			}
		}

		return stageResultFromReport(in.Stage, rep), nil
	}
}

// gapReason flattens a channel's gaps into one human-readable reason.
func gapReason(gaps []provider.RangeGap) string {
	seen := map[string]bool{}
	var reasons []string
	for _, g := range gaps {
		if g.Reason == "" || seen[g.Reason] {
			continue
		}
		seen[g.Reason] = true
		reasons = append(reasons, g.Reason)
	}
	if len(reasons) == 0 {
		return "unobtainable at provider"
	}
	return strings.Join(reasons, "; ")
}

// stageResultFromReport builds the job's ResultJSON from the fresh channel
// reports: scanned = the channels' windows, observed = the merge of actually
// observed windows, gaps = every channel's recorded gaps (kind-prefixed).
func stageResultFromReport(stage string, rep provider.RecentRangeReport) string {
	res := onboardingsync.StageResult{Stage: stage, Status: storage.OnboardingSyncCoverageCompleted}
	merge := func(kind string, r *provider.RangeChannelReport) {
		if r == nil {
			return
		}
		if res.ScannedFrom == nil || r.ScannedFrom < *res.ScannedFrom {
			s := r.ScannedFrom
			res.ScannedFrom = &s
		}
		if res.ScannedTo == nil || r.ScannedTo > *res.ScannedTo {
			s := r.ScannedTo
			res.ScannedTo = &s
		}
		if r.ObservedFrom != nil {
			if res.ObservedFrom == nil || *r.ObservedFrom < *res.ObservedFrom {
				s := *r.ObservedFrom
				res.ObservedFrom = &s
			}
		}
		if r.ObservedTo != nil {
			if res.ObservedTo == nil || *r.ObservedTo > *res.ObservedTo {
				s := *r.ObservedTo
				res.ObservedTo = &s
			}
		}
		for _, g := range r.Gaps {
			res.Gaps = append(res.Gaps, onboardingsync.StageGap{From: g.From, To: g.To, Reason: kind + ": " + g.Reason})
		}
	}
	merge(kindActivities, rep.Activities)
	merge(kindHealth, rep.Health)
	merge(kindDashboard, rep.Dashboard)
	if len(res.Gaps) > 0 {
		res.Status = storage.OnboardingSyncCoverageCompletedWithGaps
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "{}"
	}
	return string(out)
}

// stageResultFromItems rebuilds the result from persisted item outcomes — the
// idempotent path where every item was already terminal before this run. It is
// an approximation of the per-day gap granularity the fresh report carries
// (items only know their whole window), which is why the executor prefers
// stageResultFromReport whenever it actually ran.
func stageResultFromItems(stage string, items []*storage.OnboardingSyncWorkItem) string {
	res := onboardingsync.StageResult{Stage: stage, Status: storage.OnboardingSyncCoverageCompleted}
	anyObserved := false
	for _, it := range items {
		if res.ScannedFrom == nil || it.RangeFrom < *res.ScannedFrom {
			s := it.RangeFrom
			res.ScannedFrom = &s
		}
		if res.ScannedTo == nil || it.RangeTo > *res.ScannedTo {
			s := it.RangeTo
			res.ScannedTo = &s
		}
		switch it.Status {
		case storage.OnboardingSyncItemGap:
			res.Status = storage.OnboardingSyncCoverageCompletedWithGaps
			reason := "unobtainable at provider"
			if it.Error != nil && *it.Error != "" {
				reason = *it.Error
			}
			res.Gaps = append(res.Gaps, onboardingsync.StageGap{From: it.RangeFrom, To: it.RangeTo, Reason: reason})
		}
		if from, to, ok := observedFromCredential(it.FetchCredential); ok {
			anyObserved = true
			if res.ObservedFrom == nil || from < *res.ObservedFrom {
				s := from
				res.ObservedFrom = &s
			}
			if res.ObservedTo == nil || to > *res.ObservedTo {
				s := to
				res.ObservedTo = &s
			}
		}
	}
	if !anyObserved && len(res.Gaps) == 0 {
		// Terminal items with no observed data and no gaps recorded: report
		// the honest emptiness rather than a covered window.
		res.Status = storage.OnboardingSyncCoverageCompletedWithGaps
	}
	out, err := json.Marshal(res)
	if err != nil {
		return "{}"
	}
	return string(out)
}

// observedFromCredential extracts the observed window recorded inside a
// complete-fetch credential — the uniform adapter shape
// coros:v1:range:<kind>:<from>..<to>:obs=<a>..<b>:n=<count> (obs days are "-"
// when the channel observed nothing). A foreign credential reports none.
func observedFromCredential(cred *string) (from, to string, ok bool) {
	if cred == nil {
		return "", "", false
	}
	parts := strings.Split(*cred, ":")
	if len(parts) != 7 || parts[0] != "coros" || !strings.HasPrefix(parts[5], "obs=") {
		return "", "", false
	}
	obs := strings.TrimPrefix(parts[5], "obs=")
	days := strings.SplitN(obs, "..", 2)
	if len(days) != 2 || len(days[0]) != 10 || len(days[1]) != 10 {
		return "", "", false
	}
	return days[0], days[1], true
}
