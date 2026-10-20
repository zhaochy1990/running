package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

type fakeSyncUserLister struct {
	ids []string
	err error
}

func (f *fakeSyncUserLister) ListSyncableUserIDs(context.Context) ([]string, error) {
	return f.ids, f.err
}

// newSyncUsersHarness is the admin-capable harness (user/admin/internal tiers
// all exercisable, same one the internal-jobs tier tests use) plus the
// sync-users lister wired through a fake.
func newSyncUsersHarness(t *testing.T, lister SyncUserLister) *harness {
	t.Helper()
	h := newPipelineAdminHarness(t)
	h.svc.syncUserLister = lister
	return h
}

func TestSyncUsers_InternalTierReturnsListerIDs(t *testing.T) {
	h := newSyncUsersHarness(t, &fakeSyncUserLister{ids: []string{
		"5ee229a6-cdc1-4260-84d3-71ec622126c2",
		"f10bc353-01ab-4db1-af9f-d9305ea9a532",
	}})

	resp := h.do(http.MethodGet, "/api/internal/sync-users", "", internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("code = %d (%s)", resp.Code, resp.Body.String())
	}
	var out syncUsersResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// The handler passes the lister's slice through verbatim (order included —
	// the sortedness contract itself is pinned by the storage test).
	if out.Count != 2 || len(out.Users) != 2 || out.Users[0] != "5ee229a6-cdc1-4260-84d3-71ec622126c2" || out.Users[1] != "f10bc353-01ab-4db1-af9f-d9305ea9a532" {
		t.Fatalf("response = %+v", out)
	}
}

func TestSyncUsers_EmptyListIsJSONArray(t *testing.T) {
	h := newSyncUsersHarness(t, &fakeSyncUserLister{})

	resp := h.do(http.MethodGet, "/api/internal/sync-users", "", internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("code = %d (%s)", resp.Code, resp.Body.String())
	}
	if got := resp.Body.String(); got != `{"users":[],"count":0}` {
		t.Fatalf("body = %s, want empty array not null", got)
	}
}

func TestSyncUsers_NilListerAnswers503(t *testing.T) {
	h := newPipelineAdminHarness(t) // no lister wired

	if resp := h.do(http.MethodGet, "/api/internal/sync-users", "", internalHdr()); resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil lister code = %d, want 503 (%s)", resp.Code, resp.Body.String())
	}
}

func TestSyncUsers_RequiresInternalTier(t *testing.T) {
	h := newSyncUsersHarness(t, &fakeSyncUserLister{ids: []string{"f10bc353-01ab-4db1-af9f-d9305ea9a532"}})

	if resp := h.do(http.MethodGet, "/api/internal/sync-users", "", h.bearerWithClaims(t, "u-1", testAudience, "")); resp.Code != http.StatusForbidden {
		t.Fatalf("user code = %d, want 403 (%s)", resp.Code, resp.Body.String())
	}
	admin := h.bearerWithClaims(t, "admin-1", testAdminAudience, "admin")
	if resp := h.do(http.MethodGet, "/api/internal/sync-users", "", admin); resp.Code != http.StatusForbidden {
		t.Fatalf("admin code = %d, want 403 (%s)", resp.Code, resp.Body.String())
	}
}
