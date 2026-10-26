// backfill_test.go drives the real Backfill against a real MySQL (gated on
// STRIDE_WORKER_TEST_MYSQL_DSN, same convention as the storage suite) with a
// MemStore bucket: stock migration, resumability, and the end-to-end
// reconciliation verdict after the drain.
package tsblob

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

// openBackfillTestStore opens the gated MySQL with the watch schema and a
// MemStore blob backend, and resets the four watch tables to empty first: the
// audit's verdicts are whole-world, so a shared scratch database (or a
// previous crashed run's rows) must not bleed into them. This DSN points at a
// throwaway test database — never a live one.
func openBackfillTestStore(t *testing.T) (*storage.Store, *tsstore.MemStore) {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run tsblob integration tests")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	// Only the watch schema: the backfill/audit never touch the jobs tables,
	// and running that migration twice in one database trips a legacy index
	// rename guard unrelated to this suite.
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	resetWatchTables(t, dsn)
	ts := tsstore.NewMemStore()
	st.SetTSBlobStore(ts)
	return st, ts
}

// resetWatchTables truncates the tables the backfill/audit world reads.
func resetWatchTables(t *testing.T, dsn string) {
	t.Helper()
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open reset handle: %v", err)
	}
	defer db.Close()
	for _, table := range []string{"timeseries", "activity_watch_zones", "laps", "activities"} {
		if _, err := db.Exec("TRUNCATE TABLE " + table); err != nil {
			t.Fatalf("truncate %s: %v (the tsblob test DSN must point at a throwaway database)", table, err)
		}
	}
}

func backfillActivity(uid, label string) *storage.Activity {
	return &storage.Activity{
		UserID: uid, LabelID: label, SportType: 100,
		Date:     time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
		Provider: "coros", SyncedAt: time.Now().UTC(),
	}
}

// seedPendingActivity writes an activity whose rows exist but whose pointer is
// NULL — the pre-Phase-1 stock shape — by upserting with the blob backend
// detached.
func seedPendingActivity(t *testing.T, st *storage.Store, uid, label string, points int) {
	t.Helper()
	st.SetTSBlobStore(nil)
	rows := make([]storage.TimeseriesPoint, points)
	for i := range rows {
		sec := int64(i + 1)
		rows[i].Timestamp = &sec
	}
	if err := st.UpsertActivity(context.Background(), backfillActivity(uid, label), nil, rows, nil); err != nil {
		t.Fatalf("seed %s: %v", label, err)
	}
}

func TestBackfill_MigratesStockAndResumes(t *testing.T) {
	st, ts := openBackfillTestStore(t)
	ctx := context.Background()
	uid := fmt.Sprintf("c1d2e3f4-%04d-4000-8000-%012d", time.Now().UnixNano()%10000, time.Now().UnixNano()%1_000_000_000_000)

	// Pending stock: rows exist, pointers NULL (the pre-Phase-1 shape). A
	// single user keeps the world simple; the worker pool still fans the pages.
	seedPendingActivity(t, st, uid, "p1", 3)
	seedPendingActivity(t, st, uid, "p2", 0) // zero-point activity: empty blob
	seedPendingActivity(t, st, uid, "p3", 2)
	st.SetTSBlobStore(ts)

	b := NewBackfill(st)
	b.PageSize = 2 // force multiple keyset pages
	report, err := b.Run(ctx)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !report.OK || report.Migrated != 3 || report.Failed != 0 || report.Points != 5 {
		t.Fatalf("first run = %+v, want migrated=3 points=5 green", report)
	}

	// Resumability: a second run finds nothing left.
	again, err := b.Run(ctx)
	if err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	if again.Migrated != 0 || !again.OK {
		t.Fatalf("second run = %+v, want migrated=0 (resume skips stamped rows)", again)
	}

	// The stamped world reconciles green end to end.
	auditor := NewAuditor(st, ts)
	audit, err := auditor.Run(ctx)
	if err != nil {
		t.Fatalf("audit: %v", err)
	}
	if !audit.OK {
		t.Fatalf("post-backfill audit not green: %+v", audit)
	}

	// A stock row edited out-of-band (rows changed, pointer stale) must fail
	// the sample — the audit is the safety net the soak window watches.
	sec := int64(99)
	st.SetTSBlobStore(nil)
	if err := st.UpsertActivity(ctx, backfillActivity(uid, "p1"), nil, []storage.TimeseriesPoint{{Timestamp: &sec}}, nil); err != nil {
		t.Fatalf("out-of-band edit: %v", err)
	}
	st.SetTSBlobStore(ts)
	drifted, err := auditor.Run(ctx)
	if err != nil {
		t.Fatalf("drift audit: %v", err)
	}
	if drifted.OK || drifted.PointSumOK {
		t.Fatalf("drifted rows passed the audit: %+v", drifted)
	}
}
