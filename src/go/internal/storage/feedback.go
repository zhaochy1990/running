package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// ErrFeedbackNotFound is returned when a feedback id does not exist (or is
// not owned by the requesting user).
var ErrFeedbackNotFound = errors.New("storage: feedback row not found")

// ErrFeedbackAdoptedImmutable is returned when an admin PATCH tries to move or
// clear an already-set adopted_feature_id (one-way, devops#519).
var ErrFeedbackAdoptedImmutable = errors.New("storage: feedback adopted_feature_id is immutable")

// AutoMigrateFeedback creates/updates the feedbacks + feedback_replies tables.
// Called by cmd/api at boot; the worker does not touch feedback data. The
// legacy feedback_image_checks table is no longer created (devops#608).
func (s *Store) AutoMigrateFeedback(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(
		&Feedback{}, &FeedbackReply{},
	); err != nil {
		return fmt.Errorf("storage: automigrate feedback: %w", err)
	}
	return nil
}

// CreateFeedback inserts one feedback row. Vocabulary and size limits are the
// API's job; the store persists as given.
func (s *Store) CreateFeedback(ctx context.Context, row *Feedback) error {
	return s.db.WithContext(ctx).Create(row).Error
}

// ListFeedbacksByUser returns the user's feedback rows, newest first. The
// session list is deliberately unpaginated (devops#519).
func (s *Store) ListFeedbacksByUser(ctx context.Context, userID string) ([]Feedback, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []Feedback
	if err := s.db.WithContext(ctx).Where("user_id = ?", uid).Order("id DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// GetFeedback returns one feedback owned by userID, ErrFeedbackNotFound when
// absent or foreign.
func (s *Store) GetFeedback(ctx context.Context, userID string, id uint64) (*Feedback, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row Feedback
	if err := s.db.WithContext(ctx).Where("user_id = ? AND id = ?", uid, id).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrFeedbackNotFound
		}
		return nil, err
	}
	return &row, nil
}

// GetFeedbackByID returns one feedback regardless of owner (the admin thread
// view), ErrFeedbackNotFound when absent.
func (s *Store) GetFeedbackByID(ctx context.Context, id uint64) (*Feedback, error) {
	var row Feedback
	if err := s.db.WithContext(ctx).Where("id = ?", id).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrFeedbackNotFound
		}
		return nil, err
	}
	return &row, nil
}

// FeedbackUnreadCounts counts the user's unread admin replies per feedback id
// (the list badge; total_unread is the sum).
func (s *Store) FeedbackUnreadCounts(ctx context.Context, userID string) (map[uint64]int64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	type cnt struct {
		FeedbackID uint64
		N          int64
	}
	var rows []cnt
	err = s.db.WithContext(ctx).Raw(
		`SELECT r.feedback_id AS feedback_id, COUNT(*) AS n
		   FROM feedback_replies r JOIN feedbacks f ON f.id = r.feedback_id
		  WHERE f.user_id = ? AND r.author = ? AND r.is_read = false
		  GROUP BY r.feedback_id`, uid, FeedbackAuthorAdmin,
	).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := make(map[uint64]int64, len(rows))
	for _, r := range rows {
		out[r.FeedbackID] = r.N
	}
	return out, nil
}

// LastFeedbackReplies returns, for each given feedback, its newest reply (the
// list preview line). Feedbacks without replies are absent from the map.
func (s *Store) LastFeedbackReplies(ctx context.Context, feedbackIDs []uint64) (map[uint64]FeedbackReply, error) {
	out := make(map[uint64]FeedbackReply, len(feedbackIDs))
	if len(feedbackIDs) == 0 {
		return out, nil
	}
	var rows []FeedbackReply
	if err := s.db.WithContext(ctx).
		Where("feedback_id IN ?", feedbackIDs).
		Order("id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows { // ascending scan: the last write per id wins
		out[r.FeedbackID] = r
	}
	return out, nil
}

// ListFeedbackReplies returns the thread under one feedback, oldest first.
func (s *Store) ListFeedbackReplies(ctx context.Context, feedbackID uint64) ([]FeedbackReply, error) {
	var rows []FeedbackReply
	if err := s.db.WithContext(ctx).
		Where("feedback_id = ?", feedbackID).Order("id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// CreateFeedbackReply inserts a user reply row.
func (s *Store) CreateFeedbackReply(ctx context.Context, row *FeedbackReply) error {
	return s.db.WithContext(ctx).Create(row).Error
}

// CreateAdminFeedbackReply inserts the official reply and applies the open→replied
// side effect in one transaction (only while the feedback is still open —
// replied and closed rows keep their status).
func (s *Store) CreateAdminFeedbackReply(ctx context.Context, row *FeedbackReply) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(row).Error; err != nil {
			return err
		}
		return tx.Model(&Feedback{}).Where("id = ? AND status = ?", row.FeedbackID, FeedbackStatusOpen).
			Updates(map[string]interface{}{"status": FeedbackStatusReplied, "updated_at": time.Now().UTC()}).Error
	})
}

// MarkFeedbackRepliesRead batch-clears a feedback's unread admin replies
// (读即清 — the side effect of the owner's detail read).
func (s *Store) MarkFeedbackRepliesRead(ctx context.Context, feedbackID uint64) error {
	return s.db.WithContext(ctx).Model(&FeedbackReply{}).
		Where("feedback_id = ? AND author = ? AND is_read = false", feedbackID, FeedbackAuthorAdmin).
		Update("is_read", true).Error
}

// PatchFeedbackAdmin applies the admin PATCH: close (status=closed is the only
// allowed status move) and/or the one-way adopted_feature_id. Absent fields
// are no-ops; a set adopted_feature_id can never be moved or cleared.
func (s *Store) PatchFeedbackAdmin(ctx context.Context, id uint64, close bool, adoptedFeatureID *uint64) (*Feedback, error) {
	var row *Feedback
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current Feedback
		if err := tx.Where("id = ?", id).First(&current).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrFeedbackNotFound
			}
			return err
		}
		updates := map[string]interface{}{"updated_at": time.Now().UTC()}
		if close {
			updates["status"] = FeedbackStatusClosed
		}
		if adoptedFeatureID != nil {
			if current.AdoptedFeatureID != nil {
				return ErrFeedbackAdoptedImmutable
			}
			updates["adopted_feature_id"] = *adoptedFeatureID
		}
		if err := tx.Model(&Feedback{}).Where("id = ?", id).Updates(updates).Error; err != nil {
			return err
		}
		if err := tx.Where("id = ?", id).First(&current).Error; err != nil {
			return err
		}
		row = &current
		return nil
	})
	if err != nil {
		return nil, err
	}
	return row, nil
}

// FeedbackFilter is the admin-list filter set (devops#519): type / status /
// adopted. Empty strings mean "no filter"; Adopted nil means "no filter".
type FeedbackFilter struct {
	Type    string
	Status  string
	Adopted *bool
}

// FeedbackWithUser is one admin-list row plus the submitter's display name.
type FeedbackWithUser struct {
	Feedback
	UserName string
}

// ListFeedbacksAdmin returns feedback rows newest first with the submitter's
// display name, filtered per f.
func (s *Store) ListFeedbacksAdmin(ctx context.Context, f FeedbackFilter) ([]FeedbackWithUser, error) {
	q := s.db.WithContext(ctx).Table("feedbacks AS f").
		Select("f.*, COALESCE(p.display_name, '') AS user_name").
		Joins("LEFT JOIN user_profile p ON p.user_id = f.user_id")
	if f.Type != "" {
		q = q.Where("f.type = ?", f.Type)
	}
	if f.Status != "" {
		q = q.Where("f.status = ?", f.Status)
	}
	if f.Adopted != nil {
		if *f.Adopted {
			q = q.Where("f.adopted_feature_id IS NOT NULL")
		} else {
			q = q.Where("f.adopted_feature_id IS NULL")
		}
	}
	var rows []FeedbackWithUser
	if err := q.Order("f.id DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// FeedbackImageKeys collects every COS key the user referenced in feedbacks —
// the erasure list for the fail-open COS cleanup.
func (s *Store) FeedbackImageKeys(ctx context.Context, userID string) ([]string, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var raws []*string
	if err := s.db.WithContext(ctx).Model(&Feedback{}).Where("user_id = ?", uid).
		Pluck("images", &raws).Error; err != nil {
		return nil, err
	}
	keys := []string{}
	for _, raw := range raws {
		if raw == nil {
			continue
		}
		var ks []string
		if err := json.Unmarshal([]byte(*raw), &ks); err != nil {
			continue // a malformed legacy row must not block erasure
		}
		keys = append(keys, ks...)
	}
	return keys, nil
}

// UserDisplayName returns the user's display name for admin attribution, ""
// when no profile row exists (a bare account that never saved a profile).
func (s *Store) UserDisplayName(ctx context.Context, userID string) (string, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return "", err
	}
	var row UserProfile
	if err := s.db.WithContext(ctx).Select("display_name").Where("user_id = ?", uid).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", nil
		}
		return "", err
	}
	return row.DisplayName, nil
}
