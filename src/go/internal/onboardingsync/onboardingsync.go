// Package onboardingsync owns the first-sync session orchestration
// (devops#1006, epic devops#1004 T02): create-or-claim, reliable stage
// dispatch over the existing Go job store, the reconcile sweep that recovers
// crashes at the create / dispatch / completion boundaries, and the read-only
// readiness view the GET endpoint serves.
//
// The package never talks to a provider — the recent-range executors are T03/
// T04's job handlers. It reuses the jobs/pipeline_runs machinery end to end:
// every stage dispatch is a durable job row created through job.Enqueuer under
// a stable idempotency key (session + stage + ranges + binding revision +
// retry generation), and the sweep's re-enqueue dedupes against the original
// job, so no crash window can lose or double-run the work.
package onboardingsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// Server-controlled window defaults (epic devops#1004): the recent stage
// targets the last 90 Shanghai natural days of activities and 28 of health.
// Clients cannot widen, narrow, or parallelize these — the server decides.
const (
	DefaultRecentActivityDays = 90
	DefaultRecentHealthDays   = 28
)

// Sweep defaults: dispatch rows pending longer than dispatchGrace are crash
// leftovers (the enqueue raced a crash) and are re-sent; each sweep pass
// observes at most sweepLimit dispatches.
const (
	DefaultDispatchGrace = 2 * time.Minute
	DefaultSweepLimit    = 100
)

// StageResult is the executor contract a stage job's ResultJSON carries
// (defined here in T02; the T03/T04 executors report it, and the sweep
// persists it into the stage coverage row). Observed/Scanned are Shanghai
// natural days; gaps are permanent unobtainable ranges with reasons.
type StageResult struct {
	Stage        string     `json:"stage"`
	Status       string     `json:"status"` // completed | completed_with_gaps
	ScannedFrom  *string    `json:"scanned_from,omitempty"`
	ScannedTo    *string    `json:"scanned_to,omitempty"`
	ObservedFrom *string    `json:"observed_from,omitempty"`
	ObservedTo   *string    `json:"observed_to,omitempty"`
	Gaps         []StageGap `json:"gaps,omitempty"`
}

// StageGap is one recorded permanent gap range.
type StageGap struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason,omitempty"`
}

// ErrNoProvider reports the user has no bound watch provider (the POST
// capability gate's failure).
var ErrNoProvider = errors.New("onboardingsync: user has no watch provider")

// ErrNoSession reports the user has no first-sync session (GET before POST).
var ErrNoSession = errors.New("onboardingsync: no onboarding sync session")

// Store is the session persistence the service needs. Satisfied by
// *storage.Store; every method matches storage 1:1 so fakes stay trivial.
type Store interface {
	ClaimOrCreateOnboardingSyncSession(ctx context.Context, spec storage.OnboardingSyncClaimSpec) (*storage.OnboardingSyncClaimResult, error)
	GetOnboardingSyncSession(ctx context.Context, userID string) (*storage.OnboardingSyncSession, error)
	GetOnboardingSyncSessionByID(ctx context.Context, sessionID string) (*storage.OnboardingSyncSession, error)
	SetOnboardingSyncSessionState(ctx context.Context, sessionID, to string, errMsg *string, from ...string) error
	TouchOnboardingSyncSession(ctx context.Context, sessionID string) error
	RecordOnboardingSyncLegacyRun(ctx context.Context, sessionID, runID string) error
	ListOnboardingSyncDispatches(ctx context.Context, sessionID string) ([]*storage.OnboardingSyncDispatch, error)
	ListPendingOnboardingSyncDispatches(ctx context.Context, grace time.Duration, limit int) ([]*storage.OnboardingSyncDispatch, error)
	ListDispatchedOnboardingSyncDispatches(ctx context.Context, limit int) ([]*storage.OnboardingSyncDispatch, error)
	MarkOnboardingSyncDispatchDispatched(ctx context.Context, id int64, jobID string) error
	MarkOnboardingSyncDispatchTerminal(ctx context.Context, id int64, status string) error
	TouchOnboardingSyncDispatch(ctx context.Context, id int64) error
	RequeueOnboardingSyncDispatchForRetry(ctx context.Context, id int64, idempotencyKey string) error
	BumpOnboardingSyncRetryCount(ctx context.Context, sessionID string) (int, error)
	ListOnboardingSyncWorkItems(ctx context.Context, sessionID, stage string) ([]*storage.OnboardingSyncWorkItem, error)
	ResetFailedOnboardingSyncWorkItems(ctx context.Context, sessionID, stage string) (int64, error)
	GetOnboardingSyncStageCoverage(ctx context.Context, sessionID, stage string) (*storage.OnboardingSyncStageCoverage, error)
	ListOnboardingSyncStageCoverage(ctx context.Context, sessionID string) ([]*storage.OnboardingSyncStageCoverage, error)
	UpdateOnboardingSyncStageCoverage(ctx context.Context, cov *storage.OnboardingSyncStageCoverage) error
	ListOnboardingSyncSessionsInStates(ctx context.Context, states []string, limit int) ([]*storage.OnboardingSyncSession, error)
	JobByIdempotencyKey(ctx context.Context, userID, key string) (*job.Job, error)
}

// RunLister reads pipeline runs: the legacy-full-run detection (list by user)
// and the waiting_legacy reconciliation (get by id).
type RunLister interface {
	PipelineRunsByUser(ctx context.Context, userID string) ([]*job.PipelineRun, error)
	PipelineRunByID(ctx context.Context, runID string) (*job.PipelineRun, error)
}

// JobGetter reads job rows for the completion-boundary observation.
type JobGetter interface {
	JobByID(ctx context.Context, jobID string) (*job.Job, error)
}

// Config wires a Service.
type Config struct {
	Store    Store
	Enqueuer job.Enqueuer
	Jobs     JobGetter
	Runs     RunLister
	// JobType is the stage-executor job type (injected from catalog so this
	// package stays decoupled, mirroring the api package's pattern).
	JobType string
	// LegacyFullPipeline is the old full pipeline's name the session waits on
	// (catalog.PipelineOnboarding).
	LegacyFullPipeline string
	// DispatchGrace / SweepLimit override the sweep defaults (tests).
	DispatchGrace time.Duration
	SweepLimit    int
	Logger        *zap.Logger
}

// Service is the first-sync session orchestrator. All mutating entry points
// are idempotent; the sweep makes every path recoverable.
type Service struct {
	store     Store
	enq       job.Enqueuer
	jobs      JobGetter
	runs      RunLister
	jobType   string
	legacyPpl string
	grace     time.Duration
	limit     int
	log       *zap.Logger
}

// New validates the wiring and returns a Service.
func New(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Enqueuer == nil || cfg.Jobs == nil || cfg.Runs == nil {
		return nil, errors.New("onboardingsync: store, enqueuer, jobs and runs are required")
	}
	if cfg.JobType == "" || cfg.LegacyFullPipeline == "" {
		return nil, errors.New("onboardingsync: job type and legacy full pipeline name are required")
	}
	grace, limit := cfg.DispatchGrace, cfg.SweepLimit
	if grace <= 0 {
		grace = DefaultDispatchGrace
	}
	if limit <= 0 {
		limit = DefaultSweepLimit
	}
	log := cfg.Logger
	if log == nil {
		log = logging.Default()
	}
	return &Service{store: cfg.Store, enq: cfg.Enqueuer, jobs: cfg.Jobs, runs: cfg.Runs,
		jobType: cfg.JobType, legacyPpl: cfg.LegacyFullPipeline, grace: grace, limit: limit, log: log}, nil
}

// recentWorkItems derives the server-controlled recent stage windows from the
// fixed anchor day. The anchor is the Shanghai calendar day of the claim; the
// windows are inclusive natural-day ranges (anchor-89..anchor = 90 days of
// activities, anchor-27..anchor = 28 days of health + the dashboard snapshot).
func recentWorkItems(anchor time.Time) map[string][]storage.OnboardingSyncWorkItemSpec {
	actFrom := anchor.AddDate(0, 0, -(DefaultRecentActivityDays - 1)).Format("2006-01-02")
	hlthFrom := anchor.AddDate(0, 0, -(DefaultRecentHealthDays - 1)).Format("2006-01-02")
	to := anchor.Format("2006-01-02")
	return map[string][]storage.OnboardingSyncWorkItemSpec{
		storage.OnboardingSyncStageRecentRaw: {
			{Kind: "activities", RangeFrom: actFrom, RangeTo: to},
			{Kind: "health", RangeFrom: hlthFrom, RangeTo: to},
			{Kind: "dashboard", RangeFrom: to, RangeTo: to},
		},
	}
}

// stageKey builds the stable idempotency key: session, stage, every range,
// and the input (binding) revision are all part of the key, plus the retry
// generation so an explicit retry creates a new job while crash recovery
// within a generation still dedupes to the same one.
func stageKey(stage, sessionID string, bindingRevision int64, retryGen int, items []storage.OnboardingSyncWorkItemSpec) string {
	ranges := make([]string, len(items))
	for i, it := range items {
		ranges[i] = it.Kind + ":" + it.RangeFrom + ".." + it.RangeTo
	}
	sort.Strings(ranges)
	return fmt.Sprintf("onbsync:%s:%s:%s:rev%d:try%d", sessionID, stage, strings.Join(ranges, "|"), bindingRevision, retryGen)
}

// stageInput is the executor job's InputJSON: the session + stage pointer; the
// executor reads the authoritative work items and ranges from the store.
type stageInput struct {
	SessionID string `json:"session_id"`
	Stage     string `json:"stage"`
}

// CreateOrClaim is the POST entry: atomically create or claim the user's
// session for their CURRENT binding, then dispatch (or adopt an in-flight
// legacy full run). A repeat POST for the same binding returns the same
// session without re-dispatching; retry re-arms only unfinished work.
func (s *Service) CreateOrClaim(ctx context.Context, userID, provider string) (*storage.OnboardingSyncSession, error) {
	if provider == "" {
		return nil, ErrNoProvider
	}
	anchor := timefmt.ShanghaiToday()
	items := recentWorkItems(anchor)
	key0 := func() func(stage, sessionID string, bindingRevision int64) string {
		return func(stage, sessionID string, rev int64) string {
			return stageKey(stage, sessionID, rev, 0, items[stage])
		}
	}()
	spec := storage.OnboardingSyncClaimSpec{
		UserID: userID, Provider: provider,
		AnchorDay: anchor.Format("2006-01-02"), AnchorAtUTC: time.Now().UTC(),
		StageNames:     []string{storage.OnboardingSyncStageRecentRaw},
		WorkItems:      items,
		IdempotencyKey: key0,
	}
	claim, err := s.store.ClaimOrCreateOnboardingSyncSession(ctx, spec)
	for attempts := 0; errors.Is(err, storage.ErrOnboardingSyncStaleBinding) && attempts < 3; attempts++ {
		// A rebind raced the claim; retry until the transaction sees a
		// binding row consistent with the caller's provider resolution.
		// Bounded: a permanently-drifted binding row surfaces as an error,
		// never a spin.
		claim, err = s.store.ClaimOrCreateOnboardingSyncSession(ctx, spec)
	}
	if err != nil {
		return nil, err
	}
	if claim.Claimed {
		return claim.Session, nil // same binding → same session, no new work
	}
	// Fresh session: an old full `onboarding` run already in flight is waited
	// on and reconciled — never a duplicate pipeline beside it (AC6).
	if runID := s.inFlightLegacyRun(ctx, userID); runID != "" {
		if err := s.store.RecordOnboardingSyncLegacyRun(ctx, claim.Session.SessionID, runID); err != nil {
			return nil, err
		}
		claim.Session.LegacyRunID = &runID
		claim.Session.State = storage.OnboardingSyncStateWaitingLegacy
		return claim.Session, nil
	}
	if err := s.DispatchSession(ctx, claim.Session.SessionID); err != nil {
		return nil, err
	}
	return claim.Session, nil
}

// inFlightLegacyRun returns the newest queued/running old full onboarding run
// for the user, or "". The store lists runs newest first.
func (s *Service) inFlightLegacyRun(ctx context.Context, userID string) string {
	runs, err := s.runs.PipelineRunsByUser(ctx, userID)
	if err != nil {
		s.log.Warn("onboardingsync: legacy run listing failed", zap.Error(err))
		return ""
	}
	for _, r := range runs { // newest first
		if r.Name == s.legacyPpl && (r.Status == job.StatusQueued || r.Status == job.StatusRunning) {
			return r.RunID
		}
	}
	return ""
}

// Retry re-arms the session's terminally-failed stages under a new
// idempotency-key generation and re-dispatches. Done work items keep their
// fetch credentials — the executor reuses them instead of re-fetching (AC4).
// Pending/dispatched stages are left to the sweep (crash recovery), so a
// retry never runs a second executor beside a live one. Re-entering a
// finished session re-pulls nothing.
func (s *Service) Retry(ctx context.Context, userID string) (*storage.OnboardingSyncSession, error) {
	sess, err := s.store.GetOnboardingSyncSession(ctx, userID)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, ErrNoSession
	}
	// Re-entering a FINISHED session re-pulls nothing (AC4). A failed
	// session is the retry's whole purpose — it must re-arm.
	if sess.State == storage.OnboardingSyncStateCompleted ||
		sess.State == storage.OnboardingSyncStateCompletedWithGaps {
		return sess, nil
	}
	disp, err := s.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	if err != nil {
		return nil, err
	}
	// Only terminally-failed stages re-arm here. Pending/dispatched rows are
	// the sweep's crash-recovery domain — re-enqueueing a still-running
	// stage would run a second executor beside the live one.
	failed := false
	for _, d := range disp {
		if d.Status == storage.OnboardingSyncDispatchFailed {
			failed = true
			break
		}
	}
	if failed {
		anchor, err := time.Parse("2006-01-02", sess.AnchorDay)
		if err != nil {
			return nil, fmt.Errorf("onboardingsync: bad anchor day %q: %w", sess.AnchorDay, err)
		}
		gen, err := s.store.BumpOnboardingSyncRetryCount(ctx, sess.SessionID)
		if err != nil {
			return nil, err
		}
		sess.RetryCount = gen
		items := recentWorkItems(anchor)
		for _, d := range disp {
			if d.Status != storage.OnboardingSyncDispatchFailed {
				continue // successful work is reused; in-flight work is left alone
			}
			key := stageKey(d.Stage, sess.SessionID, sess.BindingRevision, gen, items[d.Stage])
			if err := s.store.RequeueOnboardingSyncDispatchForRetry(ctx, d.ID, key); err != nil {
				return nil, err
			}
			if _, err := s.store.ResetFailedOnboardingSyncWorkItems(ctx, sess.SessionID, d.Stage); err != nil {
				return nil, err
			}
		}
		if err := s.store.SetOnboardingSyncSessionState(ctx, sess.SessionID,
			storage.OnboardingSyncStateDispatching, nil); err != nil {
			return nil, err
		}
		if err := s.DispatchSession(ctx, sess.SessionID); err != nil {
			return nil, err
		}
	}
	if sess, err = s.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID); err != nil {
		return nil, err
	}
	return sess, nil
}

// DispatchSession enqueues every pending dispatch of the session under its
// stable idempotency key and marks it dispatched. A crash leaves the row
// pending — the sweep re-runs this exact path and the key dedupes. Sessions
// waiting on a legacy run or superseded are skipped (the legacy path dispatches
// after the run terminalizes; superseded sessions must not run at all).
func (s *Service) DispatchSession(ctx context.Context, sessionID string) error {
	sess, err := s.store.GetOnboardingSyncSessionByID(ctx, sessionID)
	if err != nil {
		return err
	}
	if sess == nil || sess.State == storage.OnboardingSyncStateSuperseded ||
		sess.State == storage.OnboardingSyncStateWaitingLegacy {
		return nil
	}
	disp, err := s.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	if err != nil {
		return err
	}
	dispatched := false
	for _, d := range disp {
		if d.Status != storage.OnboardingSyncDispatchPending {
			continue
		}
		input, err := json.Marshal(stageInput{SessionID: sess.SessionID, Stage: d.Stage})
		if err != nil {
			return fmt.Errorf("onboardingsync: marshal stage input: %w", err)
		}
		jobID, err := s.enq.Enqueue(ctx, job.EnqueueSpec{
			Type: s.jobType, UserID: sess.UserID,
			InputJSON: string(input), IdempotencyKey: d.IdempotencyKey,
		})
		if errors.Is(err, job.ErrConflict) {
			// A crash between the enqueue and the dispatched-mark: the job
			// exists; adopt it instead of double-enqueueing.
			existing, lookupErr := s.store.JobByIdempotencyKey(ctx, sess.UserID, d.IdempotencyKey)
			if lookupErr != nil {
				return fmt.Errorf("onboardingsync: dispatch conflict resolve: %w", lookupErr)
			}
			jobID = existing.ID
		} else if err != nil {
			// Fail-closed enqueue error: the row stays pending and the sweep
			// retries; report but do not abort the other stages.
			s.log.Warn("onboardingsync: stage enqueue failed; sweep will retry",
				zap.String("session", sess.SessionID), zap.String("stage", d.Stage), zap.Error(err))
			continue
		}
		if err := s.store.MarkOnboardingSyncDispatchDispatched(ctx, d.ID, jobID); err != nil {
			return err
		}
		dispatched = true
		if cov, err := s.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, d.Stage); err != nil {
			return err
		} else if cov != nil {
			cov.Status = storage.OnboardingSyncCoverageRunning
			cov.JobID = &jobID
			if err := s.store.UpdateOnboardingSyncStageCoverage(ctx, cov); err != nil {
				return err
			}
		}
	}
	if dispatched {
		if err := s.store.SetOnboardingSyncSessionState(ctx, sess.SessionID,
			storage.OnboardingSyncStateRunning, nil,
			storage.OnboardingSyncStateDispatching, storage.OnboardingSyncStateRunning); err != nil {
			return err
		}
	}
	return nil
}

// Sweep is the reconcile pass (the worker runs it on a ticker; tests drive it
// directly). It closes every crash window:
//
//   - create/dispatch boundary: pending dispatch rows older than the grace
//     window are re-enqueued (the idempotency key dedupes);
//   - completion boundary: dispatched rows whose job reached a terminal state
//     are recorded, the executor's coverage report persisted, and the session
//     advanced to its terminal state;
//   - legacy adoption: waiting_legacy sessions whose old full run finished
//     dispatch their own stages (对账 after the legacy run — never beside it).
//
// A pass is safe to run concurrently with anything: every transition is a
// guarded update, and every enqueue is idempotent.
func (s *Service) Sweep(ctx context.Context) {
	s.reconcileLegacy(ctx)
	s.sweepPending(ctx)
	s.sweepDispatched(ctx)
}

// reconcileLegacy moves waiting_legacy sessions forward once their legacy full
// run is terminal, then dispatches the session's own stages.
func (s *Service) reconcileLegacy(ctx context.Context) {
	sessions, err := s.store.ListOnboardingSyncSessionsInStates(ctx, []string{storage.OnboardingSyncStateWaitingLegacy}, s.limit)
	if err != nil {
		s.log.Warn("onboardingsync: legacy session scan failed", zap.Error(err))
		return
	}
	for _, sess := range sessions {
		ready := false
		switch {
		case sess.LegacyRunID == nil || *sess.LegacyRunID == "":
			ready = true // defensive: partial write, no run recorded
		default:
			run, err := s.runs.PipelineRunByID(ctx, *sess.LegacyRunID)
			switch {
			case job.IsNotFound(err):
				ready = true // the run vanished (erasure/test cleanup)
			case err != nil:
				s.log.Warn("onboardingsync: legacy run read failed", zap.String("run", *sess.LegacyRunID), zap.Error(err))
				continue
			case run.Status.Terminal():
				ready = true
			}
		}
		if !ready {
			continue // still running: keep waiting, reconcile on the next pass
		}
		if err := s.store.SetOnboardingSyncSessionState(ctx, sess.SessionID,
			storage.OnboardingSyncStateDispatching, nil); err != nil {
			s.log.Warn("onboardingsync: legacy session advance failed", zap.Error(err))
			continue
		}
		if err := s.DispatchSession(ctx, sess.SessionID); err != nil {
			s.log.Warn("onboardingsync: post-legacy dispatch failed", zap.String("session", sess.SessionID), zap.Error(err))
		}
	}
}

// sweepPending re-enqueues crash-stranded pending dispatches.
func (s *Service) sweepPending(ctx context.Context) {
	rows, err := s.store.ListPendingOnboardingSyncDispatches(ctx, s.grace, s.limit)
	if err != nil {
		s.log.Warn("onboardingsync: pending dispatch scan failed", zap.Error(err))
		return
	}
	seen := map[string]bool{}
	for _, d := range rows {
		if seen[d.SessionID] {
			continue
		}
		seen[d.SessionID] = true
		if err := s.DispatchSession(ctx, d.SessionID); err != nil {
			s.log.Warn("onboardingsync: pending re-dispatch failed", zap.String("session", d.SessionID), zap.Error(err))
		}
	}
}

// sweepDispatched observes terminal jobs and records the completion boundary.
func (s *Service) sweepDispatched(ctx context.Context) {
	rows, err := s.store.ListDispatchedOnboardingSyncDispatches(ctx, s.limit)
	if err != nil {
		s.log.Warn("onboardingsync: dispatched scan failed", zap.Error(err))
		return
	}
	for _, d := range rows {
		if d.JobID == nil {
			continue
		}
		j, err := s.jobs.JobByID(ctx, *d.JobID)
		if job.IsNotFound(err) {
			// The job vanished without a terminal record — re-arm as pending
			// so the dispatch boundary heals under the same key.
			if err := s.store.RequeueOnboardingSyncDispatchForRetry(ctx, d.ID, d.IdempotencyKey); err != nil {
				s.log.Warn("onboardingsync: vanished-job requeue failed", zap.Error(err))
			}
			continue
		}
		if err != nil {
			s.log.Warn("onboardingsync: job read failed", zap.String("job", *d.JobID), zap.Error(err))
			continue
		}
		if !j.Status.Terminal() {
			// Rotate the row to the back of the bounded oldest-first window
			// so a long-running stage cannot starve younger rows.
			if err := s.store.TouchOnboardingSyncDispatch(ctx, d.ID); err != nil {
				s.log.Warn("onboardingsync: dispatch touch failed", zap.Error(err))
			}
			continue
		}
		switch j.Status {
		case job.StatusDone:
			if err := s.store.MarkOnboardingSyncDispatchTerminal(ctx, d.ID, storage.OnboardingSyncDispatchDone); err != nil {
				s.log.Warn("onboardingsync: dispatch done mark failed", zap.Error(err))
				continue
			}
			s.applyStageResult(ctx, d, j)
		case job.StatusFailed:
			if err := s.store.MarkOnboardingSyncDispatchTerminal(ctx, d.ID, storage.OnboardingSyncDispatchFailed); err != nil {
				s.log.Warn("onboardingsync: dispatch failed mark failed", zap.Error(err))
				continue
			}
			s.failStage(ctx, d, j.ErrorMessage)
		}
	}
	s.finalizeSessions(ctx)
}

// applyStageResult persists the executor's coverage report onto the stage
// coverage row (scanned/observed/gaps stay separate; a report that carries no
// observed window never reads as coverage).
func (s *Service) applyStageResult(ctx context.Context, d *storage.OnboardingSyncDispatch, j *job.Job) {
	cov, err := s.store.GetOnboardingSyncStageCoverage(ctx, d.SessionID, d.Stage)
	if err != nil {
		s.log.Warn("onboardingsync: coverage read failed", zap.String("session", d.SessionID), zap.Error(err))
		return
	}
	if cov == nil {
		return
	}
	cov.Status = storage.OnboardingSyncCoverageCompleted
	var res StageResult
	if json.Unmarshal([]byte(j.ResultJSON), &res) == nil && res.Stage == d.Stage {
		if res.Status == storage.OnboardingSyncCoverageCompletedWithGaps {
			cov.Status = storage.OnboardingSyncCoverageCompletedWithGaps
		}
		cov.ScannedFrom, cov.ScannedTo = res.ScannedFrom, res.ScannedTo
		cov.ObservedFrom, cov.ObservedTo = res.ObservedFrom, res.ObservedTo
		if len(res.Gaps) > 0 {
			if b, err := json.Marshal(res.Gaps); err == nil {
				str := string(b)
				cov.GapsJSON = &str
			}
		}
	}
	if err := s.store.UpdateOnboardingSyncStageCoverage(ctx, cov); err != nil {
		s.log.Warn("onboardingsync: coverage update failed", zap.String("session", d.SessionID), zap.Error(err))
	}
}

// failStage records a stage's terminal failure on the coverage row and flags
// the session failed (retryable through POST {"retry":true}).
func (s *Service) failStage(ctx context.Context, d *storage.OnboardingSyncDispatch, msg string) {
	if cov, err := s.store.GetOnboardingSyncStageCoverage(ctx, d.SessionID, d.Stage); err == nil && cov != nil {
		m := msg
		if m == "" {
			m = "stage job failed"
		}
		cov.Status = storage.OnboardingSyncCoverageFailed
		cov.LastError = &m
		if err := s.store.UpdateOnboardingSyncStageCoverage(ctx, cov); err != nil {
			s.log.Warn("onboardingsync: coverage failure update failed", zap.Error(err))
		}
	}
	m := msg
	if m == "" {
		m = "stage job failed"
	}
	if err := s.store.SetOnboardingSyncSessionState(ctx, d.SessionID,
		storage.OnboardingSyncStateFailed, &m); err != nil {
		s.log.Warn("onboardingsync: session failure mark failed", zap.Error(err))
	}
}

// finalizeSessions advances non-terminal sessions whose dispatches are ALL
// terminal to their terminal state: failed if any dispatch failed, else
// completed / completed_with_gaps by the coverage rows' worst outcome.
func (s *Service) finalizeSessions(ctx context.Context) {
	sessions, err := s.store.ListOnboardingSyncSessionsInStates(ctx,
		[]string{storage.OnboardingSyncStateRunning, storage.OnboardingSyncStateDispatching}, s.limit)
	if err != nil {
		s.log.Warn("onboardingsync: finalize scan failed", zap.Error(err))
		return
	}
	for _, sess := range sessions {
		disp, err := s.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
		if err != nil {
			continue
		}
		if len(disp) == 0 {
			continue
		}
		allTerminal, anyFailed := true, false
		for _, d := range disp {
			switch d.Status {
			case storage.OnboardingSyncDispatchDone:
			case storage.OnboardingSyncDispatchFailed:
				anyFailed = true
			default:
				allTerminal = false
			}
		}
		if !allTerminal {
			// Mid-flight: rotate the row to the back of the bounded
			// oldest-first window so it cannot starve younger sessions.
			if err := s.store.TouchOnboardingSyncSession(ctx, sess.SessionID); err != nil {
				s.log.Warn("onboardingsync: session touch failed", zap.Error(err))
			}
			continue
		}
		if anyFailed {
			// The failed stage already wrote its reason onto the session.
			continue
		}
		covs, err := s.store.ListOnboardingSyncStageCoverage(ctx, sess.SessionID)
		if err != nil {
			continue
		}
		state := storage.OnboardingSyncStateCompleted
		for _, cov := range covs {
			if cov.Status == storage.OnboardingSyncCoverageCompletedWithGaps {
				state = storage.OnboardingSyncStateCompletedWithGaps
			}
		}
		if err := s.store.SetOnboardingSyncSessionState(ctx, sess.SessionID, state, nil); err != nil {
			s.log.Warn("onboardingsync: session finalize failed", zap.Error(err))
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness view (GET)
// ─────────────────────────────────────────────────────────────────────────────

// Readiness is one stage's user-facing readiness level.
type Readiness string

const (
	ReadinessNotStarted    Readiness = "not_started"
	ReadinessPending       Readiness = "pending"
	ReadinessRunning       Readiness = "running"
	ReadinessReady         Readiness = "ready"
	ReadinessReadyWithGaps Readiness = "ready_with_gaps"
	ReadinessFailed        Readiness = "failed"
)

// StageView is one stage's GET projection: target / scanned / observed kept
// separate, gaps listed, readiness derived (never asserted).
type StageView struct {
	Stage        string     `json:"stage"`
	Status       string     `json:"status"`
	Readiness    Readiness  `json:"readiness"`
	TargetFrom   string     `json:"target_from"`
	TargetTo     string     `json:"target_to"`
	ScannedFrom  *string    `json:"scanned_from,omitempty"`
	ScannedTo    *string    `json:"scanned_to,omitempty"`
	ObservedFrom *string    `json:"observed_from,omitempty"`
	ObservedTo   *string    `json:"observed_to,omitempty"`
	Gaps         []StageGap `json:"gaps,omitempty"`
	JobID        *string    `json:"job_id,omitempty"`
	Error        *string    `json:"error,omitempty"`
}

// View is the GET body: the session plus the readiness flags the client polls.
// shell_ready, recent_data and friends are DERIVED here — nothing upstream may
// assert them. recent_analysis / historical_* / auxiliary stay not_started
// until their owning tickets (T05/T06) land executors; an executor-less stage
// is never reported ready (不假报近期数据ready).
type View struct {
	SessionID       string        `json:"session_id"`
	State           string        `json:"state"`
	ShellReady      bool          `json:"shell_ready"`
	Provider        string        `json:"provider"`
	BindingRevision int64         `json:"binding_revision"`
	AnchorDay       string        `json:"anchor_day"`
	LegacyRunID     *string       `json:"legacy_run_id,omitempty"`
	RetryCount      int           `json:"retry_count"`
	Error           *string       `json:"error,omitempty"`
	Stages          []StageView   `json:"stages"`
	Readiness       ViewReadiness `json:"readiness"`
	CreatedAt       time.Time     `json:"created_at"`
	UpdatedAt       time.Time     `json:"updated_at"`
}

// ViewReadiness is the summary the client surfaces. Each field is one of the
// Readiness levels.
type ViewReadiness struct {
	ShellReady         bool      `json:"shell_ready"`
	RecentData         Readiness `json:"recent_data"`
	RecentAnalysis     Readiness `json:"recent_analysis"`
	HistoricalData     Readiness `json:"historical_data"`
	HistoricalAnalysis Readiness `json:"historical_analysis"`
	Auxiliary          Readiness `json:"auxiliary"`
}

// View assembles the read-only session projection for a user, or
// ErrNoSession. It performs no writes whatsoever (GET 严格只读).
func (s *Service) View(ctx context.Context, userID string) (*View, error) {
	sess, err := s.store.GetOnboardingSyncSession(ctx, userID)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, ErrNoSession
	}
	covs, err := s.store.ListOnboardingSyncStageCoverage(ctx, sess.SessionID)
	if err != nil {
		return nil, err
	}
	disp, err := s.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	if err != nil {
		return nil, err
	}
	dispByStage := map[string]*storage.OnboardingSyncDispatch{}
	for _, d := range disp {
		dispByStage[d.Stage] = d
	}
	v := &View{
		SessionID: sess.SessionID, State: sess.State, ShellReady: sess.ShellReady,
		Provider: sess.Provider, BindingRevision: sess.BindingRevision,
		AnchorDay: sess.AnchorDay, LegacyRunID: sess.LegacyRunID,
		RetryCount: sess.RetryCount, Error: sess.LastError,
		CreatedAt: sess.CreatedAt, UpdatedAt: sess.UpdatedAt,
		Readiness: ViewReadiness{ShellReady: sess.ShellReady,
			RecentData: ReadinessPending, RecentAnalysis: ReadinessNotStarted,
			HistoricalData: ReadinessNotStarted, HistoricalAnalysis: ReadinessNotStarted,
			Auxiliary: ReadinessNotStarted},
	}
	for _, cov := range covs {
		sv := StageView{
			Stage: cov.Stage, Status: cov.Status,
			TargetFrom: cov.TargetFrom, TargetTo: cov.TargetTo,
			ScannedFrom: cov.ScannedFrom, ScannedTo: cov.ScannedTo,
			ObservedFrom: cov.ObservedFrom, ObservedTo: cov.ObservedTo,
			JobID: cov.JobID, Error: cov.LastError,
		}
		if cov.GapsJSON != nil {
			_ = json.Unmarshal([]byte(*cov.GapsJSON), &sv.Gaps)
		}
		if d, ok := dispByStage[cov.Stage]; ok {
			if d.Status == storage.OnboardingSyncDispatchFailed {
				sv.Status = storage.OnboardingSyncCoverageFailed
			}
		}
		sv.Readiness = stageReadiness(cov)
		v.Stages = append(v.Stages, sv)
		if cov.Stage == storage.OnboardingSyncStageRecentRaw {
			v.Readiness.RecentData = sv.Readiness
		}
	}
	if sess.State == storage.OnboardingSyncStateWaitingLegacy {
		v.Readiness.RecentData = ReadinessPending
	}
	return v, nil
}

// stageReadiness derives one stage's readiness from its coverage row:
// ready requires a COMPLETED scan whose observed window actually covers the
// target and no recorded gaps; ready_with_gaps is terminal but not coverage.
func stageReadiness(cov *storage.OnboardingSyncStageCoverage) Readiness {
	switch cov.Status {
	case storage.OnboardingSyncCoverageCompleted:
		if cov.ObservedFrom == nil || cov.ObservedTo == nil {
			return ReadinessRunning // done scan, no observation yet: not ready
		}
		if *cov.ObservedFrom > cov.TargetFrom || *cov.ObservedTo < cov.TargetTo {
			return ReadinessRunning // observation does not cover the target
		}
		if cov.GapsJSON != nil && *cov.GapsJSON != "" && *cov.GapsJSON != "[]" {
			return ReadinessReadyWithGaps
		}
		return ReadinessReady
	case storage.OnboardingSyncCoverageCompletedWithGaps:
		return ReadinessReadyWithGaps
	case storage.OnboardingSyncCoverageFailed:
		return ReadinessFailed
	case storage.OnboardingSyncCoverageRunning:
		return ReadinessRunning
	default: // pending
		return ReadinessPending
	}
}
