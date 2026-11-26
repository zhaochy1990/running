// Package onboardinganalysis provides the worker job handler for job type
// "onboarding_recent_analysis" (devops#1009, epic devops#1004 T05): it
// executes one first-sync session's recent-analysis stage — the current
// calibration + load/zones/PB/PMC + ability computation over the recently
// synced window, with explicit dates, explicit missing items and a readiness
// independent of the raw stage.
//
// Semantics this executor owns (the ticket's acceptance criteria):
//
//   - Independent readiness: analysis failure never touches the raw stage's
//     coverage, the session's raw completion or the user's onboarding
//     completion; the canonical compute/ability handlers themselves never
//     replace-all wipe old PB/PMC when inputs are unavailable (they write
//     nothing), so old published results survive analysis failures.
//   - Canonical reuse: the calibration/compute/ability job handlers run
//     in-process — no second algorithm, no second tables. Missing historical
//     calibration keeps load/zones/L1 explicitly unavailable; per-day
//     calibration lookup is as-of (a snapshot on or before the day), never
//     today's/future baseline, and rest_confirmed only ever comes from real
//     health dates.
//   - Unified dates: the session's fixed scan anchor and the analysis as-of
//     day are separate. When the run crosses midnight (as-of > anchor) the
//     executor first tops up the recent window's missing days and the same-day
//     dashboard/health through the RAW executor (provider fetch, credentials,
//     fenced publishes — the identical machinery), and only then pins the
//     common input revision and runs the analysis steps.
//   - Supersede/refresh: the published result row carries its TRUE as-of day,
//     coverage and the input fingerprint it was computed from. Same-day
//     snapshot ids never gate validity — the fingerprint hashes the input
//     data/policy revision, so changed inputs invalidate the published result
//     and the sweep dispatches one merged refresh (the old row is flagged
//     stale, never silently rewritten, until the new one lands).
package onboardinganalysis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// JobType is the registered job_type (mirrors
// catalog.JobTypeOnboardingRecentAnalysis; kept local so the package is
// self-contained like onboardingrecent).
const JobType = "onboarding_recent_analysis"

// Domain names of the published per-domain outcomes.
const (
	DomainCalibration = "calibration"
	DomainLoad        = "load"
	DomainZones       = "zones"
	DomainAbility     = "ability"
)

// Store is the session persistence + analysis-input surface the executor
// needs (satisfied by *storage.Store).
type Store interface {
	GetOnboardingSyncSessionByID(ctx context.Context, sessionID string) (*storage.OnboardingSyncSession, error)
	GetOnboardingSyncStageCoverage(ctx context.Context, sessionID, stage string) (*storage.OnboardingSyncStageCoverage, error)
	UpdateOnboardingSyncStageCoverage(ctx context.Context, cov *storage.OnboardingSyncStageCoverage) error
	AppendOnboardingSyncWorkItems(ctx context.Context, sessionID, stage string, specs []storage.OnboardingSyncWorkItemSpec) error
	ExtendOnboardingSyncStageTarget(ctx context.Context, sessionID, stage, newTo string) error
	GetOnboardingRecentAnalysis(ctx context.Context, sessionID string) (*storage.OnboardingRecentAnalysis, error)
	UpsertOnboardingRecentAnalysis(ctx context.Context, row *storage.OnboardingRecentAnalysis) error
	MarkOnboardingRecentAnalysisStale(ctx context.Context, sessionID string, stale bool) error
	OnboardingAnalysisDigest(ctx context.Context, userID, fromDay, toDay string) (storage.OnboardingAnalysisDigest, error)
	CalibrationPolicy(ctx context.Context) (storage.RunningCalibrationPolicy, error)
	ActivitiesInWindow(ctx context.Context, userID, provider string, start, end time.Time) ([]storage.Activity, error)
	AllRunningActivities(ctx context.Context, userID string) ([]storage.Activity, error)
}

// Config wires the handler. RawStage is the onboarding_recent_sync executor
// (onboardingrecent.New) reused verbatim for the cross-midnight top-up;
// Calibration/Compute/Ability are the canonical compute handlers
// (compute.NewCalibration / NewCompute / NewAbility) — the analysis adds NO
// algorithm of its own.
type Config struct {
	Store       Store
	RawStage    job.Handler
	Calibration job.Handler
	Compute     job.Handler
	Ability     job.Handler
}

// domainOutcome is one analysis domain's explicit outcome.
type domainOutcome struct {
	Status string `json:"status"` // ready | unavailable
	Reason string `json:"reason,omitempty"`
}

// analysisOutput is the executor's ResultJSON: the published row's fields
// echoed for observability (the sweep persists the StageResult part).
type analysisOutput struct {
	onboardingsync.StageResult
	AsOfDay               string                   `json:"as_of_day"`
	AnchorDay             string                   `json:"anchor_day"`
	InputFingerprint      string                   `json:"input_fingerprint"`
	PublishedStatus       string                   `json:"published_status"`
	Domains               map[string]domainOutcome `json:"domains"`
	SupersededFingerprint string                   `json:"superseded_fingerprint,omitempty"`
}

// New returns the onboarding_recent_analysis job.Handler.
func New(cfg Config) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		if cfg.Store == nil || cfg.RawStage == nil || cfg.Calibration == nil || cfg.Compute == nil || cfg.Ability == nil {
			return "", job.NewPermanentError("bad_wiring",
				errors.New("onboardinganalysis: store and all stage handlers are required"))
		}
		var in struct {
			SessionID string `json:"session_id"`
			Stage     string `json:"stage"`
		}
		if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
			return "", job.NewPermanentError("bad_payload", err)
		}
		if in.SessionID == "" || in.Stage != storage.OnboardingSyncStageRecentAnalysis {
			return "", job.NewPermanentError("bad_payload",
				fmt.Errorf("onboardinganalysis: unexpected stage input session=%q stage=%q", in.SessionID, in.Stage))
		}
		sess, err := cfg.Store.GetOnboardingSyncSessionByID(ctx, in.SessionID)
		if err != nil {
			return "", err
		}
		if sess == nil {
			return "", job.NewPermanentError("session_gone",
				fmt.Errorf("onboardinganalysis: session %s not found", in.SessionID))
		}
		if sess.State == storage.OnboardingSyncStateSuperseded {
			return "", job.NewPermanentError("session_superseded",
				fmt.Errorf("onboardinganalysis: session %s superseded by a rebind", in.SessionID))
		}
		rawCov, err := cfg.Store.GetOnboardingSyncStageCoverage(ctx, in.SessionID, storage.OnboardingSyncStageRecentRaw)
		if err != nil {
			return "", err
		}
		if rawCov == nil || (rawCov.Status != storage.OnboardingSyncCoverageCompleted &&
			rawCov.Status != storage.OnboardingSyncCoverageCompletedWithGaps) {
			// Structurally impossible (the sweep arms analysis only after raw
			// terminalizes) — a defensive retryable bail, never a silent run
			// beside unfinished raw work.
			return "", fmt.Errorf("onboardinganalysis: recent_raw not terminal for session %s", in.SessionID)
		}

		anchor, err := time.Parse("2006-01-02", sess.AnchorDay)
		if err != nil {
			return "", job.NewPermanentError("bad_anchor_day",
				fmt.Errorf("onboardinganalysis: bad anchor day %q: %w", sess.AnchorDay, err))
		}
		asOf := timefmt.ShanghaiToday()
		asOfDay := asOf.Format("2006-01-02")

		// Cross-midnight top-up: fill the recent window's missing days and the
		// same-day dashboard/health BEFORE the analysis pins its inputs.
		if asOfDay > sess.AnchorDay {
			if err := topUpRecentRaw(ctx, cfg, j, hb, sess, anchor, asOf); err != nil {
				return "", err // raw executor's classification (retryable/permanent) stands
			}
			if rawCov, err = cfg.Store.GetOnboardingSyncStageCoverage(ctx, in.SessionID, storage.OnboardingSyncStageRecentRaw); err != nil {
				return "", err
			}
		}

		// Pin the common input revision every analysis step runs against.
		fromDay := asOf.AddDate(0, 0, -onboardingsync.AnalysisDigestLookbackDays).Format("2006-01-02")
		digest, err := cfg.Store.OnboardingAnalysisDigest(ctx, sess.UserID, fromDay, asOfDay)
		if err != nil {
			return "", err
		}
		if err := refreshActivityGaps(ctx, cfg.Store, sess, rawCov); err != nil {
			return "", err
		}

		policy, err := cfg.Store.CalibrationPolicy(ctx)
		if err != nil {
			return "", err
		}
		fingerprint := storage.AnalysisFingerprint(sess.AnchorDay, asOfDay, sess.BindingRevision, policy, digest)

		published, err := cfg.Store.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
		if err != nil {
			return "", err
		}
		if published != nil && published.InputFingerprint == fingerprint {
			// Idempotent redelivery (crash between job-done and the sweep's
			// observation): the published result already reflects exactly
			// these inputs.
			return stageResultJSON(rawCov, published.AsOfDay, published.CoverageFrom, published.CoverageTo), nil
		}
		if published != nil {
			// A changed input revision supersedes the old result: flag it
			// stale — its true as-of stays readable until this run lands.
			if err := cfg.Store.MarkOnboardingRecentAnalysisStale(ctx, sess.SessionID, true); err != nil {
				return "", err
			}
		}

		// Run the canonical analysis steps against the pinned inputs.
		domains := map[string]domainOutcome{}
		running, err := cfg.Store.AllRunningActivities(ctx, sess.UserID)
		if err != nil {
			return "", err
		}
		hasInputs := len(running) > 0 || digest.HealthDayCount > 0 || digest.HRVDayCount > 0
		if !hasInputs {
			for _, d := range []string{DomainCalibration, DomainLoad, DomainZones, DomainAbility} {
				domains[d] = domainOutcome{Status: "unavailable", Reason: "no_inputs"}
			}
		} else {
			calRes, calErr := runStep(ctx, cfg.Calibration, sess.UserID, hb, DomainCalibration)
			if calErr != nil {
				return "", calErr // infra fault: retryable, nothing published
			}
			domains[DomainCalibration] = calibrationOutcome(calRes)
			_ = hb(DomainCalibration, 40)
			if len(running) == 0 {
				// Zero activities: load/zones/L1 stay explicitly unavailable —
				// no fabricated rest, no empty-set replace-all over the PB/PMC
				// tables. The health-based calibration above still lands.
				for _, d := range []string{DomainLoad, DomainZones, DomainAbility} {
					domains[d] = domainOutcome{Status: "unavailable", Reason: "no_activities"}
				}
			} else {
				compRes, compErr := runStep(ctx, cfg.Compute, sess.UserID, hb, DomainLoad)
				if compErr != nil {
					return "", compErr
				}
				domains[DomainLoad], domains[DomainZones] = computeOutcomes(compRes)
				_ = hb(DomainLoad, 70)
				abRes, abErr := runStep(ctx, cfg.Ability, sess.UserID, hb, DomainAbility)
				if abErr != nil {
					return "", abErr
				}
				domains[DomainAbility] = abilityOutcome(abRes)
				_ = hb(DomainAbility, 90)
			}
		}

		status := aggregateStatus(domains)
		covFrom, covTo := recentCoverage(cfg.Store, ctx, sess.UserID, anchor, asOf)

		row := &storage.OnboardingRecentAnalysis{
			SessionID: sess.SessionID, UserID: sess.UserID,
			AsOfDay: asOfDay, AnchorDay: sess.AnchorDay,
			InputFingerprint: fingerprint,
			PolicyVersion:    policy.ActiveVersion, PolicyRevision: policy.Revision,
			Status: status, CoverageFrom: covFrom, CoverageTo: covTo,
			Stale: false, ComputedAt: time.Now().UTC(),
		}
		if b, err := json.Marshal(domains); err == nil {
			s := string(b)
			row.DomainsJSON = &s
		}
		if err := cfg.Store.UpsertOnboardingRecentAnalysis(ctx, row); err != nil {
			return "", err
		}
		_ = hb("analysis", 100)

		out := analysisOutput{
			StageResult:      stageResult(rawCov, asOfDay, covFrom, covTo),
			AsOfDay:          asOfDay,
			AnchorDay:        sess.AnchorDay,
			InputFingerprint: fingerprint,
			PublishedStatus:  status,
			Domains:          domains,
		}
		if published != nil {
			out.SupersededFingerprint = published.InputFingerprint
		}
		raw, _ := json.Marshal(out)
		return string(raw), nil
	}
}

// topUpRecentRaw fills the days between the fixed scan anchor and the analysis
// as-of day through the RAW executor: extension work items are appended
// idempotently (done credentials from a crashed predecessor are reused), the
// raw stage job runs over recent_raw, and ONLY on its success does the raw
// coverage target extend — a failed top-up never retracts the raw stage's
// completed readiness (devops#1009 AC1/AC3).
func topUpRecentRaw(ctx context.Context, cfg Config, j *job.Job, hb job.Heartbeat, sess *storage.OnboardingSyncSession, anchor, asOf time.Time) error {
	extFrom := anchor.AddDate(0, 0, 1).Format("2006-01-02")
	extTo := asOf.Format("2006-01-02")
	specs := []storage.OnboardingSyncWorkItemSpec{
		{Kind: "activities", RangeFrom: extFrom, RangeTo: extTo},
		{Kind: "health", RangeFrom: extFrom, RangeTo: extTo},
		{Kind: "dashboard", RangeFrom: extTo, RangeTo: extTo},
	}
	if err := cfg.Store.AppendOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw, specs); err != nil {
		return err
	}
	input, err := json.Marshal(struct {
		SessionID string `json:"session_id"`
		Stage     string `json:"stage"`
	}{SessionID: sess.SessionID, Stage: storage.OnboardingSyncStageRecentRaw})
	if err != nil {
		return err
	}
	synthetic := &job.Job{ID: j.ID, UserID: sess.UserID, InputJSON: string(input)}
	resJSON, err := cfg.RawStage(ctx, synthetic, func(stage string, pct int) error {
		return hb("topup:"+stage, pct)
	})
	if err != nil {
		return err
	}
	if err := cfg.Store.ExtendOnboardingSyncStageTarget(ctx, sess.SessionID,
		storage.OnboardingSyncStageRecentRaw, extTo); err != nil {
		return err
	}
	onboardingsync.ApplyStageResult(ctx, cfg.Store, sess.SessionID,
		storage.OnboardingSyncStageRecentRaw, resJSON, nil)
	return nil
}

// runStep invokes one canonical compute handler with a synthetic job.
func runStep(ctx context.Context, h job.Handler, userID string, hb job.Heartbeat, stage string) (string, error) {
	synthetic := &job.Job{UserID: userID}
	return h(ctx, synthetic, func(stage string, pct int) error { return hb(stage, pct) })
}

// stepStatus pulls {"status":...} out of a handler result body.
func stepStatus(resultJSON string) string {
	var out struct {
		Status string `json:"status"`
	}
	if json.Unmarshal([]byte(resultJSON), &out) != nil {
		return ""
	}
	return out.Status
}

func calibrationOutcome(resultJSON string) domainOutcome {
	switch stepStatus(resultJSON) {
	case "ok", "skipped_no_new_data":
		return domainOutcome{Status: "ready"}
	default:
		return domainOutcome{Status: "unavailable", Reason: stepStatus(resultJSON)}
	}
}

// computeOutcomes maps the compute handler's own explicit availability
// semantics onto the load + zones domains: unavailable_historical_calibration
// (and the active-candidate gate) write NOTHING derived — old PB/PMC/zones
// rows survive untouched.
func computeOutcomes(resultJSON string) (load, zones domainOutcome) {
	switch stepStatus(resultJSON) {
	case "full", "incremental":
		return domainOutcome{Status: "ready"}, domainOutcome{Status: "ready"}
	case "unavailable_historical_calibration":
		reason := "historical_calibration_missing"
		return domainOutcome{Status: "unavailable", Reason: reason},
			domainOutcome{Status: "unavailable", Reason: reason}
	case "unavailable_active_calibration":
		reason := "candidate_baseline_incomplete"
		return domainOutcome{Status: "unavailable", Reason: reason},
			domainOutcome{Status: "unavailable", Reason: reason}
	default:
		reason := stepStatus(resultJSON)
		return domainOutcome{Status: "unavailable", Reason: reason},
			domainOutcome{Status: "unavailable", Reason: reason}
	}
}

func abilityOutcome(resultJSON string) domainOutcome {
	switch stepStatus(resultJSON) {
	case "ok", "backfill", "backfill_l1":
		return domainOutcome{Status: "ready"}
	case "unavailable_historical_calibration":
		return domainOutcome{Status: "unavailable", Reason: "historical_calibration_missing"}
	case "unavailable_active_calibration":
		return domainOutcome{Status: "unavailable", Reason: "candidate_baseline_incomplete"}
	default:
		return domainOutcome{Status: "unavailable", Reason: stepStatus(resultJSON)}
	}
}

// aggregateStatus folds the per-domain outcomes into the published status:
// ready (every domain ready), unavailable (none), partial (mixed).
func aggregateStatus(domains map[string]domainOutcome) string {
	ready, unavailable := 0, 0
	for _, d := range domains {
		switch d.Status {
		case "ready":
			ready++
		case "unavailable":
			unavailable++
		}
	}
	switch {
	case ready > 0 && unavailable == 0:
		return storage.OnboardingAnalysisStatusReady
	case ready == 0 && unavailable > 0:
		return storage.OnboardingAnalysisStatusUnavailable
	default:
		return storage.OnboardingAnalysisStatusPartial
	}
}

// recentCoverage returns the observed Shanghai-day window of the user's
// activities inside the session's recent window (anchor-89 .. asOf), the
// honest coverage of what the analysis actually had.
func recentCoverage(store Store, ctx context.Context, userID string, anchor, asOf time.Time) (from, to *string) {
	acts, err := store.ActivitiesInWindow(ctx, userID, "",
		anchor.AddDate(0, 0, -(onboardingsync.DefaultRecentActivityDays-1)), asOf)
	if err != nil || len(acts) == 0 {
		return nil, nil
	}
	minDay, maxDay := "", ""
	for _, a := range acts {
		day := timefmt.ShanghaiDayStr(a.Date)
		if minDay == "" || day < minDay {
			minDay = day
		}
		if maxDay == "" || day > maxDay {
			maxDay = day
		}
	}
	return &minDay, &maxDay
}

// stageResult builds the StageResult coverage contract for the analysis stage
// row: scanned = the analyzed window, observed = the recent activity coverage,
// completed_with_gaps when the raw scan recorded permanent gaps.
func stageResult(rawCov *storage.OnboardingSyncStageCoverage, asOfDay string, covFrom, covTo *string) onboardingsync.StageResult {
	res := onboardingsync.StageResult{
		Stage:        storage.OnboardingSyncStageRecentAnalysis,
		Status:       storage.OnboardingSyncCoverageCompleted,
		ScannedFrom:  strPtr(recentWindowStart(asOfDay)),
		ScannedTo:    strPtr(asOfDay),
		ObservedFrom: covFrom,
		ObservedTo:   covTo,
	}
	if rawCov != nil && onboardingsync.CoverageStatus(rawCov) == storage.OnboardingSyncCoverageCompletedWithGaps {
		res.Status = storage.OnboardingSyncCoverageCompletedWithGaps
	}
	return res
}

func stageResultJSON(rawCov *storage.OnboardingSyncStageCoverage, asOfDay string, covFrom, covTo *string) string {
	out, err := json.Marshal(stageResult(rawCov, asOfDay, covFrom, covTo))
	if err != nil {
		return "{}"
	}
	return string(out)
}

// recentWindowStart derives the recent window start for an as-of day (the
// same 90-day window the session's raw scan targets).
func recentWindowStart(asOfDay string) string {
	day, err := time.Parse("2006-01-02", asOfDay)
	if err != nil {
		return asOfDay
	}
	return day.AddDate(0, 0, -(onboardingsync.DefaultRecentActivityDays - 1)).Format("2006-01-02")
}

func strPtr(s string) *string { return &s }

// asOfDayToWindowStart derives the recent window start for an as-of day (the
// same 90-day window the session's raw scan targets).
func asOfDayToWindowStart(asOfDay string) string {
	day, err := time.Parse("2006-01-02", asOfDay)
	if err != nil {
		return asOfDay
	}
	return day.AddDate(0, 0, -(onboardingsync.DefaultRecentActivityDays - 1)).Format("2006-01-02")
}

func ptr(s string) *string { return &s }
