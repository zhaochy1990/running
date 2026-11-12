package storage

import (
	"context"
	"errors"
	"strings"
	"sync"
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

// ── accept transaction (#951) ───────────────────────────────────────────────

// accept 成功：所有周变更 + workout 物化 + pending → accepted 同一事务提交。
func TestAcceptPlanAdjustmentAppliesWeeksAndStatusInOneTransaction(t *testing.T) {
	st := openTestStore(t)
	ctx := t.Context()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate plan_adjustment: %v", err)
	}
	migrateBatchWeeklyPlans(t, st)
	uid := uuid.NewString()
	master := uuid.NewString()
	payload := `{"weekly_docs":[{"week_name":"2026-03-09_03-15"}]}`
	row, err := st.UpsertPendingAdjustment(ctx, uid, master, "2026-02-09", "no_time", "问句", payload)
	if err != nil {
		t.Fatalf("upsert pending: %v", err)
	}
	replacedWeek := seedBatchWeek(t, st, uid, master, "2026-03-09", "2026-03-09", "原课")
	items := []WeeklyPlanBatchItem{
		{WeekStart: "2026-03-09", Content: batchWeeklyContent("2026-03-09", "2026-03-10", "调整后"),
			Replacement: &WeeklyPlanReplacement{PlanID: replacedWeek.PlanID, Revision: replacedWeek.Revision}},
		{WeekStart: "2026-03-16", Content: batchWeeklyContent("2026-03-16", "2026-03-16", "新增周")},
	}
	results, err := st.AcceptPlanAdjustment(ctx, uid, row.ID, payload, items)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if len(results) != 2 || results[0].Revision != 2 || !results[0].Replaced || results[1].Revision != 1 {
		t.Fatalf("results=%+v", results)
	}
	accepted, err := st.GetAdjustmentByID(ctx, uid, row.ID)
	if err != nil || accepted.Status != PlanAdjustmentStatusAccepted {
		t.Fatalf("status=%+v err=%v", accepted, err)
	}
	for _, weekStart := range []string{"2026-03-09", "2026-03-16"} {
		plan, err := st.GetActiveWeeklyPlan(ctx, uid, weekStart)
		if err != nil || plan == nil || plan.MasterPlanID == nil || *plan.MasterPlanID != master {
			t.Fatalf("week %s=%+v err=%v", weekStart, plan, err)
		}
	}
	workouts, err := st.ListPlanSessions(ctx, uid, "2026-03-09", "2026-03-22")
	if err != nil || len(workouts) != 2 {
		t.Fatalf("workouts=%d err=%v", len(workouts), err)
	}
}

// payload 在用户同意后被并发 choose 改掉：拒绝应用旧提案，周不变、提案仍 pending。
func TestAcceptPlanAdjustmentRejectsChangedPayload(t *testing.T) {
	st := openTestStore(t)
	ctx := t.Context()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate plan_adjustment: %v", err)
	}
	migrateBatchWeeklyPlans(t, st)
	uid := uuid.NewString()
	master := uuid.NewString()
	row, err := st.UpsertPendingAdjustment(ctx, uid, master, "2026-05-25", "no_time", "问句", `{"v":1}`)
	if err != nil {
		t.Fatalf("upsert pending: %v", err)
	}
	items := []WeeklyPlanBatchItem{{WeekStart: "2026-06-01", Content: batchWeeklyContent("2026-06-01", "2026-06-01", "旧提案周")}}
	if _, err := st.AcceptPlanAdjustment(ctx, uid, row.ID, `{"v":2}`, items); !errors.Is(err, ErrAdjustmentState) {
		t.Fatalf("accept err=%v want ErrAdjustmentState", err)
	}
	if plan, err := st.GetActiveWeeklyPlan(ctx, uid, "2026-06-01"); err != nil || plan != nil {
		t.Fatalf("week leaked: %+v err=%v", plan, err)
	}
	stored, err := st.GetAdjustmentByID(ctx, uid, row.ID)
	if err != nil || stored.Status != PlanAdjustmentStatusPending || stored.Payload == nil || *stored.Payload != `{"v":1}` {
		t.Fatalf("row changed: %+v err=%v", stored, err)
	}
}

// accepted 状态更新失败（DB 触发器模拟）：所有周回滚，提案保持 pending。
func TestAcceptPlanAdjustmentRollsBackWeeksWhenStatusTransitionFails(t *testing.T) {
	st := openTestStore(t)
	ctx := t.Context()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate plan_adjustment: %v", err)
	}
	migrateBatchWeeklyPlans(t, st)
	uid := uuid.NewString()
	master := uuid.NewString()
	payload := `{"v":1}`
	row, err := st.UpsertPendingAdjustment(ctx, uid, master, "2026-07-20", "no_time", "问句", payload)
	if err != nil {
		t.Fatalf("upsert pending: %v", err)
	}
	trigger := "trg_accept_fail_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	create := "CREATE TRIGGER " + trigger + " BEFORE UPDATE ON plan_adjustment FOR EACH ROW " +
		"BEGIN IF NEW.status = 'accepted' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'induced accept failure'; END IF; END"
	// CREATE TRIGGER is unsupported by the prepared-statement protocol, so take
	// the bare *sql.DB (no GORM PrepareStmt wrapping) for this DDL.
	sqlDB, err := st.db.DB()
	if err != nil {
		t.Fatalf("sql db: %v", err)
	}
	if _, err := sqlDB.ExecContext(ctx, create); err != nil {
		t.Fatalf("create failure trigger: %v", err)
	}
	t.Cleanup(func() { _, _ = sqlDB.ExecContext(context.Background(), "DROP TRIGGER IF EXISTS "+trigger) })

	items := []WeeklyPlanBatchItem{{WeekStart: "2026-07-27", Content: batchWeeklyContent("2026-07-27", "2026-07-27", "应回滚周")}}
	if _, err := st.AcceptPlanAdjustment(ctx, uid, row.ID, payload, items); err == nil {
		t.Fatalf("accept must fail when the status update is rejected")
	}
	if plan, err := st.GetActiveWeeklyPlan(ctx, uid, "2026-07-27"); err != nil || plan != nil {
		t.Fatalf("week leaked after failed status: %+v err=%v", plan, err)
	}
	workouts, err := st.ListPlanSessions(ctx, uid, "2026-07-27", "2026-08-02")
	if err != nil || len(workouts) != 0 {
		t.Fatalf("workouts leaked after failed status: %+v err=%v", workouts, err)
	}
	stored, err := st.GetAdjustmentByID(ctx, uid, row.ID)
	if err != nil || stored.Status != PlanAdjustmentStatusPending {
		t.Fatalf("proposal status=%+v err=%v", stored, err)
	}
}

// 并发双 accept：行锁 + 锁内状态校验保证只有一个成功，周只落库一次。
func TestAcceptPlanAdjustmentConcurrentDoubleAcceptAppliesOnce(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate plan_adjustment: %v", err)
	}
	migrateBatchWeeklyPlans(t, st)
	uid := uuid.NewString()
	master := uuid.NewString()
	payload := `{"v":1}`
	row, err := st.UpsertPendingAdjustment(ctx, uid, master, "2026-08-03", "no_time", "问句", payload)
	if err != nil {
		t.Fatalf("upsert pending: %v", err)
	}
	items := []WeeklyPlanBatchItem{{WeekStart: "2026-08-10", Content: batchWeeklyContent("2026-08-10", "2026-08-10", "并发周")}}

	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := st.AcceptPlanAdjustment(ctx, uid, row.ID, payload, items)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	succeeded, conflicts := 0, 0
	for err := range errs {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrAdjustmentState):
			conflicts++
		default:
			t.Fatalf("unexpected accept error: %v", err)
		}
	}
	if succeeded != 1 || conflicts != 1 {
		t.Fatalf("succeeded=%d conflicts=%d, want 1/1", succeeded, conflicts)
	}
	stored, err := st.GetAdjustmentByID(ctx, uid, row.ID)
	if err != nil || stored.Status != PlanAdjustmentStatusAccepted {
		t.Fatalf("status=%+v err=%v", stored, err)
	}
	plan, err := st.GetActiveWeeklyPlan(ctx, uid, "2026-08-10")
	if err != nil || plan == nil || plan.Revision != 1 {
		t.Fatalf("week=%+v err=%v", plan, err)
	}
	workouts, err := st.ListPlanSessions(ctx, uid, "2026-08-10", "2026-08-16")
	if err != nil || len(workouts) != 1 {
		t.Fatalf("workouts=%d err=%v", len(workouts), err)
	}
}

// 并发 accept vs dismiss：只有一方成功；dismiss 赢了就绝不能留下 accept 的周。
func TestAcceptPlanAdjustmentConcurrentDismissKeepsOutcomeConsistent(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate plan_adjustment: %v", err)
	}
	migrateBatchWeeklyPlans(t, st)
	uid := uuid.NewString()
	master := uuid.NewString()
	payload := `{"v":1}`
	row, err := st.UpsertPendingAdjustment(ctx, uid, master, "2026-08-17", "no_time", "问句", payload)
	if err != nil {
		t.Fatalf("upsert pending: %v", err)
	}
	items := []WeeklyPlanBatchItem{{WeekStart: "2026-08-24", Content: batchWeeklyContent("2026-08-24", "2026-08-24", "竞态周")}}

	start := make(chan struct{})
	var acceptErr, dismissErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, acceptErr = st.AcceptPlanAdjustment(ctx, uid, row.ID, payload, items)
	}()
	go func() {
		defer wg.Done()
		<-start
		dismissErr = st.SetAdjustmentStatus(ctx, uid, row.ID, PlanAdjustmentStatusDismissed)
	}()
	close(start)
	wg.Wait()

	if !((acceptErr == nil && errors.Is(dismissErr, ErrAdjustmentState)) ||
		(errors.Is(acceptErr, ErrAdjustmentState) && dismissErr == nil)) {
		t.Fatalf("accept err=%v dismiss err=%v, want exactly one winner", acceptErr, dismissErr)
	}
	stored, err := st.GetAdjustmentByID(ctx, uid, row.ID)
	if err != nil {
		t.Fatalf("load row: %v", err)
	}
	plan, err := st.GetActiveWeeklyPlan(ctx, uid, "2026-08-24")
	if err != nil {
		t.Fatalf("load week: %v", err)
	}
	switch stored.Status {
	case PlanAdjustmentStatusAccepted:
		if plan == nil || plan.Revision != 1 {
			t.Fatalf("accepted but week=%+v", plan)
		}
	case PlanAdjustmentStatusDismissed:
		if plan != nil {
			t.Fatalf("dismissed but proposal week was applied: %+v", plan)
		}
	default:
		t.Fatalf("unexpected final status %s", stored.Status)
	}
}

// #952：所有周都被保留（没有可安全替换的周）时，accept 仍只把提案置为
// accepted，items 为空也必须成功（这是 API 层的正常路径，不是非法批次）。
func TestAcceptPlanAdjustmentWithNoWeeksStillClosesProposal(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate plan_adjustment: %v", err)
	}
	migrateBatchWeeklyPlans(t, st)
	uid := uuid.NewString()
	master := uuid.NewString()
	payload := `{"v":1}`
	row, err := st.UpsertPendingAdjustment(ctx, uid, master, "2026-09-21", "no_time", "问句", payload)
	if err != nil {
		t.Fatalf("upsert pending: %v", err)
	}
	results, err := st.AcceptPlanAdjustment(ctx, uid, row.ID, payload, nil)
	if err != nil || len(results) != 0 {
		t.Fatalf("accept with no weeks: results=%+v err=%v", results, err)
	}
	stored, err := st.GetAdjustmentByID(ctx, uid, row.ID)
	if err != nil || stored.Status != PlanAdjustmentStatusAccepted {
		t.Fatalf("proposal status=%+v err=%v", stored, err)
	}
}

// accept 锁内异计划拒绝：即使 revision 匹配也不得替换别的 master plan 的周。
func TestAcceptPlanAdjustmentRejectsOtherMasterPlanWeek(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate plan_adjustment: %v", err)
	}
	migrateBatchWeeklyPlans(t, st)
	uid := uuid.NewString()
	master := uuid.NewString()
	otherMaster := uuid.NewString()
	payload := `{"v":1}`
	row, err := st.UpsertPendingAdjustment(ctx, uid, master, "2026-09-07", "no_time", "问句", payload)
	if err != nil {
		t.Fatalf("upsert pending: %v", err)
	}
	existing := seedBatchWeek(t, st, uid, otherMaster, "2026-09-14", "2026-09-14", "别的计划")
	items := []WeeklyPlanBatchItem{{
		WeekStart: "2026-09-14", Content: batchWeeklyContent("2026-09-14", "2026-09-15", "试图替换"),
		Replacement: &WeeklyPlanReplacement{PlanID: existing.PlanID, Revision: existing.Revision},
	}}
	if _, err := st.AcceptPlanAdjustment(ctx, uid, row.ID, payload, items); !errors.Is(err, ErrWeeklyPlanMasterPlanConflict) {
		t.Fatalf("accept err=%v want ErrWeeklyPlanMasterPlanConflict", err)
	}
	after, err := st.GetActiveWeeklyPlan(ctx, uid, "2026-09-14")
	if err != nil || after == nil || after.PlanID != existing.PlanID {
		t.Fatalf("cross-plan week changed: %+v err=%v", after, err)
	}
	stored, err := st.GetAdjustmentByID(ctx, uid, row.ID)
	if err != nil || stored.Status != PlanAdjustmentStatusPending {
		t.Fatalf("proposal status=%+v err=%v", stored, err)
	}
}
