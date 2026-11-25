// Package historicalcalibration provides the worker job handler for job type
// "historical_calibration_recompute" (devops#1011, epic devops#1004 T07): the
// explicit, auditable, default-off historical-calibration recompute run.
//
// Semantics this executor owns (the ticket's acceptance criteria):
//
//   - Independent run (AC1): every run row explicitly declares its
//     analysis_as_of_day, 365-day target window and pinned binding/data/policy
//     revisions. Nothing here is triggered by a GET, an ordinary calibration
//     step or a listener — the only entry is an operator-dispatched job of
//     this type, and the handler stays inert unless the rollout flag is on.
//   - Event cutoff (AC2): each target day D is estimated through the canonical
//     per-day seam (compute.RunCalibrationAsOfDay) over the activities of
//     [D-179, D] and the health rows of [D-89, D] — the estimator's own as-of
//     windows. No future event contributes to a day's baseline, and the
//     active/candidate policy is never touched (v3-only; a non-v3 active
//     policy is refused, ADR 0045/0046).
//   - Chunked resume with yield (AC3): one job run processes at most 7 target
//     days (日校准每 7 日 checkpoint), persists the day ledger, then chains the
//     next chunk as a NEW job and returns in_progress — the per-user work
//     holds no lease between chunks, so new trainings and webhooks jump the
//     queue. Evidence-insufficient days are recorded partial/unavailable in
//     the ledger; they are honest outcomes, never retried as network faults.
//   - Frozen bundle + visibility (AC4): each day's snapshot publishes under
//     the same (user, day, version) natural key as the ordinary path — every
//     row individually consistent as-of its day — and the run's final
//     publication freezes the whole ledger into one bundle fingerprint with
//     the pinned input revisions, the set marker downstream derived recompute
//     steps (load/PMC/ability, later tickets) must consume as one consistent
//     baseline.
//   - Revision isolation (AC5): before every chunk publishes and again at
//     final publication the run re-verifies its pinned binding revision,
//     policy revision and data fingerprint; a change supersedes the run — old
//     chunks refuse to publish — and concurrent explicit requests
//     create-or-merge onto at most one active run per user. No production
//     backfill is executed by this ticket: the flag is off by default and the
//     spec authorizes development of the capability only.
package historicalcalibration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	handlerscompute "github.com/zhaochy1990/stride/internal/handlers/compute"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// JobType is the registered job_type (mirrors
// catalog.JobTypeHistoricalCalibrationRecompute; kept local so the package is
// self-contained like onboardingrecent).
const JobType = "historical_calibration_recompute"

// Fixed window semantics (epic devops#1004): the V1 historical derivation
// target is the 365 calendar days ending at the run's analysis as-of day, and
// a day's evidence may reach 180 activity days / 90 health days back.
const (
	TargetDays           = 365
	EvidenceActivityDays = 180
	EvidenceHealthDays   = 90
)

// Chunk cadence (AC3): at most DaysPerChunk target days per job run — the
// 日校准每 7 日 checkpoint of the parent spec. maxChunkSeq bounds a run's
// continuations so a pathological no-progress loop surfaces as a failed run
// instead of spinning forever (53 chunks cover 365 days; job-level retries
// re-run the same chunk key without bumping the run's ChunkSeq).
const (
	DaysPerChunk = 7
	maxChunkSeq  = 200
)

// Store is the persistence + canonical-input surface the executor needs
// (satisfied by *storage.Store).
type Store interface {
	// The canonical per-day calibration seam's whole surface.
	handlerscompute.CalibrationStore
	// Run tables.
	ClaimOrCreateHistoricalRecomputeRun(ctx context.Context, spec storage.HistoricalRecomputeClaimSpec) (*storage.HistoricalRecomputeClaimResult, error)
	GetHistoricalRecomputeRun(ctx context.Context, runID string) (*storage.HistoricalRecomputeRun, error)
	ListHistoricalRecomputeDays(ctx context.Context, runID string) ([]*storage.HistoricalRecomputeDay, error)
	RecordHistoricalRecomputeDay(ctx context.Context, row *storage.HistoricalRecomputeDay) (bool, error)
	HistoricalRecomputeCounts(ctx context.Context, runID string) (storage.HistoricalRecomputeDayCounts, error)
	AdvanceHistoricalRecomputeCheckpoint(ctx context.Context, runID, checkpointDay string, chunkSeq int, jobID string) error
	FinalizeHistoricalRecomputeRun(ctx context.Context, runID, state, bundleFingerprint string, counts storage.HistoricalRecomputeDayCounts) error
	SupersedeHistoricalRecomputeRun(ctx context.Context, runID, reason string) error
	FailHistoricalRecomputeRun(ctx context.Context, runID, msg string) error
	// Pinned-revision inputs.
	GetWatchBinding(ctx context.Context, userID string) (*storage.WatchBindingState, error)
	OnboardingAnalysisDigest(ctx context.Context, userID, fromDay, toDay string) (storage.OnboardingAnalysisDigest, error)
	// Job lookups (enqueue-conflict adoption + merge liveness).
	JobByID(ctx context.Context, jobID string) (*job.Job, error)
	JobByIdempotencyKey(ctx context.Context, userID, key string) (*job.Job, error)
}

// Config wires the handler. Enabled is the rollout flag (default off):
// disabled workers fail any stray job permanently instead of running an
// unauthorized historical recompute. ChunkDays overrides DaysPerChunk (tests).
type Config struct {
	Store     Store
	Enq       job.Enqueuer
	Enabled   bool
	ChunkDays int
}

// chunkInput is the job's InputJSON. Request jobs (operator-dispatched) carry
// Request=true and optionally pin the analysis as-of day; continuation jobs
// chained by a finished chunk carry the run id they advance.
type chunkInput struct {
	Request         bool   `json:"request,omitempty"`
	AsOfDay         string `json:"as_of_day,omitempty"`
	BindingRevision int64  `json:"binding_revision,omitempty"`
	RunID           string `json:"run_id,omitempty"`
	ChunkSeq        int    `json:"chunk_seq,omitempty"`
}

// runResult is the executor's ResultJSON: the run's explicit outcome echo for
// observability and audit.
type runResult struct {
	User              string                               `json:"user"`
	RunID             string                               `json:"run_id"`
	Status            string                               `json:"status"` // in_progress | completed | completed_with_gaps | superseded | merged
	AnalysisAsOfDay   string                               `json:"as_of_day"`
	TargetFrom        string                               `json:"target_from"`
	TargetTo          string                               `json:"target_to"`
	BindingRevision   int64                                `json:"binding_revision"`
	PolicyVersion     int                                  `json:"policy_version"`
	PolicyRevision    uint64                               `json:"policy_revision"`
	InputFingerprint  string                               `json:"input_fingerprint"`
	CheckpointDay     string                               `json:"checkpoint_day,omitempty"`
	ChunkSeq          int                                  `json:"chunk_seq"`
	DaysProcessed     int                                  `json:"days_processed"`
	Counts            storage.HistoricalRecomputeDayCounts `json:"counts"`
	BundleFingerprint string                               `json:"bundle_fingerprint,omitempty"`
	SupersedeReason   string                               `json:"supersede_reason,omitempty"`
	SupersededFrom    string                               `json:"superseded_run,omitempty"`
	CreatedRun        bool                                 `json:"created_run,omitempty"`
}

// New returns the historical_calibration_recompute job.Handler.
func New(cfg Config) job.Handler {
	chunkDays := cfg.ChunkDays
	if chunkDays <= 0 {
		chunkDays = DaysPerChunk
	}
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if !cfg.Enabled {
			// Default-off capability: a job may reach a worker whose flag is
			// still off (mixed fleet or a stray enqueue). Fail permanently and
			// visibly — never silently run an unauthorized recompute. Checked
			// before the wiring so a disabled worker needs no live deps.
			return "", job.NewPermanentError("historical_recompute_disabled",
				errors.New("historicalcalibration: the explicit historical recompute rollout flag is off"))
		}
		if cfg.Store == nil || cfg.Enq == nil {
			return "", job.NewPermanentError("bad_wiring",
				errors.New("historicalcalibration: store and enqueue are required"))
		}
		user := j.UserID
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition",
				fmt.Errorf("historicalcalibration: partition key must be a user UUID: %w", err))
		}
		var in chunkInput
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("historicalcalibration: parse input: %w", err))
			}
		}
		e := &executor{cfg: cfg, chunkDays: chunkDays, user: user, job: j, hb: hb}
		var run *storage.HistoricalRecomputeRun
		var created, merged bool
		var supersededFrom string
		switch {
		case in.RunID != "":
			// Continuation of one specific run.
			r, err := cfg.Store.GetHistoricalRecomputeRun(ctx, in.RunID)
			if err != nil {
				return "", err
			}
			if r == nil || r.UserID != user {
				return "", job.NewPermanentError("run_gone",
					fmt.Errorf("historicalcalibration: run %s not found", in.RunID))
			}
			run = r
		default:
			// Explicit request: resolve current revisions, create-or-merge.
			r, c, m, sup, err := e.claim(ctx, in.AsOfDay, in.BindingRevision, j.CreatedBy)
			if err != nil {
				return "", err
			}
			run, created, merged = r, c, m
			if sup != nil {
				supersededFrom = *sup
			}
		}
		e.supersededFrom = supersededFrom
		e.createdRun = created

		// Terminal fast paths (idempotent redelivery / merged requests).
		if merged {
			return e.resultJSON(run, "merged"), nil
		}
		switch run.State {
		case storage.HistoricalRecomputeStateCompleted, storage.HistoricalRecomputeStateCompletedWithGaps:
			return e.resultJSON(run, run.State), nil
		case storage.HistoricalRecomputeStateSuperseded:
			return e.resultJSON(run, storage.HistoricalRecomputeStateSuperseded), nil
		case storage.HistoricalRecomputeStateFailed:
			return "", job.NewPermanentError("run_failed",
				fmt.Errorf("historicalcalibration: run %s already failed: %s", run.RunID, derefStr(run.LastError)))
		}
		return e.advanceRun(ctx, run)
	}
}

// executor carries one job invocation's context.
type executor struct {
	cfg            Config
	chunkDays      int
	user           string
	job            *job.Job
	hb             job.Heartbeat
	supersededFrom string
	createdRun     bool
	daysProcessed  int
}

// claim resolves the CURRENT pinned revisions and atomically create-or-merges
// the user's active run (AC5 合并派发): same identity → merge (and if a chunk
// is still live, this request only observes), different identity → the old
// run is superseded and a fresh run starts under the new revision.
func (e *executor) claim(ctx context.Context, asOfDay string, bindingRevision int64, createdBy string) (*storage.HistoricalRecomputeRun, bool, bool, *string, error) {
	store := e.cfg.Store
	binding, err := store.GetWatchBinding(ctx, e.user)
	if err != nil {
		return nil, false, false, nil, err
	}
	if binding == nil {
		return nil, false, false, nil, job.NewPermanentError("no_watch_binding",
			errors.New("historicalcalibration: user has no watch binding to pin a revision"))
	}
	if bindingRevision != 0 && binding.Revision != bindingRevision {
		return nil, false, false, nil, job.NewPermanentError("binding_revision_changed", errors.New("historicalcalibration: watch binding changed before automatic dispatch"))
	}
	if asOfDay == "" {
		asOfDay = timefmt.ShanghaiToday().Format("2006-01-02")
	}
	asOf, err := time.Parse("2006-01-02", asOfDay)
	if err != nil {
		return nil, false, false, nil, job.NewPermanentError("bad_as_of_day",
			fmt.Errorf("historicalcalibration: bad as_of_day %q: %w", asOfDay, err))
	}
	targetFrom := asOf.AddDate(0, 0, -(TargetDays - 1)).Format("2006-01-02")
	targetTo := asOfDay
	policy, err := store.CalibrationPolicy(ctx)
	if err != nil {
		return nil, false, false, nil, err
	}
	// v3-only (AC2: 不变更 active/candidate 策略): historical per-day writes
	// for the v3 model are the authorized V1 scope; an active-v4 policy has no
	// authorized historical write path yet (ADR 0045 active-candidate gates).
	if policy.ActiveVersion != calibration.ModelVersion {
		return nil, false, false, nil, job.NewPermanentError("policy_active_version_not_supported",
			fmt.Errorf("historicalcalibration: active policy version %d has no authorized historical per-day write path", policy.ActiveVersion))
	}
	// The data revision digest covers every input day the run may read: the
	// earliest target day's 180-day activity evidence reaches targetFrom-179.
	evidenceFrom := asOf.AddDate(0, 0, -(TargetDays-1)-(EvidenceActivityDays-1)).Format("2006-01-02")
	digest, err := store.OnboardingAnalysisDigest(ctx, e.user, evidenceFrom, targetTo)
	if err != nil {
		return nil, false, false, nil, err
	}
	fp := storage.HistoricalRecomputeFingerprint(asOfDay, targetFrom, targetTo, binding.Revision, policy, digest)
	claim, err := store.ClaimOrCreateHistoricalRecomputeRun(ctx, storage.HistoricalRecomputeClaimSpec{
		RunID: uuid.NewString(), UserID: e.user, Provider: derefStr(binding.Provider),
		AnalysisAsOfDay: asOfDay, TargetFromDay: targetFrom, TargetToDay: targetTo,
		BindingRevision: binding.Revision, PolicyVersion: policy.ActiveVersion,
		PolicyRevision: policy.Revision, InputFingerprint: fp,
		DaysTotal: TargetDays, CreatedBy: createdBy, JobID: e.job.ID,
	})
	if err != nil {
		return nil, false, false, nil, err
	}
	if !claim.Created {
		// Merged into a live run: if its latest chunk job is still queued or
		// running, this request observes instead of executing beside it.
		if claim.Run.LastJobID != nil && *claim.Run.LastJobID != e.job.ID {
			if j, err := e.cfg.Store.JobByID(ctx, *claim.Run.LastJobID); err == nil && j != nil && !j.Status.Terminal() {
				return claim.Run, false, true, claim.SupersededFrom, nil
			}
		}
	}
	return claim.Run, claim.Created, false, claim.SupersededFrom, nil
}

type pinnedInputStore interface {
	GetWatchBinding(context.Context, string) (*storage.WatchBindingState, error)
	CalibrationPolicy(context.Context) (storage.RunningCalibrationPolicy, error)
	OnboardingAnalysisDigest(context.Context, string, string, string) (storage.OnboardingAnalysisDigest, error)
}

// CheckPinnedInputs re-verifies the run's pinned revisions against CURRENT reality
// (AC5: revision 变化后旧块拒绝发布). Returns the supersede reason, or "" when
// the pinned revision still holds.
func CheckPinnedInputs(ctx context.Context, store pinnedInputStore, run *storage.HistoricalRecomputeRun) (string, error) {
	binding, err := store.GetWatchBinding(ctx, run.UserID)
	if err != nil {
		return "", err
	}
	if binding == nil || binding.Revision != run.BindingRevision {
		return "binding_revision_changed", nil
	}
	policy, err := store.CalibrationPolicy(ctx)
	if err != nil {
		return "", err
	}
	if policy.ActiveVersion != run.PolicyVersion || policy.Revision != run.PolicyRevision {
		return "policy_revision_changed", nil
	}
	asOf, err := time.Parse("2006-01-02", run.AnalysisAsOfDay)
	if err != nil {
		return "", fmt.Errorf("historicalcalibration: bad run as-of day %q: %w", run.AnalysisAsOfDay, err)
	}
	evidenceFrom := asOf.AddDate(0, 0, -(TargetDays-1)-(EvidenceActivityDays-1)).Format("2006-01-02")
	digest, err := store.OnboardingAnalysisDigest(ctx, run.UserID, evidenceFrom, run.TargetToDay)
	if err != nil {
		return "", err
	}
	fp := storage.HistoricalRecomputeFingerprint(run.AnalysisAsOfDay, run.TargetFromDay, run.TargetToDay, run.BindingRevision, policy, digest)
	if fp != run.InputFingerprint {
		return "data_revision_changed", nil
	}
	return "", nil
}

// advanceRun executes one bounded chunk of the run and either chains the next
// chunk or publishes the terminal outcome.
func (e *executor) advanceRun(ctx context.Context, run *storage.HistoricalRecomputeRun) (string, error) {
	store := e.cfg.Store
	// Publish fence BEFORE any chunk write (旧块拒绝发布).
	reason, err := CheckPinnedInputs(ctx, store, run)
	if err != nil {
		return "", err
	}
	if reason != "" {
		if err := store.SupersedeHistoricalRecomputeRun(ctx, run.RunID, reason); err != nil {
			return "", err
		}
		run.State, run.SupersedeReason = storage.HistoricalRecomputeStateSuperseded, &reason
		return e.resultJSON(run, storage.HistoricalRecomputeStateSuperseded), nil
	}
	if run.ChunkSeq >= maxChunkSeq {
		msg := fmt.Sprintf("run exceeded %d chunk continuations", maxChunkSeq)
		if err := store.FailHistoricalRecomputeRun(ctx, run.RunID, msg); err != nil {
			return "", err
		}
		return "", job.NewPermanentError("chunk_budget_exceeded", errors.New(msg))
	}

	days, err := pendingDays(run)
	if err != nil {
		return "", err
	}
	ledger, err := store.ListHistoricalRecomputeDays(ctx, run.RunID)
	if err != nil {
		return "", err
	}
	done := make(map[string]bool, len(ledger))
	for _, d := range ledger {
		done[d.Day] = true
	}
	var chunk []string
	for _, d := range days {
		if !done[d] {
			chunk = append(chunk, d)
			if len(chunk) >= e.chunkDays {
				break
			}
		}
	}

	processed := 0
	for i, day := range chunk {
		if err := e.processDay(ctx, run, day); err != nil {
			// An infra fault mid-chunk is retryable at the JOB level: the
			// ledger keeps every settled day, so the re-run resumes exactly
			// here. Evidence gaps are NOT errors (AC3) — they are recorded
			// inside processDay.
			return "", err
		}
		processed = i + 1
		e.heartbeat("historical_calibration", progress(len(done)+processed, run.DaysTotal))
	}
	if processed > 0 {
		if err := store.AdvanceHistoricalRecomputeCheckpoint(ctx, run.RunID, chunk[processed-1], run.ChunkSeq, e.job.ID); err != nil {
			return "", err
		}
		run.CheckpointDay = &chunk[processed-1]
	}

	remaining := len(days) - len(done) - processed
	if remaining > 0 {
		// Chain the next chunk as a NEW job (让权): between chunks the
		// per-user work holds no lease, and the queue can prioritize new
		// trainings and webhooks. The stable chunk key dedupes crash-restarts.
		nextSeq := run.ChunkSeq + 1
		input, err := json.Marshal(chunkInput{RunID: run.RunID, ChunkSeq: nextSeq})
		if err != nil {
			return "", err
		}
		key := continuationKey(run.RunID, nextSeq)
		jobID, err := e.cfg.Enq.Enqueue(ctx, job.EnqueueSpec{
			Type: JobType, UserID: run.UserID,
			InputJSON: string(input), IdempotencyKey: key,
		})
		if errors.Is(err, job.ErrConflict) {
			existing, lookupErr := store.JobByIdempotencyKey(ctx, run.UserID, key)
			if lookupErr != nil {
				return "", fmt.Errorf("historicalcalibration: continuation conflict resolve: %w", lookupErr)
			}
			jobID = existing.ID
		} else if err != nil {
			// The chunk's writes are durable (ledger + checkpoint); a failed
			// enqueue surfaces as a retryable job error so the re-run re-does
			// only the chaining — never the settled days.
			return "", fmt.Errorf("historicalcalibration: chain next chunk: %w", err)
		}
		if err := store.AdvanceHistoricalRecomputeCheckpoint(ctx, run.RunID, "", nextSeq, jobID); err != nil {
			return "", err
		}
		run.ChunkSeq = nextSeq
		run.State = storage.HistoricalRecomputeStateRunning
		return e.resultJSON(run, "in_progress"), nil
	}

	// Final publication: re-verify the pinned revisions one last time, then
	// freeze the whole ledger into the bundle fingerprint (AC4/AC5).
	reason, err = CheckPinnedInputs(ctx, store, run)
	if err != nil {
		return "", err
	}
	if reason != "" {
		if err := store.SupersedeHistoricalRecomputeRun(ctx, run.RunID, reason); err != nil {
			return "", err
		}
		run.State, run.SupersedeReason = storage.HistoricalRecomputeStateSuperseded, &reason
		return e.resultJSON(run, storage.HistoricalRecomputeStateSuperseded), nil
	}
	ledgerRows, err := store.ListHistoricalRecomputeDays(ctx, run.RunID)
	if err != nil {
		return "", err
	}
	counts, err := store.HistoricalRecomputeCounts(ctx, run.RunID)
	if err != nil {
		return "", err
	}
	rows := make([]storage.HistoricalRecomputeDay, len(ledgerRows))
	for i, r := range ledgerRows {
		rows[i] = *r
	}
	bundleFP := storage.HistoricalRecomputeBundleFingerprint(rows)
	state := storage.HistoricalRecomputeStateCompleted
	if counts.Partial > 0 || counts.Unavailable > 0 {
		state = storage.HistoricalRecomputeStateCompletedWithGaps
	}
	if err := store.FinalizeHistoricalRecomputeRun(ctx, run.RunID, state, bundleFP, counts); err != nil {
		return "", err
	}
	run.State, run.BundleFingerprint = state, &bundleFP
	run.DaysTotal, run.DaysReady, run.DaysPartial, run.DaysUnavailable =
		counts.Total, counts.Ready, counts.Partial, counts.Unavailable
	return e.resultJSON(run, state), nil
}

// processDay executes ONE target day: canonical per-day estimate under the
// day's event cutoff, honest outcome classification, ledger write. A day with
// zero evidence in both windows writes NO snapshot (nothing to estimate) and
// records unavailable — explicitly not an error (AC3 证据缺失如实报告).
func (e *executor) processDay(ctx context.Context, run *storage.HistoricalRecomputeRun, day string) error {
	asOf, err := time.Parse("2006-01-02", day)
	if err != nil {
		return fmt.Errorf("historicalcalibration: bad target day %q: %w", day, err)
	}
	// Cheap evidence probe first: the 180-day RUNNING-activity window (the
	// estimator drops non-running sports — a strength-only day is no
	// calibration evidence) + 90-day RHR health window decide whether the day
	// has anything to estimate at all.
	activities, err := e.cfg.Store.ActivitiesInWindow(ctx, run.UserID, "",
		asOf.AddDate(0, 0, -(EvidenceActivityDays-1)), asOf)
	if err != nil {
		return err
	}
	runningEvidence := 0
	for i := range activities {
		if watchmap.IsRunningSport(watchmap.SportFromRow(activities[i].Sport, activities[i].SportType)) {
			runningEvidence++
		}
	}
	health, err := e.cfg.Store.DailyHealthWithRHR(ctx, run.UserID)
	if err != nil {
		return err
	}
	healthStart := asOf.AddDate(0, 0, -(EvidenceHealthDays - 1))
	healthDays := 0
	for _, h := range health {
		d, ok := parseHealthDay(h.Date)
		if ok && !d.Before(healthStart) && !d.After(asOf) {
			healthDays++
		}
	}
	row := &storage.HistoricalRecomputeDay{RunID: run.RunID, Day: day}
	switch {
	case runningEvidence == 0 && healthDays == 0:
		row.Status, row.Reason = storage.HistoricalRecomputeDayUnavailable, "no_evidence"
	default:
		out, err := handlerscompute.RunCalibrationAsOfDay(ctx, e.cfg.Store, run.UserID, asOf, run.PolicyVersion)
		if err != nil {
			return err
		}
		row.Status = storage.HistoricalRecomputeDayPartial
		row.Reason = "insufficient_evidence"
		if out.CentersDone {
			row.Status, row.Reason = storage.HistoricalRecomputeDayReady, ""
		}
		row.SnapshotID = &out.SnapshotID
		row.Fingerprint = out.Fingerprint
		row.VerifiedExisting = out.Verified
	}
	_, err = e.cfg.Store.RecordHistoricalRecomputeDay(ctx, row)
	return err
}

// continuationKey is the stable idempotency key of one chunk continuation.
func continuationKey(runID string, chunkSeq int) string {
	return fmt.Sprintf("histcal:%s:c%d", runID, chunkSeq)
}

// pendingDays lists the run's target days oldest-first.
func pendingDays(run *storage.HistoricalRecomputeRun) ([]string, error) {
	from, err := time.Parse("2006-01-02", run.TargetFromDay)
	if err != nil {
		return nil, fmt.Errorf("historicalcalibration: bad target from %q: %w", run.TargetFromDay, err)
	}
	to, err := time.Parse("2006-01-02", run.TargetToDay)
	if err != nil {
		return nil, fmt.Errorf("historicalcalibration: bad target to %q: %w", run.TargetToDay, err)
	}
	if to.Before(from) {
		return nil, fmt.Errorf("historicalcalibration: target window %s..%s is empty", run.TargetFromDay, run.TargetToDay)
	}
	days := make([]string, 0, int(to.Sub(from).Hours()/24)+1)
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		days = append(days, d.Format("2006-01-02"))
	}
	return days, nil
}

func (e *executor) resultJSON(run *storage.HistoricalRecomputeRun, status string) string {
	out := runResult{
		User: run.UserID, RunID: run.RunID, Status: status,
		AnalysisAsOfDay: run.AnalysisAsOfDay,
		TargetFrom:      run.TargetFromDay, TargetTo: run.TargetToDay,
		BindingRevision: run.BindingRevision, PolicyVersion: run.PolicyVersion,
		PolicyRevision: run.PolicyRevision, InputFingerprint: run.InputFingerprint,
		ChunkSeq:      run.ChunkSeq,
		DaysProcessed: e.daysProcessed,
		Counts: storage.HistoricalRecomputeDayCounts{
			Total: run.DaysTotal, Ready: run.DaysReady,
			Partial: run.DaysPartial, Unavailable: run.DaysUnavailable,
		},
		SupersededFrom: e.supersededFrom,
		CreatedRun:     e.createdRun,
	}
	if run.CheckpointDay != nil {
		out.CheckpointDay = *run.CheckpointDay
	}
	if run.BundleFingerprint != nil {
		out.BundleFingerprint = *run.BundleFingerprint
	}
	if run.SupersedeReason != nil {
		out.SupersedeReason = *run.SupersedeReason
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func progress(done, total int) int {
	if total <= 0 {
		return 100
	}
	p := done * 100 / total
	if p > 100 {
		p = 100
	}
	return p
}

// heartbeat tolerates a nil Heartbeat (direct handler invocations in tests).
func (e *executor) heartbeat(stage string, pct int) {
	if e.hb != nil {
		_ = e.hb(stage, pct)
	}
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// parseHealthDay parses a daily_health.date (Shanghai-local, "YYYYMMDD" or
// "YYYY-MM-DD") into a UTC-midnight civil day (same rule as calibrationsource).
func parseHealthDay(s string) (time.Time, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), "-", "")
	if len(s) < 8 {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102", s[:8])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}
