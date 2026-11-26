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

			if it := byKind[kindActivities]; it != nil && rep.Activities != nil {
				cp := parseChannelCheckpoint(it.Checkpoint)
				gaps := provider.MergeRangeGaps(cp.Gaps, rep.Activities.Gaps)
				if rep.Activities.Status == "" {
					// The channel failed later in the walk. Keep only durable
					// rejection evidence, and let the job retry the remaining work.
					if len(gaps) != 0 {
						cp.Gaps = gaps
						if err := cfg.Store.SaveOnboardingSyncWorkItemCheckpoint(ctx, it.ID, cp.marshal()); err != nil {
							return "", err
						}
					}
					rep.Activities = nil
				} else if len(gaps) != 0 {
					rep.Activities.Gaps = gaps
					rep.Activities.Status = provider.RangeChannelGap
				}
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
				var msg *string
				if ch.rep.Status == provider.RangeChannelGap {
					status = storage.OnboardingSyncItemGap
					msg = encodeWorkItemGaps(ch.rep.Gaps)
				}
				if err := cfg.Store.MarkOnboardingSyncWorkItem(ctx, it.ID, status, credential, msg); err != nil {
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
					msg := it.Error
					if first {
						msg = workItemFailure(it, classified)
						first = false
					}
					_ = cfg.Store.MarkOnboardingSyncWorkItem(ctx, it.ID, storage.OnboardingSyncItemFailed, "", msg)
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

// Work items keep the precise gap ranges between retries. The existing text
// column also accepts legacy flattened reasons (see workItemGaps).
func encodeWorkItemGaps(gaps []provider.RangeGap) *string {
	data, _ := json.Marshal(gaps)
	encoded := string(data)
	return &encoded
}

func workItemFailure(it *storage.OnboardingSyncWorkItem, err error) *string {
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
	if it.Error != nil && *it.Error != "" {
		var gaps []provider.RangeGap
		if json.Unmarshal([]byte(*it.Error), &gaps) == nil && len(gaps) != 0 {
			return gaps
		}
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
