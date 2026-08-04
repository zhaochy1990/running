package storage

import (
	"context"
	"errors"
	"fmt"

	"gorm.io/gorm"
)

// AutoMigrateMasterPlan creates/updates the master_plan table (ADR 0024). Called
// by cmd/api at boot; the worker does not need this table.
func (s *Store) AutoMigrateMasterPlan(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&MasterPlan{}); err != nil {
		return fmt.Errorf("storage: automigrate master_plan: %w", err)
	}
	return nil
}

// GetActiveStructuredPlan returns the athlete's single active structured
// (content_version=2) master plan, or (nil, nil) when none exists — the #6
// handler then renders 404 and the frontend falls back to the markdown overview.
// It filters on Status (Python-parity), never on ActiveFlag, which is a
// storage-integrity lever only.
func (s *Store) GetActiveStructuredPlan(ctx context.Context, userID string) (*MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var p MasterPlan
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND content_version = ? AND status = ?",
			uid, MasterPlanContentStructured, MasterPlanStatusActive).
		First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// GetMarkdownOverview returns the athlete's active markdown (content_version=1)
// season-plan overview, or (nil, nil) when none exists. There is at most one
// active markdown row per athlete.
func (s *Store) GetMarkdownOverview(ctx context.Context, userID string) (*MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var p MasterPlan
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND content_version = ? AND status = ?",
			uid, MasterPlanContentMarkdown, MasterPlanStatusActive).
		First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}
