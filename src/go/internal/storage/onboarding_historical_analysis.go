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

// ClaimOnboardingHistoricalReplay throttles replay of a stale queued pointer
// across replicas. Claim/terminal transitions still own the job status.
func (s *Store) ClaimOnboardingHistoricalReplay(ctx context.Context, id string, before, now time.Time) (bool, error) {
	result := s.db.WithContext(ctx).Model(&jobModel{}).
		Where("id = ? AND status = ? AND updated_at <= ?", id, job.StatusQueued, before).
		UpdateColumn("updated_at", now)
	return result.RowsAffected > 0, result.Error
}

func (s *Store) OnboardingHistoricalRunActive(ctx context.Context, sess *OnboardingSyncSession) (bool, error) {
	var active bool
	err := s.db.WithContext(ctx).Raw(`
		SELECT EXISTS (
			SELECT 1 FROM historical_recompute_runs r LEFT JOIN jobs j ON j.id = r.last_job_id
			WHERE r.user_id = ? AND r.binding_revision = ? AND r.created_at >= ? AND r.state IN ('pending', 'running')
			  AND (r.updated_at >= UTC_TIMESTAMP(6) - INTERVAL 15 MINUTE OR
			    (j.status = 'running' AND COALESCE(j.heartbeat_at, j.updated_at) >= UTC_TIMESTAMP(6) - INTERVAL 15 MINUTE))
		) OR EXISTS (
			SELECT 1 FROM historical_metrics_recompute_runs r LEFT JOIN jobs j ON j.id = r.last_job_id
			WHERE r.user_id = ? AND r.binding_revision = ? AND r.created_at >= ? AND r.state IN ('pending', 'running')
			  AND (r.updated_at >= UTC_TIMESTAMP(6) - INTERVAL 15 MINUTE OR
			    (j.status = 'running' AND COALESCE(j.heartbeat_at, j.updated_at) >= UTC_TIMESTAMP(6) - INTERVAL 15 MINUTE))
		)
	`, sess.UserID, sess.BindingRevision, sess.CreatedAt, sess.UserID, sess.BindingRevision, sess.CreatedAt).Scan(&active).Error
	return active, err
}

// OnboardingHistoricalRequestQueued lets status polling follow a durable
// dispatch even before its worker claims a run.
func (s *Store) OnboardingHistoricalRequestQueued(ctx context.Context, sess *OnboardingSyncSession) (bool, error) {
	var found bool
	err := s.db.WithContext(ctx).Raw(`
		SELECT EXISTS (SELECT 1 FROM jobs
		 WHERE user_id = ? AND idempotency_key LIKE ? AND status IN ('queued', 'running')
			 AND COALESCE(heartbeat_at, updated_at) >= UTC_TIMESTAMP(6) - INTERVAL 15 MINUTE)
	`, sess.UserID, "onbhist:"+sess.SessionID+":%").Scan(&found).Error
	return found, err
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

// OnboardingHistoricalContinuation reads only job pointers for this run.
// The last pointer covers the initial claim (which has no run_id payload).
func (s *Store) OnboardingHistoricalContinuation(ctx context.Context, userID, kind, runID string, lastJobID *string, since time.Time) (*job.Job, error) {
	var rows []jobModel
	knownID := ""
	if lastJobID != nil {
		knownID = *lastJobID
	}
	err := s.db.WithContext(ctx).Where("user_id = ? AND job_type = ?", userID, kind).
		Where(`id = ? OR (created_at >= ? AND
			JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(input_json), input_json, '{}'), '$.run_id')) = ?)`, knownID, since, runID).
		Order("created_at DESC, id DESC").Limit(1).Find(&rows).Error
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0].toDomain(), nil
}

// OnboardingHistoricalDigestBounds pins all imported raw inputs for a
// first-sync attempt, including newly imported activity days after midnight.
// The calculation window remains unchanged. Manual runs keep their original
// event-day input bound and fingerprint.
func OnboardingHistoricalDigestBounds(actor, from, to string) (string, string) {
	if actor == OnboardingHistoricalActor {
		return "0000-01-01", "9999-12-31"
	}
	return from, to
}

// OnboardingHistoricalRecentEvidence describes published evidence from the
// selected run that falls within the original snapshot's coverage.
type OnboardingHistoricalRecentEvidence struct {
	Activities int
	Loads      int
	Zones      int
	Ability    bool `gorm:"column:has_ability"`
}

func (s *Store) ReadOnboardingHistoricalRecentEvidence(ctx context.Context, run *HistoricalMetricsRun, from, to, asOf string) (OnboardingHistoricalRecentEvidence, error) {
	var evidence OnboardingHistoricalRecentEvidence
	err := s.db.WithContext(ctx).Raw(`
		SELECT COUNT(*) AS activities,
		       COALESCE(SUM(artifact.kind = 'activity_load' AND l.training_dose IS NOT NULL
		         AND JSON_TYPE(JSON_EXTRACT(artifact.payload, '$.TrainingDose')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
		         AND JSON_UNQUOTE(JSON_EXTRACT(artifact.payload, '$.ExcludedFromPMC')) = 'false'), 0) AS loads,
		       COALESCE(SUM(EXISTS (
		         SELECT 1 FROM historical_metrics_recompute_staged z
		         JOIN activity_zones az ON az.user_id = a.user_id AND az.label_id = a.label_id
		         WHERE z.run_id = artifact.run_id AND z.kind = 'activity_zones' AND z.item_key = a.label_id
		           AND JSON_CONTAINS(z.payload, '{"ZoneType":"heartRate"}')
		           AND az.zone_type = 'heartRate'
		       )), 0) AS zones,
		       EXISTS (SELECT 1 FROM ability_snapshot ability
		         WHERE ability.user_id = ? AND ability.date = ? AND ? AND ability.level = 'L4'
		           AND ability.value IS NOT NULL AND ability.computed_at >= ?) AS has_ability
		FROM historical_metrics_recompute_staged artifact
		JOIN activities a ON a.user_id = ? AND a.label_id = artifact.item_key
		LEFT JOIN activity_training_load l ON l.user_id = a.user_id AND l.label_id = a.label_id
		WHERE artifact.run_id = ? AND artifact.kind IN ('activity_load', 'activity_skip')
		  AND DATE(a.date + INTERVAL 8 HOUR) BETWEEN ? AND ?
	`, run.UserID, asOf, asOf == run.AnalysisAsOfDay, run.PublishedAt, run.UserID, run.RunID, from, to).Scan(&evidence).Error
	return evidence, err
}
