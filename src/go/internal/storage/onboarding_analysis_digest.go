// onboarding_analysis_digest.go is the recent-analysis input revision marker
// (devops#1009, epic devops#1004 T05): a cheap aggregate digest of the
// analysis inputs (recent activities, daily health, daily HRV) plus the
// calibration policy, hashed into the fingerprint that decides whether a
// published analysis result is still valid.
//
// The fingerprint deliberately hashes INPUT DATA and the policy revision, not
// artifact ids: a same-day calibration snapshot whose inputs changed underneath
// it (a new activity landed, a health day re-delivered, a policy bump) still
// invalidates the published result even though no snapshot id moved. Day rolls
// move it too (the as-of day is part of the key), which is the cross-midnight
// refresh trigger.
package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// OnboardingAnalysisDigest is the aggregate change marker of one user's
// recent-analysis inputs over a Shanghai-day window. Every field is a
// monotone-ish summary: count + max-timestamp + value sums. It is a
// invalidation heuristic, not a content hash — a change that alters values
// without moving count/max/sums would be missed, which for provider-synced
// raw rows (every write stamps synced_at) does not occur in practice.
type OnboardingAnalysisDigest struct {
	ActivityCount       int64      `json:"activity_count"`
	ActivityMaxSyncedAt *time.Time `json:"activity_max_synced_at,omitempty"`
	ActivityDistanceSum float64    `json:"activity_distance_sum"`
	ActivityDurationSum float64    `json:"activity_duration_sum"`

	HealthDayCount int64   `json:"health_day_count"`
	HealthMaxDate  *string `json:"health_max_date,omitempty"`
	HealthRHRSum   int64   `json:"health_rhr_sum"`
	HealthSleepSum int64   `json:"health_sleep_sum"`
	HealthScoreSum int64   `json:"health_score_sum"`

	HRVDayCount int64   `json:"hrv_day_count"`
	HRVMaxDate  *string `json:"hrv_max_date,omitempty"`
	HRVAvgSum   int64   `json:"hrv_avg_sum"`
}

// OnboardingAnalysisDigest reads the aggregate digest of the user's analysis
// inputs over [fromDay, toDay] (Shanghai natural days, inclusive). Activities
// are filtered by their Shanghai civil day exactly like ActivitiesInWindow;
// health/HRV rows key on their date column directly.
func (s *Store) OnboardingAnalysisDigest(ctx context.Context, userID, fromDay, toDay string) (OnboardingAnalysisDigest, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return OnboardingAnalysisDigest{}, err
	}
	var d OnboardingAnalysisDigest

	var act struct {
		Count   int64
		MaxSync *time.Time
		DistSum *float64
		DurSum  *float64
	}
	err = s.db.WithContext(ctx).Table("activities").
		Select(`COUNT(*) AS count, MAX(synced_at) AS max_sync,
			COALESCE(SUM(distance_m), 0) AS dist_sum, COALESCE(SUM(duration_s), 0) AS dur_sum`).
		Where("user_id = ?", uid).
		Where("DATE(date + INTERVAL 8 HOUR) >= ? AND DATE(date + INTERVAL 8 HOUR) <= ?", fromDay, toDay).
		Scan(&act).Error
	if err != nil {
		return d, fmt.Errorf("storage: analysis digest activities: %w", err)
	}
	d.ActivityCount = act.Count
	d.ActivityMaxSyncedAt = act.MaxSync
	d.ActivityDistanceSum = derefFloat(act.DistSum)
	d.ActivityDurationSum = derefFloat(act.DurSum)

	var health struct {
		Count    int64
		MaxDate  *string
		RHRSum   *int64
		SleepSum *int64
		ScoreSum *int64
	}
	err = s.db.WithContext(ctx).Table("daily_health").
		Select(`COUNT(*) AS count, MAX(date) AS max_date,
			COALESCE(SUM(rhr), 0) AS rhr_sum, COALESCE(SUM(sleep_total_s), 0) AS sleep_sum,
			COALESCE(SUM(sleep_score), 0) AS score_sum`).
		Where("user_id = ? AND date >= ? AND date <= ?", uid, fromDay, toDay).
		Scan(&health).Error
	if err != nil {
		return d, fmt.Errorf("storage: analysis digest health: %w", err)
	}
	d.HealthDayCount = health.Count
	d.HealthMaxDate = health.MaxDate
	d.HealthRHRSum = derefInt(health.RHRSum)
	d.HealthSleepSum = derefInt(health.SleepSum)
	d.HealthScoreSum = derefInt(health.ScoreSum)

	var hrv struct {
		Count   int64
		MaxDate *string
		AvgSum  *int64
	}
	err = s.db.WithContext(ctx).Table("daily_hrv").
		Select(`COUNT(*) AS count, MAX(date) AS max_date, COALESCE(SUM(last_night_avg), 0) AS avg_sum`).
		Where("user_id = ? AND date >= ? AND date <= ?", uid, fromDay, toDay).
		Scan(&hrv).Error
	if err != nil {
		return d, fmt.Errorf("storage: analysis digest hrv: %w", err)
	}
	d.HRVDayCount = hrv.Count
	d.HRVMaxDate = hrv.MaxDate
	d.HRVAvgSum = derefInt(hrv.AvgSum)

	return d, nil
}

// AnalysisFingerprint pins one analysis run's input revision: the scan anchor,
// the as-of day, the binding revision, the calibration policy version +
// revision, and the input digest. The sweep compares it against the published
// row's fingerprint to decide whether a merged refresh must supersede the old
// result (devops#1009: 同日snapshot ID不变仍按fingerprint/revision识别失效).
func AnalysisFingerprint(anchorDay, asOfDay string, bindingRevision int64, policy RunningCalibrationPolicy, d OnboardingAnalysisDigest) string {
	maxSync := "-"
	if d.ActivityMaxSyncedAt != nil {
		maxSync = d.ActivityMaxSyncedAt.UTC().Format(time.RFC3339Nano)
	}
	healthMax := "-"
	if d.HealthMaxDate != nil {
		healthMax = *d.HealthMaxDate
	}
	hrvMax := "-"
	if d.HRVMaxDate != nil {
		hrvMax = *d.HRVMaxDate
	}
	candidate := -1
	if policy.CandidateVersion != nil {
		candidate = *policy.CandidateVersion
	}
	payload := fmt.Sprintf("v1|anchor=%s|asof=%s|binding=%d|policy=%d/%d/%d|act=%d/%s/%.2f/%.2f|health=%d/%s/%d/%d/%d|hrv=%d/%s/%d",
		anchorDay, asOfDay, bindingRevision,
		policy.ActiveVersion, policy.Revision, candidate,
		d.ActivityCount, maxSync, d.ActivityDistanceSum, d.ActivityDurationSum,
		d.HealthDayCount, healthMax, d.HealthRHRSum, d.HealthSleepSum, d.HealthScoreSum,
		d.HRVDayCount, hrvMax, d.HRVAvgSum)
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func derefFloat(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func derefInt(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
