package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrRoadmapFeatureNotFound is returned when a roadmap feature id does not
// exist — the same 404 to every caller.
var ErrRoadmapFeatureNotFound = errors.New("storage: roadmap feature row not found")

// AutoMigrateRoadmap creates/updates the roadmap_features + roadmap_votes
// tables. Called by cmd/api at boot; the worker does not touch roadmap data.
func (s *Store) AutoMigrateRoadmap(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&RoadmapFeature{}, &RoadmapVote{}); err != nil {
		return fmt.Errorf("storage: automigrate roadmap: %w", err)
	}
	return nil
}

// CreateRoadmapFeature inserts one global feature row. Status must already be
// validated (IsRoadmapFeatureStatus); the handler owns vocabulary checks and
// the released side effects (released_at/snapshot) when creating straight
// into released.
func (s *Store) CreateRoadmapFeature(ctx context.Context, row *RoadmapFeature) error {
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	if err := s.db.WithContext(ctx).Create(row).Error; err != nil {
		return fmt.Errorf("storage: create roadmap_features: %w", err)
	}
	return nil
}

// UpdateRoadmapFeature persists the full editable projection (title,
// description, category, planned_note, status + release side effects) of the
// row with the given id. releasing=true marks a →released transition: the
// live vote count is taken and frozen into votes_snapshot, released_at set —
// inside the same transaction so a vote landing mid-release cannot skew the
// snapshot. A missing id is ErrRoadmapFeatureNotFound.
func (s *Store) UpdateRoadmapFeature(ctx context.Context, row *RoadmapFeature, releasing bool) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if releasing {
			var votes int64
			if err := tx.Model(&RoadmapVote{}).Where("feature_id = ?", row.ID).Count(&votes).Error; err != nil {
				return fmt.Errorf("storage: count roadmap_votes: %w", err)
			}
			now := time.Now().UTC()
			row.ReleasedAt = &now
			row.VotesSnapshot = uint64(votes)
		}
		res := tx.Model(&RoadmapFeature{}).Where("id = ?", row.ID).Updates(map[string]any{
			"title": row.Title, "description": row.Description, "category": row.Category,
			"status": row.Status, "planned_note": row.PlannedNote,
			"released_at": row.ReleasedAt, "votes_snapshot": row.VotesSnapshot,
			"updated_at": time.Now().UTC(),
		})
		if res.Error != nil {
			return fmt.Errorf("storage: update roadmap_features: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			// MySQL reports 0 affected rows for a value-identical update;
			// only treat it as missing when the row genuinely is not there.
			var n int64
			if err := tx.Model(&RoadmapFeature{}).Where("id = ?", row.ID).Count(&n).Error; err != nil {
				return fmt.Errorf("storage: reload roadmap_features: %w", err)
			}
			if n == 0 {
				return ErrRoadmapFeatureNotFound
			}
		}
		return nil
	})
}

// DeleteRoadmapFeature removes the feature and its votes in one transaction —
// orphaned votes on a deleted draft/backlog feature would otherwise inflate
// total_votes forever. Admin callers must have already refused to delete
// accepted/released rows (history preservation); this method does not check.
func (s *Store) DeleteRoadmapFeature(ctx context.Context, id uint64) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("feature_id = ?", id).Delete(&RoadmapVote{}).Error; err != nil {
			return fmt.Errorf("storage: delete roadmap_votes: %w", err)
		}
		res := tx.Delete(&RoadmapFeature{}, id)
		if res.Error != nil {
			return fmt.Errorf("storage: delete roadmap_features: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return ErrRoadmapFeatureNotFound
		}
		return nil
	})
}

// GetRoadmapFeature returns the feature with the given id,
// ErrRoadmapFeatureNotFound when absent.
func (s *Store) GetRoadmapFeature(ctx context.Context, id uint64) (*RoadmapFeature, error) {
	var row RoadmapFeature
	if err := s.db.WithContext(ctx).First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRoadmapFeatureNotFound
		}
		return nil, fmt.Errorf("storage: get roadmap_features: %w", err)
	}
	return &row, nil
}

// ListRoadmapFeatures returns feature rows, optionally filtered by status
// ("" = all, including draft). Newest first; the user-side aggregate re-sorts
// per its own contract, the admin list renders this as-is.
func (s *Store) ListRoadmapFeatures(ctx context.Context, status string) ([]RoadmapFeature, error) {
	q := s.db.WithContext(ctx).Model(&RoadmapFeature{})
	if status != "" {
		q = q.Where("status = ?", status)
	}
	var rows []RoadmapFeature
	if err := q.Order("created_at DESC, id DESC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list roadmap_features: %w", err)
	}
	return rows, nil
}

// RoadmapVoteCounts returns live vote counts keyed by feature id. Features
// with zero votes are absent from the map; the total vote count is the sum of
// the values (vote rows always reference a live feature — deletions cascade).
func (s *Store) RoadmapVoteCounts(ctx context.Context) (map[uint64]uint64, error) {
	var rows []struct {
		FeatureID uint64 `gorm:"column:feature_id"`
		N         uint64 `gorm:"column:n"`
	}
	if err := s.db.WithContext(ctx).Model(&RoadmapVote{}).
		Select("feature_id, COUNT(*) AS n").Group("feature_id").
		Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: count roadmap_votes: %w", err)
	}
	out := make(map[uint64]uint64, len(rows))
	for _, r := range rows {
		out[r.FeatureID] = r.N
	}
	return out, nil
}

// RoadmapVoteIDsByUser returns the ids of the features the user voted on —
// the voted flags and the my_votes summary in one read.
func (s *Store) RoadmapVoteIDsByUser(ctx context.Context, userID string) ([]uint64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var ids []uint64
	if err := s.db.WithContext(ctx).Model(&RoadmapVote{}).
		Where("user_id = ?", uid).Pluck("feature_id", &ids).Error; err != nil {
		return nil, fmt.Errorf("storage: list roadmap_votes: %w", err)
	}
	return ids, nil
}

// AddRoadmapVote inserts the user's vote on a feature; a duplicate (UNIQUE
// user_id + feature_id) is a no-op, making re-votes idempotent. The caller
// has already verified the feature exists and is votable (backlog).
func (s *Store) AddRoadmapVote(ctx context.Context, userID string, featureID uint64) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	row := &RoadmapVote{UserID: uid, FeatureID: featureID, CreatedAt: time.Now().UTC()}
	if err := s.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(row).Error; err != nil {
		return fmt.Errorf("storage: add roadmap_vote: %w", err)
	}
	return nil
}

// RemoveRoadmapVote deletes the user's vote on a feature if present; removing
// a non-existent vote is a no-op (idempotent un-vote).
func (s *Store) RemoveRoadmapVote(ctx context.Context, userID string, featureID uint64) error {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND feature_id = ?", uid, featureID).
		Delete(&RoadmapVote{}).Error; err != nil {
		return fmt.Errorf("storage: remove roadmap_vote: %w", err)
	}
	return nil
}
