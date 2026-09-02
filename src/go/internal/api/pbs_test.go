package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/zhaochy1990/stride/internal/storage"
)

// fakePBStore returns canned personal_bests rows out of canonical order (HM/FM
// before 5K, mirroring storage's distance-alphabetical ORDER).
type fakePBStore struct{ rows []storage.PersonalBest }

func (f *fakePBStore) PersonalBests(_ context.Context, _ string) ([]storage.PersonalBest, error) {
	return f.rows, nil
}

func TestGetPBs_CanonicalOrderAndFilter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// Inject an internal-tier caller (authorizeUser passes any user path).
	r.Use(func(c *gin.Context) { c.Set(callerContextKey, Caller{Tier: TierInternal}) })

	store := &fakePBStore{rows: []storage.PersonalBest{
		{Distance: "FM", EntryJSON: `{"distance":"FM","race_type":"full","pb_time_sec":14000,"achieved_at":"2025-10-01","label_id":"l-fm","source":"activity","name":null,"history":[{"date":"2025-10-01","best_so_far_sec":14000,"label_id":"l-fm","source":"activity"}]}`},
		{Distance: "5K", EntryJSON: `{"distance":"5K","race_type":"5K","pb_time_sec":1140,"achieved_at":"2025-11-02","label_id":"l-5k","source":"segment","name":"Morning 5K","segment_start_s":120,"segment_end_s":1260,"history":[{"date":"2025-11-02","best_so_far_sec":1140,"label_id":"l-5k","source":"segment","segment_start_s":120,"segment_end_s":1260}]}`},
		{Distance: "1K", EntryJSON: `{"distance":"1K","race_type":"1K","pb_time_sec":200,"achieved_at":"2025-09-01","label_id":"l-1k","source":"segment","name":null,"segment_start_s":0,"segment_end_s":200,"history":[{"date":"2025-09-01","best_so_far_sec":200,"label_id":"l-1k","source":"segment","segment_start_s":0,"segment_end_s":200}]}`},
	}}
	newPbsRoutes(store, nil).register(r.Group(""))

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/u1/pbs", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", w.Code, w.Body.String())
	}

	var resp pbsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.UserID != "u1" {
		t.Errorf("user_id = %q, want u1", resp.UserID)
	}
	if resp.ComputedAt == "" {
		t.Error("computed_at is empty")
	}

	// Only 1K/5K/FM present, ordered canonically (5K comes from distance-order,
	// must NOT be emitted before 1K just because storage listed FM/5K first).
	if len(resp.PBs) != 3 {
		t.Fatalf("pbs len = %d, want 3 (%+v)", len(resp.PBs), resp.PBs)
	}
	want := []string{"1K", "5K", "FM"}
	for i, d := range want {
		if resp.PBs[i].Distance != d {
			t.Errorf("pbs[%d].distance = %q, want %q (full %+v)", i, resp.PBs[i].Distance, d, resp.PBs)
		}
	}

	// segment offsets survive the entry_json round-trip for the 5K row.
	if resp.PBs[1].SegmentStartS == nil || *resp.PBs[1].SegmentStartS != 120 {
		t.Errorf("5K segment_start_s = %v, want 120", resp.PBs[1].SegmentStartS)
	}
	if len(resp.PBs[1].History) != 1 {
		t.Errorf("5K history len = %d, want 1", len(resp.PBs[1].History))
	}
}
