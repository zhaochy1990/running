package storage

import (
	"context"
	"fmt"
)

// RouteThumbCandidates returns the label IDs of a user's activities that still
// need a route thumbnail.
//
// An activity is a candidate when it has no uploaded thumbnail yet AND at least
// one GPS fix to draw. That predicate narrows itself: once an activity has a
// thumbnail it drops out permanently, so the steady-state cost on a routine
// incremental sync is one indexed query returning nothing, not a rescan of the
// user's history. The GPS check is pushed into SQL for the same reason — it
// keeps activities that have no trace at all (indoor, treadmill, strength) from
// being re-read on every sync, since they can never gain a thumbnail.
//
// It does NOT filter out activities that have GPS rows but too few valid fixes
// to draw (a mostly-failed GPS lock). Those stay candidates and have their
// timeseries re-read each run; that costs one indexed read per such activity and
// writing a "we tried and there was nothing to draw" marker to buy it back would
// blur the column's meaning.
func (s *Store) RouteThumbCandidates(ctx context.Context, userID string) ([]string, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := s.db.WithContext(ctx).
		Model(&Activity{}).
		Where("user_id = ? AND route_thumb_url IS NULL", uid).
		Where(`EXISTS (SELECT 1 FROM timeseries t
		                WHERE t.user_id = activities.user_id
		                  AND t.label_id = activities.label_id
		                  AND t.gps_lat IS NOT NULL)`).
		Order("date DESC").
		Pluck("label_id", &ids).Error; err != nil {
		return nil, fmt.Errorf("storage: route thumb candidates: %w", err)
	}
	return ids, nil
}

// SetActivityRouteThumb records the computed polyline and the uploaded PNG's
// public URL on one activity. Both are written together: the polyline is what
// the web client draws, the URL is what the miniprogram renders.
func (s *Store) SetActivityRouteThumb(ctx context.Context, userID, labelID, thumbJSON, thumbURL string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	return s.db.WithContext(ctx).
		Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Updates(map[string]any{
			"route_thumb_json": thumbJSON,
			"route_thumb_url":  thumbURL,
		}).Error
}
