package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

// #858 PR-D 伤病模式 API 单测（照 plan_adjustment_test 的 fake-store 模式）：
// 进入四选一 / 每日轻问状态机（better/same/worse/recovered + 当天幂等）/
// 医生三选一 / 内部通道（夜检读态 + worker 回写锚）/ tier 与 self-scope 门。
// fake 的状态转移镜像 storage 实现（真库不变量由 DSN 门控的 storage 测试覆盖）。

const injUserID = "d31c2cbc-c3f5-4a10-92d0-73fa3281a301"

// fakeInjuryStateStore implements PlanInjuryStore in memory.
type fakeInjuryStateStore struct {
	mu       sync.Mutex
	active   *storage.PlanInjuryState
	checkins []storage.PlanInjuryCheckin
	today    string // 当天上海日（幂等判定）
	nextID   int
	stateErr error // AnswerPendingDoctor / UpdateInjuryMaintenanceKm 的守卫注入
	notFound bool  // 强制 ErrInjuryNotFound
}

func newInjuryHarness(t *testing.T) (*weeklyPlanHarness, *fakeInjuryStateStore) {
	t.Helper()
	h := newWeeklyPlanHarness(t)
	store := &fakeInjuryStateStore{today: "2026-09-16"}
	h.svc.planInjury = newPlanInjuryRoutes(store, h.svc.log)
	return h, store
}

func (f *fakeInjuryStateStore) record(kind, answer, note string) {
	f.nextID++
	f.checkins = append(f.checkins, storage.PlanInjuryCheckin{
		ID: fmt.Sprintf("chk-%02d", f.nextID), UserID: injUserID,
		Day: f.today, Kind: kind, Answer: answer, CreatedAt: testTime(),
	})
}

func (f *fakeInjuryStateStore) EnterInjuryState(_ context.Context, userID, masterPlanID, detail, verdict string) (*storage.PlanInjuryState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if verdict == storage.PlanInjuryVerdictContinue {
		f.active = nil // 继续练：不留 active 行
		f.record("verdict", verdict, detail)
		return nil, nil
	}
	mode := verdict
	if verdict == storage.PlanInjuryVerdictUndecided {
		mode = storage.PlanInjuryModePendingDoctor
	}
	if f.active == nil {
		f.active = &storage.PlanInjuryState{UserID: userID, MasterPlanID: masterPlanID, Mode: mode, Detail: detail, CreatedAt: testTime()}
	} else {
		f.active.Mode, f.active.Detail, f.active.MasterPlanID = mode, detail, masterPlanID
		f.active.MaintenanceKm, f.active.NeedsVerdict = nil, false
		f.active.LastCheckinDay, f.active.LastCheckinAnswer = nil, nil
	}
	f.record("verdict", verdict, detail)
	return f.active, nil
}

func (f *fakeInjuryStateStore) AnswerDailyCheckin(_ context.Context, _ string, answer string) (*storage.PlanInjuryState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.active == nil {
		return nil, storage.ErrInjuryNotFound
	}
	if f.active.LastCheckinDay != nil && *f.active.LastCheckinDay == f.today {
		return f.active, nil // 当天幂等
	}
	f.record("daily", answer, "")
	if answer == storage.PlanInjuryCheckinRecovered {
		f.active = nil
		return nil, nil
	}
	day, answerCopy := f.today, answer
	f.active.LastCheckinDay, f.active.LastCheckinAnswer = &day, &answerCopy
	if answer == storage.PlanInjuryCheckinWorse {
		f.active.NeedsVerdict = true
	}
	return f.active, nil
}

func (f *fakeInjuryStateStore) AnswerPendingDoctor(_ context.Context, _ string, verdict string) (*storage.PlanInjuryState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.active == nil {
		return nil, storage.ErrInjuryNotFound
	}
	if f.active.Mode != storage.PlanInjuryModePendingDoctor {
		return nil, storage.ErrInjuryState
	}
	f.record("doctor", verdict, "")
	if verdict == storage.PlanInjuryVerdictContinue {
		f.active = nil
		return nil, nil
	}
	f.active.Mode, f.active.MaintenanceKm, f.active.NeedsVerdict = verdict, nil, false
	return f.active, nil
}

func (f *fakeInjuryStateStore) GetInjuryState(_ context.Context, _ string) (*storage.PlanInjuryState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.active, nil
}

func (f *fakeInjuryStateStore) CloseInjuryState(_ context.Context, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.active = nil
	return nil
}

func (f *fakeInjuryStateStore) UpdateInjuryMaintenanceKm(_ context.Context, _ string, km float64) (*storage.PlanInjuryState, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.active == nil {
		return nil, storage.ErrInjuryNotFound
	}
	if f.active.Mode != storage.PlanInjuryModeReduced {
		return nil, storage.ErrInjuryState
	}
	f.active.MaintenanceKm = &km
	return f.active, nil
}

// ── tests ───────────────────────────────────────────────────────────────────

func TestInjuryEnterFourVerdicts(t *testing.T) {
	h, store := newInjuryHarness(t)
	headers := h.bearer(t, injUserID)

	// reduced → active 行
	resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/enter", headers, strings.NewReader(`{"detail":"左膝髌骨酸痛，跑量到 40km 后加重","verdict":"reduced"}`))
	if resp.Code != http.StatusCreated {
		t.Fatalf("enter reduced status=%d body=%s", resp.Code, resp.Body.String())
	}
	// GET self → 200 active 态（含 needs_verdict/maintenance_km 字段）
	resp = h.do(http.MethodGet, "/api/users/"+injUserID+"/plan-injury", headers)
	if resp.Code != http.StatusOK {
		t.Fatalf("state status=%d body=%s", resp.Code, resp.Body.String())
	}
	var state injuryStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.Injury.Mode != storage.PlanInjuryModeReduced || state.Injury.NeedsVerdict || state.Injury.MaintenanceKm != nil {
		t.Fatalf("reduced state=%+v", state.Injury)
	}

	// continue → 立即关闭（201 closed:true，无 active 行）
	resp = h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/enter", headers, strings.NewReader(`{"detail":"可以继续练","verdict":"continue"}`))
	if resp.Code != http.StatusCreated {
		t.Fatalf("enter continue status=%d body=%s", resp.Code, resp.Body.String())
	}
	var closed injuryClosedResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &closed); err != nil || !closed.Closed {
		t.Fatalf("continue closed=%+v err=%v", closed, err)
	}
	if row, _ := store.GetInjuryState(nil, injUserID); row != nil {
		t.Fatalf("continue 留下了 active 行：%+v", row)
	}
	if resp := h.do(http.MethodGet, "/api/users/"+injUserID+"/plan-injury", headers); resp.Code != http.StatusNotFound {
		t.Fatalf("state after continue status=%d", resp.Code)
	}

	// undecided → pending_doctor（不带 maintenance_km）
	resp = h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/enter", headers, strings.NewReader(`{"detail":"足底刺痛，判断不了","verdict":"undecided"}`))
	if resp.Code != http.StatusCreated {
		t.Fatalf("enter undecided status=%d body=%s", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &state); err != nil || state.Injury.Mode != storage.PlanInjuryModePendingDoctor {
		t.Fatalf("undecided state=%+v err=%v", state.Injury, err)
	}
	// 履历：三次 enter 各留一行 verdict
	if len(store.checkins) != 3 {
		t.Fatalf("checkins=%d want 3", len(store.checkins))
	}
}

func TestInjuryDailyCheckinStateMachine(t *testing.T) {
	h, store := newInjuryHarness(t)
	headers := h.bearer(t, injUserID)
	enter := func(body string) *httptest.ResponseRecorder {
		return h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/enter", headers, strings.NewReader(body))
	}
	if resp := enter(`{"detail":"跟腱不适","verdict":"reduced"}`); resp.Code != http.StatusCreated {
		t.Fatalf("enter status=%d", resp.Code)
	}

	// better → 记履历，needs_verdict 不变（量回抬在 TS 维护，端点只透传态）
	resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/checkin", headers, strings.NewReader(`{"answer":"better"}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("better status=%d body=%s", resp.Code, resp.Body.String())
	}
	var state injuryStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &state); err != nil || state.Injury.LastCheckinAnswer == nil || *state.Injury.LastCheckinAnswer != "better" {
		t.Fatalf("better state=%+v err=%v", state.Injury, err)
	}
	// 当天幂等：再答 worse 不生效（每天一答）
	before := len(store.checkins)
	resp = h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/checkin", headers, strings.NewReader(`{"answer":"worse"}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("same-day re-answer status=%d", resp.Code)
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &state); err != nil || state.Injury.NeedsVerdict {
		t.Fatalf("same-day re-answer must be idempotent: %+v", state.Injury)
	}
	if len(store.checkins) != before {
		t.Fatalf("same-day re-answer must not append history")
	}

	// 次日 worse → needs_verdict=true（mode 不变）
	store.today = "2026-09-17"
	resp = h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/checkin", headers, strings.NewReader(`{"answer":"worse"}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("worse status=%d body=%s", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &state); err != nil || !state.Injury.NeedsVerdict || state.Injury.Mode != storage.PlanInjuryModeReduced {
		t.Fatalf("worse state=%+v err=%v", state.Injury, err)
	}
	// 重新自判：再 enter reduced 清 needs_verdict
	if resp := enter(`{"detail":"复诊后减量","verdict":"reduced"}`); resp.Code != http.StatusCreated {
		t.Fatalf("re-enter status=%d", resp.Code)
	}

	// recovered → closed:true，active 行删除（留履历）
	resp = h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/checkin", headers, strings.NewReader(`{"answer":"recovered"}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("recovered status=%d body=%s", resp.Code, resp.Body.String())
	}
	var closed injuryClosedResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &closed); err != nil || !closed.Closed {
		t.Fatalf("recovered closed=%+v err=%v", closed, err)
	}
	if row, _ := store.GetInjuryState(nil, injUserID); row != nil {
		t.Fatalf("recovered 后仍有 active 行")
	}
	// 无 active 行再答 → 404
	if resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/checkin", headers, strings.NewReader(`{"answer":"better"}`)); resp.Code != http.StatusNotFound {
		t.Fatalf("checkin without state status=%d", resp.Code)
	}
	// 履历留痕：enter×2 + better + worse + recovered = 5
	if len(store.checkins) != 5 {
		t.Fatalf("checkins=%d want 5", len(store.checkins))
	}
}

func TestInjuryDoctorResolution(t *testing.T) {
	h, _ := newInjuryHarness(t)
	headers := h.bearer(t, injUserID)
	// 非待定行上答医生 → 409
	if resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/enter", headers, strings.NewReader(`{"detail":"胫骨应力反应","verdict":"rest"}`)); resp.Code != http.StatusCreated {
		t.Fatalf("enter rest status=%d", resp.Code)
	}
	if resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/doctor", headers, strings.NewReader(`{"verdict":"reduced"}`)); resp.Code != http.StatusConflict {
		t.Fatalf("doctor on rest status=%d", resp.Code)
	}
	// 待定 → reduced
	if resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/enter", headers, strings.NewReader(`{"detail":"胫骨应力反应，先看医生","verdict":"undecided"}`)); resp.Code != http.StatusCreated {
		t.Fatalf("enter undecided status=%d", resp.Code)
	}
	resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/doctor", headers, strings.NewReader(`{"verdict":"reduced"}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("doctor reduced status=%d body=%s", resp.Code, resp.Body.String())
	}
	var state injuryStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &state); err != nil || state.Injury.Mode != storage.PlanInjuryModeReduced {
		t.Fatalf("doctor reduced state=%+v err=%v", state.Injury, err)
	}
	// 医生 continue：关行
	if resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/enter", headers, strings.NewReader(`{"detail":"复诊","verdict":"undecided"}`)); resp.Code != http.StatusCreated {
		t.Fatalf("re-enter undecided status=%d", resp.Code)
	}
	resp = h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/doctor", headers, strings.NewReader(`{"verdict":"continue"}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("doctor continue status=%d", resp.Code)
	}
	var closed injuryClosedResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &closed); err != nil || !closed.Closed {
		t.Fatalf("doctor continue closed=%+v err=%v", closed, err)
	}
}

func TestInjuryInternalChannelAndGating(t *testing.T) {
	h, store := newInjuryHarness(t)
	userHeaders := h.bearer(t, injUserID)

	// 用户进 reduced
	if resp := h.doBody(http.MethodPost, "/api/users/"+injUserID+"/plan-injury/enter", userHeaders, strings.NewReader(`{"detail":"髂胫束","verdict":"reduced"}`)); resp.Code != http.StatusCreated {
		t.Fatalf("enter status=%d", resp.Code)
	}
	// 内部读态（夜检）
	resp := h.do(http.MethodGet, "/api/internal/users/"+injUserID+"/plan-injury", internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("internal state status=%d body=%s", resp.Code, resp.Body.String())
	}
	// 内部回写锚（worker）：reduced 接受，值落行
	resp = h.doBody(http.MethodPost, "/api/internal/users/"+injUserID+"/plan-injury/maintenance", internalHdr(), strings.NewReader(`{"km":39}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("internal maintenance status=%d body=%s", resp.Code, resp.Body.String())
	}
	var state injuryStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &state); err != nil || state.Injury.MaintenanceKm == nil || *state.Injury.MaintenanceKm != 39 {
		t.Fatalf("maintenance state=%+v err=%v", state.Injury, err)
	}
	// rest 行不接受锚写入（409）
	store.active.Mode = storage.PlanInjuryModeRest
	if resp := h.doBody(http.MethodPost, "/api/internal/users/"+injUserID+"/plan-injury/maintenance", internalHdr(), strings.NewReader(`{"km":39}`)); resp.Code != http.StatusConflict {
		t.Fatalf("maintenance on rest status=%d", resp.Code)
	}

	// tier 门：user 不能打内部端点 / internal 不能打用户端点 / 跨用户 403
	if resp := h.do(http.MethodGet, "/api/internal/users/"+injUserID+"/plan-injury", userHeaders); resp.Code != http.StatusForbidden {
		t.Fatalf("user on internal route status=%d", resp.Code)
	}
	if resp := h.do(http.MethodGet, "/api/users/"+injUserID+"/plan-injury", internalHdr()); resp.Code != http.StatusForbidden {
		t.Fatalf("internal on user route status=%d", resp.Code)
	}
	other := h.bearer(t, "d31c2cbc-c3f5-4a10-92d0-73fa3281a999")
	if resp := h.do(http.MethodGet, "/api/users/"+injUserID+"/plan-injury", other); resp.Code != http.StatusForbidden {
		t.Fatalf("cross-user state status=%d", resp.Code)
	}
	// 无 active 行：内部 404
	if err := store.CloseInjuryState(nil, injUserID); err != nil {
		t.Fatal(err)
	}
	if resp := h.do(http.MethodGet, "/api/internal/users/"+injUserID+"/plan-injury", internalHdr()); resp.Code != http.StatusNotFound {
		t.Fatalf("internal state without row status=%d", resp.Code)
	}
}

func TestInjuryValidation(t *testing.T) {
	h, _ := newInjuryHarness(t)
	headers := h.bearer(t, injUserID)
	cases := []struct {
		name string
		path string
		body string
		want int
	}{
		{"bad verdict", "/plan-injury/enter", `{"detail":"x","verdict":"power_through"}`, http.StatusBadRequest},
		{"empty detail", "/plan-injury/enter", `{"detail":"","verdict":"reduced"}`, http.StatusBadRequest},
		{"bad master plan", "/plan-injury/enter", `{"detail":"x","verdict":"reduced","master_plan_id":"nope"}`, http.StatusBadRequest},
		{"bad answer", "/plan-injury/checkin", `{"answer":"magically_healed"}`, http.StatusBadRequest},
		{"bad doctor verdict", "/plan-injury/doctor", `{"verdict":"undecided"}`, http.StatusBadRequest},
		{"bad km", "/api/internal/users/" + injUserID + "/plan-injury/maintenance", `{"km":0}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := tc.path
			if !strings.HasPrefix(path, "/api/") {
				path = "/api/users/" + injUserID + tc.path
			}
			headersFor := headers
			if strings.HasPrefix(path, "/api/internal/") {
				headersFor = internalHdr()
			}
			resp := h.doBody(http.MethodPost, path, headersFor, strings.NewReader(tc.body))
			if resp.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", resp.Code, tc.want, resp.Body.String())
			}
		})
	}
}
