// stride_read.go adds the read surface the STRIDE self-developed metric
// endpoints need (ADR 0023) for /api/{user}/stride/zones and
// /stride/training-load: the calibration zones for a snapshot, the daily PMC
// (training-load) series, and the latest usable PMC state. It mirrors
// stride_server/routes/stride.py so the Go endpoints emit the same payloads as
// the FastAPI routes they shadow.
//
// The latest calibration snapshot itself is read via the existing
// LatestRunningCalibrationSnapshot (compute_read.go); this file adds the
// snapshot's zone rows and the daily-load reads.
package storage

import "context"

// CalibrationZonesForSnapshot returns a snapshot's pace and heart-rate training
// zones (the two split tables), each ordered by name. /stride/zones re-sorts
// them into physiological order at the API boundary; the store just returns
// them deterministically. Mirrors fetch_zones_for_snapshot, which the Python
// endpoint calls after fetch_latest to hydrate the zone rows.
func (s *Store) CalibrationZonesForSnapshot(ctx context.Context, userID string, snapshotID uint64) ([]RunningCalibrationPaceZone, []RunningCalibrationHRZone, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, nil, err
	}
	var pace []RunningCalibrationPaceZone
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND snapshot_id = ?", uid, snapshotID).
		Order("name").Find(&pace).Error; err != nil {
		return nil, nil, err
	}
	var hr []RunningCalibrationHRZone
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND snapshot_id = ?", uid, snapshotID).
		Order("name").Find(&hr).Error; err != nil {
		return nil, nil, err
	}
	return pace, hr, nil
}

// DailyTrainingLoadSeries returns the most recent `days` daily_training_load
// rows ordered oldest-first (chart-friendly). Mirrors
// fetch_daily_training_load(limit=days), which selects the newest `days` rows
// (date DESC) and reverses them.
func (s *Store) DailyTrainingLoadSeries(ctx context.Context, userID string, days int) ([]DailyTrainingLoad, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []DailyTrainingLoad
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", uid).
		Order("date DESC").
		Limit(limitDays(days)).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	// Reverse in place to oldest-first.
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, nil
}

// usableCoverageStatuses are the coverage states that represent an observed
// athlete state (as opposed to an `unknown` continuity placeholder). Mirrors
// the fetch_latest_daily_training_load filter.
var usableCoverageStatuses = []string{"complete", "partial", "rest_confirmed"}

// LatestUsableDailyTrainingLoad returns the most recent daily_training_load row
// whose coverage_status is observed (never an `unknown` placeholder), searched
// unbounded (not limited to any window) so a long unknown gap never hides the
// last real state. Returns (nil, nil) when the user has no usable row. Mirrors
// Database.fetch_latest_daily_training_load; both /stride/training-load
// (current) and /pmc (stride_summary) read it.
func (s *Store) LatestUsableDailyTrainingLoad(ctx context.Context, userID string) (*DailyTrainingLoad, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []DailyTrainingLoad
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND coverage_status IN ?", uid, usableCoverageStatuses).
		Order("date DESC").
		Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}
