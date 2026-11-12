package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

// Adjustment pending e2e gate (#858 PR-C 下半): env-gated integration test
// driving the REAL store + the internal upsert endpoint with the payload the
// TS generate_adjustment handler produced in create_pending mode
// (coach_agent_api/scripts/test_scan.ts APPLY=1 writes it to
// STRIDE_SCAN_E2E_UPSERT and invokes this test).
//
// Coverage: pending row established with the projection payload verbatim,
// same-event refresh, stale pending superseded, dismiss closes the event
// (409 on re-upsert). Evidence JSON is written to STRIDE_SCAN_E2E_OUT.
//
// Env:
//   - STRIDE_ROLL_E2E_DSN    — go-sql-driver DSN of a scratch MySQL
//   - STRIDE_SCAN_E2E_UPSERT — JSON {user_id, master_plan_id, event_week_start, reason, question, payload}
//   - STRIDE_SCAN_E2E_OUT    — result JSON path (optional; asserted evidence)
func TestRollingE2EAdjustmentPendingRealPayload(t *testing.T) {
	dsn := os.Getenv("STRIDE_ROLL_E2E_DSN")
	upsertPath := os.Getenv("STRIDE_SCAN_E2E_UPSERT")
	if dsn == "" || upsertPath == "" {
		t.Skip("set STRIDE_ROLL_E2E_DSN + STRIDE_SCAN_E2E_UPSERT to run the adjustment pending e2e test")
	}
	raw, err := os.ReadFile(upsertPath)
	if err != nil {
		t.Fatalf("read upsert: %v", err)
	}
	var request struct {
		UserID        string `json:"user_id"`
		MasterPlanID  string `json:"master_plan_id"`
		EventWeek     string `json:"event_week_start"`
		Reason        string `json:"reason"`
		Question      string `json:"question"`
		Payload       string `json:"payload"`
		ClosedWeekOne string `json:"closed_event_week"` // 可选：预先关闭的事件周（验证 409）
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatalf("parse upsert: %v", err)
	}
	if request.UserID == "" || request.MasterPlanID == "" || request.EventWeek == "" || request.Reason == "" || request.Payload == "" {
		t.Fatalf("upsert needs user_id, master_plan_id, event_week_start, reason and payload")
	}

	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = store.Close() }()
	ctx := context.Background()
	if err := store.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatalf("migrate plan_adjustment: %v", err)
	}
	// 注意：不做行清理——调用方（TS 脚本）每轮生成独立 user UUID（一次性 docker
	// 库或显式 DSN 专用库），残留行不影响下一轮。

	svc := NewService(Config{
		Auth:                NewAuthenticator(testToken, nil),
		PlanAdjustmentStore: store,
	})
	upsert := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/internal/users/"+request.UserID+"/plan-adjustments", strings.NewReader(body))
		req.Header.Set("X-Internal-Token", testToken)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		svc.Router().ServeHTTP(rec, req)
		return rec
	}

	// 0) 先撒一个他事件的 pending——upsert 后应被 supersede（单 pending 不变量）。
	staleWeek := request.ClosedWeekOne
	if staleWeek == "" {
		staleWeek = addDaysFormatted(request.EventWeek, -7)
	}
	staleBody, _ := json.Marshal(map[string]string{
		"master_plan_id":   request.MasterPlanID,
		"event_week_start": staleWeek,
		"reason":           request.Reason,
		"question":         request.Question,
		"payload":          `{"stale":true}`,
	})
	staleResp := upsert(string(staleBody))
	if staleResp.Code != http.StatusCreated {
		t.Fatalf("stale seed status=%d body=%s", staleResp.Code, staleResp.Body.String())
	}
	var staleRow adjustmentResponse
	if err := json.Unmarshal(staleResp.Body.Bytes(), &staleRow); err != nil {
		t.Fatalf("decode stale seed: %v", err)
	}

	// 1) 夜检建行：pending 行建立 + payload 原样落库。
	body, _ := json.Marshal(map[string]string{
		"master_plan_id":   request.MasterPlanID,
		"event_week_start": request.EventWeek,
		"reason":           request.Reason,
		"question":         request.Question,
		"payload":          request.Payload,
	})
	created := upsert(string(body))
	if created.Code != http.StatusCreated {
		t.Fatalf("upsert status=%d body=%s", created.Code, created.Body.String())
	}
	var createdRow adjustmentResponse
	if err := json.Unmarshal(created.Body.Bytes(), &createdRow); err != nil {
		t.Fatalf("decode upsert: %v", err)
	}
	if createdRow.Adjustment.Status != storage.PlanAdjustmentStatusPending {
		t.Fatalf("status=%s want pending", createdRow.Adjustment.Status)
	}
	if createdRow.Adjustment.Payload == nil || *createdRow.Adjustment.Payload != request.Payload {
		t.Fatalf("payload not stored verbatim")
	}

	// 2) 幂等重投：同事件 upsert 刷新（201），仍是 pending、id 不变。
	refreshed := upsert(string(body))
	if refreshed.Code != http.StatusCreated {
		t.Fatalf("refresh status=%d body=%s", refreshed.Code, refreshed.Body.String())
	}
	var refreshedRow adjustmentResponse
	if err := json.Unmarshal(refreshed.Body.Bytes(), &refreshedRow); err != nil {
		t.Fatalf("decode refresh: %v", err)
	}
	if refreshedRow.Adjustment.ID != createdRow.Adjustment.ID {
		t.Fatalf("refresh changed id: %s -> %s", createdRow.Adjustment.ID, refreshedRow.Adjustment.ID)
	}

	// 3) 单 pending 不变量 + 旧事件 pending 已 supersede。
	pending, err := store.GetPendingAdjustment(ctx, request.UserID)
	if err != nil || pending == nil || pending.ID != createdRow.Adjustment.ID {
		t.Fatalf("pending row=%+v err=%v", pending, err)
	}
	staleAfter, err := store.GetAdjustmentByID(ctx, request.UserID, staleRow.Adjustment.ID)
	if err != nil || staleAfter == nil || staleAfter.Status != storage.PlanAdjustmentStatusSuperseded {
		t.Fatalf("stale row after upsert=%+v err=%v (want superseded)", staleAfter, err)
	}

	// 4) dismiss 关闭事件（store 层终态转换，与 HTTP dismiss 同一入口）：同事件再
	// upsert → 409（用户答过的事件永不重问）。
	if err := store.SetAdjustmentStatus(ctx, request.UserID, createdRow.Adjustment.ID, storage.PlanAdjustmentStatusDismissed); err != nil {
		t.Fatalf("dismiss via store: %v", err)
	}
	closed := upsert(string(body))
	if closed.Code != http.StatusConflict {
		t.Fatalf("closed-event upsert status=%d want 409", closed.Code)
	}

	if out := os.Getenv("STRIDE_SCAN_E2E_OUT"); out != "" {
		evidence := map[string]any{
			"adjustment_id":    createdRow.Adjustment.ID,
			"event_week_start": request.EventWeek,
			"payload_bytes":    len(request.Payload),
			"stale_superseded": staleAfter.Status,
			"closed_reupsert":  closed.Code,
		}
		encoded, _ := json.Marshal(evidence)
		if err := os.WriteFile(out, encoded, 0o644); err != nil {
			t.Fatalf("write evidence: %v", err)
		}
	}
}
