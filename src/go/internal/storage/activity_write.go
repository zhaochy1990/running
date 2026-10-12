// activity_write.go is the athlete-facing activity write surface (#508): the
// only place outside the provider sync that may touch the activities table.
// It writes solely the normalized `feel` column — `feel_type` stays the
// vendor's raw value and is never user-writable.
package storage

import (
	"context"
	"fmt"
)

// SetActivityFeel writes the athlete's subjective feel (normalized 0–10 RPE)
// for one activity. Only the `feel` column is updated: the vendor-owned
// `feel_type` keeps its raw semantics. Returns false when the (user, label)
// activity does not exist. The existence probe runs first (rather than reading
// UPDATE's RowsAffected) because MySQL reports rows *changed* by default, so
// rewriting an identical feel would otherwise look like a miss.
func (s *Store) SetActivityFeel(ctx context.Context, userID, labelID string, feel float64) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	exists, err := s.ActivityExists(ctx, uid, labelID)
	if err != nil || !exists {
		return false, err
	}
	if err := s.db.WithContext(ctx).Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Update("feel", feel).Error; err != nil {
		return false, fmt.Errorf("storage: set activity feel: %w", err)
	}
	return true, nil
}
