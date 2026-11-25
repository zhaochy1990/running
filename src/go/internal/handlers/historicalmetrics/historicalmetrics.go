// Package historicalmetrics provides the worker job handler for job type
// "historical_metrics_recompute" (devops#1012, epic devops#1004 T08): the
// explicit, auditable, default-off rebuild of the historical DERIVED metrics —
// per-activity load/classification/zones, the daily PMC chain, the
// full-history PB set, per-activity L1 and the refreshed current-day
// four-layer ability — over the 365-day window whose calibration baseline a
// completed T07 run froze (ADR 0046/0047).
//
// Semantics this executor owns (the ticket's acceptance criteria):
//
//   - Bounded scope (AC1): load/classification/zones/L1 and the daily PMC are
//     rebuilt ONLY inside the 365-day target window ending at the run's
//     analysis as-of day; the PB stage alone scans the full history (更早完整
//     活动仍参与全历史 PB); the four-layer ability snapshot is refreshed for
//     the as-of day only (当天四层 ability) — never a multi-year daily ability
//     or L1 backfill.
//   - Chunked yield with checkpoints (AC2): per-activity stages process at
//     most 20 activities per job (逐活动每 20 条), the PMC stage at most 30
//     days (PMC 每 30 日), the PB scan at most 20 activities (PB 每 20 条);
//     each chunk stages its artifacts, chains the next chunk as a NEW job and
//     returns in_progress — no per-user lease is held between chunks. The PMC
//     seed is always explainable: a provenance-verifiable prior row (frozen
//     seed), a legacy row (legacy_seed_lineage_unavailable) or an explicit
//     zero anchor at the window start.
//   - Staged publication with one consistent revision (AC3): every staged
//     artifact belongs to the run's pinned binding/data/policy revision and
//     consumed calibration bundle; ordinary API/Coach reads never see the
//     staged table, so the previous consistent derived rows keep serving until
//     the final publication transaction promotes the whole staged set (fence
//     re-verified inside the transaction) — no mixed PMC chain or baseline.
//   - Honest gaps (AC4): activities/days whose calibration baseline is
//     missing stage an explicit skip marker and keep their existing rows; the
//     run terminalizes completed_with_gaps. Raw history may be complete while
//     the analysis honestly is not.
//   - Current ability closure (AC5): the full-history PB set (which the race
//     recognition results feed through the canonical classification evidence)
//     publishes BEFORE the L1 stage, and the as-of day's four-layer ability is
//     refreshed separately AFTER the L1 publication. No plan or watch-push
//     record is touched.
//   - Revision isolation (AC5/T07 parity): before every chunk stages and
//     again at publication the run re-verifies its pinned revisions; any
//     change (binding, policy, data, calibration bundle) supersedes the run
//     and old chunks refuse to publish. Concurrent explicit requests
//     create-or-merge onto at most one active run per user.
//
// No production backfill is executed by this capability: the rollout flag is
// default off and each run requires an explicit internal jobs-API dispatch.
package historicalmetrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/compute/abilitysource"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/pb"
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/compute/trainingloadsource"
	handlerscompute "github.com/zhaochy1990/stride/internal/handlers/compute"
	"github.com/zhaochy1990/stride/internal/handlers/historicalcalibration"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// JobType is the registered job_type (mirrors
// catalog.JobTypeHistoricalMetricsRecompute).
const JobType = "historical_metrics_recompute"

// Fixed window semantics: the derivation target is the 365 calendar days
// ending at the run's analysis as-of day (the same window the consumed T07
// calibration bundle froze a baseline for).
const TargetDays = 365

// Chunk cadences (AC2): 逐活动每 20 条 / PMC 每 30 日 / PB 每 20 条. maxChunkSeq
// bounds continuations so a pathological no-progress loop fails visibly.
const (
	ActivitiesPerChunk = 20
	DailyChunkDays     = 30
	PBPerChunk         = 20
	maxChunkSeq        = 1000
)

// pbProgressPayload is the PB scan cursor's staged payload.
type pbProgressPayload struct {
	Scanned int `json:"scanned"`
}

// skipPayload records why an item staged no artifact (honest gap marker).
// Day is audit provenance: which Shanghai day the gap was observed on —
// written for the ledger/audit reader, not consumed by the executor.
type skipPayload struct {
	Reason string `json:"reason"`
	Day    string `json:"day,omitempty"`
}

// Store is the persistence + canonical-input surface the executor needs
// (satisfied by *storage.Store).
type Store interface {
	// Canonical derivation seams (handlers/compute exports) need the compute
	// + ability read/write surfaces; *storage.Store satisfies both.
	handlerscompute.ComputeStore
	handlerscompute.AbilityStore
	// Run tables (this ticket).
	ClaimOrCreateHistoricalMetricsRun(ctx context.Context, spec storage.HistoricalMetricsClaimSpec) (*storage.HistoricalMetricsClaimResult, error)
	GetHistoricalMetricsRun(ctx context.Context, runID string) (*storage.HistoricalMetricsRun, error)
	ListHistoricalMetricsStaged(ctx context.Context, runID, kind string) ([]*storage.HistoricalMetricsStaged, error)
	StageHistoricalMetrics(ctx context.Context, rows []*storage.HistoricalMetricsStaged) error
	AdvanceHistoricalMetricsCheckpoint(ctx context.Context, runID, phase string, chunkSeq int, jobID string) error
	PublishHistoricalMetricsRun(ctx context.Context, runID string) (storage.HistoricalMetricsStagedCounts, error)
	FinalizeHistoricalMetricsRun(ctx context.Context, runID, state, outputFingerprint string, counts storage.HistoricalMetricsStagedCounts, totals storage.HistoricalMetricsTotals) error
	SupersedeHistoricalMetricsRun(ctx context.Context, runID, reason string) error
	FailHistoricalMetricsRun(ctx context.Context, runID, msg string) error
	// Pinned-revision inputs + the consumed calibration bundle.
	GetWatchBinding(ctx context.Context, userID string) (*storage.WatchBindingState, error)
	CalibrationPolicy(ctx context.Context) (storage.RunningCalibrationPolicy, error)
	OnboardingAnalysisDigest(ctx context.Context, userID, fromDay, toDay string) (storage.OnboardingAnalysisDigest, error)
	HistoricalCalibrationDigest(ctx context.Context, userID, fromDay, toDay string) (storage.HistoricalCalibrationDigest, error)
	LatestTerminalHistoricalRecomputeRunByUser(ctx context.Context, userID string) (*storage.HistoricalRecomputeRun, error)
	ActiveHistoricalRecomputeRunByUser(ctx context.Context, userID string) (*storage.HistoricalRecomputeRun, error)
	// Job lookups (enqueue-conflict adoption + merge liveness).
	JobByID(ctx context.Context, jobID string) (*job.Job, error)
	JobByIdempotencyKey(ctx context.Context, userID, key string) (*job.Job, error)
}

// ChunkSizes overrides the chunk cadences (tests).
type ChunkSizes struct {
	Acts int
	Days int
	PB   int
}

// Config wires the handler. Enabled is the rollout flag (default off).
type Config struct {
	Store   Store
	Enq     job.Enqueuer
	Enabled bool
	Chunk   ChunkSizes
}

// chunkInput is the job's InputJSON (T07 shape).
type chunkInput struct {
	Request          bool   `json:"request,omitempty"`
	AsOfDay          string `json:"as_of_day,omitempty"`
	BindingRevision  int64  `json:"binding_revision,omitempty"`
	CalibrationRunID string `json:"calibration_run_id,omitempty"`
	RunID            string `json:"run_id,omitempty"`
	ChunkSeq         int    `json:"chunk_seq,omitempty"`
}

// runResult is the executor's ResultJSON.
type runResult struct {
	User             string                          `json:"user"`
	RunID            string                          `json:"run_id"`
	Status           string                          `json:"status"` // in_progress | completed | completed_with_gaps | superseded | merged
	AnalysisAsOfDay  string                          `json:"as_of_day"`
	TargetFrom       string                          `json:"target_from"`
	TargetTo         string                          `json:"target_to"`
	Phase            string                          `json:"phase"`
	BindingRevision  int64                           `json:"binding_revision"`
	PolicyVersion    int                             `json:"policy_version"`
	PolicyRevision   uint64                          `json:"policy_revision"`
	InputFingerprint string                          `json:"input_fingerprint"`
	CalibrationRunID string                          `json:"calibration_run_id"`
	ChunkSeq         int                             `json:"chunk_seq"`
	Totals           storage.HistoricalMetricsTotals `json:"totals"`
	AbilityRefresh   string                          `json:"ability_refresh,omitempty"` // ok | unavailable_historical_calibration | partial_historical_calibration
	OutputFP         string                          `json:"output_fingerprint,omitempty"`
	SupersedeReason  string                          `json:"supersede_reason,omitempty"`
	SupersededFrom   string                          `json:"superseded_run,omitempty"`
	CreatedRun       bool                            `json:"created_run,omitempty"`
}

// New returns the historical_metrics_recompute job.Handler.
func New(cfg Config) job.Handler {
	acts, days, pbChunk := cfg.Chunk.Acts, cfg.Chunk.Days, cfg.Chunk.PB
	if acts <= 0 {
		acts = ActivitiesPerChunk
	}
	if days <= 0 {
		days = DailyChunkDays
	}
	if pbChunk <= 0 {
		pbChunk = PBPerChunk
	}
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if !cfg.Enabled {
			return "", job.NewPermanentError("historical_metrics_disabled",
				errors.New("historicalmetrics: the explicit historical-metrics recompute rollout flag is off"))
		}
		if cfg.Store == nil || cfg.Enq == nil {
			return "", job.NewPermanentError("bad_wiring",
				errors.New("historicalmetrics: store and enqueue are required"))
		}
		user := j.UserID
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition",
				fmt.Errorf("historicalmetrics: partition key must be a user UUID: %w", err))
		}
		var in chunkInput
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("historicalmetrics: parse input: %w", err))
			}
		}
		e := &executor{cfg: cfg, acts: acts, days: days, pbChunk: pbChunk, user: user, job: j, hb: hb}
		ctx = storage.WithCalibrationCache(ctx)
		var run *storage.HistoricalMetricsRun
		var created, merged bool
		var supersededFrom string
		switch {
		case in.RunID != "":
			r, err := cfg.Store.GetHistoricalMetricsRun(ctx, in.RunID)
			if err != nil {
				return "", err
			}
			if r == nil || r.UserID != user {
				return "", job.NewPermanentError("run_gone",
					fmt.Errorf("historicalmetrics: run %s not found", in.RunID))
			}
			run = r
		default:
			r, c, m, sup, err := e.claim(ctx, in, j.CreatedBy)
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

		if merged {
			return e.resultJSON(run, "merged"), nil
		}
		switch run.State {
		case storage.HistoricalMetricsStateCompleted, storage.HistoricalMetricsStateCompletedWithGaps:
			return e.resultJSON(run, run.State), nil
		case storage.HistoricalMetricsStateSuperseded:
			return e.resultJSON(run, storage.HistoricalMetricsStateSuperseded), nil
		case storage.HistoricalMetricsStateFailed:
			return "", job.NewPermanentError("run_failed",
				fmt.Errorf("historicalmetrics: run %s already failed: %s", run.RunID, derefStr(run.LastError)))
		}
		return e.advanceRun(ctx, run)
	}
}

type executor struct {
	cfg                 Config
	acts, days, pbChunk int
	user                string
	job                 *job.Job
	hb                  job.Heartbeat
	supersededFrom      string
	createdRun          bool
	abilityRefresh      string
	l1Skipped           int
	l1Unavailable       int
}

// claim resolves the CURRENT pinned revisions plus the newest frozen
// calibration bundle and atomically create-or-merges the user's active run.
func (e *executor) claim(ctx context.Context, in chunkInput, createdBy string) (*storage.HistoricalMetricsRun, bool, bool, *string, error) {
	store := e.cfg.Store
	binding, err := store.GetWatchBinding(ctx, e.user)
	if err != nil {
		return nil, false, false, nil, err
	}
	if binding == nil {
		return nil, false, false, nil, job.NewPermanentError("no_watch_binding",
			errors.New("historicalmetrics: user has no watch binding to pin a revision"))
	}
	if in.BindingRevision != 0 && binding.Revision != in.BindingRevision {
		return nil, false, false, nil, job.NewPermanentError("binding_revision_changed", errors.New("historicalmetrics: watch binding changed before automatic dispatch"))
	}
	asOfDay := in.AsOfDay
	if asOfDay == "" {
		asOfDay = timefmt.ShanghaiToday().Format("2006-01-02")
	}
	asOf, err := time.Parse("2006-01-02", asOfDay)
	if err != nil {
		return nil, false, false, nil, job.NewPermanentError("bad_as_of_day",
			fmt.Errorf("historicalmetrics: bad as_of_day %q: %w", asOfDay, err))
	}
	// The consumed frozen calibration baseline (ADR 0046): the newest
	// terminal T07 run. Without one there is no consistent historical
	// baseline to derive against — an explicit, permanent gap, not a retry.
	// A still-ACTIVE calibration run means the baseline is being rewritten
	// right now: refuse rather than derive against a moving vintage.
	calRun, err := store.LatestTerminalHistoricalRecomputeRunByUser(ctx, e.user)
	if err != nil {
		return nil, false, false, nil, err
	}
	if calRun == nil {
		return nil, false, false, nil, job.NewPermanentError("calibration_bundle_missing",
			errors.New("historicalmetrics: no completed historical-calibration recompute run to consume (dispatch historical_calibration_recompute first)"))
	}
	if in.CalibrationRunID != "" && in.CalibrationRunID != calRun.RunID {
		return nil, false, false, nil, job.NewPermanentError("calibration_bundle_changed", errors.New("historicalmetrics: automatic dispatch was pinned to a different calibration bundle"))
	}
	if active, err := store.ActiveHistoricalRecomputeRunByUser(ctx, e.user); err != nil {
		return nil, false, false, nil, err
	} else if active != nil {
		return nil, false, false, nil, job.NewPermanentError("calibration_run_active",
			errors.New("historicalmetrics: a historical-calibration recompute run is still active; wait for it to terminalize before rebuilding derived metrics"))
	}
	targetFrom := asOf.AddDate(0, 0, -(TargetDays - 1)).Format("2006-01-02")
	targetTo := asOfDay
	policy, err := store.CalibrationPolicy(ctx)
	if err != nil {
		return nil, false, false, nil, err
	}
	if policy.ActiveVersion != calibration.ModelVersion {
		return nil, false, false, nil, job.NewPermanentError("policy_active_version_not_supported",
			fmt.Errorf("historicalmetrics: active policy version %d has no authorized historical derived write path", policy.ActiveVersion))
	}
	// The data digest covers the run's WHOLE read surface — full history,
	// because the PB stage consumes activities beyond the 365-day window —
	// and the calibration-window digest pins the published baseline rows the
	// derivation reads (a rewritten window day supersedes the run even when
	// no raw input moved).
	digest, err := store.OnboardingAnalysisDigest(ctx, e.user, "0000-01-01", targetTo)
	if err != nil {
		return nil, false, false, nil, err
	}
	calDigest, err := store.HistoricalCalibrationDigest(ctx, e.user, targetFrom, targetTo)
	if err != nil {
		return nil, false, false, nil, err
	}
	calDigestJSON, err := json.Marshal(calDigest)
	if err != nil {
		return nil, false, false, nil, err
	}
	fp := storage.HistoricalMetricsFingerprint(asOfDay, targetFrom, targetTo, binding.Revision, policy, digest, calDigest, calRun.RunID, *calRun.BundleFingerprint)
	fromDay, err := parseDay("target from", targetFrom)
	if err != nil {
		return nil, false, false, nil, err
	}
	toDay, err := parseDay("target to", targetTo)
	if err != nil {
		return nil, false, false, nil, err
	}
	windowActs, err := store.ActivitiesInWindow(ctx, e.user, "", fromDay, toDay)
	if err != nil {
		return nil, false, false, nil, err
	}
	claim, err := store.ClaimOrCreateHistoricalMetricsRun(ctx, storage.HistoricalMetricsClaimSpec{
		RunID: uuid.NewString(), UserID: e.user, Provider: derefStr(binding.Provider),
		AnalysisAsOfDay: asOfDay, TargetFromDay: targetFrom, TargetToDay: targetTo,
		BindingRevision: binding.Revision, PolicyVersion: policy.ActiveVersion,
		PolicyRevision: policy.Revision, InputFingerprint: fp,
		CalibrationDigestJSON:        string(calDigestJSON),
		CalibrationRunID:             calRun.RunID,
		CalibrationBundleFingerprint: *calRun.BundleFingerprint,
		ActivitiesTotal:              len(windowActs), DaysTotal: TargetDays,
		CreatedBy: createdBy, JobID: e.job.ID,
	})
	if err != nil {
		return nil, false, false, nil, err
	}
	if !claim.Created {
		// Merged into a live run: if its latest chunk job is still live, this
		// request observes instead of executing beside it.
		if claim.Run.LastJobID != nil && *claim.Run.LastJobID != e.job.ID {
			if j, err := e.cfg.Store.JobByID(ctx, *claim.Run.LastJobID); err == nil && j != nil && !j.Status.Terminal() {
				return claim.Run, false, true, claim.SupersededFrom, nil
			}
		}
	}
	// The calibration run may have frozen just before a new activity landed.
	// Recheck its original raw inputs after pinning the metrics inputs so an
	// automatic hand-off can never publish against that older baseline.
	if in.CalibrationRunID != "" {
		reason, err := historicalcalibration.CheckPinnedInputs(ctx, store, calRun)
		if err != nil {
			return nil, false, false, nil, err
		}
		if reason != "" {
			if err := store.SupersedeHistoricalMetricsRun(ctx, claim.Run.RunID, reason); err != nil {
				return nil, false, false, nil, err
			}
			claim.Run.State, claim.Run.SupersedeReason = storage.HistoricalMetricsStateSuperseded, &reason
		}
	}
	return claim.Run, claim.Created, false, claim.SupersededFrom, nil
}

// fence re-verifies the run's pinned revisions against CURRENT reality.
func (e *executor) fence(ctx context.Context, run *storage.HistoricalMetricsRun) (string, error) {
	store := e.cfg.Store
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
	digest, err := store.OnboardingAnalysisDigest(ctx, run.UserID, "0000-01-01", run.TargetToDay)
	if err != nil {
		return "", err
	}
	calDigest, err := store.HistoricalCalibrationDigest(ctx, run.UserID, run.TargetFromDay, run.TargetToDay)
	if err != nil {
		return "", err
	}
	fp := storage.HistoricalMetricsFingerprint(run.AnalysisAsOfDay, run.TargetFromDay, run.TargetToDay, run.BindingRevision, policy, digest, calDigest, run.CalibrationRunID, run.CalibrationBundleFingerprint)
	if fp != run.InputFingerprint {
		// Attribute the mismatch: a changed calibration window is a
		// baseline-vintage change even when every raw input is identical,
		// and the audit reason must say so.
		var pinned storage.HistoricalCalibrationDigest
		if err := json.Unmarshal([]byte(run.CalibrationDigestJSON), &pinned); err == nil && pinned.SameAs(calDigest) {
			return "data_revision_changed", nil
		}
		return "calibration_bundle_changed", nil
	}
	if active, err := store.ActiveHistoricalRecomputeRunByUser(ctx, run.UserID); err != nil {
		return "", err
	} else if active != nil {
		// The baseline is being rewritten by a new calibration run right
		// now: stop deriving rather than mix vintages chunk by chunk.
		return "calibration_bundle_changed", nil
	}
	calRun, err := store.LatestTerminalHistoricalRecomputeRunByUser(ctx, run.UserID)
	if err != nil {
		return "", err
	}
	if calRun == nil || calRun.RunID != run.CalibrationRunID ||
		calRun.BundleFingerprint == nil || *calRun.BundleFingerprint != run.CalibrationBundleFingerprint {
		return "calibration_bundle_changed", nil
	}
	return "", nil
}

// advanceRun executes one bounded chunk of the run's current phase, walking
// phases forward inside the invocation while a phase finishes, then chains a
// continuation job (yield) or publishes the terminal outcome.
func (e *executor) advanceRun(ctx context.Context, run *storage.HistoricalMetricsRun) (string, error) {
	store := e.cfg.Store
	if run.ChunkSeq >= maxChunkSeq {
		msg := fmt.Sprintf("run exceeded %d chunk continuations", maxChunkSeq)
		if err := store.FailHistoricalMetricsRun(ctx, run.RunID, msg); err != nil {
			return "", err
		}
		return "", job.NewPermanentError("chunk_budget_exceeded", errors.New(msg))
	}
	for {
		if reason, err := e.fence(ctx, run); err != nil {
			return "", err
		} else if reason != "" {
			return e.supersede(ctx, run, reason)
		}
		var done bool
		var err error
		switch run.Phase {
		case storage.HistoricalMetricsPhaseActivity:
			done, err = e.phaseActivity(ctx, run)
		case storage.HistoricalMetricsPhaseDaily:
			done, err = e.phaseDaily(ctx, run)
		case storage.HistoricalMetricsPhasePB:
			done, err = e.phasePB(ctx, run)
		case storage.HistoricalMetricsPhaseL1:
			done, err = e.phaseL1(ctx, run)
		case storage.HistoricalMetricsPhasePublish:
			return e.phasePublish(ctx, run)
		default:
			return "", fmt.Errorf("historicalmetrics: unknown phase %q", run.Phase)
		}
		if err != nil {
			return "", err
		}
		if !done {
			// Chain the next chunk as a NEW job (让权).
			return e.chain(ctx, run)
		}
		next := map[string]string{
			storage.HistoricalMetricsPhaseActivity: storage.HistoricalMetricsPhaseDaily,
			storage.HistoricalMetricsPhaseDaily:    storage.HistoricalMetricsPhasePB,
			storage.HistoricalMetricsPhasePB:       storage.HistoricalMetricsPhaseL1,
			storage.HistoricalMetricsPhaseL1:       storage.HistoricalMetricsPhasePublish,
		}[run.Phase]
		if err := store.AdvanceHistoricalMetricsCheckpoint(ctx, run.RunID, next, run.ChunkSeq, e.job.ID); err != nil {
			return "", err
		}
		run.Phase = next
	}
}

// chain enqueues the run's next chunk continuation under its stable
// idempotency key and reports in_progress.
func (e *executor) chain(ctx context.Context, run *storage.HistoricalMetricsRun) (string, error) {
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
		existing, lookupErr := e.cfg.Store.JobByIdempotencyKey(ctx, run.UserID, key)
		if lookupErr != nil {
			return "", fmt.Errorf("historicalmetrics: continuation conflict resolve: %w", lookupErr)
		}
		jobID = existing.ID
	} else if err != nil {
		// The chunk's staged writes are durable; a failed enqueue surfaces as
		// a retryable error so the re-run only re-does the chaining.
		return "", fmt.Errorf("historicalmetrics: chain next chunk: %w", err)
	}
	if err := e.cfg.Store.AdvanceHistoricalMetricsCheckpoint(ctx, run.RunID, run.Phase, nextSeq, jobID); err != nil {
		return "", err
	}
	run.ChunkSeq = nextSeq
	run.State = storage.HistoricalMetricsStateRunning
	return e.resultJSON(run, "in_progress"), nil
}

// supersede records a fence failure's terminal outcome.
func (e *executor) supersede(ctx context.Context, run *storage.HistoricalMetricsRun, reason string) (string, error) {
	if err := e.cfg.Store.SupersedeHistoricalMetricsRun(ctx, run.RunID, reason); err != nil {
		return "", err
	}
	run.State, run.SupersedeReason = storage.HistoricalMetricsStateSuperseded, &reason
	return e.resultJSON(run, storage.HistoricalMetricsStateSuperseded), nil
}

// stagedKeySet loads a kind's staged item keys into a set.
func (e *executor) stagedKeySet(ctx context.Context, run *storage.HistoricalMetricsRun, kind string) (map[string]bool, []*storage.HistoricalMetricsStaged, error) {
	rows, err := e.cfg.Store.ListHistoricalMetricsStaged(ctx, run.RunID, kind)
	if err != nil {
		return nil, nil, err
	}
	set := make(map[string]bool, len(rows))
	for _, r := range rows {
		set[r.ItemKey] = true
	}
	return set, rows, nil
}

// windowActivities returns the user's activities whose Shanghai day is inside
// the run's target window, ordered chronologically (date, label_id).
func (e *executor) windowActivities(ctx context.Context, run *storage.HistoricalMetricsRun) ([]storage.Activity, error) {
	from, err := parseDay("target from", run.TargetFromDay)
	if err != nil {
		return nil, err
	}
	to, err := parseDay("target to", run.TargetToDay)
	if err != nil {
		return nil, err
	}
	rows, err := e.cfg.Store.ActivitiesInWindow(ctx, run.UserID, "", from, to)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].Date.Equal(rows[j].Date) {
			return rows[i].LabelID < rows[j].LabelID
		}
		return rows[i].Date.Before(rows[j].Date)
	})
	return rows, nil
}

// phaseActivity stages load/classification/zone rows for the next ≤20 window
// activities (逐活动每 20 条 checkpoint). An activity whose Shanghai day has no
// calibration bundle stages an honest skip marker — its existing rows stay.
func (e *executor) phaseActivity(ctx context.Context, run *storage.HistoricalMetricsRun) (bool, error) {
	store := e.cfg.Store
	window, err := e.windowActivities(ctx, run)
	if err != nil {
		return false, err
	}
	doneSet, _, err := e.stagedKeySet(ctx, run, storage.HistoricalMetricsKindActivityLoad)
	if err != nil {
		return false, err
	}
	skipSet, _, err := e.stagedKeySet(ctx, run, storage.HistoricalMetricsKindActivitySkip)
	if err != nil {
		return false, err
	}
	var pending []storage.Activity
	for i := range window {
		if !doneSet[window[i].LabelID] && !skipSet[window[i].LabelID] {
			pending = append(pending, window[i])
			if len(pending) >= e.acts {
				break
			}
		}
	}
	if len(pending) == 0 {
		return len(doneSet)+len(skipSet) >= len(window), nil
	}
	from := timefmt.ShanghaiDay(pending[0].Date)
	to := timefmt.ShanghaiDay(pending[len(pending)-1].Date)
	inputs, err := trainingloadsource.Load(ctx, store, run.UserID, "", from, to)
	if err != nil {
		return false, err
	}
	byLabel := make(map[string]trainingload.ActivityInput, len(inputs))
	for i := range inputs {
		byLabel[inputs[i].LabelID] = inputs[i]
	}
	var staged []*storage.HistoricalMetricsStaged
	processed := 0
	for i := range pending {
		label := pending[i].LabelID
		a, ok := byLabel[label]
		if !ok {
			// The loader dropped it (e.g. a date anomaly): an honest skip.
			day := timefmt.ShanghaiDayStr(pending[i].Date)
			staged = append(staged, skipRow(run.RunID, storage.HistoricalMetricsKindActivitySkip, label, skipPayload{Reason: "not_loadable", Day: day}))
			processed++
			continue
		}
		res, ok, err := handlerscompute.DeriveActivityLoad(ctx, store, run.UserID, a)
		if err != nil {
			return false, err
		}
		if !ok {
			staged = append(staged, skipRow(run.RunID, storage.HistoricalMetricsKindActivitySkip, label,
				skipPayload{Reason: "no_calibration_bundle", Day: timefmt.ShanghaiDayStr(pending[i].Date)}))
			processed++
			continue
		}
		rows, err := handlerscompute.DeriveActivityLoadRows(ctx, store, run.UserID, []trainingload.ActivityLoadResult{res})
		if err != nil {
			return false, err
		}
		payload, err := json.Marshal(rows[0])
		if err != nil {
			return false, err
		}
		staged = append(staged, &storage.HistoricalMetricsStaged{RunID: run.RunID, Kind: storage.HistoricalMetricsKindActivityLoad, ItemKey: label, Payload: string(payload)})
		zr, err := handlerscompute.DeriveActivityZoneRows(ctx, store, run.UserID, &a)
		if err != nil {
			return false, err
		}
		if zr != nil {
			zp, err := json.Marshal(zr)
			if err != nil {
				return false, err
			}
			staged = append(staged, &storage.HistoricalMetricsStaged{RunID: run.RunID, Kind: storage.HistoricalMetricsKindActivityZones, ItemKey: label, Payload: string(zp)})
		}
		processed++
	}
	if err := store.StageHistoricalMetrics(ctx, staged); err != nil {
		return false, err
	}
	e.heartbeat("historical_metrics_activity", progress(len(doneSet)+len(skipSet)+processed, len(window)))
	return false, nil
}

// phaseDaily stages the next ≤30-day PMC chunk (PMC 每 30 日 checkpoint),
// seeded explicitly: the prior production row before the window start, the
// last staged row (frozen seed), or an explicit zero anchor.
func (e *executor) phaseDaily(ctx context.Context, run *storage.HistoricalMetricsRun) (bool, error) {
	store := e.cfg.Store
	targetFrom, err := parseDay("target from", run.TargetFromDay)
	if err != nil {
		return false, err
	}
	targetTo, err := parseDay("target to", run.TargetToDay)
	if err != nil {
		return false, err
	}
	stagedRows, err := store.ListHistoricalMetricsStaged(ctx, run.RunID, storage.HistoricalMetricsKindDailyLoad)
	if err != nil {
		return false, err
	}
	doneDays := make(map[string]bool, len(stagedRows))
	for _, r := range stagedRows {
		doneDays[r.ItemKey] = true
	}
	total := int(targetTo.Sub(targetFrom).Hours()/24) + 1
	if len(doneDays) >= total {
		return true, nil
	}
	var start time.Time
	if len(stagedRows) == 0 {
		start = targetFrom
	} else {
		// Staged rows are contiguous from the window start; resume after the
		// last staged day (list is key-ordered, so the last row is the max).
		resumeDay, err := parseDay("staged daily key", stagedRows[len(stagedRows)-1].ItemKey)
		if err != nil {
			return false, err
		}
		start = resumeDay.AddDate(0, 0, 1)
	}
	end := start.AddDate(0, 0, e.days-1)
	if end.After(targetTo) {
		end = targetTo
	}

	// Seed: prior production row before the window (once), then the staged
	// chain's last row (frozen seed by construction).
	var prior *trainingload.PriorLoadState
	var seed *storage.CalibrationSeed
	if len(stagedRows) == 0 {
		prior, seed, err = handlerscompute.PriorDailyLoadSeed(ctx, store, run.UserID, targetFrom)
		if err != nil {
			return false, err
		}
		if seed == nil {
			seed = &storage.CalibrationSeed{State: "explicit_zero_anchor", Date: run.TargetFromDay}
		}
	} else {
		var row storage.DailyTrainingLoad
		if err := json.Unmarshal([]byte(stagedRows[len(stagedRows)-1].Payload), &row); err != nil {
			return false, fmt.Errorf("historicalmetrics: staged daily row %s: %w", stagedRows[len(stagedRows)-1].ItemKey, err)
		}
		values, rowSeed := handlerscompute.SeedFromDailyRow(row)
		prior, seed = &values, &rowSeed
	}

	// The chunk's per-activity doses come from the staged load ledger — the
	// exact rows this run derived under its pinned revisions.
	results, err := e.stagedLoadResults(ctx, run, start, end)
	if err != nil {
		return false, err
	}
	daily, err := handlerscompute.ComputeDailySeries(ctx, store, run.UserID, results, start, end, prior)
	if err != nil {
		return false, err
	}
	rows, _, err := handlerscompute.DeriveDailyLoadRows(ctx, store, run.UserID, daily, seed)
	if err != nil {
		return false, err
	}
	staged := make([]*storage.HistoricalMetricsStaged, len(rows))
	for i := range rows {
		payload, err := json.Marshal(rows[i])
		if err != nil {
			return false, err
		}
		staged[i] = &storage.HistoricalMetricsStaged{RunID: run.RunID, Kind: storage.HistoricalMetricsKindDailyLoad, ItemKey: rows[i].Date, Payload: string(payload)}
	}
	if err := store.StageHistoricalMetrics(ctx, staged); err != nil {
		return false, err
	}
	e.heartbeat("historical_metrics_daily", progress(len(doneDays)+len(rows), total))
	return len(doneDays)+len(rows) >= total, nil
}

// stagedLoadResults maps the staged activity-load rows whose Shanghai day is
// in [start, end] back onto the daily series' per-activity results — the same
// rows the publication promotes, so the PMC chain is derived from exactly
// what publishes (fields mirror toStorageActivityLoad one-to-one).
func (e *executor) stagedLoadResults(ctx context.Context, run *storage.HistoricalMetricsRun, start, end time.Time) ([]trainingload.ActivityLoadResult, error) {
	rows, err := e.cfg.Store.ListHistoricalMetricsStaged(ctx, run.RunID, storage.HistoricalMetricsKindActivityLoad)
	if err != nil {
		return nil, err
	}
	out := make([]trainingload.ActivityLoadResult, 0, len(rows))
	for _, r := range rows {
		var row storage.ActivityTrainingLoad
		if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
			return nil, fmt.Errorf("historicalmetrics: staged load row %s: %w", r.ItemKey, err)
		}
		day, err := time.Parse("2006-01-02", row.ActivityDate)
		if err != nil {
			return nil, fmt.Errorf("historicalmetrics: staged load row %s bad day %q: %w", r.ItemKey, row.ActivityDate, err)
		}
		if day.Before(start) || day.After(end) {
			continue
		}
		res := trainingload.ActivityLoadResult{
			LabelID:          row.LabelID,
			ActivityDate:     day,
			AlgorithmVersion: row.AlgorithmVersion,
			CalibrationID:    row.CalibrationID,
			TrainingDose:     row.TrainingDose,
			ExcludedFromPMC:  row.ExcludedFromPMC,
			CoverageStatus:   trainingload.CoverageStatus(row.CoverageStatus),
		}
		if row.Sport != nil {
			res.Sport = *row.Sport
		}
		if row.SessionClass != nil {
			res.SessionClass = trainingload.SessionClass(*row.SessionClass)
		}
		out = append(out, res)
	}
	return out, nil
}

// phasePB advances the full-history PB scan by ≤20 activities (PB 每 20 条
// checkpoint), resuming the canonical scanner from the staged best-so-far set.
func (e *executor) phasePB(ctx context.Context, run *storage.HistoricalMetricsRun) (bool, error) {
	store := e.cfg.Store
	allRows, err := store.AllRunningActivities(ctx, run.UserID)
	if err != nil {
		return false, err
	}
	// The PB scan reads FULL history but never past the run's as-of day: a
	// later sync's activities are outside the pinned data revision (the
	// digest covers [.., targetTo]) and would leak a future vintage into an
	// as-of recompute's published PBs.
	targetTo, err := parseDay("target to", run.TargetToDay)
	if err != nil {
		return false, err
	}
	all := make([]storage.Activity, 0, len(allRows))
	for i := range allRows {
		if !timefmt.ShanghaiDay(allRows[i].Date).After(targetTo) {
			all = append(all, allRows[i])
		}
	}
	scanned := 0
	if progressRows, err := store.ListHistoricalMetricsStaged(ctx, run.RunID, storage.HistoricalMetricsKindPBProgress); err != nil {
		return false, err
	} else if len(progressRows) > 0 {
		var p pbProgressPayload
		if err := json.Unmarshal([]byte(progressRows[len(progressRows)-1].Payload), &p); err != nil {
			return false, err
		}
		scanned = p.Scanned
	}
	if scanned >= len(all) {
		return true, nil
	}
	end := scanned + e.pbChunk
	if end > len(all) {
		end = len(all)
	}
	entries := map[string]pb.Entry{}
	stagedPB, err := store.ListHistoricalMetricsStaged(ctx, run.RunID, storage.HistoricalMetricsKindPersonalBest)
	if err != nil {
		return false, err
	}
	for _, r := range stagedPB {
		var row storage.PersonalBest
		if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
			return false, err
		}
		var entry pb.Entry
		if err := json.Unmarshal([]byte(row.EntryJSON), &entry); err != nil {
			return false, err
		}
		entries[entry.Distance] = entry
	}
	scanner := pb.ResumeScanner(entries)
	fetch := handlerscompute.PBTimeseriesFetch(ctx, store, run.UserID)
	if err := scanner.Scan(handlerscompute.PBActivitiesFromRows(all[scanned:end]), fetch); err != nil {
		return false, err
	}
	staged := make([]*storage.HistoricalMetricsStaged, 0, len(scanner.Entries())+1)
	for _, entry := range scanner.Entries() {
		row := handlerscompute.PBRawFromEntry(entry)
		row.UserID = run.UserID
		payload, err := json.Marshal(row)
		if err != nil {
			return false, err
		}
		staged = append(staged, &storage.HistoricalMetricsStaged{RunID: run.RunID, Kind: storage.HistoricalMetricsKindPersonalBest, ItemKey: entry.Distance, Payload: string(payload)})
	}
	pp, err := json.Marshal(pbProgressPayload{Scanned: end})
	if err != nil {
		return false, err
	}
	staged = append(staged, &storage.HistoricalMetricsStaged{RunID: run.RunID, Kind: storage.HistoricalMetricsKindPBProgress, ItemKey: "scan", Payload: string(pp)})
	if err := store.StageHistoricalMetrics(ctx, staged); err != nil {
		return false, err
	}
	e.heartbeat("historical_metrics_pb", progress(end, len(all)))
	return end >= len(all), nil
}

// phaseL1 stages L1 rows for the next ≤20 window running activities (L1 跟随
// 逐活动 20 条 cadence): recomputed — not only missing — because the rebuilt
// baseline legitimately changes historical L1 values. No HRMax for the
// activity's day stages an honest skip; ultra-short activities skip as usual.
func (e *executor) phaseL1(ctx context.Context, run *storage.HistoricalMetricsRun) (bool, error) {
	store := e.cfg.Store
	all, err := store.AllRunningActivities(ctx, run.UserID)
	if err != nil {
		return false, err
	}
	from, err := parseDay("target from", run.TargetFromDay)
	if err != nil {
		return false, err
	}
	to, err := parseDay("target to", run.TargetToDay)
	if err != nil {
		return false, err
	}
	var window []storage.Activity
	for i := range all {
		day := timefmt.ShanghaiDay(all[i].Date)
		if !day.Before(from) && !day.After(to) {
			window = append(window, all[i])
		}
	}
	l1Set, l1Rows, err := e.stagedKeySet(ctx, run, storage.HistoricalMetricsKindActivityL1)
	if err != nil {
		return false, err
	}
	skipSet, skipRows, err := e.stagedKeySet(ctx, run, storage.HistoricalMetricsKindActivityL1Skip)
	if err != nil {
		return false, err
	}
	var pending []storage.Activity
	for i := range window {
		if !l1Set[window[i].LabelID] && !skipSet[window[i].LabelID] {
			pending = append(pending, window[i])
			if len(pending) >= e.acts {
				break
			}
		}
	}
	if len(pending) == 0 {
		return len(l1Set)+len(skipSet) >= len(window), nil
	}
	mapped, err := abilitysource.MapActivities(ctx, store, pending)
	if err != nil {
		return false, err
	}
	byLabel := make(map[string]ability.Activity, len(mapped))
	for i := range mapped {
		byLabel[mapped[i].LabelID] = mapped[i]
	}
	var staged []*storage.HistoricalMetricsStaged
	for i := range pending {
		// MapActivities silently drops sports it cannot normalize; a dropped
		// pending item must still settle (skip marker) or the phase would
		// re-select it forever and burn the chunk budget (mirror of the
		// activity phase's not_loadable branch).
		a, ok := byLabel[pending[i].LabelID]
		if !ok {
			staged = append(staged, skipRow(run.RunID, storage.HistoricalMetricsKindActivityL1Skip, pending[i].LabelID,
				skipPayload{Reason: "not_mappable", Day: timefmt.ShanghaiDayStr(pending[i].Date)}))
			continue
		}
		day := a.Date
		if ability.IsUltraShort(a.DistanceM, a.DurationS) {
			staged = append(staged, skipRow(run.RunID, storage.HistoricalMetricsKindActivityL1Skip, a.LabelID, skipPayload{Reason: "ultra_short", Day: day}))
			continue
		}
		hrMax, err := abilitysource.ResolveHRMax(ctx, store, run.UserID, day)
		if err != nil {
			return false, err
		}
		if hrMax == nil {
			staged = append(staged, skipRow(run.RunID, storage.HistoricalMetricsKindActivityL1Skip, a.LabelID, skipPayload{Reason: "hrmax_unavailable", Day: day}))
			continue
		}
		bundle, err := storage.ReadCachedRunningCalibration(ctx, store, run.UserID, day, storage.CalibrationActive)
		if err != nil {
			return false, err
		}
		row, err := handlerscompute.DeriveL1Row(run.UserID, &a, *hrMax, bundle)
		if err != nil {
			return false, err
		}
		payload, err := json.Marshal(row)
		if err != nil {
			return false, err
		}
		staged = append(staged, &storage.HistoricalMetricsStaged{RunID: run.RunID, Kind: storage.HistoricalMetricsKindActivityL1, ItemKey: a.LabelID, Payload: string(payload)})
	}
	if err := store.StageHistoricalMetrics(ctx, staged); err != nil {
		return false, err
	}
	e.heartbeat("historical_metrics_l1", progress(len(l1Rows)+len(skipRows)+len(staged), len(window)))
	return false, nil
}

// phasePublish promotes the whole staged set in one transaction, then —
// separately, after L1 is published — refreshes the as-of day's four-layer
// ability (当天四层 ability 收口), then freezes the output fingerprint and
// terminalizes. Publication is idempotent, so an infra failure between the
// promotion and the finalize re-runs cleanly on retry.
func (e *executor) phasePublish(ctx context.Context, run *storage.HistoricalMetricsRun) (string, error) {
	store := e.cfg.Store
	counts, err := store.PublishHistoricalMetricsRun(ctx, run.RunID)
	if err != nil {
		return "", err
	}
	// Current-ability closure: refresh the as-of day's snapshot through the
	// ordinary ability path (it reads the just-published PBs and L1 rows).
	// A missing as-of HRMax is an honest unavailable outcome, not a failure.
	abilityState := "ok"
	asOf, err := parseDay("analysis as-of", run.AnalysisAsOfDay)
	if err != nil {
		return "", err
	}
	_, _, unavailable, err := handlerscompute.PersistAbilityDay(ctx, store, run.UserID, asOf, nil)
	switch {
	case errors.Is(err, handlerscompute.ErrHistoricalCalibrationMissing):
		abilityState = "unavailable_historical_calibration"
	case err != nil:
		return "", err
	case unavailable > 0:
		abilityState = "partial_historical_calibration"
	}
	e.abilityRefresh = abilityState

	// Freeze the staged ledger into the run's output fingerprint and count
	// the honest gaps from the STAGED markers (durable across chunks — a
	// continuation's in-memory counters would forget earlier chunks):
	// skipped activities, ultra-short and HRMax-unavailable L1 rows, or an
	// ability refresh that could not fully resolve.
	l1SkipRows, err := store.ListHistoricalMetricsStaged(ctx, run.RunID, storage.HistoricalMetricsKindActivityL1Skip)
	if err != nil {
		return "", err
	}
	l1Unavailable, l1Skipped := 0, 0
	for _, r := range l1SkipRows {
		var p skipPayload
		if json.Unmarshal([]byte(r.Payload), &p) != nil {
			continue
		}
		switch p.Reason {
		case "hrmax_unavailable":
			l1Unavailable++
		case "ultra_short":
			l1Skipped++
		}
	}
	staged, err := store.ListHistoricalMetricsStaged(ctx, run.RunID, "")
	if err != nil {
		return "", err
	}
	outputFP := storage.HistoricalMetricsOutputFingerprint(staged)
	state := storage.HistoricalMetricsStateCompleted
	if counts.ActivitySkip > 0 || l1Unavailable > 0 || abilityState != "ok" {
		state = storage.HistoricalMetricsStateCompletedWithGaps
	}
	if err := store.FinalizeHistoricalMetricsRun(ctx, run.RunID, state, outputFP, counts,
		storage.HistoricalMetricsTotals{
			ActivitiesTotal: run.ActivitiesTotal, DaysTotal: run.DaysTotal,
			L1Skipped: l1Skipped, L1Unavailable: l1Unavailable,
		}); err != nil {
		return "", err
	}
	run.State, run.OutputFingerprint = state, &outputFP
	return e.resultJSON(run, state), nil
}

func skipRow(runID, kind, key string, p skipPayload) *storage.HistoricalMetricsStaged {
	payload, _ := json.Marshal(p)
	return &storage.HistoricalMetricsStaged{RunID: runID, Kind: kind, ItemKey: key, Payload: string(payload)}
}

func continuationKey(runID string, chunkSeq int) string {
	return fmt.Sprintf("histmet:%s:c%d", runID, chunkSeq)
}

func (e *executor) resultJSON(run *storage.HistoricalMetricsRun, status string) string {
	out := runResult{
		User: run.UserID, RunID: run.RunID, Status: status,
		AnalysisAsOfDay: run.AnalysisAsOfDay,
		TargetFrom:      run.TargetFromDay, TargetTo: run.TargetToDay,
		Phase:           run.Phase,
		BindingRevision: run.BindingRevision, PolicyVersion: run.PolicyVersion,
		PolicyRevision: run.PolicyRevision, InputFingerprint: run.InputFingerprint,
		CalibrationRunID: run.CalibrationRunID,
		ChunkSeq:         run.ChunkSeq,
		Totals: storage.HistoricalMetricsTotals{
			ActivitiesTotal: run.ActivitiesTotal, DaysTotal: run.DaysTotal,
			L1Skipped: run.L1Skipped, L1Unavailable: run.L1Unavailable,
		},
		AbilityRefresh: e.abilityRefresh,
		SupersededFrom: e.supersededFrom,
		CreatedRun:     e.createdRun,
	}
	if run.OutputFingerprint != nil {
		out.OutputFP = *run.OutputFingerprint
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

// parseDay parses a stored Shanghai day. A malformed day in a run row is a
// permanent payload fault, never a worker-killing panic.
func parseDay(what, day string) (time.Time, error) {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return time.Time{}, job.NewPermanentError("bad_day",
			fmt.Errorf("historicalmetrics: bad %s %q: %w", what, day, err))
	}
	return t, nil
}
