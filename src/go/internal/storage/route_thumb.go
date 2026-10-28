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

// RouteThumbShapeCandidates returns the label IDs of a user's activities that
// have GPS but no stored route_thumb_json — the shape-channel gap the
// compute-only backfill (devops#830) fills. The predicate is deliberately
// different from RouteThumbCandidates': it keys on route_thumb_json, not
// route_thumb_url, because the two columns have different histories. A row can
// carry a URL but no polyline (rendered before the sync pipeline started
// writing both), and once client-side vector drawing replaces the PNG that row
// still needs its shape. Like the PNG candidate query it narrows itself: a
// filled row drops out permanently, so a rerun is a no-op, and the has_gps
// filter keeps no-trace activities out of every future run.
func (s *Store) RouteThumbShapeCandidates(ctx context.Context, userID string) ([]string, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var ids []string
	if err := s.db.WithContext(ctx).
		Model(&Activity{}).
		Where("user_id = ?", uid).
		Where("has_gps = ?", true).
		Where("route_thumb_json IS NULL").
		Order("date DESC").
		Pluck("label_id", &ids).Error; err != nil {
		return nil, fmt.Errorf("storage: route thumb shape candidates: %w", err)
	}
	return ids, nil
}

// SetActivityRouteThumbJSON fills in only the polyline column of one activity,
// leaving route_thumb_url untouched: the shape backfill (devops#830) computes
// geometry and never renders or uploads, so a legacy PNG URL that already
// exists must survive the write.
func (s *Store) SetActivityRouteThumbJSON(ctx context.Context, userID, labelID, thumbJSON string) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	return s.db.WithContext(ctx).
		Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Update("route_thumb_json", thumbJSON).Error
}
