package storage

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

// PlanAdjustment storage invariants (#858 PR-C), DSN-gated like the other
// storage integration tests (set STRIDE_WORKER_TEST_MYSQL_DSN):
//   - at most one pending per user (a new event supersedes the old pending)
//   - same-event refresh keeps the row and updates payload
//   - accepted/dismissed closes the event forever (ErrAdjustmentEventClosed)
//   - choose same reason keeps payload / changed reason clears it
//   - payload refill guards the reason; status transitions are terminal-safe

func TestPlanAdjustmentPendingLifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := t.Context()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := uuid.NewString()
	defer func() { _ = st.db.Where("user_id = ?", user).Delete(&PlanAdjustment{}).Error }()

	// ① 首个 pending
	row, err := st.UpsertPendingAdjustment(ctx, user, "11111111-2222-3333-4444-555555555501", "2026-08-17", "no_time", "问句", `{"v":1}`)
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	// ② 同事件刷新：同 id、payload 更新
	refreshed, err := st.UpsertPendingAdjustment(ctx, user, row.MasterPlanID, "2026-08-17", "no_time", "问句", `{"v":2}`)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if refreshed.ID != row.ID || refreshed.Payload == nil || *refreshed.Payload != `{"v":2}` {
		t.Fatalf("refresh kept id=%v payload=%v", refreshed.ID, refreshed.Payload)
	}
	// ③ 新事件：旧 pending 转 superseded，全局仍只有一行 pending
	second, err := st.UpsertPendingAdjustment(ctx, user, row.MasterPlanID, "2026-08-24", "no_time", "问句", `{"v":3}`)
	if err != nil {
		t.Fatalf("second event: %v", err)
	}
	if second.ID == row.ID {
		t.Fatalf("second event must be a new row")
	}
	var pendingCount int64
	st.db.Model(&PlanAdjustment{}).Where("user_id = ? AND status = ?", user, PlanAdjustmentStatusPending).Count(&pendingCount)
	if pendingCount != 1 {
		t.Fatalf("pending count=%d want 1", pendingCount)
	}
	var supersededCount int64
	st.db.Model(&PlanAdjustment{}).Where("user_id = ? AND status = ?", user, PlanAdjustmentStatusSuperseded).Count(&supersededCount)
	if supersededCount != 1 {
		t.Fatalf("superseded count=%d want 1", supersededCount)
	}

	// ④ choose 同因保 payload / 异因清 payload；回填守卫原因
	chosen, err := st.ChooseAdjustmentReason(ctx, user, second.ID, "no_time")
	if err != nil || chosen.Payload == nil {
		t.Fatalf("choose same: err=%v payload=%v", err, chosen.Payload)
	}
	changed, err := st.ChooseAdjustmentReason(ctx, user, second.ID, "over_delivered")
	if err != nil || changed.Payload != nil || changed.Reason != "over_delivered" {
		t.Fatalf("choose changed: err=%v payload=%v reason=%v", err, changed.Payload, changed.Reason)
	}
	if _, err := st.CompleteAdjustmentPayload(ctx, user, second.ID, "no_time", `{}`); !errors.Is(err, ErrAdjustmentState) {
		t.Fatalf("refill wrong reason err=%v want state violation", err)
	}
	if _, err := st.CompleteAdjustmentPayload(ctx, user, second.ID, "over_delivered", `{"v":4}`); err != nil {
		t.Fatalf("refill: %v", err)
	}

	// ⑤ accept 终态；同事件再建 = 关闭
	if err := st.SetAdjustmentStatus(ctx, user, second.ID, PlanAdjustmentStatusAccepted); err != nil {
		t.Fatalf("accept: %v", err)
	}
	if err := st.SetAdjustmentStatus(ctx, user, second.ID, PlanAdjustmentStatusDismissed); !errors.Is(err, ErrAdjustmentState) {
		t.Fatalf("accepted→dismissed err=%v want state violation", err)
	}
	if _, err := st.UpsertPendingAdjustment(ctx, user, second.MasterPlanID, "2026-08-24", "no_time", "问句", `{}`); !errors.Is(err, ErrAdjustmentEventClosed) {
		t.Fatalf("closed event err=%v want ErrAdjustmentEventClosed", err)
	}
}

func TestPlanAdjustmentDismissClosesEventForGood(t *testing.T) {
	st := openTestStore(t)
	ctx := t.Context()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := uuid.NewString()
	defer func() { _ = st.db.Where("user_id = ?", user).Delete(&PlanAdjustment{}).Error }()

	row, err := st.UpsertPendingAdjustment(ctx, user, "11111111-2222-3333-4444-555555555502", "2026-08-17", "ran_other", "问句", `{}`)
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := st.SetAdjustmentStatus(ctx, user, row.ID, PlanAdjustmentStatusDismissed); err != nil {
		t.Fatalf("dismiss: %v", err)
	}
	if pending, err := st.GetPendingAdjustment(ctx, user); err != nil || pending != nil {
		t.Fatalf("pending after dismiss=%v err=%v", pending, err)
	}
	if _, err := st.UpsertPendingAdjustment(ctx, user, row.MasterPlanID, "2026-08-17", "ran_other", "问句", `{}`); !errors.Is(err, ErrAdjustmentEventClosed) {
		t.Fatalf("re-ask dismissed event err=%v want ErrAdjustmentEventClosed", err)
	}
	// 不同用户同事件不受影响
	if _, err := st.UpsertPendingAdjustment(ctx, uuid.NewString(), row.MasterPlanID, "2026-08-17", "ran_other", "问句", `{}`); err != nil {
		t.Fatalf("other user upsert: %v", err)
	}
}

// #858 换计划归档：pending 提案整体 supersede（锚定旧计划），终态行保留历史。
func TestSupersedePendingAdjustments(t *testing.T) {
	st := openTestStore(t)
	ctx := t.Context()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := uuid.NewString()
	other := uuid.NewString()
	defer func() {
		_ = st.db.Where("user_id IN ?", []string{user, other}).Delete(&PlanAdjustment{}).Error
	}()

	// 先铺终态历史行（dismiss）——upsert 的单 pending 不变量会 supersede 旧
	// pending，所以种子顺序：先 dismiss 候选，再落当前 pending。
	dismissed, err := st.UpsertPendingAdjustment(ctx, user, "11111111-2222-3333-4444-555555555603", "2026-08-10", "no_time", "问句", `{"v":1}`)
	if err != nil {
		t.Fatalf("seed to-dismiss: %v", err)
	}
	if err := st.SetAdjustmentStatus(ctx, user, dismissed.ID, PlanAdjustmentStatusDismissed); err != nil {
		t.Fatalf("dismiss: %v", err)
	}
	pending, err := st.UpsertPendingAdjustment(ctx, user, "11111111-2222-3333-4444-555555555601", "2026-08-17", "no_time", "问句", `{"v":1}`)
	if err != nil {
		t.Fatalf("seed pending: %v", err)
	}
	otherPending, err := st.UpsertPendingAdjustment(ctx, other, "11111111-2222-3333-4444-555555555602", "2026-08-17", "no_time", "问句", `{"v":1}`)
	if err != nil {
		t.Fatalf("seed other user pending: %v", err)
	}

	count, err := st.SupersedePendingAdjustments(ctx, user)
	if err != nil {
		t.Fatalf("supersede: %v", err)
	}
	if count != 1 {
		t.Fatalf("superseded=%d want 1", count)
	}
	row, err := st.GetPendingAdjustment(ctx, user)
	if err != nil || row != nil {
		t.Fatalf("user pending after supersede: row=%+v err=%v", row, err)
	}
	var status string
	st.db.Model(&PlanAdjustment{}).Where("id = ?", pending.ID).Pluck("status", &status)
	if status != PlanAdjustmentStatusSuperseded {
		t.Fatalf("pending row status=%s want superseded", status)
	}
	// 终态行不动
	st.db.Model(&PlanAdjustment{}).Where("id = ?", dismissed.ID).Pluck("status", &status)
	if status != PlanAdjustmentStatusDismissed {
		t.Fatalf("dismissed row status=%s", status)
	}
	// 其他用户的 pending 不受影响
	otherRow, err := st.GetPendingAdjustment(ctx, other)
	if err != nil || otherRow == nil || otherRow.ID != otherPending.ID {
		t.Fatalf("other user pending: row=%+v err=%v", otherRow, err)
	}
	// 幂等：无 pending 时 0 行
	again, err := st.SupersedePendingAdjustments(ctx, user)
	if err != nil || again != 0 {
		t.Fatalf("idempotent re-run: count=%d err=%v", again, err)
	}
}
