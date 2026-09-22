// Integration tests for the watch_schedule table (requires a real MySQL via
// STRIDE_WORKER_TEST_MYSQL_DSN; skipped otherwise — same gate as the rest of
// the storage package).
package storage

import (
	"context"
	"testing"
	"time"
)

func TestWatchSchedule_UpsertIdempotent(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}

	uid := "d31c2cbc-c3f5-4a10-92d0-73fa3281a001"
	spec1 := `{"schema":"run-workout/v1","name":"Easy 8K","date":"2026-09-22","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"distance_m","value":8000},"target":{"kind":"pace_s_km","low":320,"high":300}}]}]}`
	spec2 := `{"schema":"run-workout/v1","name":"Easy 8K (edited)","date":"2026-09-22","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"distance_m","value":8000},"target":{"kind":"pace_s_km","low":315,"high":295}}]}]}`
	fetched := time.Now().UTC().Truncate(time.Millisecond)

	rows := []WatchSchedule{{
		Provider:   "coros",
		EntityID:   "sch-1",
		Date:       "2026-09-22",
		Kind:       "run",
		Name:       "Easy 8K",
		SpecJSON:   spec1,
		FetchedAt:  fetched,
		WindowFrom: "2026-09-15",
		WindowTo:   "2026-12-21",
	}}
	if err := st.UpsertWatchSchedules(ctx, uid, rows); err != nil {
		t.Fatalf("upsert 1: %v", err)
	}

	// Re-pull the same (provider, entity_id) with new content: one updated row,
	// not a duplicate.
	rows[0].Name = "Easy 8K (edited)"
	rows[0].SpecJSON = spec2
	if err := st.UpsertWatchSchedules(ctx, uid, rows); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}

	var count int64
	if err := st.db.WithContext(ctx).Model(&WatchSchedule{}).
		Where("user_id = ? AND provider = ? AND entity_id = ?", uid, "coros", "sch-1").
		Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("rows for (coros, sch-1) = %d, want 1 (idempotent upsert)", count)
	}

	var got WatchSchedule
	if err := st.db.WithContext(ctx).
		Where("user_id = ? AND provider = ? AND entity_id = ?", uid, "coros", "sch-1").
		First(&got).Error; err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got.Name != "Easy 8K (edited)" || got.SpecJSON != spec2 {
		t.Errorf("row = name %q / spec %q, want the re-pulled content", got.Name, got.SpecJSON)
	}
}
