package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func migrateMasterPlan(t *testing.T, st *Store) {
	t.Helper()
	if err := st.AutoMigrateMasterPlan(context.Background()); err != nil {
		t.Fatalf("automigrate master_plan: %v", err)
	}
}

func ptrInt8(v int8) *int8    { return &v }
func ptrInt64(v int64) *int64 { return &v }

func structuredPlan(uid string) *MasterPlan {
	now := time.Now().UTC().Truncate(time.Millisecond)
	return &MasterPlan{
		PlanID:         uuid.NewString(),
		UserID:         uid,
		ContentVersion: MasterPlanContentStructured,
		Content:        `{"plan_id":"x","status":"active","goal":{"goal_id":"g"}}`,
		GoalID:         uuid.NewString(),
		Status:         MasterPlanStatusActive,
		ActiveFlag:     ptrInt8(1),
		Revision:       ptrInt64(1),
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func markdownPlan(uid string) *MasterPlan {
	now := time.Now().UTC().Truncate(time.Millisecond)
	return &MasterPlan{
		PlanID:         uuid.NewString(),
		UserID:         uid,
		ContentVersion: MasterPlanContentMarkdown,
		Content:        "# 训练总纲\n\nPhase 1: 基础期\n",
		GoalID:         uuid.NewString(),
		Status:         MasterPlanStatusActive,
		ActiveFlag:     ptrInt8(1),
		Revision:       nil,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func seedPlan(t *testing.T, st *Store, p *MasterPlan) {
	t.Helper()
	if err := st.db.WithContext(context.Background()).Create(p).Error; err != nil {
		t.Fatalf("seed plan (cv=%d status=%s): %v", p.ContentVersion, p.Status, err)
	}
}

func TestMasterPlan_CurrentStructured(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	uid := uuid.NewString()
	want := structuredPlan(uid)
	seedPlan(t, st, want)

	got, err := st.GetCurrentMasterPlan(context.Background(), uid)
	if err != nil || got == nil {
		t.Fatalf("GetCurrentMasterPlan: err=%v nil=%v", err, got == nil)
	}
	if got.PlanID != want.PlanID || got.ContentVersion != MasterPlanContentStructured {
		t.Fatalf("wrong row: %+v", got)
	}
	if got.Revision == nil || *got.Revision != 1 {
		t.Fatalf("revision not preserved: %v", got.Revision)
	}
}

func TestMasterPlan_CurrentMarkdown(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	uid := uuid.NewString()
	want := markdownPlan(uid)
	seedPlan(t, st, want)

	got, err := st.GetCurrentMasterPlan(context.Background(), uid)
	if err != nil || got == nil {
		t.Fatalf("GetCurrentMasterPlan: err=%v nil=%v", err, got == nil)
	}
	if got.PlanID != want.PlanID || got.ContentVersion != MasterPlanContentMarkdown {
		t.Fatalf("wrong row: %+v", got)
	}
	if got.Revision != nil {
		t.Fatalf("markdown row must have NULL revision, got %v", *got.Revision)
	}
}

func TestMasterPlan_CurrentIgnoresInactiveAndOtherUsers(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	active := structuredPlan(uid)
	seedPlan(t, st, active)

	draft := structuredPlan(uid)
	draft.Status = MasterPlanStatusDraft
	draft.ActiveFlag = nil
	seedPlan(t, st, draft)
	archived := structuredPlan(uid)
	archived.Status = MasterPlanStatusArchived
	archived.ActiveFlag = nil
	seedPlan(t, st, archived)
	seedPlan(t, st, structuredPlan(uuid.NewString()))

	got, err := st.GetCurrentMasterPlan(ctx, uid)
	if err != nil || got == nil || got.PlanID != active.PlanID {
		t.Fatalf("GetCurrentMasterPlan returned %+v, err=%v", got, err)
	}
}

func TestMasterPlan_CurrentNotFoundAndBadUserID(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)

	got, err := st.GetCurrentMasterPlan(context.Background(), uuid.NewString())
	if err != nil || got != nil {
		t.Fatalf("unknown user: got=%v err=%v", got, err)
	}
	if _, err := st.GetCurrentMasterPlan(context.Background(), "not-a-uuid"); err == nil {
		t.Fatal("expected error for non-UUID user id")
	}
}

func TestMasterPlan_RelationalInvariants(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	t.Run("one current plan across formats", func(t *testing.T) {
		uid := uuid.NewString()
		seedPlan(t, st, structuredPlan(uid))
		err := st.db.WithContext(ctx).Create(markdownPlan(uid)).Error
		if err == nil || !isDuplicateKey(err) {
			t.Fatalf("expected duplicate-key error, got %v", err)
		}
	})

	tests := []struct {
		name string
		plan *MasterPlan
	}{
		{name: "invalid content version", plan: func() *MasterPlan {
			p := structuredPlan(uuid.NewString())
			p.ContentVersion = 3
			return p
		}()},
		{name: "structured revision missing", plan: func() *MasterPlan {
			p := structuredPlan(uuid.NewString())
			p.Revision = nil
			return p
		}()},
		{name: "structured revision nonpositive", plan: func() *MasterPlan {
			p := structuredPlan(uuid.NewString())
			p.Revision = ptrInt64(0)
			return p
		}()},
		{name: "markdown revision present", plan: func() *MasterPlan {
			p := markdownPlan(uuid.NewString())
			p.Revision = ptrInt64(1)
			return p
		}()},
		{name: "active status without flag", plan: func() *MasterPlan {
			p := structuredPlan(uuid.NewString())
			p.ActiveFlag = nil
			return p
		}()},
		{name: "flag without active status", plan: func() *MasterPlan {
			p := structuredPlan(uuid.NewString())
			p.Status = MasterPlanStatusArchived
			return p
		}()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := st.db.WithContext(ctx).Create(tt.plan).Error; err == nil {
				t.Fatalf("expected CHECK constraint rejection")
			}
		})
	}
}

func TestMasterPlan_CurrentRejectsInvalidStoredIdentity(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	p := structuredPlan(uid)
	seedPlan(t, st, p)

	if err := st.db.WithContext(ctx).Model(&MasterPlan{}).
		Where("plan_id = ?", p.PlanID).
		Update("goal_id", "").Error; err != nil {
		t.Fatalf("corrupt row fixture: %v", err)
	}
	if _, err := st.GetCurrentMasterPlan(ctx, uid); err == nil {
		t.Fatal("expected invalid stored identity error")
	}
}
