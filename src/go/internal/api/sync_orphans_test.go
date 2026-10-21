package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

type fakeSyncUserAuditor struct {
	ids []string
	err error
}

func (f *fakeSyncUserAuditor) ListOrphanSyncUsers(context.Context) ([]string, error) {
	return f.ids, f.err
}

func newOrphansHarness(t *testing.T, auditor SyncUserAuditor) *harness {
	t.Helper()
	h := newPipelineAdminHarness(t)
	h.svc.syncUserAuditor = auditor
	return h
}

func TestOrphanSyncUsers_InternalTierReturnsOrphans(t *testing.T) {
	orphan := "d6145954-a6ae-4a0a-b06d-cfd35e5d5475"
	h := newOrphansHarness(t, &fakeSyncUserAuditor{ids: []string{orphan}})

	resp := h.do(http.MethodGet, "/api/internal/sync-user-orphans", "", internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("code = %d (%s)", resp.Code, resp.Body.String())
	}
	var out orphanSyncUsersResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Count != 1 || len(out.Orphans) != 1 || out.Orphans[0] != orphan {
		t.Fatalf("response = %+v", out)
	}
}

func TestOrphanSyncUsers_EmptyIsJSONArray(t *testing.T) {
	h := newOrphansHarness(t, &fakeSyncUserAuditor{})

	resp := h.do(http.MethodGet, "/api/internal/sync-user-orphans", "", internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("code = %d (%s)", resp.Code, resp.Body.String())
	}
	if got := resp.Body.String(); got != `{"orphans":[],"count":0}` {
		t.Fatalf("body = %s, want empty array not null", got)
	}
}

func TestOrphanSyncUsers_NilAuditorAnswers503(t *testing.T) {
	h := newPipelineAdminHarness(t) // no auditor wired

	if resp := h.do(http.MethodGet, "/api/internal/sync-user-orphans", "", internalHdr()); resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil auditor code = %d, want 503 (%s)", resp.Code, resp.Body.String())
	}
}

func TestOrphanSyncUsers_StorageErrorAnswers500(t *testing.T) {
	h := newOrphansHarness(t, &fakeSyncUserAuditor{err: errors.New("boom")})

	if resp := h.do(http.MethodGet, "/api/internal/sync-user-orphans", "", internalHdr()); resp.Code != http.StatusInternalServerError {
		t.Fatalf("storage error code = %d, want 500 (%s)", resp.Code, resp.Body.String())
	}
}

func TestOrphanSyncUsers_RequiresInternalTier(t *testing.T) {
	h := newOrphansHarness(t, &fakeSyncUserAuditor{})

	if resp := h.do(http.MethodGet, "/api/internal/sync-user-orphans", "", h.bearerWithClaims(t, "u-1", testAudience, "")); resp.Code != http.StatusForbidden {
		t.Fatalf("user code = %d, want 403 (%s)", resp.Code, resp.Body.String())
	}
	admin := h.bearerWithClaims(t, "admin-1", testAdminAudience, "admin")
	if resp := h.do(http.MethodGet, "/api/internal/sync-user-orphans", "", admin); resp.Code != http.StatusForbidden {
		t.Fatalf("admin code = %d, want 403 (%s)", resp.Code, resp.Body.String())
	}
}
