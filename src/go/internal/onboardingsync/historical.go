package onboardingsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/catalog"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

const historicalInterruptionLimit = 20

type historicalStore interface {
	ListOnboardingHistoricalCandidates(context.Context, int) ([]*storage.OnboardingSyncSession, error)
	TouchOnboardingHistoricalCandidate(context.Context, string) error
	BlockOnboardingHistoricalAnalysis(context.Context, string, string) (bool, error)
	OnboardingHistoricalPublication(context.Context, *storage.OnboardingSyncSession) (*storage.HistoricalMetricsRun, error)
	ReadOnboardingHistoricalRuns(context.Context, *storage.OnboardingSyncSession) (storage.OnboardingHistoricalRuns, error)
	ClaimOnboardingHistoricalReplay(context.Context, string, time.Time, time.Time) (bool, error)
	OnboardingHistoricalRunActive(context.Context, *storage.OnboardingSyncSession) (bool, error)
	OnboardingHistoricalRequestQueued(context.Context, *storage.OnboardingSyncSession) (bool, error)
	OnboardingHistoricalContinuation(context.Context, string, string, string, *string, time.Time) (*job.Job, error)
	SupersedeHistoricalRecomputeRun(context.Context, string, string) error
	SupersedeHistoricalMetricsRun(context.Context, string, string) error
	LatestOnboardingHistoricalJob(context.Context, string, string, time.Time, bool) (*job.Job, error)
	ReadOnboardingHistoricalRecentEvidence(context.Context, *storage.HistoricalMetricsRun, string, string, string) (storage.OnboardingHistoricalRecentEvidence, error)
	GetWatchBinding(context.Context, string) (*storage.WatchBindingState, error)
}

type historicalJobInput struct {
	AsOfDay          string `json:"as_of_day,omitempty"`
	BindingRevision  int64  `json:"binding_revision,omitempty"`
	CalibrationRunID string `json:"calibration_run_id,omitempty"`
	RunID            string `json:"run_id,omitempty"`
	ChunkSeq         int    `json:"chunk_seq,omitempty"`
}

func (s *Service) sweepHistoricalAnalysis(ctx context.Context) {
	if !s.historicalAuto || s.historical == nil {
		return
	}
	sessions, err := s.historical.ListOnboardingHistoricalCandidates(ctx, s.limit)
	if err != nil {
		s.log.Warn("onboardingsync: historical analysis scan failed", zap.Error(err))
		return
	}
	for _, sess := range sessions {
		if err := s.historical.TouchOnboardingHistoricalCandidate(ctx, sess.SessionID); err != nil {
			s.log.Warn("onboardingsync: historical analysis scan rotation failed", zap.Error(err))
			continue
		}
		if err := s.reconcileHistoricalAnalysis(ctx, sess); err != nil {
			s.log.Warn("onboardingsync: historical analysis reconciliation failed", zap.String("session_id", sess.SessionID), zap.Error(err))
		}
	}
}

func (s *Service) reconcileHistoricalAnalysis(ctx context.Context, sess *storage.OnboardingSyncSession) error {
	binding, err := s.historical.GetWatchBinding(ctx, sess.UserID)
	if err != nil || binding == nil || binding.Revision != sess.BindingRevision {
		return err
	}
	runs, err := s.historical.ReadOnboardingHistoricalRuns(ctx, sess)
	if err != nil {
		return err
	}
	// The candidate selection and run reads span multiple statements. A
	// concurrent or manual publication wins even when it landed after listing.
	if published, err := s.historical.OnboardingHistoricalPublication(ctx, sess); published != nil || err != nil {
		return err
	}

	const calType = catalog.JobTypeHistoricalCalibrationRecompute
	const metricsType = catalog.JobTypeHistoricalMetricsRecompute
	// Adopt any live job (including manual requests) before enqueueing. After
	// a store-first enqueue crash, replay the pointer to the same durable row.
	for _, kind := range []string{calType, metricsType} {
		live, err := s.historical.LatestOnboardingHistoricalJob(ctx, sess.UserID, kind, time.Time{}, true)
		if err != nil {
			return err
		}
		if live != nil {
			if live.Status == job.StatusQueued && s.historicalPublisher != nil {
				now := time.Now().UTC()
				before := now.Add(-s.historicalReplayAge)
				if !live.UpdatedAt.After(before) {
					claimed, err := s.historical.ClaimOnboardingHistoricalReplay(ctx, live.ID, before, now)
					if err != nil || !claimed {
						return err
					}
					return s.historicalPublisher.PublishWork(ctx, job.Message{JobID: live.ID, UserID: live.UserID})
				}
			}
			return nil
		}
	}

	// A checkpoint with no live job can be resumed in-place. Keep the
	// continuation tied to the run and to the most recent terminal job.
	if cal := runs.ActiveCalibration; cal != nil {
		if cal.BindingRevision > sess.BindingRevision {
			return nil // an older sweep observed work begun after the rebind
		}
		if cal.BindingRevision < sess.BindingRevision {
			return s.historical.SupersedeHistoricalRecomputeRun(ctx, cal.RunID, "binding_revision_changed")
		}
		return s.recoverHistoricalRun(ctx, sess, calType, cal.RunID, cal.LastJobID, cal.ChunkSeq, cal.CreatedAt)
	}
	if metrics := runs.ActiveMetrics; metrics != nil {
		if metrics.BindingRevision > sess.BindingRevision {
			return nil // an older sweep observed work begun after the rebind
		}
		if metrics.BindingRevision < sess.BindingRevision {
			return s.historical.SupersedeHistoricalMetricsRun(ctx, metrics.RunID, "binding_revision_changed")
		}
		return s.recoverHistoricalRun(ctx, sess, metricsType, metrics.RunID, metrics.LastJobID, metrics.ChunkSeq, metrics.CreatedAt)
	}
	if runs.Interruptions >= historicalInterruptionLimit {
		return s.blockHistoricalAnalysis(ctx, sess, storage.OnboardingHistoricalRetryLimit, runs.Interruptions)
	}

	policy, err := s.store.CalibrationPolicy(ctx)
	if err != nil {
		return err
	}
	in := historicalJobInput{AsOfDay: timefmt.ShanghaiToday().Format("2006-01-02"), BindingRevision: sess.BindingRevision}
	kind, calID, metricsID := calType, "", ""
	if runs.Calibration != nil {
		calID = runs.Calibration.RunID
	}
	if runs.Metrics != nil {
		metricsID = runs.Metrics.RunID
	}
	if cal := runs.Calibration; cal != nil && cal.BundleFingerprint != nil &&
		(cal.State == storage.HistoricalRecomputeStateCompleted || cal.State == storage.HistoricalRecomputeStateCompletedWithGaps) &&
		cal.PolicyVersion == policy.ActiveVersion && cal.PolicyRevision == policy.Revision &&
		(runs.Metrics == nil || runs.Metrics.State != storage.HistoricalMetricsStateSuperseded || runs.Metrics.CalibrationRunID != cal.RunID) {
		kind = metricsType
		// A sequence crossing Shanghai midnight keeps the original frozen
		// window. A fresh calibration attempt always uses its dispatch day.
		in.AsOfDay, in.CalibrationRunID = cal.AnalysisAsOfDay, cal.RunID
	}

	key := fmt.Sprintf("onbhist:%s:%s:%s:%s", sess.SessionID, kind, calID, metricsID)
	return s.enqueueHistoricalAnalysis(ctx, sess, kind, key, in)
}

func (s *Service) recoverHistoricalRun(ctx context.Context, sess *storage.OnboardingSyncSession, kind, runID string, lastJobID *string, seq int, since time.Time) error {
	last, err := s.historical.OnboardingHistoricalContinuation(ctx, sess.UserID, kind, runID, lastJobID, since)
	if err != nil {
		return err
	}
	lastID := ""
	if last != nil {
		if !last.Status.Terminal() {
			return nil
		}
		lastID = last.ID
		if last.Status == job.StatusFailed && last.ErrorCode != "publish_failed" {
			return s.blockHistoricalAnalysis(ctx, sess, storage.OnboardingHistoricalJobFailed, 0)
		}
	}
	key := fmt.Sprintf("onbhist:%s:resume:%s:%s", sess.SessionID, runID, lastID)
	return s.enqueueHistoricalAnalysis(ctx, sess, kind, key, historicalJobInput{RunID: runID, ChunkSeq: seq})
}

func (s *Service) enqueueHistoricalAnalysis(ctx context.Context, sess *storage.OnboardingSyncSession, kind, key string, input historicalJobInput) error {
	// A rejected broker publish is durable. Move to a new key only after
	// observing that failure. Concurrent workers use the same successor key.
	for {
		prior, err := s.store.JobByIdempotencyKey(ctx, sess.UserID, key)
		if job.IsNotFound(err) || (err == nil && prior == nil) {
			break
		}
		if err != nil {
			return err
		}
		if prior.Status != job.StatusFailed {
			return nil
		}
		switch prior.ErrorCode {
		case "publish_failed", "calibration_run_active", "calibration_bundle_changed":
			key = fmt.Sprintf("onbhist:%s:retry:%s", sess.SessionID, prior.ID)
		default:
			return s.blockHistoricalAnalysis(ctx, sess, storage.OnboardingHistoricalJobFailed, 0)
		}
	}
	raw, err := json.Marshal(input)
	if err != nil {
		return err
	}
	_, err = s.enq.Enqueue(ctx, job.EnqueueSpec{
		Type: kind, UserID: sess.UserID, CreatedBy: storage.OnboardingHistoricalActor,
		IdempotencyKey: key, InputJSON: string(raw),
	})
	if errors.Is(err, job.ErrConflict) {
		return nil
	}
	return err
}

func (s *Service) blockHistoricalAnalysis(ctx context.Context, sess *storage.OnboardingSyncSession, reason string, interruptions int64) error {
	first, err := s.historical.BlockOnboardingHistoricalAnalysis(ctx, sess.SessionID, reason)
	if first {
		s.log.Error("onboardingsync: historical analysis requires operator intervention",
			zap.String("session_id", sess.SessionID), zap.String("user_id", sess.UserID),
			zap.String("reason", reason), zap.Int64("interruptions", interruptions))
	}
	return err
}

func (s *Service) projectHistoricalAnalysis(ctx context.Context, sess *storage.OnboardingSyncSession, covs []*storage.OnboardingSyncStageCoverage, v *View) error {
	history, auxiliary := false, false
	for _, cov := range covs {
		switch cov.Stage {
		case storage.OnboardingSyncStageHistoricalRaw:
			history = coverageTerminal(cov)
		case storage.OnboardingSyncStageAuxiliary:
			auxiliary = coverageTerminal(cov)
		}
	}
	if history && auxiliary {
		v.Readiness.HistoricalAnalysis = ReadinessPending
	}
	if s.historical == nil || !history {
		return nil
	}
	published, err := s.historical.OnboardingHistoricalPublication(ctx, sess)
	if err != nil {
		return err
	}
	if published != nil {
		v.Readiness.HistoricalAnalysis = ReadinessReady
		if published.State == storage.HistoricalMetricsStateCompletedWithGaps {
			v.Readiness.HistoricalAnalysis = ReadinessReadyWithGaps
		}
		return s.projectPublishedRecentEvidence(ctx, published, v)
	}
	if !auxiliary {
		return nil
	}
	if sess.HistoricalAnalysisReason != nil {
		v.HistoricalAnalysisReason = sess.HistoricalAnalysisReason
		return nil
	}
	// Bridge the first sweep and gaps between chunks without keeping clients
	// polling indefinitely when the automatic dispatcher is switched off.
	v.HistoricalAnalysisPoll = time.Since(sess.UpdatedAt) < 2*time.Minute ||
		(sess.HistoricalAnalysisCheckedAt != nil && time.Since(*sess.HistoricalAnalysisCheckedAt) < 2*time.Minute)
	active, err := s.historical.OnboardingHistoricalRunActive(ctx, sess)
	if err != nil {
		return err
	}
	if active {
		v.HistoricalAnalysisPoll = true
		v.Readiness.HistoricalAnalysis = ReadinessRunning
		return nil
	}
	if !v.HistoricalAnalysisPoll {
		v.HistoricalAnalysisPoll, err = s.historical.OnboardingHistoricalRequestQueued(ctx, sess)
	}
	return err
}

func (s *Service) projectPublishedRecentEvidence(ctx context.Context, published *storage.HistoricalMetricsRun, v *View) error {
	recent := v.RecentAnalysis
	if recent == nil || recent.ComputedAt.After(*published.PublishedAt) ||
		recent.AsOfDay < published.TargetFromDay || recent.AsOfDay > published.TargetToDay {
		return nil
	}
	hasGap := false
	for _, name := range []string{"load", "zones", "ability"} {
		hasGap = hasGap || recent.Domains[name].Reason == "historical_calibration_missing"
	}
	if !hasGap {
		return nil
	}
	from, to := published.TargetToDay, published.TargetFromDay
	if recent.CoverageFrom != nil && recent.CoverageTo != nil && *recent.CoverageFrom >= published.TargetFromDay && *recent.CoverageTo <= published.TargetToDay {
		from, to = *recent.CoverageFrom, *recent.CoverageTo
	}
	evidence, err := s.historical.ReadOnboardingHistoricalRecentEvidence(ctx, published, from, to, recent.AsOfDay)
	if err != nil {
		return err
	}
	ability := 0
	if evidence.Ability {
		ability = 1
	}
	for _, domain := range []struct {
		name             string
		available, total int
	}{
		{"load", evidence.Loads, evidence.Activities},
		{"zones", evidence.Zones, evidence.Activities},
		{"ability", ability, 1},
	} {
		if recent.Domains[domain.name].Reason != "historical_calibration_missing" {
			continue
		}
		switch {
		case domain.available == 0:
			recent.Domains[domain.name] = AnalysisDomainView{Status: "unavailable", Reason: "no_published_evidence"}
		case domain.available < domain.total:
			recent.Domains[domain.name] = AnalysisDomainView{Status: "partial", Reason: "historical_recompute_coverage_gap"}
		default:
			recent.Domains[domain.name] = AnalysisDomainView{Status: "ready"}
		}
	}
	ready, usable := 0, 0
	for _, domain := range recent.Domains {
		if domain.Status == "ready" {
			ready++
		}
		if domain.Status == "ready" || domain.Status == "partial" {
			usable++
		}
	}
	switch {
	case ready == len(recent.Domains):
		recent.Status = storage.OnboardingAnalysisStatusReady
	case usable > 0:
		recent.Status = storage.OnboardingAnalysisStatusPartial
	default:
		recent.Status = storage.OnboardingAnalysisStatusUnavailable
	}
	if v.Readiness.RecentAnalysis == ReadinessFailed || v.Readiness.RecentAnalysis == ReadinessNotStarted {
		return nil
	}
	v.Readiness.RecentAnalysis = Readiness(recent.Status)
	for i := range v.Stages {
		if v.Stages[i].Stage == storage.OnboardingSyncStageRecentAnalysis && v.Stages[i].Readiness != ReadinessFailed {
			v.Stages[i].Readiness = v.Readiness.RecentAnalysis
		}
	}
	return nil
}
