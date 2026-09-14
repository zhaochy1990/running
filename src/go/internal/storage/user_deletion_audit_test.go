package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestUserDeletionAudit_Lifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateUserDeletionAudit(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	record := &UserDeletionAudit{
		ID:        uuid.NewString(),
		UserID:    uuid.NewString(),
		ActorID:   uuid.NewString(),
		Status:    DeletionStatusPending,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := st.StartUserDeletionAudit(ctx, record); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := st.MarkUserDeletionStep(ctx, record.ID, DeletionStepAuth, now); err != nil {
		t.Fatalf("mark auth: %v", err)
	}
	if err := st.MarkUserDeletionStep(ctx, record.ID, DeletionStepCoach, now); err != nil {
		t.Fatalf("mark coach: %v", err)
	}
	if err := st.MarkUserDeletionStep(ctx, record.ID, "bogus", now); err == nil {
		t.Fatal("unknown step must be rejected")
	}
	counts := `{"checkpoints":2}`
	if err := st.FinishUserDeletionAudit(ctx, record.ID, DeletionStatusPartial, "coach down", &counts); err != nil {
		t.Fatalf("finish: %v", err)
	}

	var got UserDeletionAudit
	if err := st.db.WithContext(ctx).Where("id = ?", record.ID).First(&got).Error; err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.Status != DeletionStatusPartial || got.AuthDeletedAt == nil || got.CoachDeletedAt == nil {
		t.Fatalf("audit = %+v", got)
	}
	if got.StrideDeletedAt != nil || got.FilesDeletedAt != nil {
		t.Fatalf("unfinished steps must stay NULL: %+v", got)
	}
	if got.ErrorMessage == nil || *got.ErrorMessage != "coach down" {
		t.Fatalf("error_message = %v", got.ErrorMessage)
	}
	if got.CoachCountsJSON == nil || *got.CoachCountsJSON != counts {
		t.Fatalf("coach_counts_json = %v", got.CoachCountsJSON)
	}
}
