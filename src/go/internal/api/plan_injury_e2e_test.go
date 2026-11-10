package api

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/zhaochy1990/stride/internal/storage"
)

// #858 PR-D 伤病生命周期 e2e（真实 store + 真实 HTTP 端点，docker mysql 门控）：
// coach_agent_api/scripts/test_injury.ts 起一次性 mysql 后以 STRIDE_INJURY_E2E_DSN
// 调用本测试。覆盖：enter 四选一 → checkin 序列（better→当天幂等→recovered）→
// doctor 转换 → 内部通道（读态/回写锚）→ 履历审计；证据 JSON 写
// STRIDE_INJURY_E2E_OUT 供脚本断言输出。
//
// Env:
//   - STRIDE_INJURY_E2E_DSN — go-sql-driver DSN（一次性 docker mysql）
//   - STRIDE_INJURY_E2E_OUT — 结果 JSON 路径（可选；脚本断言证据）
func TestInjuryLifecycleE2E(t *testing.T) {
	dsn := os.Getenv("STRIDE_INJURY_E2E_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_INJURY_E2E_DSN to run the injury lifecycle e2e test")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = store.Close() }()
	ctx := context.Background()
	if err := store.AutoMigratePlanInjury(ctx); err != nil {
		t.Fatalf("migrate plan injury: %v", err)
	}

	// 用户端点需要真 JWT：独立 RSA key + verifier（同 weeklyPlanHarness 装配）。
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	svc := NewService(Config{
		Auth:            NewAuthenticator(testToken, verifier),
		PlanInjuryStore: store,
	})
	// 每轮独立 user UUID（一次性 docker 库，不做行清理——同 adjustment e2e 约定）。
	user := jwtE2EUser(t, key)
	masterPlan := "11111111-2222-3333-4444-555555555777"

	do := func(method, path string, headers map[string]string, body string) *httptest.ResponseRecorder {
		var req *http.Request
		if body != "" {
			req = httptest.NewRequest(method, path, strings.NewReader(body))
		} else {
			req = httptest.NewRequest(method, path, nil)
		}
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		rec := httptest.NewRecorder()
		svc.Router().ServeHTTP(rec, req)
		return rec
	}
	userHdr := map[string]string{"Authorization": "Bearer " + user}
	internal := internalHdr()
	steps := []map[string]any{}

	// ① 进入减量（detail 文本 + verdict=reduced）。
	resp := do(http.MethodPost, "/api/users/"+jwtE2ESub+"/plan-injury/enter", userHdr, `{"detail":"左膝髌骨酸痛，下坡加重","verdict":"reduced","master_plan_id":"`+masterPlan+`"}`)
	steps = append(steps, map[string]any{"step": "enter_reduced", "code": resp.Code})
	if resp.Code != http.StatusCreated {
		t.Fatalf("enter reduced status=%d body=%s", resp.Code, resp.Body.String())
	}

	// ② checkin 序列：better（锚不动——重估单一真源在 TS）→ 同日 worse 幂等。
	resp = do(http.MethodPost, "/api/users/"+jwtE2ESub+"/plan-injury/checkin", userHdr, `{"answer":"better"}`)
	steps = append(steps, map[string]any{"step": "checkin_better", "code": resp.Code})
	var afterBetter injuryStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &afterBetter); err != nil || afterBetter.Injury.NeedsVerdict {
		t.Fatalf("better decode=%v state=%+v", err, afterBetter.Injury)
	}
	resp = do(http.MethodPost, "/api/users/"+jwtE2ESub+"/plan-injury/checkin", userHdr, `{"answer":"worse"}`)
	steps = append(steps, map[string]any{"step": "checkin_same_day_idempotent", "code": resp.Code})
	var sameDay injuryStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &sameDay); err != nil || sameDay.Injury.NeedsVerdict {
		t.Fatalf("same-day re-answer must stay idempotent: %+v", sameDay.Injury)
	}

	// ③ 内部通道：夜检读态 + worker 回写锚（reduced 接受，值落行）。
	resp = do(http.MethodGet, "/api/internal/users/"+jwtE2ESub+"/plan-injury", internal, "")
	steps = append(steps, map[string]any{"step": "internal_read", "code": resp.Code})
	if resp.Code != http.StatusOK {
		t.Fatalf("internal read status=%d body=%s", resp.Code, resp.Body.String())
	}
	resp = do(http.MethodPost, "/api/internal/users/"+jwtE2ESub+"/plan-injury/maintenance", internal, `{"km":39}`)
	steps = append(steps, map[string]any{"step": "internal_maintenance_write", "code": resp.Code})
	var anchored injuryStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &anchored); err != nil || anchored.Injury.MaintenanceKm == nil || *anchored.Injury.MaintenanceKm != 39 {
		t.Fatalf("anchor write state=%+v", anchored.Injury)
	}

	// ④ 重新自判：re-enter reduced（清 needs_verdict、重基线锚）→ recovered 关行。
	resp = do(http.MethodPost, "/api/users/"+jwtE2ESub+"/plan-injury/enter", userHdr, `{"detail":"复诊：继续减量","verdict":"reduced","master_plan_id":"`+masterPlan+`"}`)
	steps = append(steps, map[string]any{"step": "reenter_reduced", "code": resp.Code})
	resp = do(http.MethodPost, "/api/users/"+jwtE2ESub+"/plan-injury/checkin", userHdr, `{"answer":"recovered"}`)
	steps = append(steps, map[string]any{"step": "checkin_recovered", "code": resp.Code})
	var closed injuryClosedResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &closed); err != nil || !closed.Closed {
		t.Fatalf("recovered closed=%+v", closed)
	}

	// ⑤ 待定流：undecided → doctor reduced（转模式）。
	resp = do(http.MethodPost, "/api/users/"+jwtE2ESub+"/plan-injury/enter", userHdr, `{"detail":"跟腱又不适，先看医生","verdict":"undecided","master_plan_id":"`+masterPlan+`"}`)
	steps = append(steps, map[string]any{"step": "enter_undecided", "code": resp.Code})
	resp = do(http.MethodPost, "/api/users/"+jwtE2ESub+"/plan-injury/doctor", userHdr, `{"verdict":"reduced"}`)
	steps = append(steps, map[string]any{"step": "doctor_reduced", "code": resp.Code})
	var doctorState injuryStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &doctorState); err != nil || doctorState.Injury.Mode != storage.PlanInjuryModeReduced {
		t.Fatalf("doctor reduced state=%+v", doctorState.Injury)
	}

	// ⑥ 履历审计（时间倒序）：verdict/doctor/daily 三类齐全。
	history, err := store.ListInjuryCheckins(ctx, jwtE2ESub, 50)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	kinds := map[string]int{}
	for _, row := range history {
		kinds[row.Kind]++
	}
	if kinds["verdict"] < 3 || kinds["doctor"] < 1 || kinds["daily"] < 2 {
		t.Fatalf("history kinds=%v (want verdict>=3, doctor>=1, daily>=2)", kinds)
	}

	// ⑦ 证据输出（脚本断言）。
	if out := os.Getenv("STRIDE_INJURY_E2E_OUT"); out != "" {
		document := map[string]any{
			"user_id":     jwtE2ESub,
			"checked_at":  time.Now().UTC().Format(time.RFC3339),
			"steps":       steps,
			"history":     kinds,
			"final_mode":  doctorState.Injury.Mode,
			"anchor_test": 39,
		}
		encoded, err := json.MarshalIndent(document, "", " ")
		if err != nil {
			t.Fatalf("encode evidence: %v", err)
		}
		if err := os.WriteFile(out, encoded, 0o644); err != nil {
			t.Fatalf("write evidence: %v", err)
		}
	}
}

// jwtE2ESub 是 e2e 用户的固定 sub（UUID——storage canonicalUserID 会校验）。
const jwtE2ESub = "e2e0e2e0-0000-4000-8000-000000000001"

// jwtE2EUser signs a self-audience JWT for the e2e user with the given key.
func jwtE2EUser(t *testing.T, key *rsa.PrivateKey) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": jwtE2ESub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	})
	signed, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}
