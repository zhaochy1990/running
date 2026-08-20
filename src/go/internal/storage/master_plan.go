package storage

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// AutoMigrateMasterPlan creates or reconciles the steady-state master_plan
// schema. An existing non-final table fails closed: the destructive
// version-to-revision rename belongs to the maintenance-window migration CLI,
// and starting this API must never create a dual-column state.
func (s *Store) AutoMigrateMasterPlan(ctx context.Context) error {
	db := s.db.WithContext(ctx)
	migrator := db.Migrator()
	if migrator.HasTable(&MasterPlan{}) {
		hasVersion := migrator.HasColumn(&MasterPlan{}, "version")
		hasRevision := migrator.HasColumn(&MasterPlan{}, "revision")
		if !hasRevision || hasVersion {
			return fmt.Errorf("storage: master_plan schema requires explicit version-to-revision migration (version=%t revision=%t)", hasVersion, hasRevision)
		}
	}
	if err := db.AutoMigrate(&MasterPlan{}); err != nil {
		return fmt.Errorf("storage: automigrate master_plan: %w", err)
	}
	return nil
}

// GetCurrentMasterPlan returns the athlete's single current season plan in
// either content representation. Discovery considers both current markers so a
// row with status/active_flag drift is reported instead of looking absent.
func (s *Store) GetCurrentMasterPlan(ctx context.Context, userID string) (*MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var candidates []MasterPlan
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND (active_flag = 1 OR status = ?)", uid, MasterPlanStatusActive).
		Find(&candidates).Error; err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	if len(candidates) != 1 {
		return nil, fmt.Errorf("storage: master_plan current invariant: user %s has %d candidates", uid, len(candidates))
	}
	p := &candidates[0]
	if err := validateCurrentMasterPlan(p, uid); err != nil {
		return nil, err
	}
	return p, nil
}

func validateCurrentMasterPlan(p *MasterPlan, userID string) error {
	if p.UserID != userID {
		return fmt.Errorf("storage: master_plan current invariant: row user mismatch")
	}
	if _, err := uuid.Parse(p.PlanID); err != nil {
		return fmt.Errorf("storage: master_plan current invariant: invalid plan_id")
	}
	if _, err := uuid.Parse(p.GoalID); err != nil {
		return fmt.Errorf("storage: master_plan current invariant: invalid goal_id")
	}
	if p.Status != MasterPlanStatusActive || p.ActiveFlag == nil || *p.ActiveFlag != 1 {
		return fmt.Errorf("storage: master_plan current invariant: status and active_flag disagree")
	}
	if p.CreatedAt.IsZero() || p.UpdatedAt.IsZero() {
		return fmt.Errorf("storage: master_plan current invariant: timestamps are required")
	}
	switch p.ContentVersion {
	case MasterPlanContentMarkdown:
		if p.Revision != nil {
			return fmt.Errorf("storage: master_plan current invariant: markdown revision must be null")
		}
		if strings.TrimSpace(p.Content) == "" {
			return fmt.Errorf("storage: master_plan current invariant: markdown content is empty")
		}
	case MasterPlanContentStructured:
		if p.Revision == nil || *p.Revision < 1 {
			return fmt.Errorf("storage: master_plan current invariant: structured revision must be positive")
		}
		if strings.TrimSpace(p.Content) == "" {
			return fmt.Errorf("storage: master_plan current invariant: structured content is empty")
		}
	default:
		return fmt.Errorf("storage: master_plan current invariant: unsupported content_version %d", p.ContentVersion)
	}
	return nil
}
