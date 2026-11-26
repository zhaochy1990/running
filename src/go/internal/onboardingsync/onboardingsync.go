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
// dispatch generation), and the sweep's re-enqueue dedupes against the original
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
	"github.com/zhaochy1990/stride/internal/provider"
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

// Background backfill window defaults (devops#1010, epic devops#1004 T06):
// after the recent stages complete, the extended stage widens activities to
// 180 and health to 90 obtainable days; the historical stage then walks every
// activity the provider still serves plus, for Garmin, health up to 365 days
// (COROS's batch endpoint returns one fixed window — it only declares what it
// actually returned, so the historical stage carries no COROS health item).
const (
	DefaultExtendedActivityDays = 180
	DefaultExtendedHealthDays   = 90
	DefaultHistoricalHealthDays = 365
)

// historyFloorDay is the open-ended activities window's lower bound: consumer
// GPS history predating it is not plausible (Garmin treats pre-2000 starts as
// unclassifiable), so the historical activities window is "everything from
// 2000-01-01 to the extended window's lower edge" — the walk still stops only
// on the vendor list's end or a proven boundary, never on the floor itself.
const historyFloorDay = "2000-01-01"

// StageStatusInProgress is the StageResult status a chunked stage's executor
// returns when its budget ran out with work remaining (devops#1010): the job
// SUCCEEDED (its chunk's writes are durable), the coverage row stays running,
// and the sweep requeues the dispatch for the next chunk. A plain "completed"
// result from a mid-history chunk would be 假完成 — exactly what this status
// exists to prevent.
const StageStatusInProgress = "in_progress"

// maxChunkSeq bounds a chunked stage's continuations. Each chunk advances a
// durable checkpoint or completes, so a healthy stage stays far below this;
// the bound exists so a pathological no-progress loop surfaces as a failed
// stage instead of spinning forever (AC4 不无限空转).
const maxChunkSeq = 5000

// Sweep defaults: dispatch rows pending longer than dispatchGrace are crash
// leftovers (the enqueue raced a crash) and are re-sent; each sweep pass
// observes at most sweepLimit dispatches.
const (
	DefaultDispatchGrace = 2 * time.Minute
	DefaultSweepLimit    = 100
)

// Analysis constants (devops#1009, T05). AnalysisDigestLookbackDays is the
// input window the fingerprint digests (matches compute's 365-day PMC window;
// the extra recent day the top-up may add is covered by the day-granular
// bounds). DefaultAnalysisRefreshHorizon bounds how long after session creation
// a changed fingerprint still auto-refreshes the published analysis: beyond it
// the standing sync pipelines (data_sync runs calibration+compute+ability on
// every sync) own freshness, so the onboarding session cannot become a
// permanent per-user daily job.
const (
	AnalysisDigestLookbackDays    = 364
	DefaultAnalysisRefreshHorizon = 72 * time.Hour
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
	MarkOnboardingSyncDispatchDispatched(ctx context.Context, d *storage.OnboardingSyncDispatch, jobID string) (bool, error)
	MarkOnboardingSyncDispatchDone(ctx context.Context, id int64, jobID string) (bool, error)
	RecordOnboardingSyncDispatchFailure(ctx context.Context, d *storage.OnboardingSyncDispatch, message string) error
	TouchOnboardingSyncDispatch(ctx context.Context, id int64) error
	RetryFailedOnboardingSyncDispatches(ctx context.Context, sessionID string, failed []*storage.OnboardingSyncDispatch, keyFor func(stage string, generation int) string) (bool, error)
	RecoverMissingOnboardingSyncJob(ctx context.Context, id int64, jobID string) error
	RefreshOnboardingSyncAnalysis(ctx context.Context, d *storage.OnboardingSyncDispatch, keyFor func(generation int) string) (bool, error)
	ListOnboardingSyncWorkItems(ctx context.Context, sessionID, stage string) ([]*storage.OnboardingSyncWorkItem, error)
	GetOnboardingSyncStageCoverage(ctx context.Context, sessionID, stage string) (*storage.OnboardingSyncStageCoverage, error)
	ListOnboardingSyncStageCoverage(ctx context.Context, sessionID string) ([]*storage.OnboardingSyncStageCoverage, error)
	UpdateOnboardingSyncStageCoverage(ctx context.Context, cov *storage.OnboardingSyncStageCoverage) error
	ListOnboardingSyncSessionsInStates(ctx context.Context, states []string, limit int) ([]*storage.OnboardingSyncSession, error)
	JobByIdempotencyKey(ctx context.Context, userID, key string) (*job.Job, error)
	// T05 (devops#1009): the analysis stage's post-raw advance + the
	// changed-input refresh sweep.
	EnsureOnboardingSyncStage(ctx context.Context, sessionID, stage, targetFrom, targetTo, idempotencyKey string) error
	RequeueOnboardingSyncDispatchChunk(ctx context.Context, id int64, idempotencyKey string) error
	AddOnboardingSyncStage(ctx context.Context, sessionID, stage, idempotencyKey string, items []storage.OnboardingSyncWorkItemSpec) (bool, error)
	GetOnboardingRecentAnalysis(ctx context.Context, sessionID string) (*storage.OnboardingRecentAnalysis, error)
	OnboardingAnalysisDigest(ctx context.Context, userID, fromDay, toDay string) (storage.OnboardingAnalysisDigest, error)
	CalibrationPolicy(ctx context.Context) (storage.RunningCalibrationPolicy, error)
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
	// JobType is the recent-raw stage-executor job type (injected from catalog
	// so this package stays decoupled, mirroring the api package's pattern).
	JobType string
	// AnalysisJobType is the recent-analysis stage-executor job type
	// (devops#1009). Required: the sweep arms the analysis stage as soon as it
	// arms the raw one.
	AnalysisJobType string
	// LegacyFullPipeline is the old full pipeline's name the session waits on
	// (catalog.PipelineOnboarding).
	LegacyFullPipeline string
	// DispatchGrace / SweepLimit override the sweep defaults (tests).
	DispatchGrace time.Duration
	SweepLimit    int
	// AnalysisRefreshHorizon overrides DefaultAnalysisRefreshHorizon (tests).
	AnalysisRefreshHorizon time.Duration
	Logger                 *zap.Logger
	HistoricalAuto         bool
	HistoricalPublisher    job.Publisher
	HistoricalReplayAge    time.Duration
}

// Service is the first-sync session orchestrator. All mutating entry points
// are idempotent; the sweep makes every path recoverable.
type Service struct {
	store               Store
	enq                 job.Enqueuer
	jobs                JobGetter
	runs                RunLister
	jobType             string
	analysisJobType     string
	legacyPpl           string
	grace               time.Duration
	limit               int
	refreshHorizon      time.Duration
	log                 *zap.Logger
	historical          historicalStore
	historicalAuto      bool
	historicalPublisher job.Publisher
	historicalReplayAge time.Duration
}

// New validates the wiring and returns a Service.
func New(cfg Config) (*Service, error) {
	if cfg.Store == nil || cfg.Enqueuer == nil || cfg.Jobs == nil || cfg.Runs == nil {
		return nil, errors.New("onboardingsync: store, enqueuer, jobs and runs are required")
	}
	if cfg.JobType == "" || cfg.LegacyFullPipeline == "" {
		return nil, errors.New("onboardingsync: job type and legacy full pipeline name are required")
	}
	if cfg.AnalysisJobType == "" {
		return nil, errors.New("onboardingsync: analysis job type is required")
	}
	grace, limit := cfg.DispatchGrace, cfg.SweepLimit
	if grace <= 0 {
		grace = DefaultDispatchGrace
	}
	if limit <= 0 {
		limit = DefaultSweepLimit
	}
	horizon := cfg.AnalysisRefreshHorizon
	if horizon <= 0 {
		horizon = DefaultAnalysisRefreshHorizon
	}
	log := cfg.Logger
	if log == nil {
		log = logging.Default()
	}
	historical, _ := cfg.Store.(historicalStore)
	return &Service{historical: historical, historicalAuto: cfg.HistoricalAuto, historicalPublisher: cfg.HistoricalPublisher, historicalReplayAge: max(5*time.Minute, cfg.HistoricalReplayAge), store: cfg.Store, enq: cfg.Enqueuer, jobs: cfg.Jobs, runs: cfg.Runs,
		jobType: cfg.JobType, analysisJobType: cfg.AnalysisJobType,
		legacyPpl: cfg.LegacyFullPipeline, grace: grace, limit: limit,
		refreshHorizon: horizon, log: log}, nil
}

// jobTypeFor maps a stage onto its executor job type.
func (s *Service) jobTypeFor(stage string) string {
	if stage == storage.OnboardingSyncStageRecentAnalysis {
		return s.analysisJobType
	}
	return s.jobType
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

// StageNames is the session's ordered stage chain (devops#1009 + devops#1010):
// recent first (T02-T04), then the recent analysis (T05), then the background
// backfill — extended, historical, auxiliary (T06). recent_analysis's rows are
// created by the arm pass (advanceStages) once recent_raw terminalizes; each
// later stage is created by advanceBackfillStages once its predecessor's
// coverage is terminal, so the interactive recent path is never queued behind
// the user's whole history and a stage's failure never retracts the stages
// below it (历史失败不撤回近期数据).
func StageNames() []string {
	return []string{
		storage.OnboardingSyncStageRecentRaw,
		storage.OnboardingSyncStageRecentAnalysis,
		storage.OnboardingSyncStageExtendedRaw,
		storage.OnboardingSyncStageHistoricalRaw,
		storage.OnboardingSyncStageAuxiliary,
	}
}

// chunkedStage reports whether a stage executes in bounded chunks whose
// in_progress results the backfill advance pass continues (devops#1010). The
// recent and analysis stages are single-shot; their dispatch lifecycle is
// owned by the claim and the refresh pass respectively.
func chunkedStage(stage string) bool {
	switch stage {
	case storage.OnboardingSyncStageExtendedRaw, storage.OnboardingSyncStageHistoricalRaw, storage.OnboardingSyncStageAuxiliary:
		return true
	}
	return false
}

// sessionStageItems builds every follow-on stage's work items for one
// provider/anchor — the item sets AddOnboardingSyncStage persists when the
// sweep chains the stage. Windows are the COMPLEMENT of what earlier stages
// already cover (backfill channels skip already-stored rows, but disjoint
// windows keep the vendor walk honest and the coverage rows readable).
func sessionStageItems(providerName string, anchor time.Time) map[string][]storage.OnboardingSyncWorkItemSpec {
	day := func(n int) string { return anchor.AddDate(0, 0, -n).Format("2006-01-02") }
	items := map[string][]storage.OnboardingSyncWorkItemSpec{
		storage.OnboardingSyncStageExtendedRaw: {
			// anchor-179..anchor-90: the 180-day activity target minus the
			// recent stage's 90 days.
			{Kind: storage.OnboardingSyncItemKindActivities, RangeFrom: day(DefaultExtendedActivityDays - 1), RangeTo: day(DefaultRecentActivityDays)},
			// anchor-89..anchor-28: health to 90 days minus the recent 28.
			{Kind: storage.OnboardingSyncItemKindHealth, RangeFrom: day(DefaultExtendedHealthDays - 1), RangeTo: day(DefaultRecentHealthDays)},
		},
		storage.OnboardingSyncStageHistoricalRaw: {
			// Every activity the provider still serves below the extended
			// window (the walk stops at the vendor list's end, not the floor).
			{Kind: storage.OnboardingSyncItemKindActivities, RangeFrom: historyFloorDay, RangeTo: day(DefaultExtendedActivityDays)},
		},
		storage.OnboardingSyncStageAuxiliary: {
			{Kind: storage.OnboardingSyncItemKindRaceDetection, RangeFrom: historyFloorDay, RangeTo: day(0)},
			{Kind: storage.OnboardingSyncItemKindRouteShapes, RangeFrom: historyFloorDay, RangeTo: day(0)},
		},
	}
	// Garmin health extends to 365 days (anchor-364..anchor-90). COROS's batch
	// endpoint has no per-day walk and no year window — it only ever declares
	// the days its single batch actually returned (COROS 只声明实际可得范围).
	if providerName == "garmin" {
		items[storage.OnboardingSyncStageHistoricalRaw] = append(
			items[storage.OnboardingSyncStageHistoricalRaw],
			storage.OnboardingSyncWorkItemSpec{Kind: storage.OnboardingSyncItemKindHealth, RangeFrom: day(DefaultHistoricalHealthDays - 1), RangeTo: day(DefaultExtendedHealthDays)},
		)
	}
	return items
}

// stageKey builds the stable idempotency key: session, stage, every range,
// and the input (binding) revision are all part of the key, plus the dispatch
// generation so an explicit retry creates a new job while crash recovery
// within a generation still dedupes to the same one.
func stageKey(stage, sessionID string, bindingRevision int64, generation, chunk int, items []storage.OnboardingSyncWorkItemSpec) string {
	ranges := make([]string, len(items))
	for i, it := range items {
		ranges[i] = it.Kind + ":" + it.RangeFrom + ".." + it.RangeTo
	}
	sort.Strings(ranges)
	key := fmt.Sprintf("%s%s:%s:%s:rev%d:try%d", storage.OnboardingSyncJobKeyPrefix, sessionID, stage, strings.Join(ranges, "|"), bindingRevision, generation)
	if chunk > 0 {
		key += fmt.Sprintf(":c%d", chunk)
	}
	return key
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
			return stageKey(stage, sessionID, rev, 0, 0, items[stage])
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
	var failed []*storage.OnboardingSyncDispatch
	for _, d := range disp {
		if d.Status == storage.OnboardingSyncDispatchFailed {
			failed = append(failed, d)
		}
	}
	if len(failed) > 0 {
		anchor, err := time.Parse("2006-01-02", sess.AnchorDay)
		if err != nil {
			return nil, fmt.Errorf("onboardingsync: bad anchor day %q: %w", sess.AnchorDay, err)
		}
		items := sessionStageItems(sess.Provider, anchor)
		items[storage.OnboardingSyncStageRecentRaw] = recentWorkItems(anchor)[storage.OnboardingSyncStageRecentRaw]
		requeued, err := s.store.RetryFailedOnboardingSyncDispatches(ctx, sess.SessionID, failed,
			func(stage string, generation int) string {
				return stageKey(stage, sess.SessionID, sess.BindingRevision, generation, 0, items[stage])
			})
		if err != nil {
			return nil, err
		}
		if requeued {
			if err := s.DispatchSession(ctx, sess.SessionID); err != nil {
				return nil, err
			}
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
			Type: s.jobTypeFor(d.Stage), UserID: sess.UserID,
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
		marked, err := s.store.MarkOnboardingSyncDispatchDispatched(ctx, d, jobID)
		if err != nil {
			return err
		}
		dispatched = dispatched || marked
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
//   - stage advance (devops#1009): once recent_raw terminalizes with data, the
//     recent_analysis stage rows are armed and dispatched — analysis readiness
//     is independent of raw, but its run strictly follows raw;
//   - changed-input refresh (devops#1009): a published analysis whose pinned
//     fingerprint no longer matches the current inputs is superseded by one
//     merged refresh (stale flag first, then a new-generation dispatch);
//   - legacy adoption: waiting_legacy sessions whose old full run finished
//     dispatch their own stages (对账 after the legacy run — never beside it).
//
// A pass is safe to run concurrently with anything: every transition is a
// guarded update, and every enqueue is idempotent.
func (s *Service) Sweep(ctx context.Context) {
	s.reconcileLegacy(ctx)
	s.sweepPending(ctx)
	s.sweepDispatched(ctx)
	s.advanceStages(ctx)         // arms recent_analysis once recent_raw terminalized (devops#1009)
	s.advanceBackfillStages(ctx) // chunk continuation + background stage chain (devops#1010)
	s.finalizeSessions(ctx)
	s.sweepAnalysisRefresh(ctx)
	s.sweepHistoricalAnalysis(ctx)
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
			if err := s.store.RecoverMissingOnboardingSyncJob(ctx, d.ID, *d.JobID); err != nil {
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
			current, err := s.store.MarkOnboardingSyncDispatchDone(ctx, d.ID, j.ID)
			if err != nil {
				s.log.Warn("onboardingsync: dispatch done mark failed", zap.Error(err))
			} else if current {
				s.applyStageResult(ctx, d, j)
			}
		case job.StatusFailed:
			if err := s.store.RecordOnboardingSyncDispatchFailure(ctx, d, j.ErrorMessage); err != nil {
				s.log.Warn("onboardingsync: record dispatch failure failed", zap.Error(err))
			}
		}
	}
}

// applyStageResult persists the executor's coverage report onto the stage
// coverage row (scanned/observed/gaps stay separate; a report that carries no
// observed window never reads as coverage). The job's terminal success
// supersedes whatever an earlier failed attempt left on the row: the stale
// error note and gap record must not outlive the retry that replaced them
// (devops#1008 D2 — a completed stage never reads as still carrying its
// first-attempt failure).
func (s *Service) applyStageResult(ctx context.Context, d *storage.OnboardingSyncDispatch, j *job.Job) {
	ApplyStageResult(ctx, s.store, d.SessionID, d.Stage, j.ResultJSON, s.log)
}

// StageCoverageStore is the minimal surface ApplyStageResult needs; satisfied
// by Store and by the recent-analysis executor's narrower Store.
type StageCoverageStore interface {
	GetOnboardingSyncStageCoverage(ctx context.Context, sessionID, stage string) (*storage.OnboardingSyncStageCoverage, error)
	UpdateOnboardingSyncStageCoverage(ctx context.Context, cov *storage.OnboardingSyncStageCoverage) error
}

// ApplyStageResult is the exported form of the sweep's completion-boundary
// write: it persists an executor's StageResult JSON onto the stage coverage
// row. The recent-analysis executor (devops#1009) reuses it to apply its
// cross-midnight raw top-up result — the same idempotent write the sweep
// performs at the raw stage's own completion boundary.
func ApplyStageResult(ctx context.Context, store StageCoverageStore, sessionID, stage, resultJSON string, log *zap.Logger) {
	if log == nil {
		log = logging.Default()
	}
	cov, err := store.GetOnboardingSyncStageCoverage(ctx, sessionID, stage)
	if err != nil {
		log.Warn("onboardingsync: coverage read failed", zap.String("session", sessionID), zap.Error(err))
		return
	}
	if cov == nil {
		return
	}
	var res StageResult
	parsed := json.Unmarshal([]byte(resultJSON), &res) == nil && res.Stage == stage
	if parsed && res.Status == StageStatusInProgress {
		// A bounded chunk finished with work remaining (devops#1010): the
		// stage is NOT complete — keep the coverage running with the chunk's
		// progress visible (scanned/observed so far, gaps so far) and let
		// the backfill advance pass arm the next chunk. Reporting completed
		// here would be exactly the 假完成 AC4 forbids.
		cov.Status = storage.OnboardingSyncCoverageRunning
		cov.LastError = nil
		cov.ScannedFrom, cov.ScannedTo = res.ScannedFrom, res.ScannedTo
		cov.ObservedFrom, cov.ObservedTo = res.ObservedFrom, res.ObservedTo
		var gaps []StageGap
		if cov.GapsJSON != nil {
			_ = json.Unmarshal([]byte(*cov.GapsJSON), &gaps)
		}
		gaps = mergeStageGaps(gaps, res.Gaps)
		if len(gaps) > 0 {
			if b, err := json.Marshal(gaps); err == nil {
				str := string(b)
				cov.GapsJSON = &str
			}
		}
		if err := store.UpdateOnboardingSyncStageCoverage(ctx, cov); err != nil {
			log.Warn("onboardingsync: coverage update failed", zap.String("session", sessionID), zap.Error(err))
		}
		return
	}
	cov.Status = storage.OnboardingSyncCoverageCompleted
	cov.LastError = nil
	cov.GapsJSON = nil
	if parsed {
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
	if err := store.UpdateOnboardingSyncStageCoverage(ctx, cov); err != nil {
		log.Warn("onboardingsync: coverage update failed", zap.String("session", sessionID), zap.Error(err))
	}
}

// mergeStageGaps merges a chunk's gap events into the running set (dedup by
// from/to/reason identity; chunk retries can legitimately re-observe the same
// permanent gap, and the running record must not stack duplicates).
func mergeStageGaps(running, chunk []StageGap) []StageGap {
	seen := map[string]bool{}
	for _, g := range running {
		seen[g.From+".."+g.To+"|"+g.Reason] = true
	}
	for _, g := range chunk {
		k := g.From + ".." + g.To + "|" + g.Reason
		if seen[k] {
			continue
		}
		seen[k] = true
		running = append(running, g)
	}
	return running
}

// failStage records an exhausted chunk continuation on coverage and the session.
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
			if cov.Status != storage.OnboardingSyncCoverageCompleted &&
				cov.Status != storage.OnboardingSyncCoverageCompletedWithGaps {
				// A stage whose coverage never reached a terminal outcome must
				// not be finalized away, even if every dispatch row happens to
				// read terminal (e.g. a chunk requeue write that failed
				// transiently) — the advance pass re-arms it. This is the
				// anti-fake-completion backstop of devops#1010 AC4.
				state = ""
				break
			}
			if cov.Status == storage.OnboardingSyncCoverageCompletedWithGaps {
				state = storage.OnboardingSyncStateCompletedWithGaps
			}
		}
		if state == "" {
			continue
		}
		if err := s.store.SetOnboardingSyncSessionState(ctx, sess.SessionID, state, nil); err != nil {
			s.log.Warn("onboardingsync: session finalize failed", zap.Error(err))
		}
	}
}

// advanceStages arms the recent_analysis stage (devops#1009) for every
// non-terminal session whose recent_raw coverage terminalized WITH data
// (completed / completed_with_gaps — a failed raw stage is retried first, the
// analysis never runs beside an unfinished raw scan). Creating the rows here —
// not at claim time — makes the dependency structural: no analysis dispatch
// row can exist while raw is still pending. Idempotent; a crash between the
// row creation and the dispatch is healed by the pending sweep.
func (s *Service) advanceStages(ctx context.Context) {
	sessions, err := s.store.ListOnboardingSyncSessionsInStates(ctx,
		[]string{storage.OnboardingSyncStateDispatching, storage.OnboardingSyncStateRunning}, s.limit)
	if err != nil {
		s.log.Warn("onboardingsync: advance scan failed", zap.Error(err))
		return
	}
	for _, sess := range sessions {
		disp, err := s.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
		if err != nil {
			continue
		}
		hasAnalysis := false
		for _, d := range disp {
			if d.Stage == storage.OnboardingSyncStageRecentAnalysis {
				hasAnalysis = true
				break
			}
		}
		if hasAnalysis {
			continue
		}
		rawCov, err := s.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
		if err != nil || rawCov == nil {
			continue
		}
		if rawCov.Status != storage.OnboardingSyncCoverageCompleted &&
			rawCov.Status != storage.OnboardingSyncCoverageCompletedWithGaps {
			continue
		}
		key := stageKey(storage.OnboardingSyncStageRecentAnalysis, sess.SessionID,
			sess.BindingRevision, sess.DispatchGeneration, 0, nil)
		if err := s.store.EnsureOnboardingSyncStage(ctx, sess.SessionID,
			storage.OnboardingSyncStageRecentAnalysis, rawCov.TargetFrom, rawCov.TargetTo, key); err != nil {
			s.log.Warn("onboardingsync: analysis stage arm failed",
				zap.String("session", sess.SessionID), zap.Error(err))
			continue
		}
		if err := s.DispatchSession(ctx, sess.SessionID); err != nil {
			s.log.Warn("onboardingsync: analysis dispatch failed",
				zap.String("session", sess.SessionID), zap.Error(err))
		}
	}
}

// advanceBackfillStages is the devops#1010 reconcile pass: it turns
// stage-terminal state into follow-on work. Two decisions, both derived from
// durable state (never from in-memory events), so a crash anywhere upstream
// costs at most one sweep interval:
//
//   - chunk continuation: a CHUNKED stage's dispatch that reached its terminal
//     DONE state while its stage coverage is still non-terminal means an
//     in_progress chunk result (or a crash between the terminal mark and this
//     requeue). Requeue the dispatch as the next chunk under a chunk-scoped
//     key. The row is left pending for the grace-gated sweepPending path —
//     the deliberate spacing between chunks that yields the per-user lease to
//     recent stages, new trainings and webhooks (AC2 让权).
//   - stage chaining: the deepest existing stage's coverage terminal means
//     its successor stage can be appended (dispatch + items + coverage in
//     one transaction) and dispatched immediately. recent_analysis is the
//     arm pass's to create — this pass skips it as a "next" and chains
//     extended_raw behind it, so the recent analysis settles before the
//     history walk starts competing for vendor quota.
//
// Both are idempotent: the requeue guards on non-pending, the append is
// unique-keyed on (session, stage).
func (s *Service) advanceBackfillStages(ctx context.Context) {
	sessions, err := s.store.ListOnboardingSyncSessionsInStates(ctx,
		[]string{storage.OnboardingSyncStateRunning, storage.OnboardingSyncStateDispatching}, s.limit)
	if err != nil {
		s.log.Warn("onboardingsync: backfill advance scan failed", zap.Error(err))
		return
	}
	for _, sess := range sessions {
		disp, err := s.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
		if err != nil {
			continue
		}
		covs, err := s.store.ListOnboardingSyncStageCoverage(ctx, sess.SessionID)
		if err != nil {
			continue
		}
		covByStage := map[string]*storage.OnboardingSyncStageCoverage{}
		for _, c := range covs {
			covByStage[c.Stage] = c
		}
		deepest := -1 // index into StageNames of the deepest chained stage
		for i, name := range StageNames() {
			for _, d := range disp {
				if d.Stage == name {
					deepest = i
				}
			}
		}
		for _, d := range disp {
			if d.Status != storage.OnboardingSyncDispatchDone || !chunkedStage(d.Stage) {
				continue // pending/dispatched rows and single-shot stages are not chunk continuations
			}
			cov := covByStage[d.Stage]
			if cov == nil || coverageTerminal(cov) {
				continue // nothing to continue: the stage is finished
			}
			if d.ChunkSeq >= maxChunkSeq {
				// A chunked stage that cannot finish within the bound is a
				// defect, not a workload — surface it instead of spinning.
				s.failStage(ctx, d, fmt.Sprintf("stage %s exceeded %d chunk continuations", d.Stage, maxChunkSeq))
				continue
			}
			items, err := s.store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, d.Stage)
			if err != nil {
				continue
			}
			specs := make([]storage.OnboardingSyncWorkItemSpec, len(items))
			for i, it := range items {
				specs[i] = storage.OnboardingSyncWorkItemSpec{Kind: it.Kind, RangeFrom: it.RangeFrom, RangeTo: it.RangeTo}
			}
			key := stageKey(d.Stage, sess.SessionID, sess.BindingRevision, sess.DispatchGeneration, d.ChunkSeq+1, specs)
			if err := s.store.RequeueOnboardingSyncDispatchChunk(ctx, d.ID, key); err != nil {
				s.log.Warn("onboardingsync: chunk requeue failed",
					zap.String("session", sess.SessionID), zap.String("stage", d.Stage), zap.Error(err))
				continue
			}
		}
		if deepest < 0 || deepest >= len(StageNames())-1 {
			continue // no chain to extend (or the auxiliary stage already exists)
		}
		cov := covByStage[StageNames()[deepest]]
		if cov == nil || !coverageTerminal(cov) {
			continue // deepest stage still mid-flight; the chain waits its turn
		}
		next := StageNames()[deepest+1]
		if next == storage.OnboardingSyncStageRecentAnalysis {
			// The arm pass owns creating the analysis stage; until it lands
			// the backfill chain waits (the analysis settles quickly and the
			// history walk should not compete with it for vendor quota).
			continue
		}
		anchor, err := time.Parse("2006-01-02", sess.AnchorDay)
		if err != nil {
			s.log.Warn("onboardingsync: bad anchor day in backfill advance",
				zap.String("session", sess.SessionID), zap.String("anchor", sess.AnchorDay))
			continue
		}
		items := sessionStageItems(sess.Provider, anchor)[next]
		key := stageKey(next, sess.SessionID, sess.BindingRevision, sess.DispatchGeneration, 0, items)
		created, err := s.store.AddOnboardingSyncStage(ctx, sess.SessionID, next, key, items)
		if err != nil {
			s.log.Warn("onboardingsync: stage append failed",
				zap.String("session", sess.SessionID), zap.String("stage", next), zap.Error(err))
			continue
		}
		if created {
			if err := s.store.SetOnboardingSyncSessionState(ctx, sess.SessionID,
				storage.OnboardingSyncStateDispatching, nil,
				storage.OnboardingSyncStateRunning, storage.OnboardingSyncStateDispatching); err != nil {
				s.log.Warn("onboardingsync: backfill advance state flip failed", zap.Error(err))
				continue
			}
			if err := s.DispatchSession(ctx, sess.SessionID); err != nil {
				s.log.Warn("onboardingsync: advanced stage dispatch failed",
					zap.String("session", sess.SessionID), zap.String("stage", next), zap.Error(err))
			}
		}
	}
}

// coverageTerminal reports whether a stage coverage row reached a terminal
// outcome (a failed stage is terminal for chaining purposes only through the
// session's failed state — failStage already handled it; here terminal means
// completed or completed_with_gaps, either of which lets the chain advance:
// permanent gaps are recorded honesty, not a blocker).
func coverageTerminal(cov *storage.OnboardingSyncStageCoverage) bool {
	return cov.Status == storage.OnboardingSyncCoverageCompleted ||
		cov.Status == storage.OnboardingSyncCoverageCompletedWithGaps
}

// sweepAnalysisRefresh supersedes published analysis results whose pinned input
// revision no longer matches reality (devops#1009 AC4/AC5): day rolls, new or
// re-delivered recent data, or a calibration policy bump each change the
// fingerprint, and every pending change MERGES into at most one refresh — the
// dispatch row is single, so concurrent triggers collapse onto the same job.
// The published row is only flagged stale (its true as-of stays readable)
// until the refresh lands and overwrites it. Bounded to the refresh horizon
// after session creation: afterwards the standing sync pipelines own analysis
// freshness.
func (s *Service) sweepAnalysisRefresh(ctx context.Context) {
	// devops#1010: the background backfill keeps sessions open long past the
	// analysis landing, so the refresh scan covers mid-flight sessions too —
	// freshness of the recent analysis must not wait for the whole history.
	sessions, err := s.store.ListOnboardingSyncSessionsInStates(ctx,
		[]string{storage.OnboardingSyncStateRunning, storage.OnboardingSyncStateDispatching,
			storage.OnboardingSyncStateCompleted, storage.OnboardingSyncStateCompletedWithGaps}, s.limit)
	if err != nil {
		s.log.Warn("onboardingsync: analysis refresh scan failed", zap.Error(err))
		return
	}
	asOf := timefmt.ShanghaiToday()
	asOfDay := asOf.Format("2006-01-02")
	fromDay := asOf.AddDate(0, 0, -AnalysisDigestLookbackDays).Format("2006-01-02")
	for _, sess := range sessions {
		if time.Since(sess.CreatedAt) > s.refreshHorizon {
			continue
		}
		disp, err := s.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
		if err != nil {
			continue
		}
		analysisDispatch := (*storage.OnboardingSyncDispatch)(nil)
		for _, d := range disp {
			if d.Stage == storage.OnboardingSyncStageRecentAnalysis {
				analysisDispatch = d
				break
			}
		}
		if analysisDispatch == nil || analysisDispatch.Status != storage.OnboardingSyncDispatchDone {
			continue // refresh already in flight / not yet armed — nothing to supersede
		}
		published, err := s.store.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
		if err != nil || published == nil {
			continue
		}
		digest, err := s.store.OnboardingAnalysisDigest(ctx, sess.UserID, fromDay, asOfDay)
		if err != nil {
			s.log.Warn("onboardingsync: analysis digest failed", zap.String("session", sess.SessionID), zap.Error(err))
			continue
		}
		policy, err := s.store.CalibrationPolicy(ctx)
		if err != nil {
			s.log.Warn("onboardingsync: calibration policy read failed", zap.String("session", sess.SessionID), zap.Error(err))
			continue
		}
		fp := storage.AnalysisFingerprint(sess.AnchorDay, asOfDay, sess.BindingRevision, policy, digest)
		if fp == published.InputFingerprint {
			continue // inputs unchanged: the published result stays current
		}
		requeued, err := s.store.RefreshOnboardingSyncAnalysis(ctx, analysisDispatch, func(generation int) string {
			return stageKey(analysisDispatch.Stage, sess.SessionID, sess.BindingRevision, generation, 0, nil)
		})
		if err != nil {
			s.log.Warn("onboardingsync: analysis refresh requeue failed", zap.String("session", sess.SessionID), zap.Error(err))
			continue
		}
		if !requeued {
			continue
		}
		if err := s.DispatchSession(ctx, sess.SessionID); err != nil {
			s.log.Warn("onboardingsync: analysis refresh dispatch failed", zap.String("session", sess.SessionID), zap.Error(err))
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Incremental gap-check seam (devops#1010 AC3)
// ─────────────────────────────────────────────────────────────────────────────

// UnfinishedRecentActivityWindow reports the user's CURRENT session's recent
// activities window while the session is unfinished — the window an ordinary
// incremental sync must re-check for credential gaps because its
// stop-at-first-existing cursor cannot see holes (devops#1010 AC3). ok=false
// when the user has no session, the session is terminal (the backfill chain
// finished or the session failed/superseded — either way the cursor is
// trustworthy again or the session executor owns recovery), or the bound
// provider no longer matches the session.
func (s *Service) UnfinishedRecentActivityWindow(ctx context.Context, userID, providerName string) (provider.DayWindow, bool) {
	sess, err := s.store.GetOnboardingSyncSession(ctx, userID)
	if err != nil || sess == nil || sess.Terminal() || sess.Provider != providerName {
		return provider.DayWindow{}, false
	}
	items, err := s.store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if err != nil {
		return provider.DayWindow{}, false
	}
	for _, it := range items {
		if it.Kind == storage.OnboardingSyncItemKindActivities {
			return provider.DayWindow{From: it.RangeFrom, To: it.RangeTo}, true
		}
	}
	return provider.DayWindow{}, false
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
	// ReadinessPartial and ReadinessUnavailable are the recent-analysis
	// levels (devops#1009): the API reports analysis availability EXPLICITLY
	// from the published per-domain outcomes — never inferred from a
	// pipeline-done bit. partial = some domains ready, some unavailable
	// (e.g. calibration ok but load/zones/L1 unavailable for missing
	// historical calibration); unavailable = no domain produced a result.
	ReadinessPartial     Readiness = "partial"
	ReadinessUnavailable Readiness = "unavailable"
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
// assert them. recent_analysis derives from the analysis stage's coverage row
// plus the published result row (devops#1009); historical_* / auxiliary stay
// not_started until their owning tickets (T06+) land executors; an
// executor-less stage is never reported ready (不假报近期数据ready).
type View struct {
	SessionID                string              `json:"session_id"`
	State                    string              `json:"state"`
	ShellReady               bool                `json:"shell_ready"`
	Provider                 string              `json:"provider"`
	BindingRevision          int64               `json:"binding_revision"`
	AnchorDay                string              `json:"anchor_day"`
	LegacyRunID              *string             `json:"legacy_run_id,omitempty"`
	DispatchGeneration       int                 `json:"dispatch_generation"`
	FailRetryCount           int                 `json:"fail_retry_count"`
	RetryCount               int                 `json:"retry_count"` // compatibility alias for DispatchGeneration
	Error                    *string             `json:"error,omitempty"`
	Stages                   []StageView         `json:"stages"`
	Readiness                ViewReadiness       `json:"readiness"`
	HistoricalAnalysisPoll   bool                `json:"historical_analysis_poll,omitempty"`
	HistoricalAnalysisReason *string             `json:"historical_analysis_reason,omitempty"`
	RecentAnalysis           *RecentAnalysisView `json:"recent_analysis_detail,omitempty"`
	CreatedAt                time.Time           `json:"created_at"`
	UpdatedAt                time.Time           `json:"updated_at"`
}

// AnalysisDomainView is one analysis domain's explicit outcome.
type AnalysisDomainView struct {
	Status string `json:"status"` // ready | partial | unavailable
	Reason string `json:"reason,omitempty"`
}

// RecentAnalysisView is the published recent-analysis result's projection:
// its TRUE as-of day (deliberately separate from the session's fixed anchor
// day), per-domain outcomes, the input fingerprint it was computed from, and
// the stale/refreshing bookkeeping (a stale row keeps its real as-of until the
// refresh supersedes it — devops#1009).
type RecentAnalysisView struct {
	AsOfDay    string                        `json:"as_of_day"`
	Status     string                        `json:"status"` // ready | partial | unavailable
	Stale      bool                          `json:"stale"`
	Refreshing bool                          `json:"refreshing"`
	Domains    map[string]AnalysisDomainView `json:"domains,omitempty"`
	// CoverageFrom/To: the observed Shanghai-day window of recent activities
	// the published result actually analyzed (omitted when none).
	CoverageFrom *string   `json:"coverage_from,omitempty"`
	CoverageTo   *string   `json:"coverage_to,omitempty"`
	ComputedAt   time.Time `json:"computed_at"`
}

// ViewReadiness is the summary the client surfaces. Each field is one of the
// Readiness levels.
type ViewReadiness struct {
	ShellReady         bool      `json:"shell_ready"`
	RecentData         Readiness `json:"recent_data"`
	RecentAnalysis     Readiness `json:"recent_analysis"`
	ExtendedData       Readiness `json:"extended_data"`
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
	analysisRow, err := s.store.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if err != nil {
		return nil, err
	}
	v := &View{
		SessionID: sess.SessionID, State: sess.State, ShellReady: sess.ShellReady,
		Provider: sess.Provider, BindingRevision: sess.BindingRevision,
		AnchorDay: sess.AnchorDay, LegacyRunID: sess.LegacyRunID,
		DispatchGeneration: sess.DispatchGeneration, FailRetryCount: sess.FailRetryCount,
		RetryCount: sess.DispatchGeneration, Error: sess.LastError,
		CreatedAt: sess.CreatedAt, UpdatedAt: sess.UpdatedAt,
		Readiness: ViewReadiness{ShellReady: sess.ShellReady,
			RecentData: ReadinessPending, RecentAnalysis: ReadinessNotStarted, ExtendedData: ReadinessNotStarted,
			HistoricalData: ReadinessNotStarted, HistoricalAnalysis: ReadinessNotStarted,
			Auxiliary: ReadinessNotStarted},
	}
	if analysisRow != nil {
		detail := &RecentAnalysisView{
			AsOfDay: analysisRow.AsOfDay, Status: analysisRow.Status,
			Stale: analysisRow.Stale, Domains: map[string]AnalysisDomainView{},
			CoverageFrom: analysisRow.CoverageFrom, CoverageTo: analysisRow.CoverageTo,
			ComputedAt: analysisRow.ComputedAt,
		}
		if analysisRow.DomainsJSON != nil {
			_ = json.Unmarshal([]byte(*analysisRow.DomainsJSON), &detail.Domains)
		}
		v.RecentAnalysis = detail
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
		dispatchFailed := false
		refreshing := false
		if d, ok := dispByStage[cov.Stage]; ok {
			if d.Status == storage.OnboardingSyncDispatchFailed {
				sv.Status = storage.OnboardingSyncCoverageFailed
				dispatchFailed = true
			}
			refreshing = d.Status == storage.OnboardingSyncDispatchDispatched
		}
		switch cov.Stage {
		case storage.OnboardingSyncStageRecentRaw:
			sv.Readiness = stageReadiness(cov)
			v.Readiness.RecentData = sv.Readiness
		case storage.OnboardingSyncStageRecentAnalysis:
			sv.Readiness = analysisReadiness(cov, dispatchFailed, analysisRow)
			v.Readiness.RecentAnalysis = sv.Readiness
			if v.RecentAnalysis != nil {
				v.RecentAnalysis.Refreshing = refreshing || cov.Status == storage.OnboardingSyncCoverageRunning
			}
		case storage.OnboardingSyncStageHistoricalRaw:
			sv.Readiness = stageReadiness(cov)
			v.Readiness.HistoricalData = sv.Readiness
		case storage.OnboardingSyncStageExtendedRaw:
			// The extended window is historical coverage too; once the
			// historical stage exists it supersedes this level.
			sv.Readiness = stageReadiness(cov)
			v.Readiness.ExtendedData = sv.Readiness
			if v.Readiness.HistoricalData == ReadinessNotStarted {
				v.Readiness.HistoricalData = sv.Readiness
			}
		case storage.OnboardingSyncStageAuxiliary:
			sv.Readiness = stageReadiness(cov)
			v.Readiness.Auxiliary = sv.Readiness
		default:
			sv.Readiness = stageReadiness(cov)
		}
		v.Stages = append(v.Stages, sv)
	}
	if sess.State == storage.OnboardingSyncStateWaitingLegacy {
		v.Readiness.RecentData = ReadinessPending
	}
	if err := s.projectHistoricalAnalysis(ctx, sess, covs, v); err != nil {
		return nil, err
	}
	return v, nil
}

// analysisReadiness derives the recent-analysis readiness level EXPLICITLY
// from the stage coverage plus the published result row (devops#1009 AC5):
// ready/partial/unavailable come from the row's per-domain outcomes, never
// from a pipeline-done bit, and a stale published row keeps its own level
// while its refresh runs.
func analysisReadiness(cov *storage.OnboardingSyncStageCoverage, dispatchFailed bool, row *storage.OnboardingRecentAnalysis) Readiness {
	if dispatchFailed {
		return ReadinessFailed
	}
	// A refresh in flight (coverage back to pending/running) does NOT retract
	// the published result: its level stands and the detail carries
	// stale/refreshing (devops#1009 AC4). Only a first run with nothing
	// published reports pending/running.
	if row != nil && (cov.Status == storage.OnboardingSyncCoveragePending ||
		cov.Status == storage.OnboardingSyncCoverageRunning) {
		return analysisRowLevel(row)
	}
	switch cov.Status {
	case storage.OnboardingSyncCoveragePending:
		return ReadinessPending
	case storage.OnboardingSyncCoverageRunning:
		return ReadinessRunning
	case storage.OnboardingSyncCoverageFailed:
		return ReadinessFailed
	case storage.OnboardingSyncCoverageCompleted, storage.OnboardingSyncCoverageCompletedWithGaps:
		if row == nil {
			// The job terminalized before its published row landed (a hole
			// the retry heals): explicitly not ready.
			return ReadinessPending
		}
		return analysisRowLevel(row)
	default:
		return ReadinessPending
	}
}

// analysisRowLevel maps the published row's status onto a readiness level.
func analysisRowLevel(row *storage.OnboardingRecentAnalysis) Readiness {
	switch row.Status {
	case storage.OnboardingAnalysisStatusReady:
		return ReadinessReady
	case storage.OnboardingAnalysisStatusPartial:
		return ReadinessPartial
	case storage.OnboardingAnalysisStatusUnavailable:
		return ReadinessUnavailable
	}
	return ReadinessPending
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
