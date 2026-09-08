package storage

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Draft lifecycle errors. These are returned by the plan-draft storage surface
// (insert / read / activate / abandon) that ADR 0030 introduces, and are the
// domain conflicts the API maps to 4xx instead of a transient 500.
var (
	// ErrMasterPlanDraftNotFound is returned when a draft id does not exist for
	// the user (or already stopped being a draft).
	ErrMasterPlanDraftNotFound = errors.New("storage: master plan draft not found")
	// ErrMasterPlanDraftConflict is returned when the caller targets a full
	// create with a draft id already owned by another user, or when an activate
	// targets a row that is no longer a draft.
	ErrMasterPlanDraftConflict = errors.New("storage: master plan draft conflict")
	// ErrWeeklyPlanDraftNotFound is the weekly-plan analogue of
	// ErrMasterPlanDraftNotFound.
	ErrWeeklyPlanDraftNotFound = errors.New("storage: weekly plan draft not found")
	// ErrWeeklyPlanDraftConflict is the weekly-plan analogue of
	// ErrMasterPlanDraftConflict.
	ErrWeeklyPlanDraftConflict = errors.New("storage: weekly plan draft conflict")
)

// ─────────────────────────────────────────────────────────────────────────────
// Master Plan drafts
// ─────────────────────────────────────────────────────────────────────────────

// InsertMasterPlanDraft persists a season training plan draft (status=draft,
// active_flag=NULL, content_version=2) keyed idempotently by draftID (=plan_id).
// A row with that plan_id owned by the same user already existing is returned
// unchanged (created=false) so an at-least-once worker retry does not duplicate.
func (s *Store) InsertMasterPlanDraft(
	ctx context.Context, userID, goalID, content, draftID string,
) (*MasterPlan, bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, false, err
	}
	if _, err := uuid.Parse(goalID); err != nil {
		return nil, false, fmt.Errorf("storage: invalid goal_id: %w", err)
	}
	if _, err := uuid.Parse(draftID); err != nil {
		return nil, false, fmt.Errorf("storage: invalid draft_id: %w", err)
	}
	if strings.TrimSpace(content) == "" {
		return nil, false, fmt.Errorf("storage: content cannot be empty")
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	revision := int64(1)
	row := &MasterPlan{
		PlanID:         draftID,
		UserID:         uid,
		GoalID:         goalID,
		ContentVersion: MasterPlanContentStructured,
		Content:        content,
		Status:         MasterPlanStatusDraft,
		ActiveFlag:     nil,
		Revision:       &revision,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	err = s.db.WithContext(ctx).Create(row).Error
	if err == nil {
		return row, true, nil
	}
	if isDuplicateKey(err) {
		// Idempotent replay: the draft id already exists. Return the existing
		// row only when it belongs to the same user; a cross-user collision is a
		// conflict, not a replay.
		existing := &MasterPlan{}
		if e := s.db.WithContext(ctx).
			Where("plan_id = ? AND user_id = ?", draftID, uid).
			First(existing).Error; e == nil {
			return existing, false, nil
		}
		return nil, false, ErrMasterPlanDraftConflict
	}
	return nil, false, fmt.Errorf("storage: create master plan draft: %w", err)
}

// GetMasterPlanDraft returns the draft row for a draft id, or nil when it does
// not exist for the user.
func (s *Store) GetMasterPlanDraft(ctx context.Context, userID, planID string) (*MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row MasterPlan
	err = s.db.WithContext(ctx).
		Where("plan_id = ? AND user_id = ?", planID, uid).
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ActivateMasterPlanDraft archives the user's current active season plan (if
// any) and promotes the chosen draft to active, all in one transaction. Sibling
// drafts stay draft. All rows for the user are locked so the active transition
// is serialized against a concurrent apply/update/activate. The promoted draft
// keeps its own identity and starts its active life at its stored revision.
func (s *Store) ActivateMasterPlanDraft(
	ctx context.Context, userID, planID string,
) (*MasterPlan, *MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, nil, err
	}
	if _, err := uuid.Parse(planID); err != nil {
		return nil, nil, fmt.Errorf("storage: invalid plan_id: %w", err)
	}

	var active *MasterPlan
	var activated *MasterPlan
	activate := func() error {
		active = nil
		activated = nil
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var rows []MasterPlan
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("user_id = ?", uid).
				Order("revision DESC, created_at DESC").
				Find(&rows).Error; err != nil {
				return fmt.Errorf("storage: lock master plans: %w", err)
			}

			var draft *MasterPlan
			for i := range rows {
				switch rows[i].Status {
				case MasterPlanStatusActive:
					active = &rows[i]
				case MasterPlanStatusDraft:
					if rows[i].PlanID == planID {
						draft = &rows[i]
					}
				}
			}
			if draft == nil {
				return ErrMasterPlanDraftNotFound
			}

			now := time.Now().UTC().Truncate(time.Millisecond)
			if active != nil {
				result := tx.Model(&MasterPlan{}).
					Where("plan_id = ? AND user_id = ? AND status = ?", active.PlanID, uid, MasterPlanStatusActive).
					Updates(map[string]any{
						"status":      MasterPlanStatusArchived,
						"active_flag": nil,
						"updated_at":  now,
					})
				if result.Error != nil {
					return fmt.Errorf("storage: archive prior master plan: %w", result.Error)
				}
				if result.RowsAffected != 1 {
					return ErrMasterPlanDraftConflict
				}
				active.Status = MasterPlanStatusArchived
				active.ActiveFlag = nil
				active.UpdatedAt = now
			}

			activeFlag := int8(1)
			result := tx.Model(&MasterPlan{}).
				Where("plan_id = ? AND user_id = ? AND status = ?", planID, uid, MasterPlanStatusDraft).
				Updates(map[string]any{
					"status":      MasterPlanStatusActive,
					"active_flag": activeFlag,
					"updated_at":  now,
				})
			if result.Error != nil {
				return fmt.Errorf("storage: activate master plan draft: %w", result.Error)
			}
			// The draft was found and locked above; a stale update means a
			// concurrent transaction changed it between the scan and update.
			if result.RowsAffected != 1 {
				return ErrMasterPlanDraftConflict
			}
			draft.Status = MasterPlanStatusActive
			draft.ActiveFlag = &activeFlag
			draft.UpdatedAt = now
			activated = draft
			return nil
		})
	}
	err = activate()
	if number, ok := mysqlErrNo(err); ok && number == 1213 {
		err = activate()
	}
	if err != nil {
		return nil, nil, err
	}
	return activated, active, nil
}

// AbandonMasterPlanDraft archives a draft. It is an error when the id is not a
// draft owned by the user (already archived or never existed).
func (s *Store) AbandonMasterPlanDraft(ctx context.Context, userID, planID string) (*MasterPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(planID); err != nil {
		return nil, fmt.Errorf("storage: invalid plan_id: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var abandoned *MasterPlan
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&MasterPlan{}).
			Where("plan_id = ? AND user_id = ? AND status = ?", planID, uid, MasterPlanStatusDraft).
			Updates(map[string]any{
				"status":      MasterPlanStatusArchived,
				"active_flag": nil,
				"updated_at":  now,
			})
		if result.Error != nil {
			return fmt.Errorf("storage: abandon master plan draft: %w", result.Error)
		}
		if result.RowsAffected != 1 {
			return ErrMasterPlanDraftNotFound
		}
		var row MasterPlan
		if err := tx.Where("plan_id = ? AND user_id = ?", planID, uid).First(&row).Error; err != nil {
			return err
		}
		abandoned = &row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return abandoned, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Plan drafts
// ─────────────────────────────────────────────────────────────────────────────

// InsertWeeklyPlanDraft persists a this-week schedule draft (status=draft,
// status_slot=NULL, content_version=2) keyed idempotently by draftID (=plan_id).
// A row with that plan_id owned by the same user already existing is returned
// unchanged (created=false). The draft links the athlete's active master plan
// at insert time, mirroring ApplyStructuredWeeklyPlan.
func (s *Store) InsertWeeklyPlanDraft(
	ctx context.Context, userID, weekStart, content, draftID string,
) (*WeeklyPlan, bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, false, err
	}
	start, err := time.Parse("2006-01-02", weekStart)
	if err != nil {
		return nil, false, fmt.Errorf("storage: invalid week_start: %w", err)
	}
	if start.Weekday() != time.Monday {
		return nil, false, fmt.Errorf("storage: week_start must be a Monday")
	}
	if _, err := uuid.Parse(draftID); err != nil {
		return nil, false, fmt.Errorf("storage: invalid draft_id: %w", err)
	}
	if strings.TrimSpace(content) == "" {
		return nil, false, fmt.Errorf("storage: content cannot be empty")
	}

	masterPlan, err := s.GetCurrentMasterPlan(ctx, uid)
	if err != nil {
		return nil, false, fmt.Errorf("storage: resolve active master plan: %w", err)
	}
	var masterPlanID *string
	if masterPlan != nil {
		id := masterPlan.PlanID
		masterPlanID = &id
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	row := &WeeklyPlan{
		PlanID:         draftID,
		UserID:         uid,
		MasterPlanID:   masterPlanID,
		WeekStart:      weekStart,
		ContentVersion: WeeklyPlanContentStructured,
		Content:        content,
		Status:         WeeklyPlanStatusDraft,
		StatusSlot:     nil,
		Revision:       1,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	err = s.db.WithContext(ctx).Create(row).Error
	if err == nil {
		return row, true, nil
	}
	if isDuplicateKey(err) {
		existing := &WeeklyPlan{}
		if e := s.db.WithContext(ctx).
			Where("plan_id = ? AND user_id = ?", draftID, uid).
			First(existing).Error; e == nil {
			return existing, false, nil
		}
		return nil, false, ErrWeeklyPlanDraftConflict
	}
	return nil, false, fmt.Errorf("storage: create weekly plan draft: %w", err)
}

// GetWeeklyPlanDraft returns the draft row for a draft id, or nil when it does
// not exist for the user.
func (s *Store) GetWeeklyPlanDraft(ctx context.Context, userID, planID string) (*WeeklyPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row WeeklyPlan
	err = s.db.WithContext(ctx).
		Where("plan_id = ? AND user_id = ?", planID, uid).
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ActivateWeeklyPlanDraft archives the user's current active plan for the week
// (status_slot was 'active') and promotes the chosen draft to active, all in one
// transaction. Sibling drafts for the week stay draft. All rows for the user and
// week are locked so the transition is serialized. The promoted draft keeps its
// identity and starts its active life at its stored revision.
func (s *Store) ActivateWeeklyPlanDraft(
	ctx context.Context, userID, weekStart, planID string,
) (*WeeklyPlan, *WeeklyPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, nil, err
	}
	if _, err := time.Parse("2006-01-02", weekStart); err != nil {
		return nil, nil, fmt.Errorf("storage: invalid week_start: %w", err)
	}
	if _, err := uuid.Parse(planID); err != nil {
		return nil, nil, fmt.Errorf("storage: invalid plan_id: %w", err)
	}

	var active *WeeklyPlan
	var activated *WeeklyPlan
	activate := func() error {
		active = nil
		activated = nil
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var rows []WeeklyPlan
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("user_id = ? AND week_start = ?", uid, weekStart).
				Order("revision DESC, created_at DESC").
				Find(&rows).Error; err != nil {
				return fmt.Errorf("storage: lock weekly plans: %w", err)
			}

			var draft *WeeklyPlan
			for i := range rows {
				switch rows[i].Status {
				case WeeklyPlanStatusActive:
					active = &rows[i]
				case WeeklyPlanStatusDraft:
					if rows[i].PlanID == planID {
						draft = &rows[i]
					}
				}
			}
			if draft == nil {
				return ErrWeeklyPlanDraftNotFound
			}

			now := time.Now().UTC().Truncate(time.Millisecond)
			if active != nil {
				result := tx.Model(&WeeklyPlan{}).
					Where("plan_id = ? AND user_id = ? AND status = ?", active.PlanID, uid, WeeklyPlanStatusActive).
					Updates(map[string]any{
						"status":      WeeklyPlanStatusArchived,
						"status_slot": nil,
						"updated_at":  now,
					})
				if result.Error != nil {
					return fmt.Errorf("storage: archive prior weekly plan: %w", result.Error)
				}
				if result.RowsAffected != 1 {
					return ErrWeeklyPlanDraftConflict
				}
				active.Status = WeeklyPlanStatusArchived
				active.StatusSlot = nil
				active.UpdatedAt = now
			}

			activeSlot := WeeklyPlanStatusActive
			result := tx.Model(&WeeklyPlan{}).
				Where("plan_id = ? AND user_id = ? AND status = ?", planID, uid, WeeklyPlanStatusDraft).
				Updates(map[string]any{
					"status":      WeeklyPlanStatusActive,
					"status_slot": activeSlot,
					"updated_at":  now,
				})
			if result.Error != nil {
				return fmt.Errorf("storage: activate weekly plan draft: %w", result.Error)
			}
			// The draft was found and locked above; a stale update means a
			// concurrent transaction changed it between the scan and update.
			if result.RowsAffected != 1 {
				return ErrWeeklyPlanDraftConflict
			}
			draft.Status = WeeklyPlanStatusActive
			draft.StatusSlot = &activeSlot
			draft.UpdatedAt = now
			activated = draft
			return nil
		})
	}
	err = activate()
	if number, ok := mysqlErrNo(err); ok && number == 1213 {
		err = activate()
	}
	if err != nil {
		return nil, nil, err
	}
	return activated, active, nil
}

// AbandonWeeklyPlanDraft archives a draft. It is an error when the id is not a
// draft owned by the user (already archived or never existed).
func (s *Store) AbandonWeeklyPlanDraft(ctx context.Context, userID, planID string) (*WeeklyPlan, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(planID); err != nil {
		return nil, fmt.Errorf("storage: invalid plan_id: %w", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	var abandoned *WeeklyPlan
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&WeeklyPlan{}).
			Where("plan_id = ? AND user_id = ? AND status = ?", planID, uid, WeeklyPlanStatusDraft).
			Updates(map[string]any{
				"status":      WeeklyPlanStatusArchived,
				"status_slot": nil,
				"updated_at":  now,
			})
		if result.Error != nil {
			return fmt.Errorf("storage: abandon weekly plan draft: %w", result.Error)
		}
		if result.RowsAffected != 1 {
			return ErrWeeklyPlanDraftNotFound
		}
		var row WeeklyPlan
		if err := tx.Where("plan_id = ? AND user_id = ?", planID, uid).First(&row).Error; err != nil {
			return err
		}
		abandoned = &row
		return nil
	})
	if err != nil {
		return nil, err
	}
	return abandoned, nil
}
