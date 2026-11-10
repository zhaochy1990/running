package storage

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

// PlanInjury storage invariants (#858 PR-D), DSN-gated like the other storage
// integration tests (set STRIDE_WORKER_TEST_MYSQL_DSN):
//   - enter 四选一：continue 不留 active 行（连 pending 也关）；reduced/rest/
//     undecided 建（或覆盖）active 行且重新基线化锚
//   - 每日轻问：better/same 记履历不动锚；worse 置 needs_verdict（mode 不变）；
//     recovered 删 active 行留履历；当天幂等
//   - 医生三选一：仅 pending_doctor 行接受（否则 ErrInjuryState）；continue 关行
//   - UpdateInjuryMaintenanceKm：仅 reduced 行接受（单一真源=TS，Go 只存值）
//   - verdict/checkin 枚举守卫与 ErrInjuryNotFound

func TestPlanInjuryLifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := t.Context()
	if err := st.AutoMigratePlanInjury(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	user := uuid.NewString()
	defer func() {
		_ = st.db.Where("user_id = ?", user).Delete(&PlanInjuryState{}).Error
		_ = st.db.Where("user_id = ?", user).Delete(&PlanInjuryCheckin{}).Error
	}()

	// ① 枚举守卫
	if _, err := st.EnterInjuryState(ctx, user, "11111111-2222-3333-4444-555555555701", "伤情", "power_through"); !errors.Is(err, ErrInjuryVerdict) {
		t.Fatalf("bad verdict err=%v", err)
	}
	if _, err := st.AnswerDailyCheckin(ctx, user, "fine"); !errors.Is(err, ErrInjuryCheckin) {
		t.Fatalf("bad answer err=%v", err)
	}

	// ② continue 进入：无 active 行（履历仍记）
	row, err := st.EnterInjuryState(ctx, user, "11111111-2222-3333-4444-555555555701", "能继续练", "continue")
	if err != nil || row != nil {
		t.Fatalf("continue enter: row=%v err=%v", row, err)
	}
	if state, _ := st.GetInjuryState(ctx, user); state != nil {
		t.Fatalf("continue 留下 active 行")
	}

	// ③ undecided → pending_doctor；锚空
	if _, err := st.EnterInjuryState(ctx, user, "11111111-2222-3333-4444-555555555702", "足底刺痛判断不了", "undecided"); err != nil {
		t.Fatalf("undecided enter: %v", err)
	}
	state, err := st.GetInjuryState(ctx, user)
	if err != nil || state == nil || state.Mode != PlanInjuryModePendingDoctor || state.MaintenanceKm != nil {
		t.Fatalf("pending state=%+v err=%v", state, err)
	}
	// 非待定守卫由 reduced 行覆盖（此处先转 reduced 再验 doctor 409）
	if _, err := st.AnswerPendingDoctor(ctx, user, "reduced"); err != nil {
		t.Fatalf("doctor reduced: %v", err)
	}

	// ④ 每日轻问：better 记履历不动锚（单一真源在 TS）
	if _, err := st.UpdateInjuryMaintenanceKm(ctx, user, 39); err != nil {
		t.Fatalf("write anchor: %v", err)
	}
	state, err = st.AnswerDailyCheckin(ctx, user, "better")
	if err != nil || state == nil || state.MaintenanceKm == nil || *state.MaintenanceKm != 39 {
		t.Fatalf("better state=%+v err=%v", state, err)
	}
	if state.NeedsVerdict {
		t.Fatalf("better 不应触发 needs_verdict")
	}
	// 当天幂等：同日再答 worse 不生效
	state, err = st.AnswerDailyCheckin(ctx, user, "worse")
	if err != nil || state == nil || state.NeedsVerdict || state.LastCheckinAnswer == nil || *state.LastCheckinAnswer != "better" {
		t.Fatalf("same-day re-answer state=%+v err=%v", state, err)
	}

	// ⑤ 覆盖 re-enter（worse 后重新自判）：锚重基线、needs_verdict 清零
	if _, err := st.EnterInjuryState(ctx, user, "11111111-2222-3333-4444-555555555703", "复诊后减量", "reduced"); err != nil {
		t.Fatalf("re-enter reduced: %v", err)
	}
	state, _ = st.GetInjuryState(ctx, user)
	if state == nil || state.NeedsVerdict || state.MaintenanceKm != nil {
		t.Fatalf("re-enter rebaseline state=%+v", state)
	}

	// ⑥ 维持锚守卫：reduced 接受；rest 行拒绝
	if _, err := st.UpdateInjuryMaintenanceKm(ctx, user, 0.5); err != nil {
		t.Fatalf("anchor on reduced: %v", err)
	}
	if _, err := st.EnterInjuryState(ctx, user, "11111111-2222-3333-4444-555555555703", "完全停", "rest"); err != nil {
		t.Fatalf("enter rest: %v", err)
	}
	if _, err := st.UpdateInjuryMaintenanceKm(ctx, user, 30); !errors.Is(err, ErrInjuryState) {
		t.Fatalf("anchor on rest err=%v want state violation", err)
	}

	// ⑦ 无 active 行路径：checkin/doctor/maintenance → ErrInjuryNotFound
	if _, err := st.AnswerPendingDoctor(ctx, user, "rest"); !errors.Is(err, ErrInjuryState) {
		t.Fatalf("doctor on rest err=%v want state violation", err)
	}
	if err := st.CloseInjuryState(ctx, user); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, err := st.AnswerDailyCheckin(ctx, user, "better"); !errors.Is(err, ErrInjuryNotFound) {
		t.Fatalf("checkin without state err=%v", err)
	}
	if _, err := st.UpdateInjuryMaintenanceKm(ctx, user, 30); !errors.Is(err, ErrInjuryNotFound) {
		t.Fatalf("anchor without state err=%v", err)
	}

	// ⑧ 履历完整性：verdict/doctor/daily 全留痕（时间倒序可读）
	history, err := st.ListInjuryCheckins(ctx, user, 50)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	kinds := map[string]int{}
	for _, row := range history {
		kinds[row.Kind]++
	}
	// verdict×4（continue/undecided/reduced 重判/rest）+ doctor×1 + daily×1（better，幂等不重记）
	if kinds["verdict"] != 4 || kinds["doctor"] != 1 || kinds["daily"] != 1 {
		t.Fatalf("history kinds=%v rows=%d", kinds, len(history))
	}
}

// 不同用户互不干扰（tenant boundary）。
func TestPlanInjuryUserIsolation(t *testing.T) {
	st := openTestStore(t)
	ctx := t.Context()
	if err := st.AutoMigratePlanInjury(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	userA, userB := uuid.NewString(), uuid.NewString()
	defer func() {
		_ = st.db.Where("user_id IN ?", []string{userA, userB}).Delete(&PlanInjuryState{}).Error
		_ = st.db.Where("user_id IN ?", []string{userA, userB}).Delete(&PlanInjuryCheckin{}).Error
	}()
	if _, err := st.EnterInjuryState(ctx, userA, "11111111-2222-3333-4444-555555555704", "A 伤", "reduced"); err != nil {
		t.Fatalf("A enter: %v", err)
	}
	if state, _ := st.GetInjuryState(ctx, userB); state != nil {
		t.Fatalf("B 不应有 active 行")
	}
	if _, err := st.AnswerDailyCheckin(ctx, userB, "better"); !errors.Is(err, ErrInjuryNotFound) {
		t.Fatalf("B checkin err=%v", err)
	}
}
