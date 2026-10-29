package storage

import (
	"context"
	"fmt"
)

// RouteThumbShapeCandidates returns the label IDs of a user's activities that
// have GPS but no stored route_thumb_json — the shape-channel gap the sync
// pipelines' route_shapes step (devops#829) and the compute-only backfill
// (devops#830) fill. The predicate deliberately keys on route_thumb_json, not
// route_thumb_url: the URL column is frozen legacy from the retired PNG
// pipeline, and a row can carry a URL but no polyline (rendered before the
// dual-write era). The query narrows itself: a filled row drops out
// permanently, so a routine sync is one indexed query returning nothing, and
// the has_gps filter keeps no-trace activities (indoor, treadmill, strength)
// out of every future run.
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
// leaving route_thumb_url untouched: nothing writes route_thumb_url anymore
// (the PNG pipeline is retired, devops#829), so a legacy PNG URL that already
// exists must survive every shape write. The column itself is kept for the
// old-client long tail that still reads it.
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
