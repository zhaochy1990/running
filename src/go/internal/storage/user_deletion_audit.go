package storage

import (
	"context"
	"fmt"
	"time"
)

// UserDeletionAudit records one account-erasure attempt. A row is written before
// the first destructive step and updated as each step completes, so an operator
// can see exactly how far a failed or interrupted deletion got. Status is
// "pending" until the flow finishes; a failure leaves "partial".
//
// The per-step timestamps are nullable: a NULL column means that step never
// completed. CoachCountsJSON captures the per-table deletion counts the coach
// service reports, which makes a coach-side no-op visible in the audit trail.
type UserDeletionAudit struct {
	ID      string `gorm:"column:id;type:char(36);primaryKey"`
	UserID  string `gorm:"column:user_id;type:char(36);not null;index:idx_user_deletion_audit_user"`
	ActorID string `gorm:"column:actor_id;type:char(36);not null"`

	Status string `gorm:"column:status;type:varchar(16);not null"`

	AuthDeletedAt   *time.Time `gorm:"column:auth_deleted_at;type:datetime(6)"`
	CoachDeletedAt  *time.Time `gorm:"column:coach_deleted_at;type:datetime(6)"`
	StrideDeletedAt *time.Time `gorm:"column:stride_deleted_at;type:datetime(6)"`
	FilesDeletedAt  *time.Time `gorm:"column:files_deleted_at;type:datetime(6)"`

	CoachCountsJSON *string `gorm:"column:coach_counts_json;type:text"`
	ErrorMessage    *string `gorm:"column:error_message;type:varchar(1000)"`

	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);not null"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (UserDeletionAudit) TableName() string { return "user_deletion_audit" }

// Deletion-audit lifecycle statuses.
const (
	DeletionStatusPending   = "pending"
	DeletionStatusCompleted = "completed"
	DeletionStatusPartial   = "partial"
)

// Audit step names accepted by MarkUserDeletionStep. Validating here keeps the
// column name out of caller-controlled input.
const (
	DeletionStepAuth   = "auth"
	DeletionStepCoach  = "coach"
	DeletionStepStride = "stride"
	DeletionStepFiles  = "files"
)

// AutoMigrateUserDeletionAudit creates/updates the user_deletion_audit table.
func (s *Store) AutoMigrateUserDeletionAudit(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&UserDeletionAudit{}); err != nil {
		return fmt.Errorf("storage: automigrate user_deletion_audit: %w", err)
	}
	return nil
}

// StartUserDeletionAudit inserts a pending audit row for one erasure attempt.
func (s *Store) StartUserDeletionAudit(ctx context.Context, audit *UserDeletionAudit) error {
	if audit == nil {
		return fmt.Errorf("storage: nil deletion audit")
	}
	return s.db.WithContext(ctx).Create(audit).Error
}

// MarkUserDeletionStep records the completion time of one cleanup step. step
// must be one of the DeletionStep* constants; anything else is rejected rather
// than interpolated into a column name.
func (s *Store) MarkUserDeletionStep(ctx context.Context, auditID, step string, at time.Time) error {
	column, ok := deletionStepColumn(step)
	if !ok {
		return fmt.Errorf("storage: unknown deletion step %q", step)
	}
	return s.db.WithContext(ctx).
		Model(&UserDeletionAudit{}).
		Where("id = ?", auditID).
		Updates(map[string]any{column: at.UTC(), "updated_at": at.UTC()}).
		Error
}

// FinishUserDeletionAudit writes the terminal status (and optional error text +
// coach counts) of one erasure attempt.
func (s *Store) FinishUserDeletionAudit(ctx context.Context, auditID, status, errorMessage string, coachCountsJSON *string) error {
	updates := map[string]any{
		"status":     status,
		"updated_at": time.Now().UTC(),
	}
	if errorMessage == "" {
		updates["error_message"] = nil
	} else {
		if len(errorMessage) > 1000 {
			errorMessage = errorMessage[:1000]
		}
		updates["error_message"] = errorMessage
	}
	if coachCountsJSON != nil {
		updates["coach_counts_json"] = *coachCountsJSON
	}
	return s.db.WithContext(ctx).Model(&UserDeletionAudit{}).Where("id = ?", auditID).Updates(updates).Error
}

func deletionStepColumn(step string) (string, bool) {
	switch step {
	case DeletionStepAuth:
		return "auth_deleted_at", true
	case DeletionStepCoach:
		return "coach_deleted_at", true
	case DeletionStepStride:
		return "stride_deleted_at", true
	case DeletionStepFiles:
		return "files_deleted_at", true
	default:
		return "", false
	}
}
