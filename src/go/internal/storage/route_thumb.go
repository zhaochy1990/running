package storage

import (
	"context"
	"fmt"
)

// RouteThumbCandidates returns the label IDs of a user's activities that need a
// route thumbnail.
//
// An activity is a candidate when it has no uploaded thumbnail yet AND GPS to
// draw. That predicate narrows itself: once an activity has a thumbnail it
// drops out permanently, so the steady-state cost on a routine incremental
// sync is one indexed query returning nothing, not a rescan of the user's
// history. The GPS check stays in SQL for the same reason — activities with no
// trace at all (indoor, treadmill, strength) can never gain a thumbnail and
// must not be re-read on every sync.
//
// Phase 2 (devops#786 AC3) reads the has_gps flag the dual-write/backfill
// stamps instead of the old EXISTS probe over timeseries rows: same meaning
// ("at least one valid fix"), one indexed column instead of a correlated
// subquery walking the biggest table. Deployment gate: has_gps is only
// populated once the backfill has stamped the stock rows, so this switch
// ships AFTER the backfill drained (un-stamped NULL rows are not candidates
// until then) — the rollout ordering is owned by ops, not this code.
//
// force drops the "no thumbnail yet" half and selects every outdoor activity,
// for regenerating existing thumbnails after a change to the rendering
// algorithm. Keys are per-activity, so a forced run overwrites in place rather
// than orphaning objects.
//
// It never filters out activities that have GPS but too few valid fixes to
// draw (a mostly-failed GPS lock). Those stay candidates and have their
// timeseries re-read each run; that costs one blob GET (Phase 2) per such
// activity and writing a "we tried and there was nothing to draw" marker to
// buy it back would blur the column's meaning.
func (s *Store) RouteThumbCandidates(ctx context.Context, userID string, force bool) ([]string, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	q := s.db.WithContext(ctx).
		Model(&Activity{}).
		Where("user_id = ?", uid).
		Where("has_gps = ?", true)
	if !force {
		q = q.Where("route_thumb_url IS NULL")
	}

	var ids []string
	if err := q.Order("date DESC").Pluck("label_id", &ids).Error; err != nil {
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
