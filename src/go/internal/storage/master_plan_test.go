package storage

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// migrateMasterPlan ensures the master_plan table exists for the integration
// test (the shared openTestStore only migrates jobs/pipeline_runs).
func migrateMasterPlan(t *testing.T, st *Store) {
	t.Helper()
	if err := st.AutoMigrateMasterPlan(context.Background()); err != nil {
		t.Fatalf("automigrate master_plan: %v", err)
	}
}

func ptrInt8(v int8) *int8    { return &v }
func ptrInt64(v int64) *int64 { return &v }

// structuredPlan builds a valid active v2 (structured) row for uid.
func structuredPlan(uid string) *MasterPlan {
	return &MasterPlan{
		PlanID:         uuid.NewString(),
		UserID:         uid,
		ContentVersion: MasterPlanContentStructured,
		Content:        `{"plan_id":"x","status":"active","goal":{"goal_id":"g"}}`,
		GoalID:         uuid.NewString(),
		Status:         MasterPlanStatusActive,
		ActiveFlag:     ptrInt8(1),
		Version:        ptrInt64(1),
	}
}

// markdownPlan builds a valid active v1 (markdown) row for uid — no plan version.
func markdownPlan(uid string) *MasterPlan {
	return &MasterPlan{
		PlanID:         uuid.NewString(),
		UserID:         uid,
		ContentVersion: MasterPlanContentMarkdown,
		Content:        "# 训练总纲\n\nPhase 1: 基础期\n",
		GoalID:         uuid.NewString(),
		Status:         MasterPlanStatusActive,
		ActiveFlag:     ptrInt8(1),
		Version:        nil,
	}
}

func seedPlan(t *testing.T, st *Store, p *MasterPlan) {
	t.Helper()
	if err := st.db.WithContext(context.Background()).Create(p).Error; err != nil {
		t.Fatalf("seed plan (cv=%d status=%s): %v", p.ContentVersion, p.Status, err)
	}
}

// Happy path: an active structured plan is returned by GetActiveStructuredPlan,
// and GetMarkdownOverview returns nil for that user.
func TestMasterPlan_ActiveStructuredHappyPath(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	want := structuredPlan(uid)
	seedPlan(t, st, want)

	got, err := st.GetActiveStructuredPlan(ctx, uid)
	if err != nil || got == nil {
		t.Fatalf("GetActiveStructuredPlan: err=%v nil=%v", err, got == nil)
	}
	if got.PlanID != want.PlanID || got.ContentVersion != MasterPlanContentStructured {
		t.Fatalf("wrong row: %+v", got)
	}
	if got.Content != want.Content {
		t.Fatalf("content not preserved verbatim: %q", got.Content)
	}
	if got.Version == nil || *got.Version != 1 {
		t.Fatalf("version not preserved: %v", got.Version)
	}

	md, err := st.GetMarkdownOverview(ctx, uid)
	if err != nil {
		t.Fatalf("GetMarkdownOverview err: %v", err)
	}
	if md != nil {
		t.Fatalf("structured user must have no markdown overview, got %+v", md)
	}
}

// Happy path: a markdown overview is returned by GetMarkdownOverview, and
// GetActiveStructuredPlan returns nil for that user.
func TestMasterPlan_MarkdownHappyPath(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	want := markdownPlan(uid)
	seedPlan(t, st, want)

	got, err := st.GetMarkdownOverview(ctx, uid)
	if err != nil || got == nil {
		t.Fatalf("GetMarkdownOverview: err=%v nil=%v", err, got == nil)
	}
	if got.PlanID != want.PlanID || got.ContentVersion != MasterPlanContentMarkdown {
		t.Fatalf("wrong row: %+v", got)
	}
	if got.Content != want.Content {
		t.Fatalf("markdown content not preserved verbatim: %q", got.Content)
	}
	if got.Version != nil {
		t.Fatalf("markdown row must have NULL version, got %v", *got.Version)
	}

	sp, err := st.GetActiveStructuredPlan(ctx, uid)
	if err != nil {
		t.Fatalf("GetActiveStructuredPlan err: %v", err)
	}
	if sp != nil {
		t.Fatalf("markdown user must have no structured plan, got %+v", sp)
	}
}

// GetActiveStructuredPlan must ignore draft/archived rows and other users' rows,
// returning only this user's single active structured plan.
func TestMasterPlan_IgnoresNonActiveAndOtherUsers(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	other := uuid.NewString()

	active := structuredPlan(uid)
	seedPlan(t, st, active)

	// A draft and an archived plan for the same user — both active_flag=NULL so
	// they never collide with the active row on UNIQUE(user_id, active_flag).
	draft := structuredPlan(uid)
	draft.Status = MasterPlanStatusDraft
	draft.ActiveFlag = nil
	seedPlan(t, st, draft)

	archived := structuredPlan(uid)
	archived.Status = MasterPlanStatusArchived
	archived.ActiveFlag = nil
	seedPlan(t, st, archived)

	// Another user's active plan must not leak.
	seedPlan(t, st, structuredPlan(other))

	got, err := st.GetActiveStructuredPlan(ctx, uid)
	if err != nil || got == nil {
		t.Fatalf("GetActiveStructuredPlan: err=%v nil=%v", err, got == nil)
	}
	if got.PlanID != active.PlanID {
		t.Fatalf("returned wrong plan: got %s want the active one %s", got.PlanID, active.PlanID)
	}
}

// Negative path: no plan for the user -> (nil, nil), never an error, for both
// readers. A malformed (non-UUID) user id is rejected.
func TestMasterPlan_NotFoundAndBadUserID(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	sp, err := st.GetActiveStructuredPlan(ctx, uuid.NewString())
	if err != nil || sp != nil {
		t.Fatalf("expected (nil,nil) for unknown user: sp=%v err=%v", sp, err)
	}
	md, err := st.GetMarkdownOverview(ctx, uuid.NewString())
	if err != nil || md != nil {
		t.Fatalf("expected (nil,nil) for unknown user: md=%v err=%v", md, err)
	}

	if _, err := st.GetActiveStructuredPlan(ctx, "not-a-uuid"); err == nil {
		t.Fatalf("expected error for non-UUID user id")
	}
}

// Edge: the UNIQUE(user_id, active_flag) constraint forbids a second active row
// (across BOTH formats) for the same athlete.
func TestMasterPlan_AtMostOneActivePerUser(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	seedPlan(t, st, structuredPlan(uid))

	// A second active row (structured or markdown) for the same user collides.
	dup := markdownPlan(uid) // active_flag=1, same user, different plan_id
	err := st.db.WithContext(ctx).Create(dup).Error
	if err == nil {
		t.Fatalf("expected UNIQUE(user_id, active_flag) violation on a second active row")
	}
	if !isDuplicateKey(err) {
		t.Fatalf("expected duplicate-key (1062), got %v", err)
	}
}

// Edge: CHECK ck_master_plan_content_version rejects an out-of-range format, and
// CHECK ck_master_plan_v2_version rejects a structured row missing its version.
// These also assert AutoMigrate actually created the CHECK constraints.
func TestMasterPlan_CheckConstraints(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	ctx := context.Background()

	badVersion := structuredPlan(uuid.NewString())
	badVersion.ContentVersion = 3
	if err := st.db.WithContext(ctx).Create(badVersion).Error; err == nil {
		t.Fatalf("expected content_version CHECK to reject content_version=3")
	}

	missingVersion := structuredPlan(uuid.NewString())
	missingVersion.Version = nil // v2 row with no version
	if err := st.db.WithContext(ctx).Create(missingVersion).Error; err == nil {
		t.Fatalf("expected v2-version CHECK to reject a structured row with NULL version")
	}
}
