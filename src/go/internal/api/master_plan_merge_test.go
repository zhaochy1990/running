package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
)

// #858 PR-C 下半验收：
//   - 读合并（mergeWeeklyPlanWeeks 纯函数 + GET current 端到端）：weekly 行覆盖
//     快照同周、快照后追加（week_index 排序）、缺失字段回退快照原值、
//     weekly 行缺 week_index 时按 week_start 相对 start_date 推算；
//   - 换计划归档（apply / applyFromContent / update）：落新计划后异链 weekly 行
//     清理（ArchiveWeeklyPlansExcept）+ pending 提案整体 supersede。

func weeklyRow(masterPlanID, weekStart, content string) storage.WeeklyPlan {
	return storage.WeeklyPlan{
		PlanID:         uuid.NewString(),
		UserID:         "u1",
		MasterPlanID:   &masterPlanID,
		WeekStart:      weekStart,
		ContentVersion: storage.WeeklyPlanContentStructured,
		Content:        content,
		Status:         storage.WeeklyPlanStatusActive,
		Revision:       2,
	}
}

func planContentOf(t *testing.T, planJSON string) mpContent {
	t.Helper()
	var parsed mpContent
	if err := json.Unmarshal([]byte(planJSON), &parsed); err != nil {
		t.Fatalf("parse plan: %v", err)
	}
	return parsed
}

func TestMergeWeeklyPlanWeeks_OverridesSnapshotWeek(t *testing.T) {
	parsed := planContentOf(t, samplePlanJSON) // start_date=2026-06-01, 2 周快照
	rawWeeks := toMapSlice(mustJSONDoc(t, samplePlanJSON)["weeks"])
	// 快照第 1 周（2026-06-01）的滚动行：km 改 42、key_sessions 带 2 节课、
	// phase_name/is_recovery_week 覆写；第 2 周（2026-06-08）行只带 km_low，
	// 其余字段回退快照原值。
	rows := []storage.WeeklyPlan{
		weeklyRow("m1", "2026-06-08", `{"week_index":2,"target_weekly_km_low":52.5}`),
		weeklyRow("m1", "2026-06-01", `{"week_index":1,"phase_name":"build","target_weekly_km_low":42,"target_weekly_km_high":42,"key_sessions":[{"type":"long_run"},{"type":"interval"}],"is_recovery_week":true}`),
	}
	merged := mergeWeeklyPlanWeeks(parsed, rawWeeks, rows)
	if len(merged) != 2 {
		t.Fatalf("merged weeks=%d want 2", len(merged))
	}
	first := merged[0]
	if first["week_start"] != "2026-06-01" || asInt(first["week_index"]) != 1 {
		t.Fatalf("week1 identity: %+v", first)
	}
	if first["phase_name"] != "build" || first["is_recovery_week"] != true {
		t.Fatalf("week1 overlay: %+v", first)
	}
	if asFloatMust(t, first["target_weekly_km_low"]) != 42 || asFloatMust(t, first["target_weekly_km_high"]) != 42 {
		t.Fatalf("week1 km overlay: %+v", first)
	}
	if sessions, ok := first["key_sessions"].([]any); !ok || len(sessions) != 2 {
		t.Fatalf("week1 key_sessions passthrough: %+v", first["key_sessions"])
	}
	second := merged[1]
	if second["week_start"] != "2026-06-08" || asInt(second["week_index"]) != 2 {
		t.Fatalf("week2 identity: %+v", second)
	}
	// km_low 覆盖、km_high 回退快照原值 55、phase_name 回退（快照无 phase_name 时保持原样）
	if asFloatMust(t, second["target_weekly_km_low"]) != 52.5 {
		t.Fatalf("week2 km_low overlay: %+v", second)
	}
	if asFloatMust(t, second["target_weekly_km_high"]) != 55 {
		t.Fatalf("week2 km_high fallback: %+v", second)
	}
	if _, has := second["key_sessions"]; !has {
		t.Fatalf("week2 keeps snapshot key_sessions key")
	}
}

func TestMergeWeeklyPlanWeeks_AppendsBeyondSnapshotSortedByIndex(t *testing.T) {
	parsed := planContentOf(t, samplePlanJSON) // start_date=2026-06-01
	rawWeeks := toMapSlice(mustJSONDoc(t, samplePlanJSON)["weeks"])
	// 快照只有 2 周；滚动批已落第 3、4 周（乱序给入）。
	rows := []storage.WeeklyPlan{
		weeklyRow("m1", "2026-06-22", `{"week_index":4,"target_weekly_km_low":60,"key_sessions":[]}`),
		weeklyRow("m1", "2026-06-15", `{"week_index":3,"target_weekly_km_low":58,"key_sessions":[]}`),
	}
	merged := mergeWeeklyPlanWeeks(parsed, rawWeeks, rows)
	if len(merged) != 4 {
		t.Fatalf("merged weeks=%d want 4", len(merged))
	}
	if asInt(merged[2]["week_index"]) != 3 || merged[2]["week_start"] != "2026-06-15" {
		t.Fatalf("appended week3 out of order: %+v", merged[2])
	}
	if asInt(merged[3]["week_index"]) != 4 || merged[3]["week_start"] != "2026-06-22" {
		t.Fatalf("appended week4 out of order: %+v", merged[3])
	}
	// 追加行 phase_id 按日期包含解析（机械查找，非训练学）：样例计划的阶段只
	// 盖到 2026-06-14，第 3 周在所有阶段之外 → 无 phase_id（Go 不猜）。
	if _, has := merged[2]["phase_id"]; has {
		t.Fatalf("appended week3 beyond all phases must not carry phase_id: %+v", merged[2])
	}
}

func TestMergeWeeklyPlanWeeks_DerivesWeekIndexFromStartDate(t *testing.T) {
	parsed := planContentOf(t, samplePlanJSON) // start_date=2026-06-01
	rawWeeks := toMapSlice(mustJSONDoc(t, samplePlanJSON)["weeks"])
	// 老滚动行无 week_index（只有 week_name）：按 week_start 相对 start_date 推算（第 2 周）。
	rows := []storage.WeeklyPlan{weeklyRow("m1", "2026-06-08", `{"target_weekly_km_low":50}`)}
	merged := mergeWeeklyPlanWeeks(parsed, rawWeeks, rows)
	if asInt(merged[1]["week_index"]) != 2 {
		t.Fatalf("derived week index: %+v", merged[1])
	}
	// 早于计划起点的行不进合并
	rows = []storage.WeeklyPlan{weeklyRow("m1", "2026-05-25", `{"week_index":9,"target_weekly_km_low":50}`)}
	merged = mergeWeeklyPlanWeeks(parsed, rawWeeks, rows)
	if len(merged) != 2 {
		t.Fatalf("pre-plan week must be skipped: %d", len(merged))
	}
}

func TestMergeWeeklyPlanWeeks_SkipsUnreadableRows(t *testing.T) {
	parsed := planContentOf(t, samplePlanJSON)
	rawWeeks := toMapSlice(mustJSONDoc(t, samplePlanJSON)["weeks"])
	rows := []storage.WeeklyPlan{
		weeklyRow("m1", "2026-06-15", `{not json`),
		{PlanID: "p", UserID: "u1", WeekStart: "2026-06-22", ContentVersion: storage.WeeklyPlanContentMarkdown, Content: "markdown 周", Status: storage.WeeklyPlanStatusActive, Revision: 1},
	}
	merged := mergeWeeklyPlanWeeks(parsed, rawWeeks, rows)
	if len(merged) != 2 {
		t.Fatalf("unreadable rows must be skipped, got %d", len(merged))
	}
}

func TestBuildCurrentResponse_MergesWeeklyRowsIntoWeeks(t *testing.T) {
	today := mustDate(t, "2026-06-10")
	rows := []storage.WeeklyPlan{
		weeklyRow("p1", "2026-06-01", `{"week_index":1,"phase_name":"build","target_weekly_km_low":42,"target_weekly_km_high":42,"key_sessions":[{"type":"long_run","distance_km":20}],"is_recovery_week":false}`),
		weeklyRow("p1", "2026-06-15", `{"week_index":3,"phase_name":"marathon","target_weekly_km_low":58,"target_weekly_km_high":58,"key_sessions":[],"is_recovery_week":false}`),
	}
	resp, windows, _, err := buildCurrentResponse(&storage.MasterPlan{Content: samplePlanJSON}, rows, today)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	weeks := resp["weeks"].([]map[string]any)
	if len(weeks) != 3 {
		t.Fatalf("weeks=%d want 3 (snapshot 2 + appended 1)", len(weeks))
	}
	first := weeks[0]
	if asFloatMust(t, first["target_weekly_km_low"]) != 42 || asFloatMust(t, first["planned_distance_km"].(float64)) != 42 {
		t.Fatalf("week1 merged km: %+v", first)
	}
	if sessions, ok := first["key_sessions"].([]any); !ok || len(sessions) != 1 {
		t.Fatalf("week1 merged key_sessions: %+v", first["key_sessions"])
	}
	third := weeks[2]
	if asInt(third["week_index"]) != 3 || third["week_start"] != "2026-06-15" {
		t.Fatalf("appended week3: %+v", third)
	}
	// 追加周同样获得派生字段（week_end/is_completed）与 actuals 窗口
	if third["week_end"] != "2026-06-21" {
		t.Fatalf("appended week3 week_end: %+v", third)
	}
	if len(windows) != 2 {
		t.Fatalf("windows=%d want 2 (started weeks)", len(windows))
	}
}

func TestGetCurrent_ReadMergeThroughHandler(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	active := &storage.MasterPlan{
		PlanID: uuid.NewString(), UserID: uid, GoalID: uuid.NewString(),
		ContentVersion: storage.MasterPlanContentStructured, Content: samplePlanJSON,
		Status: storage.MasterPlanStatusActive, ActiveFlag: ptrInt8(1),
		Revision: ptrInt64(1), CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	h.store.current[uid] = active
	h.store.weeklyRows = map[string][]storage.WeeklyPlan{
		uid: {weeklyRow(active.PlanID, "2026-06-01", `{"week_index":1,"target_weekly_km_low":42,"target_weekly_km_high":42,"key_sessions":[{"type":"long_run"}],"is_recovery_week":false}`)},
	}
	w := h.do(http.MethodGet, "/api/users/"+uid+"/master-plan/current", internalHdr())
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"target_weekly_km_low":42`) {
		t.Fatalf("merged km not in response: %s", w.Body.String())
	}
	if h.store.weeklyListUID != uid {
		t.Fatalf("weekly list uid=%s want %s", h.store.weeklyListUID, uid)
	}
}

func TestGetCurrent_WeeklyListErrorIs500(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	h.store.current[uid] = &storage.MasterPlan{
		PlanID: uuid.NewString(), UserID: uid, GoalID: uuid.NewString(),
		ContentVersion: storage.MasterPlanContentStructured, Content: samplePlanJSON,
		Status: storage.MasterPlanStatusActive, ActiveFlag: ptrInt8(1),
		Revision: ptrInt64(1), CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	h.store.weeklyErr = errFake
	w := h.do(http.MethodGet, "/api/users/"+uid+"/master-plan/current", internalHdr())
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d want 500", w.Code)
	}
}

// ── 换计划归档：三条写路径都挂清理 ────────────────────────────────────────────

/** 422 校验可过的 body：sample plan 注入合法 goal_id 后序列化。 */
func applyBodyWithGoal(t *testing.T, extra string) string {
	t.Helper()
	content := mustAppliedContent(t, uuid.NewString())
	raw, err := json.Marshal(content)
	if err != nil {
		t.Fatalf("marshal content: %v", err)
	}
	return `{"content":` + string(raw) + `,` + extra + `}`
}

func TestApplyFromContent_ArchivesReplacedSeasonArtifacts(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	body := applyBodyWithGoal(t, `"apply_token":"`+uuid.NewString()+`"`)
	w := h.doBody(http.MethodPost, "/api/users/me/master-plan/apply", h.bearer(t, uid), strings.NewReader(body))
	if w.Code != http.StatusCreated {
		t.Fatalf("apply status=%d body=%s", w.Code, w.Body.String())
	}
	created := h.store.current[uid]
	if len(h.store.archiveCalls) != 1 || h.store.archiveCalls[0] != created.PlanID {
		t.Fatalf("archive calls=%v want new plan %s", h.store.archiveCalls, created.PlanID)
	}
	if h.store.supersedeUser != uid {
		t.Fatalf("supersede user=%s want %s", h.store.supersedeUser, uid)
	}
}

func TestAdminApply_ArchivesReplacedSeasonArtifacts(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	w := h.doBody(http.MethodPost, "/api/users/"+uid+"/master-plan", h.bearerWithClaims(t, uid, testAdminAudience, "admin"), strings.NewReader(applyBodyWithGoal(t, `"replace_existing":false`)))
	if w.Code != http.StatusCreated {
		t.Fatalf("apply status=%d body=%s", w.Code, w.Body.String())
	}
	created := h.store.current[uid]
	if len(h.store.archiveCalls) != 1 || h.store.archiveCalls[0] != created.PlanID {
		t.Fatalf("archive calls=%v", h.store.archiveCalls)
	}
	if h.store.supersedeUser != uid {
		t.Fatalf("supersede user=%s", h.store.supersedeUser)
	}
}

func TestAdminUpdate_ArchivesReplacedSeasonArtifacts(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	active := &storage.MasterPlan{
		PlanID: uuid.NewString(), UserID: uid, GoalID: uuid.NewString(),
		ContentVersion: storage.MasterPlanContentStructured, Content: samplePlanJSON,
		Status: storage.MasterPlanStatusActive, ActiveFlag: ptrInt8(1),
		Revision: ptrInt64(1), CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	h.store.current[uid] = active
	body := applyBodyWithGoal(t, `"expected_active_plan_id":"`+active.PlanID+`","expected_active_revision":1`)
	w := h.doBody(http.MethodPatch, "/api/users/"+uid+"/master-plan", h.bearerWithClaims(t, uid, testAdminAudience, "admin"), strings.NewReader(body))
	if w.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", w.Code, w.Body.String())
	}
	// 原地更新 keep=同一 plan id（同链周行保留），pending 仍整体 supersede
	if len(h.store.archiveCalls) != 1 || h.store.archiveCalls[0] != active.PlanID {
		t.Fatalf("archive calls=%v", h.store.archiveCalls)
	}
	if h.store.supersedeUser != uid {
		t.Fatalf("supersede user=%s", h.store.supersedeUser)
	}
}

func TestApplyFromContent_ArchiveErrorIs500(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	h.store.archiveErr = errFake
	body := applyBodyWithGoal(t, `"apply_token":"`+uuid.NewString()+`"`)
	w := h.doBody(http.MethodPost, "/api/users/me/master-plan/apply", h.bearer(t, uid), strings.NewReader(body))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d want 500", w.Code)
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

var errFake = &fakeError{}

type fakeError struct{}

func (*fakeError) Error() string { return "fake storage error" }

func mustJSONDoc(t *testing.T, raw string) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("parse doc: %v", err)
	}
	return doc
}

func asFloatMust(t *testing.T, value any) float64 {
	t.Helper()
	f, ok := asFloat(value)
	if !ok {
		t.Fatalf("not a number: %+v", value)
	}
	return f
}

func ptrInt8(v int8) *int8    { return &v }
func ptrInt64(v int64) *int64 { return &v }
