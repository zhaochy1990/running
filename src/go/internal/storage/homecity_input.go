// homecity_input.go adds the lean read surface the resident-city detector
// consumes (internal/homecity): the distinct activity-user list and, per user,
// every activity reduced to its two location signals — the watch-recorded name
// (city prefix) and the cached GPS start fix. Deliberately one flat query per
// user with no joins or aggregates: the detector needs raw votes, and a
// periodic job will re-read only users whose activity set changed.
package storage

import (
	"context"
	"time"
)

// ActivityStartSignal is one activity's location signals for resident-city
// detection. StartGPS is present only when the sync pipeline cached a valid
// first fix; Name is the raw watch-recorded activity name.
type ActivityStartSignal struct {
	Name        *string
	StartGPSLat *float64
	StartGPSLon *float64
	Date        time.Time
}

// ListActivityUserIDs returns every user that has at least one activity,
// oldest-user-first for stable iteration in jobs and validation output.
func (s *Store) ListActivityUserIDs(ctx context.Context) ([]string, error) {
	var ids []string
	if err := s.db.WithContext(ctx).Model(&Activity{}).
		Distinct().
		Order("user_id").
		Pluck("user_id", &ids).Error; err != nil {
		return nil, err
	}
	return ids, nil
}

// ListActivityStartSignals loads one user's activity location signals in
// chronological order. GPS validity mirrors the race-detection query: present,
// in range, and not the (0,0) sentinel.
func (s *Store) ListActivityStartSignals(ctx context.Context, userID string) ([]ActivityStartSignal, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []ActivityStartSignal
	if err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("name", "start_gps_lat", "start_gps_lon", "date").
		Where("user_id = ?", uid).
		Where("start_gps_lat IS NULL OR (start_gps_lat BETWEEN -90 AND 90 AND start_gps_lon BETWEEN -180 AND 180 AND NOT (start_gps_lat = 0 AND start_gps_lon = 0))").
		Order("date, label_id").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
