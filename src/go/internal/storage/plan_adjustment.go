package storage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrAdjustmentEventClosed is returned when a proposal is attempted for a
// (user, event week) that already reached a terminal state: accepted or
// dismissed events are never re-asked — the athlete already answered.
var ErrAdjustmentEventClosed = errors.New("storage: adjustment event already closed")

// ErrAdjustmentNotFound means no adjustment row matched (wrong id / user).
var ErrAdjustmentNotFound = errors.New("storage: plan adjustment not found")

// ErrAdjustmentState is a status-transition guard violation (e.g. choosing a
// reason on an already-accepted row).
var ErrAdjustmentState = errors.New("storage: plan adjustment state violation")

func (s *Store) AutoMigratePlanAdjustment(ctx context.Context) error {
	db := s.db.WithContext(ctx)
	if err := db.Migrator().AutoMigrate(&PlanAdjustment{}); err != nil {
		return fmt.Errorf("storage: migrate plan_adjustment: %w", err)
	}
	return nil
}

// UpsertPendingAdjustment creates or refreshes the user's pending proposal
// (#858 invariants, in one transaction):
//   - a pending row for the same event week → payload/reason/question refreshed
//     (the nightly scan keeps the popup current with the latest data);
//   - a terminal row (accepted/dismissed) for the same event week →
//     ErrAdjustmentEventClosed (the event was answered; re-asking is forbidden);
//   - any other pending row → superseded (at most one pending per user).
func (s *Store) UpsertPendingAdjustment(
	ctx context.Context, userID, masterPlanID, eventWeekStart, reason, question, payload string,
) (*PlanAdjustment, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	var created *PlanAdjustment
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Same-event terminal row closes the event for good.
		var closed int64
		if err := tx.Model(&PlanAdjustment{}).
			Where("user_id = ? AND event_week_start = ? AND status IN ?", uid, eventWeekStart, []string{PlanAdjustmentStatusAccepted, PlanAdjustmentStatusDismissed}).
			Count(&closed).Error; err != nil {
			return fmt.Errorf("storage: check closed adjustment event: %w", err)
		}
		if closed > 0 {
			return ErrAdjustmentEventClosed
		}
		// Supersede any other pending row (one pending per user).
		if err := tx.Model(&PlanAdjustment{}).
			Where("user_id = ? AND status = ? AND event_week_start <> ?", uid, PlanAdjustmentStatusPending, eventWeekStart).
			Update("status", PlanAdjustmentStatusSuperseded).Error; err != nil {
			return fmt.Errorf("storage: supersede stale pending adjustment: %w", err)
		}
		// Refresh or insert the event's pending row.
		row := PlanAdjustment{}
		err := tx.Where("user_id = ? AND event_week_start = ? AND status = ?", uid, eventWeekStart, PlanAdjustmentStatusPending).
			Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&row).Error
		switch {
		case err == nil:
			// refresh 只更新业务列：Save 全字段回写会把 gorm 读出的 DATE 列
			// （parseTime 下被格式化成 RFC3339）写回 event_week_start 而 1292 拒收
			// （首次真库运行实证，2026-11-10）。
			if err := tx.Model(&PlanAdjustment{}).Where("id = ?", row.ID).Updates(map[string]any{
				"reason": reason, "question": question, "payload": payload, "updated_at": now,
			}).Error; err != nil {
				return fmt.Errorf("storage: refresh pending adjustment: %w", err)
			}
			row.Reason = reason
			row.Question = question
			row.Payload = &payload
			row.UpdatedAt = now
			created = &row
			return nil
		case errors.Is(err, gorm.ErrRecordNotFound):
			row = PlanAdjustment{
				ID: uuid.NewString(), UserID: uid, MasterPlanID: masterPlanID,
				EventWeekStart: eventWeekStart, Reason: reason,
				Status: PlanAdjustmentStatusPending, Payload: &payload,
				Question: question, CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(&row).Error; err != nil {
				return fmt.Errorf("storage: create pending adjustment: %w", err)
			}
			created = &row
			return nil
		default:
			return fmt.Errorf("storage: load pending adjustment: %w", err)
		}
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

// SupersedePendingAdjustments closes every pending proposal of the user
// (#858 换计划归档): a plan change invalidates the popup's anchored proposal
// (its payload references the replaced plan's weeks), so all pending rows move
// to superseded in one statement. Terminal rows (accepted/dismissed) keep
// their history. Returns the number of rows superseded.
func (s *Store) SupersedePendingAdjustments(ctx context.Context, userID string) (int64, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return 0, err
	}
	result := s.db.WithContext(ctx).
		Model(&PlanAdjustment{}).
		Where("user_id = ? AND status = ?", uid, PlanAdjustmentStatusPending).
		Update("status", PlanAdjustmentStatusSuperseded)
	if result.Error != nil {
		return 0, fmt.Errorf("storage: supersede pending adjustments: %w", result.Error)
	}
	return result.RowsAffected, nil
}

// GetPendingAdjustment returns the user's single pending row, if any.
func (s *Store) GetPendingAdjustment(ctx context.Context, userID string) (*PlanAdjustment, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	row := PlanAdjustment{}
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND status = ?", uid, PlanAdjustmentStatusPending).
		Order("updated_at DESC").First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("storage: load pending adjustment: %w", err)
	}
	return &row, nil
}

// GetAdjustmentByID loads one row scoped to the user (mp endpoints never cross users).
func (s *Store) GetAdjustmentByID(ctx context.Context, userID, id string) (*PlanAdjustment, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(id); err != nil {
		return nil, ErrAdjustmentNotFound
	}
	row := PlanAdjustment{}
	err = s.db.WithContext(ctx).Where("user_id = ? AND id = ?", uid, id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrAdjustmentNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("storage: load plan adjustment: %w", err)
	}
	return &row, nil
}

// ChooseAdjustmentReason records the athlete's answer for the reason question.
// Same reason → payload kept (the mp shows the pre-generated proposal
// instantly). A different reason → payload cleared (NULL): the mp enqueues the
// generate_adjustment job and shows a generating state until the worker
// refills it via CompleteAdjustmentPayload.
func (s *Store) ChooseAdjustmentReason(ctx context.Context, userID, id, reason string) (*PlanAdjustment, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	row, err := s.GetAdjustmentByID(ctx, uid, id)
	if err != nil {
		return nil, err
	}
	if row.Status != PlanAdjustmentStatusPending {
		return nil, ErrAdjustmentState
	}
	if row.Reason == reason {
		return row, nil
	}
	updates := map[string]any{"reason": reason, "payload": nil, "updated_at": time.Now().UTC()}
	// Conditional on pending: an accept/dismiss that committed after the read
	// above wins instead of being overwritten by this stale answer.
	update := s.db.WithContext(ctx).Model(&PlanAdjustment{}).
		Where("user_id = ? AND id = ? AND status = ?", uid, row.ID, PlanAdjustmentStatusPending).
		Updates(updates)
	if update.Error != nil {
		return nil, fmt.Errorf("storage: choose adjustment reason: %w", update.Error)
	}
	if update.RowsAffected != 1 {
		return nil, ErrAdjustmentState
	}
	row.Reason = reason
	row.Payload = nil
	return row, nil
}

// CompleteAdjustmentPayload refills a pending row's payload after the
// regeneration job finished (worker internal channel). Only pending rows with
// the same reason accept the refill — a racing accept/dismiss wins.
func (s *Store) CompleteAdjustmentPayload(ctx context.Context, userID, id, reason, payload string) (*PlanAdjustment, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	row, err := s.GetAdjustmentByID(ctx, uid, id)
	if err != nil {
		return nil, err
	}
	if row.Status != PlanAdjustmentStatusPending {
		return nil, ErrAdjustmentState
	}
	if row.Reason != reason {
		return nil, ErrAdjustmentState
	}
	updates := map[string]any{"payload": payload, "updated_at": time.Now().UTC()}
	// Conditional on pending + the same reason: a reason change or a terminal
	// transition that committed after the read above wins over this refill.
	update := s.db.WithContext(ctx).Model(&PlanAdjustment{}).
		Where("user_id = ? AND id = ? AND status = ? AND reason = ?", uid, row.ID, PlanAdjustmentStatusPending, reason).
		Updates(updates)
	if update.Error != nil {
		return nil, fmt.Errorf("storage: complete adjustment payload: %w", update.Error)
	}
	if update.RowsAffected != 1 {
		return nil, ErrAdjustmentState
	}
	row.Payload = &payload
	return row, nil
}

// AcceptPlanAdjustment applies the proposal the athlete agreed to and marks the
// row accepted in ONE transaction:
//   - the plan_adjustment row is locked and re-validated: it must still be
//     pending and its payload must still be the exact JSON the caller parsed
//     and validated (a concurrent choose/dismiss/accept therefore cannot make
//     an older, un-agreed payload take effect);
//   - every weekly document replaces its active row (revision expectation,
//     cross-master-plan rejection) and materializes its workouts;
//   - pending → accepted commits together with the weeks, so a failed status
//     transition rolls every week back and the proposal keeps its state.
//
// items may be empty: the accept handler keeps weeks that cannot be safely
// replaced (#952 — past arrangements / no future session), and the proposal
// still closes as accepted. A deadlock retries the whole transaction once; the
// rollback makes that safe.
func (s *Store) AcceptPlanAdjustment(
	ctx context.Context, userID, id, expectedPayload string, items []WeeklyPlanBatchItem,
) ([]WeeklyPlanBatchResult, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(id); err != nil {
		return nil, ErrAdjustmentNotFound
	}
	prepared, err := prepareWeeklyPlanBatch(items)
	if err != nil {
		return nil, err
	}
	results := make([]WeeklyPlanBatchResult, len(items))
	apply := func() error {
		clear(results)
		return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var row PlanAdjustment
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("user_id = ? AND id = ?", uid, id).
				First(&row).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrAdjustmentNotFound
			}
			if err != nil {
				return fmt.Errorf("storage: lock plan adjustment: %w", err)
			}
			if row.Status != PlanAdjustmentStatusPending {
				return ErrAdjustmentState
			}
			if row.Payload == nil || *row.Payload != expectedPayload {
				return ErrAdjustmentState
			}
			masterPlanID := row.MasterPlanID
			for _, week := range prepared {
				created, replaced, err := applyWeeklyPlanTx(
					tx, uid, week.item.WeekStart, week.item.Content, week.item.Replacement,
					&masterPlanID, true, true,
				)
				if err != nil {
					return err
				}
				results[week.index] = batchResultOf(created, replaced)
			}
			update := tx.Model(&PlanAdjustment{}).
				Where("id = ? AND user_id = ? AND status = ?", row.ID, uid, PlanAdjustmentStatusPending).
				Updates(map[string]any{"status": PlanAdjustmentStatusAccepted, "updated_at": time.Now().UTC()})
			if update.Error != nil {
				return fmt.Errorf("storage: accept plan adjustment: %w", update.Error)
			}
			if update.RowsAffected != 1 {
				return ErrAdjustmentState
			}
			return nil
		})
	}
	err = apply()
	if isDeadlock(err) {
		err = apply()
	}
	if err != nil {
		return nil, err
	}
	return results, nil
}

// SetAdjustmentStatus moves a pending row to a terminal state (accept /
// dismiss). Idempotent for the same terminal value; any other transition of a
// non-pending row is a state violation. The update is conditional on the row
// still being pending, so a concurrent accept and dismiss cannot overwrite each
// other's terminal state.
//
// Accepting a proposal's weeks must go through AcceptPlanAdjustment, which
// applies them in the same transaction; SetAdjustmentStatus(accepted) only
// moves the row and is reserved for callers with no weeks to write.
func (s *Store) SetAdjustmentStatus(ctx context.Context, userID, id, status string) error {
	if status != PlanAdjustmentStatusAccepted && status != PlanAdjustmentStatusDismissed {
		return fmt.Errorf("storage: invalid terminal adjustment status %q", status)
	}
	uid, err := canonicalUserID(userID)
	if err != nil {
		return err
	}
	if _, err := uuid.Parse(id); err != nil {
		return ErrAdjustmentNotFound
	}
	update := s.db.WithContext(ctx).Model(&PlanAdjustment{}).
		Where("user_id = ? AND id = ? AND status = ?", uid, id, PlanAdjustmentStatusPending).
		Updates(map[string]any{"status": status, "updated_at": time.Now().UTC()})
	if update.Error != nil {
		return fmt.Errorf("storage: set adjustment status: %w", update.Error)
	}
	if update.RowsAffected == 1 {
		return nil
	}
	row, err := s.GetAdjustmentByID(ctx, uid, id)
	if err != nil {
		return err
	}
	if row.Status == status {
		return nil
	}
	return ErrAdjustmentState
}
