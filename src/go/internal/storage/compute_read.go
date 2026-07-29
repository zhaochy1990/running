// compute_read.go adds the read surface the onboarding_compute handler needs to
// reconstruct calibration/ability inputs from the synced watch tables: activities
// in a Shanghai-day window with their timeseries + laps, and daily resting-HR
// rows. Mirrors the Python calibration connector's fetch_history /
// fetch_health_rows (stride_storage/sqlite/calibration_connector.py).
package storage

import (
	"context"
	"time"
)

// ActivitiesInWindow returns activities whose Shanghai-local day falls in
// [start, end] inclusive, ordered by (date, label_id) — matching the Python
// fetch_history SHANGHAI_DAY_SQL filter. An empty provider means all providers.
func (s *Store) ActivitiesInWindow(ctx context.Context, userID, provider string, start, end time.Time) ([]Activity, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	// DATE(date + INTERVAL 8 HOUR) is the Shanghai civil day of the UTC instant.
	q := s.db.WithContext(ctx).
		Where("user_id = ?", uid).
		Where("DATE(date + INTERVAL 8 HOUR) >= ?", start.Format("2006-01-02")).
		Where("DATE(date + INTERVAL 8 HOUR) <= ?", end.Format("2006-01-02"))
	if provider != "" {
		q = q.Where("provider = ?", provider)
	}
	var rows []Activity
	if err := q.Order("date, label_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ActivityTimeseries returns an activity's timeseries points ordered by id
// (insertion order), matching the Python connector's "ORDER BY id".
func (s *Store) ActivityTimeseries(ctx context.Context, userID, labelID string) ([]TimeseriesPoint, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []TimeseriesPoint
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Order("id").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ActivityLaps returns an activity's laps ordered by lap_index.
func (s *Store) ActivityLaps(ctx context.Context, userID, labelID string) ([]Lap, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []Lap
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Order("lap_index").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// DailyHealthWithRHR returns all daily-health rows with a non-null RHR for the
// user (the caller windows them; the RHR estimator re-filters by its own
// lookback). Mirrors fetch_health_rows' "rhr IS NOT NULL" filter.
func (s *Store) DailyHealthWithRHR(ctx context.Context, userID string) ([]DailyHealth, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []DailyHealth
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND rhr IS NOT NULL", uid).
		Order("date").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// runSportIDs mirrors stride_core.models.RUN_SPORT_IDS (sport_type integers
// treated as running for the PB scan).
var runSportIDs = []int{100, 101, 102, 103, 104, 600, 601, 8001, 8002, 8003, 8004, 8005}

// AllRunningActivities returns every running activity (by sport_type) with a
// positive duration, ordered by (date, label_id) — the chronological scan order
// the PB detector needs. Mirrors pb_records.detect_personal_bests' query.
func (s *Store) AllRunningActivities(ctx context.Context, userID string) ([]Activity, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []Activity
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND sport_type IN ? AND duration_s IS NOT NULL AND duration_s > 0", uid, runSportIDs).
		Order("date, label_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
