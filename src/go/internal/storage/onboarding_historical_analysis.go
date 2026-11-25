package storage

import (
	"context"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"gorm.io/gorm"
)

const (
	OnboardingHistoricalActor      = "onboarding_historical_analysis"
	OnboardingHistoricalRetryLimit = "interruption_limit"
	OnboardingHistoricalJobFailed  = "recompute_failed"
)

// A historical publication belongs to the binding and a frozen bundle. Reuse
// manual publications too, including sessions past the recent refresh horizon.
const onboardingHistoricalPublication = `
	FROM historical_metrics_recompute_runs AS m
	JOIN historical_recompute_runs AS c
	  ON c.run_id = m.calibration_run_id AND c.user_id = m.user_id
	 AND c.binding_revision = m.binding_revision
	 AND c.bundle_fingerprint = m.calibration_bundle_fingerprint
	 AND c.state IN ('completed', 'completed_with_gaps')
	WHERE m.state IN ('completed', 'completed_with_gaps')
	  AND m.published_at IS NOT NULL AND m.output_fingerprint IS NOT NULL
`

// ListOnboardingHistoricalCandidates rotates unfinished eligible sessions
// independently of the raw-sync timestamps and the recent-analysis horizon.
func (s *Store) ListOnboardingHistoricalCandidates(ctx context.Context, limit int) ([]*OnboardingSyncSession, error) {
	var sessions []*OnboardingSyncSession
	err := s.db.WithContext(ctx).Table("onboarding_sync_sessions AS s").Select("s.*").
		Where("s.state <> ? AND s.historical_analysis_reason IS NULL", OnboardingSyncStateSuperseded).
		Where(`EXISTS (
			SELECT 1 FROM onboarding_sync_stage_coverage c WHERE c.session_id = s.session_id
			AND c.stage = 'historical_raw' AND c.status IN ('completed', 'completed_with_gaps')
		) AND EXISTS (
			SELECT 1 FROM onboarding_sync_stage_coverage c WHERE c.session_id = s.session_id
			AND c.stage = 'auxiliary' AND c.status IN ('completed', 'completed_with_gaps')
		)`).
		Where("NOT EXISTS (SELECT 1 " + onboardingHistoricalPublication +
			" AND m.user_id = s.user_id AND m.binding_revision = s.binding_revision AND m.created_at >= s.created_at)").
		Order("s.historical_analysis_checked_at, s.session_id").Limit(limit).Find(&sessions).Error
	return sessions, err
}

func (s *Store) TouchOnboardingHistoricalCandidate(ctx context.Context, sessionID string) error {
	return s.db.WithContext(ctx).Model(&OnboardingSyncSession{}).Where("session_id = ?", sessionID).
		UpdateColumn("historical_analysis_checked_at", time.Now().UTC()).Error
}

// BlockOnboardingHistoricalAnalysis returns true only to the replica that
// first records the reason, so an operations alert is emitted once.
func (s *Store) BlockOnboardingHistoricalAnalysis(ctx context.Context, sessionID, reason string) (bool, error) {
	res := s.db.WithContext(ctx).Model(&OnboardingSyncSession{}).
		Where("session_id = ? AND historical_analysis_reason IS NULL AND state <> ?", sessionID, OnboardingSyncStateSuperseded).
		UpdateColumn("historical_analysis_reason", reason)
	return res.RowsAffected > 0, res.Error
}

func (s *Store) OnboardingHistoricalPublication(ctx context.Context, sess *OnboardingSyncSession) (*HistoricalMetricsRun, error) {
	var runs []HistoricalMetricsRun
	err := s.db.WithContext(ctx).Raw("SELECT m.* "+onboardingHistoricalPublication+
		" AND m.user_id = ? AND m.binding_revision = ? AND m.created_at >= ? ORDER BY m.published_at DESC, m.run_id DESC LIMIT 1",
		sess.UserID, sess.BindingRevision, sess.CreatedAt).Scan(&runs).Error
	if len(runs) == 0 || err != nil {
		return nil, err
	}
	return &runs[0], nil
}

// OnboardingHistoricalRuns uses the existing durable run ledgers to reconcile
// interrupted and in-flight work. The newest active runs can include manual
// work; older bindings must finish fencing out before an automatic claim.
type OnboardingHistoricalRuns struct {
	Calibration       *HistoricalRecomputeRun
	Metrics           *HistoricalMetricsRun
	ActiveCalibration *HistoricalRecomputeRun
	ActiveMetrics     *HistoricalMetricsRun
	Interruptions     int64
}

func (s *Store) ReadOnboardingHistoricalRuns(ctx context.Context, sess *OnboardingSyncSession) (OnboardingHistoricalRuns, error) {
	result := OnboardingHistoricalRuns{}
	db := s.db.WithContext(ctx)
	scope := func(model any) *gorm.DB {
		return db.Model(model).Where("user_id = ? AND binding_revision = ? AND created_at >= ?",
			sess.UserID, sess.BindingRevision, sess.CreatedAt)
	}
	latest := func(query *gorm.DB, out any) error {
		return query.Order("created_at DESC, run_id DESC").Limit(1).Find(out).Error
	}
	var cal HistoricalRecomputeRun
	var metrics HistoricalMetricsRun
	var activeMetrics HistoricalMetricsRun
	if err := latest(scope(&cal), &cal); err != nil {
		return result, err
	}
	if err := latest(scope(&metrics), &metrics); err != nil {
		return result, err
	}
	if cal.RunID != "" {
		result.Calibration = &cal
	}
	if metrics.RunID != "" {
		result.Metrics = &metrics
	}
	active, err := s.ActiveHistoricalRecomputeRunByUser(ctx, sess.UserID)
	if err != nil {
		return result, err
	}
	result.ActiveCalibration = active
	if err := latest(db.Model(&activeMetrics).Where("user_id = ? AND state IN ?", sess.UserID,
		[]string{HistoricalMetricsStatePending, HistoricalMetricsStateRunning}), &activeMetrics); err != nil {
		return result, err
	}
	if activeMetrics.RunID != "" {
		result.ActiveMetrics = &activeMetrics
	}
	for _, model := range []any{&HistoricalRecomputeRun{}, &HistoricalMetricsRun{}} {
		var count int64
		if err := scope(model).Where("state = ? AND created_by = ?", HistoricalRecomputeStateSuperseded, OnboardingHistoricalActor).
			Count(&count).Error; err != nil {
			return result, err
		}
		result.Interruptions += count
	}
	return result, nil
}

func (s *Store) LatestOnboardingHistoricalJob(ctx context.Context, userID, jobType string, since time.Time, activeOnly bool) (*job.Job, error) {
	var rows []jobModel
	query := s.db.WithContext(ctx).Where("user_id = ? AND job_type = ?", userID, jobType)
	if !since.IsZero() {
		query = query.Where("created_at >= ?", since)
	}
	if activeOnly {
		query = query.Where("status IN ?", []job.Status{job.StatusQueued, job.StatusRunning})
	}
	if err := query.Order("created_at DESC, id DESC").Limit(1).Find(&rows).Error; err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0].toDomain(), nil
}

// OnboardingHistoricalRecentEvidence only examines published data in the
// recent snapshot's original window. A skipped or empty derived row does not
// make a domain ready. Ability is verified separately on the publication day.
type OnboardingHistoricalRecentEvidence struct {
	Load, Zones, Ability bool
}

func (s *Store) ReadOnboardingHistoricalRecentEvidence(ctx context.Context, run *HistoricalMetricsRun, from, to string) (OnboardingHistoricalRecentEvidence, error) {
	var evidence OnboardingHistoricalRecentEvidence
	// The load date is a Shanghai natural day, not an activity timestamp.
	err := s.db.WithContext(ctx).Raw(`
		SELECT EXISTS (SELECT 1 FROM activity_training_load l
			WHERE l.user_id = ? AND l.activity_date BETWEEN ? AND ?
			  AND l.training_dose IS NOT NULL AND l.excluded_from_pmc = 0) AS load,
		       EXISTS (SELECT 1 FROM activity_training_load l JOIN activity_zones z
			ON z.user_id = l.user_id AND z.label_id = l.label_id
			WHERE l.user_id = ? AND l.activity_date BETWEEN ? AND ? AND z.zone_type = 'heartRate') AS zones,
		       EXISTS (SELECT 1 FROM ability_snapshot a WHERE a.user_id = ?
			AND a.date = ? AND a.level = 'L4' AND a.value IS NOT NULL
			AND a.computed_at >= ?) AS ability`,
		run.UserID, from, to, run.UserID, from, to,
		run.UserID, run.AnalysisAsOfDay, run.PublishedAt).Scan(&evidence).Error
	return evidence, err
}
