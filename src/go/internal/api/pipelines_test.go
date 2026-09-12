package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/zhaochy1990/stride/internal/job"
)

// newPipelineAdminHarness wires the full pipeline surface with an admin-capable
// verifier (separate admin audience + role=admin), so admin-JWT and internal
// callers can exercise the admin pipeline-status routes.
func newPipelineAdminHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&h.key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	h.svc = NewService(Config{
		Enqueuer:              h.jobs,
		Jobs:                  h.jobs,
		JobsIdem:              h.jobs,
		Pipelines:             h.runs,
		Runs:                  h.runs,
		RunsList:              h.runs,
		RunsAdminList:         h.runs,
		RunsIdem:              h.runs,
		JobUserInitiable:      map[string]bool{"hello": false, "watch_sync": true},
		PipelineUserInitiable: map[string]bool{"onboarding": true, "internal_only": false},
		Auth:                  NewAuthenticator(testToken, verifier),
	})
	return h
}

// bearerWithClaims mints an RS256 JWT with the given sub/audience/role, signing
// with the harness key. Pass testAudience + "admin" for the admin tier.
func (h *harness) bearerWithClaims(t *testing.T, sub, audience, role string) map[string]string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub": sub, "iss": testIssuer, "aud": testAudience,
		"exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	claims["aud"] = audience
	if role != "" {
		claims["role"] = role
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	s, err := tok.SignedString(h.key)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + s}
}

// seedAdminRuns plants three runs across two users with mixed statuses so list
// filters and ordering have something deterministic to assert on. Insertion
// order is oldest → newest; ListAllPipelineRuns returns newest-first.
func seedAdminRuns(h *harness) {
	now := time.Now().UTC().Truncate(time.Second)
	done := now.Add(-3 * time.Minute)
	failedAt := now.Add(-2 * time.Minute)
	running := now.Add(-1 * time.Minute)
	h.runs.seedRun(&job.PipelineRun{
		RunID: "r1", UserID: "u1", CreatedBy: "admin", Name: "onboarding",
		Status: job.StatusDone, CreatedAt: done, UpdatedAt: done,
	})
	h.runs.seedRun(&job.PipelineRun{
		RunID: "r2", UserID: "u1", CreatedBy: "admin", Name: "onboarding",
		Status: job.StatusFailed, ErrorMessage: "step calibration: boom",
		CreatedAt: failedAt, UpdatedAt: failedAt, CompletedAt: &failedAt,
	})
	h.runs.seedRun(&job.PipelineRun{
		RunID: "r3", UserID: "u2", CreatedBy: "", Name: "data_sync",
		Status: job.StatusRunning, CreatedAt: running, UpdatedAt: running,
	})
}

func decode[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("decode response: %v: %s", err, body)
	}
	return v
}

func TestListAdminPipelineRuns_AdminListsAll(t *testing.T) {
	h := newPipelineAdminHarness(t)
	seedAdminRuns(h)
	w := h.do(http.MethodGet, "/api/admin/pipeline-runs", "", h.bearerWithClaims(t, "a1", testAdminAudience, "admin"))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	resp := decode[pipelineRunsAdminResponse](t, w.Body.String())
	if resp.Total != 3 || len(resp.Runs) != 3 {
		t.Fatalf("total/runs = %d/%d, want 3/3", resp.Total, len(resp.Runs))
	}
	// Newest first.
	wantOrder := []string{"r3", "r2", "r1"}
	for i, want := range wantOrder {
		if resp.Runs[i].RunID != want {
			t.Fatalf("runs[%d].run_id = %q, want %q", i, resp.Runs[i].RunID, want)
		}
	}
	// Failed run carries its error_message.
	if resp.Runs[1].Status != "failed" || resp.Runs[1].ErrorMessage != "step calibration: boom" {
		t.Fatalf("failed run serialization wrong: %+v", resp.Runs[1])
	}
}

func TestListAdminPipelineRuns_FiltersAndPagination(t *testing.T) {
	h := newPipelineAdminHarness(t)
	seedAdminRuns(h)

	cases := []struct {
		name   string
		query  string
		wantID []string
		wantN  int64
	}{
		{"status filter", "?status=failed", []string{"r2"}, 1},
		{"user filter", "?user_id=u1", []string{"r2", "r1"}, 2},
		{"pipeline filter", "?pipeline_name=onboarding", []string{"r2", "r1"}, 2},
		{"combined filters", "?user_id=u1&pipeline_name=onboarding&status=failed", []string{"r2"}, 1},
		{"empty result", "?user_id=missing", nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := h.do(http.MethodGet, "/api/admin/pipeline-runs"+tc.query, "", h.bearerWithClaims(t, "a1", testAdminAudience, "admin"))
			if w.Code != http.StatusOK {
				t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
			}
			resp := decode[pipelineRunsAdminResponse](t, w.Body.String())
			if resp.Total != tc.wantN {
				t.Fatalf("total = %d, want %d", resp.Total, tc.wantN)
			}
			if len(resp.Runs) != len(tc.wantID) {
				t.Fatalf("runs = %d, want %d", len(resp.Runs), len(tc.wantID))
			}
			for i, want := range tc.wantID {
				if resp.Runs[i].RunID != want {
					t.Fatalf("runs[%d].run_id = %q, want %q", i, resp.Runs[i].RunID, want)
				}
			}
		})
	}

	// Pagination: page 2 of size 1 → r2, total stays 3.
	w := h.do(http.MethodGet, "/api/admin/pipeline-runs?limit=1&offset=1", "", h.bearerWithClaims(t, "a1", testAdminAudience, "admin"))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	resp := decode[pipelineRunsAdminResponse](t, w.Body.String())
	if resp.Total != 3 || len(resp.Runs) != 1 || resp.Runs[0].RunID != "r2" {
		t.Fatalf("page 2 = total %d runs %d first %q, want 3/1/r2", resp.Total, len(resp.Runs), resp.Runs[0].RunID)
	}
	if resp.Limit != 1 || resp.Offset != 1 {
		t.Fatalf("limit/offset echoed = %d/%d, want 1/1", resp.Limit, resp.Offset)
	}
}

func TestGetAdminPipelineRun_AdminReadsAnyRun(t *testing.T) {
	h := newPipelineAdminHarness(t)
	seedAdminRuns(h)

	w := h.do(http.MethodGet, "/api/admin/pipeline-runs/r2", "", h.bearerWithClaims(t, "a1", testAdminAudience, "admin"))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200: %s", w.Code, w.Body.String())
	}
	run := decode[runStateResponse](t, w.Body.String())
	if run.RunID != "r2" || run.Status != "failed" || run.ErrorMessage != "step calibration: boom" {
		t.Fatalf("detail wrong: %+v", run)
	}

	// A run owned by another user is still readable by an admin.
	w = h.do(http.MethodGet, "/api/admin/pipeline-runs/r3", "", h.bearerWithClaims(t, "a1", testAdminAudience, "admin"))
	if w.Code != http.StatusOK {
		t.Fatalf("admin reading other user's run: code = %d, want 200: %s", w.Code, w.Body.String())
	}
}

func TestAdminPipelineRoutes_InternalTokenAllowed(t *testing.T) {
	h := newPipelineAdminHarness(t)
	seedAdminRuns(h)

	w := h.do(http.MethodGet, "/api/admin/pipeline-runs", "", internalHdr())
	if w.Code != http.StatusOK {
		t.Fatalf("internal list code = %d, want 200: %s", w.Code, w.Body.String())
	}
	if resp := decode[pipelineRunsAdminResponse](t, w.Body.String()); resp.Total != 3 {
		t.Fatalf("internal list total = %d, want 3", resp.Total)
	}

	w = h.do(http.MethodGet, "/api/admin/pipeline-runs/r2", "", internalHdr())
	if w.Code != http.StatusOK {
		t.Fatalf("internal detail code = %d, want 200: %s", w.Code, w.Body.String())
	}
}

func TestAdminPipelineRoutes_UserDenied(t *testing.T) {
	h := newPipelineAdminHarness(t)
	seedAdminRuns(h)
	userHdr := h.bearerWithClaims(t, "u1", testAudience, "")

	for _, path := range []string{"/api/admin/pipeline-runs", "/api/admin/pipeline-runs/r2"} {
		w := h.do(http.MethodGet, path, "", userHdr)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s as user: code = %d, want 403: %s", path, w.Code, w.Body.String())
		}
	}
}

func TestAdminPipelineRoutes_Unauthorized(t *testing.T) {
	h := newPipelineAdminHarness(t)

	w := h.do(http.MethodGet, "/api/admin/pipeline-runs", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no credential: code = %d, want 401: %s", w.Code, w.Body.String())
	}

	// Admin audience without role=admin is rejected by the verifier (401).
	w = h.do(http.MethodGet, "/api/admin/pipeline-runs", "", h.bearerWithClaims(t, "a1", testAdminAudience, ""))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("admin audience without role: code = %d, want 401: %s", w.Code, w.Body.String())
	}
}

func TestGetAdminPipelineRun_NotFound(t *testing.T) {
	h := newPipelineAdminHarness(t)
	w := h.do(http.MethodGet, "/api/admin/pipeline-runs/missing", "", h.bearerWithClaims(t, "a1", testAdminAudience, "admin"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404: %s", w.Code, w.Body.String())
	}
}
