// activity_write.go is the athlete-facing activity write surface (#508): the
// only place outside the provider sync that may touch the activities table.
// It writes solely the athlete's `feel_note` free text — `feel` (vendor-
// normalized 1–10) and `feel_type` (vendor raw) are never user-writable.
package storage

import (
	"context"
	"fmt"
)

// SetActivityFeelNote writes the athlete's subjective feel verbatim (free
// text, e.g. "前面4组体感6，最后两组7-8") for one activity. Only the
// `feel_note` column is updated: the vendor-owned `feel`/`feel_type` columns
// keep their semantics. Returns false when the (user, label) activity does
// not exist. The existence probe runs first (rather than reading UPDATE's
// RowsAffected) because MySQL reports rows *changed* by default, so
// rewriting an identical note would otherwise look like a miss.
func (s *Store) SetActivityFeelNote(ctx context.Context, userID, labelID, note string) (bool, error) {
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
		Update("feel_note", note).Error; err != nil {
		return false, fmt.Errorf("storage: set activity feel note: %w", err)
	}
	return true, nil
}
