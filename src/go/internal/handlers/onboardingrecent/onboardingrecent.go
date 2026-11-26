// Package onboardingrecent provides the worker job handler for job type
// "onboarding_recent_sync" (devops#1008, epic devops#1004 T04 + T06
// devops#1010): it executes one first-sync session stage — the recent stage
// (COROS/Garmin recent-range channels), the chunked background backfill
// stages (extended_raw / historical_raw) and the auxiliary stage (race
// detection + route shapes) — and returns the onboardingsync.StageResult
// coverage contract the reconcile sweep persists.
//
// The handler is the stage executor T02's orchestration dispatches: it reads
// the session's authoritative work items, skips items whose complete-fetch
// credential already exists (a retry reuses done work, never re-pulls), runs
// the rest through the provider's range contracts, and records each item's
// terminal outcome (done+credential / gap). The raw stages run under a
// per-user write-isolation session (binding revision + execution lease,
// devops#1005) that fences every activity publish exactly like a watch_sync
// run; the backfill stages hold that lease only for one bounded chunk at a
// time (devops#1010: ≤20 activity fetches or ≤7 health days, then checkpoint
// and yield so recent stages, new trainings and webhooks jump the queue). A
// stale lease or rebind surfaces as a retryable error whose retry re-begins
// the session under the CURRENT binding.
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

// Work-item kind aliases (the claim/stage transactions create them).
const (
	kindActivities = storage.OnboardingSyncItemKindActivities
	kindHealth     = storage.OnboardingSyncItemKindHealth
	kindDashboard  = storage.OnboardingSyncItemKindDashboard
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
	MarkOnboardingSyncWorkItemWithGaps(ctx context.Context, id int64, status, credential string, reason, gaps *string) error
	SaveOnboardingSyncWorkItemCheckpoint(ctx context.Context, id int64, checkpoint string) error
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
	// BackfillBudget caps one backfill chunk (devops#1010); zero fields fall
	// back to the provider defaults (20 fetches / 7 health days / 2 min soft).
	BackfillBudget provider.BackfillBudget
	// Aux wires the auxiliary stage's two independent retryable tasks
	// (devops#1010 AC5). Nil disables the stage — dispatching it then fails
	// permanently as aux_not_configured instead of silently no-oping.
	Aux *AuxiliaryConfig
}

// knownStage reports whether the executor implements the stage.
func knownStage(stage string) bool {
	switch stage {
	case storage.OnboardingSyncStageRecentRaw,
		storage.OnboardingSyncStageExtendedRaw,
		storage.OnboardingSyncStageHistoricalRaw,
		storage.OnboardingSyncStageAuxiliary:
		return true
	}
	return false
}

// New returns the onboarding_recent_sync job.Handler.
func New(cfg Config) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		var in stageJobInput
		if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
			return "", job.NewPermanentError("bad_payload", err)
		}
		if in.SessionID == "" || !knownStage(in.Stage) {
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

		if in.Stage == storage.OnboardingSyncStageAuxiliary {
			return runAuxiliary(ctx, cfg, in, sess, hb)
		}

		// --- provider + write-isolation session (recent + backfill) --------
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

		if in.Stage != storage.OnboardingSyncStageRecentRaw {
			return runBackfill(ctx, cfg, in, sess, prov, hb)
		}

		// --- run the recent stage's unfinished work items -------------------
		// Job-level auto-retries re-run this handler without the session-level
		// retry's reset; re-arm failed items here so their terminal marks can
		// land (marks only transition out of pending). Done/gap items are
		// untouched — done credentials are reused, gaps stay gaps.
		if _, err := cfg.Store.ResetFailedOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage); err != nil {
			return "", err
		}
		items, err := cfg.Store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage)
		if err != nil {
			return "", err
		}

		for {
			opts := provider.RecentRangeOptions{Jobs: cfg.Jobs}
			byKind := map[string]*storage.OnboardingSyncWorkItem{}
			for _, it := range items {
				if it.Status == storage.OnboardingSyncItemDone || it.Status == storage.OnboardingSyncItemGap {
					continue
				}
				byKind[it.Kind] = it
				w := provider.DayWindow{From: it.RangeFrom, To: it.RangeTo}
				switch it.Kind {
				case kindActivities:
					opts.Activities = &w
					opts.RejectedActivityIDs = make(map[string]bool)
					provider.RememberRejectedActivities(opts.RejectedActivityIDs, parseChannelCheckpoint(it.Checkpoint).Gaps)
				case kindHealth:
					cp := parseChannelCheckpoint(it.Checkpoint)
					if cp.ScannedThrough != "" {
						w.From = nextDayLabel(cp.ScannedThrough)
					}
					opts.Health = &w
					opts.RejectedHealthEndpoints = rejectedHealthEndpoints(cp.Gaps)
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

			rep.Activities, err = resumeRecentChannel(ctx, cfg.Store, prov.Info().Name, byKind[kindActivities], rep.Activities)
			if err != nil {
				return "", err
			}
			rep.Health, err = resumeRecentChannel(ctx, cfg.Store, prov.Info().Name, byKind[kindHealth], rep.Health)
			if err != nil {
				return "", err
			}

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
				if it == nil {
					continue
				}
				if ch.rep == nil {
					if syncErr == nil {
						return "", fmt.Errorf("onboardingrecent: %s scan returned no outcome", ch.kind)
					}
					continue
				}
				status, credential := storage.OnboardingSyncItemDone, ch.rep.Credential
				var reason, details *string
				if ch.rep.Status == provider.RangeChannelGap {
					status = storage.OnboardingSyncItemGap
					reason, details = encodeWorkItemGaps(ch.rep.Gaps)
				}
				if err := cfg.Store.MarkOnboardingSyncWorkItemWithGaps(ctx, it.ID, status, credential, reason, details); err != nil {
					return "", fmt.Errorf("onboardingrecent: record %s outcome: %w", ch.kind, err)
				}
			}

			if syncErr != nil {
				// The run's unfinished items carry the failure reason for
				// observability; the job retry (or an explicit session retry)
				// re-runs them — recorded-done items above are never re-fetched.
				classified := classifySyncError(syncErr)
				first := true
				for _, ch := range channels {
					it := byKind[ch.kind]
					if ch.rep != nil || it == nil || it.Status != storage.OnboardingSyncItemPending {
						continue
					}
					reason, details := it.Error, it.RecordedRangeGaps()
					if first {
						reason, details = workItemFailure(it, classified)
						first = false
					}
					_ = cfg.Store.MarkOnboardingSyncWorkItemWithGaps(ctx, it.ID, storage.OnboardingSyncItemFailed, "", reason, details)
				}
				return "", classified
			}

			// A top-up may have appended a second range for the same channel.
			// Continue until every item has a durable outcome.
			items, err = cfg.Store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, in.Stage)
			if err != nil {
				return "", err
			}
		}
	}
}

// resumeRecentChannel preserves settled evidence from a partial attempt. For
// day-based health, both the scanned prefix and exact endpoint rejections are
// reused when the job resumes. Activities already reuse stored detail rows.
func resumeRecentChannel(ctx context.Context, store Store, providerName string, item *storage.OnboardingSyncWorkItem, report *provider.RangeChannelReport) (*provider.RangeChannelReport, error) {
	if item == nil || report == nil {
		return report, nil
	}
	cp := parseChannelCheckpoint(item.Checkpoint)
	cp.Gaps = provider.MergeRangeGaps(cp.Gaps, report.Gaps)
	if report.Status == "" {
		if report.ScannedTo != "" {
			cp.ScannedThrough = report.ScannedTo
			mergeRecentObserved(&cp, report)
		}
		if cp.ScannedThrough != "" || len(cp.Gaps) != 0 {
			return nil, store.SaveOnboardingSyncWorkItemCheckpoint(ctx, item.ID, cp.marshal())
		}
		return nil, nil
	}
	if len(cp.Gaps) > 0 {
		report.Gaps = cp.Gaps
		report.Status = provider.RangeChannelGap
	}
	if cp.ScannedThrough != "" && report.Credential != "" {
		mergeRecentObserved(&cp, report)
		obs := "-..-"
		if cp.ObservedFrom != "" {
			obs = cp.ObservedFrom + ".." + cp.ObservedTo
		}
		report.Credential = fmt.Sprintf("%s:v1:range:%s:%s..%s:obs=%s:n=%d", providerName, item.Kind, item.RangeFrom, item.RangeTo, obs, cp.Fetches)
	}
	return report, nil
}

func mergeRecentObserved(cp *channelCheckpoint, report *provider.RangeChannelReport) {
	if report.ObservedFrom != nil && (cp.ObservedFrom == "" || *report.ObservedFrom < cp.ObservedFrom) {
		cp.ObservedFrom = *report.ObservedFrom
	}
	if report.ObservedTo != nil && *report.ObservedTo > cp.ObservedTo {
		cp.ObservedTo = *report.ObservedTo
	}
	cp.Fetches += report.Count
}

func rejectedHealthEndpoints(gaps []provider.RangeGap) map[string]map[string]bool {
	byDay := make(map[string]map[string]bool)
	for _, gap := range gaps {
		if gap.Kind != provider.RangeGapUnavailable || gap.Endpoint == "" {
			continue
		}
		for day := gap.From; day != "" && day <= gap.To; day = nextDayLabel(day) {
			if byDay[day] == nil {
				byDay[day] = make(map[string]bool)
			}
			byDay[day][gap.Endpoint] = true
			if nextDayLabel(day) <= day {
				break
			}
		}
	}
	return byDay
}

// stageJobInput is the stage-executor job's InputJSON (shared by every stage).
type stageJobInput struct {
	SessionID string `json:"session_id"`
	Stage     string `json:"stage"`
}

// classifySyncError maps a provider sync error onto the job error taxonomy
// shared by the recent and backfill executors.
func classifySyncError(syncErr error) error {
	switch {
	case provider.IsAuthError(syncErr):
		return job.NewPermanentError("auth_failed", syncErr)
	case errors.Is(syncErr, provider.ErrUnrecoverableRangeData):
		// Confirmed-but-unclassifiable provider data (e.g. Garmin's
		// undatable activities, devops#1007): blocking is the honest
		// outcome — a retry cannot repair the vendor's data.
		return job.NewPermanentError("unrecoverable_range_data", syncErr)
	case provider.IsRangeRejection(syncErr):
		return job.NewPermanentError("provider_invalid_request", syncErr)
	default:
		// Network / throttling / fence refusal: retryable. A fence
		// refusal re-begins the isolation session on the retry and
		// re-publishes under the CURRENT binding — the isolation
		// guarantee (devops#1005).
		return syncErr
	}
}

// Keep both precise gap ranges and the reason older workers use.
func encodeWorkItemGaps(gaps []provider.RangeGap) (reason, details *string) {
	var reasons []string
	seen := make(map[string]bool)
	for _, gap := range gaps {
		if gap.Reason != "" && !seen[gap.Reason] {
			seen[gap.Reason] = true
			reasons = append(reasons, gap.Reason)
		}
	}
	legacy := strings.Join(reasons, "; ")
	if legacy == "" || len(legacy) > 65_535 {
		legacy = "provider reported gaps"
	}
	data, _ := json.Marshal(gaps)
	encoded := string(data)
	return &legacy, &encoded
}

func workItemFailure(it *storage.OnboardingSyncWorkItem, err error) (reason, details *string) {
	kind := provider.RangeGapTransient
	if _, permanent := job.AsPermanent(err); permanent {
		kind = provider.RangeGapUnavailable
	}
	gap := provider.RangeGap{From: it.RangeFrom, To: it.RangeTo, Kind: kind, Reason: err.Error(), RangeEstimated: true}
	var scope *provider.RangeFetchError
	if errors.As(err, &scope) {
		gap.From, gap.To, gap.RangeEstimated = scope.Window.From, scope.Window.To, false
	}
	return encodeWorkItemGaps([]provider.RangeGap{gap})
}

func workItemGaps(it *storage.OnboardingSyncWorkItem) []provider.RangeGap {
	if it.Status != storage.OnboardingSyncItemGap {
		return nil
	}
	reason := "unobtainable at provider"
	if details := it.RecordedRangeGaps(); details != nil {
		var gaps []provider.RangeGap
		if json.Unmarshal([]byte(*details), &gaps) == nil && len(gaps) != 0 {
			return gaps
		}
	}
	if it.Error != nil && *it.Error != "" {
		reason = *it.Error
	}
	gap := (provider.RangeGap{From: it.RangeFrom, To: it.RangeTo, Reason: reason}).Classified()
	if gap.Kind != provider.RangeGapEmpty {
		return []provider.RangeGap{gap}
	}
	if it.FetchCredential == nil {
		return []provider.RangeGap{gap}
	}
	obsFrom, obsTo, ok := provider.RangeCredentialObservedWindow(*it.FetchCredential)
	if !ok {
		return []provider.RangeGap{gap}
	}
	var gaps []provider.RangeGap
	if obsFrom > it.RangeFrom {
		leading := gap
		leading.To = prevDayLabel(obsFrom)
		gaps = append(gaps, leading)
	}
	if obsTo < it.RangeTo {
		gap.From = nextDayLabel(obsTo)
		gaps = append(gaps, gap)
	}
	return gaps
}

func appendChannelGaps(dst []onboardingsync.StageGap, channel string, gaps []provider.RangeGap) []onboardingsync.StageGap {
	for _, gap := range gaps {
		gap = gap.Classified()
		gap.Channel = channel
		dst = append(dst, gap)
	}
	return dst
}

// stageResultFromItems is shared by initial completion and retry. A
// terminal rejection without a credential contributes only its gap.
func stageResultFromItems(stage string, items []*storage.OnboardingSyncWorkItem) string {
	res := onboardingsync.StageResult{Stage: stage, Status: storage.OnboardingSyncCoverageCompleted}
	for _, it := range items {
		if it.Status != storage.OnboardingSyncItemDone && it.Status != storage.OnboardingSyncItemGap {
			continue
		}
		res.Gaps = appendChannelGaps(res.Gaps, it.Kind, workItemGaps(it))
		if it.FetchCredential == nil {
			continue
		}
		if res.ScannedFrom == nil || it.RangeFrom < *res.ScannedFrom {
			res.ScannedFrom = &it.RangeFrom
		}
		if res.ScannedTo == nil || it.RangeTo > *res.ScannedTo {
			res.ScannedTo = &it.RangeTo
		}
		if from, to, ok := provider.RangeCredentialObservedWindow(*it.FetchCredential); ok {
			if res.ObservedFrom == nil || from < *res.ObservedFrom {
				res.ObservedFrom = &from
			}
			if res.ObservedTo == nil || to > *res.ObservedTo {
				res.ObservedTo = &to
			}
		}
	}
	if provider.HasBlockingRangeGaps(res.Gaps) {
		res.Status = storage.OnboardingSyncCoverageCompletedWithGaps
	}
	out, _ := json.Marshal(res)
	return string(out)
}
