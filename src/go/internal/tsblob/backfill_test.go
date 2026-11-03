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
// NULL — the pre-Phase-1 stock shape. Since Phase 3 froze the row table the
// only way rows appear is a direct insert, so both the activity row and its
// points go in over a raw handle (an upsert would stamp or refuse).
func seedPendingActivity(t *testing.T, st *storage.Store, uid, label string, points int) {
	t.Helper()
	db := rawTestHandle(t)
	defer db.Close()
	a := backfillActivity(uid, label)
	if _, err := db.Exec("INSERT INTO activities (user_id, label_id, sport_type, date, provider, synced_at) VALUES (?, ?, ?, ?, ?, ?)",
		a.UserID, a.LabelID, a.SportType, a.Date, a.Provider, a.SyncedAt); err != nil {
		t.Fatalf("seed activity %s: %v", label, err)
	}
	for i := 0; i < points; i++ {
		sec := int64(i + 1)
		if _, err := db.Exec("INSERT INTO timeseries (user_id, label_id, timestamp) VALUES (?, ?, ?)", uid, label, sec); err != nil {
			t.Fatalf("seed row %s#%d: %v", label, i, err)
		}
	}
}

// rawTestHandle opens a throwaway database/sql connection for direct stock
// seeding — the same DSN openBackfillTestStore gates on.
func rawTestHandle(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run tsblob integration tests")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open raw handle: %v", err)
	}
	return db
}

func TestBackfill_MigratesStockAndResumes(t *testing.T) {
	st, ts := openBackfillTestStore(t)
	ctx := context.Background()
	uid := fmt.Sprintf("c1d2e3f4-%04d-4000-8000-%012d", time.Now().UnixNano()%10000, time.Now().UnixNano()%1_000_000_000_000)

	// Pending stock: rows exist, pointers NULL (the pre-Phase-1 shape). A
	// single user keeps the world simple; the worker pool still fans the pages.
	seedPendingActivity(t, st, uid, "p1", 3)
	// p2 has no rows (zero-point stock): since devops#787 paging is rowful-only
	// — there is nothing to migrate, so it stays legitimately unstamped.
	seedPendingActivity(t, st, uid, "p2", 0)
	seedPendingActivity(t, st, uid, "p3", 2)
	st.SetTSBlobStore(ts)

	b := NewBackfill(st)
	b.PageSize = 2 // force multiple keyset pages
	report, err := b.Run(ctx)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !report.OK || report.Migrated != 2 || report.Failed != 0 || report.Points != 5 {
		t.Fatalf("first run = %+v, want migrated=2 (p1+p3; rowless p2 skipped) points=5 green", report)
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

	// A stock row edited out-of-band (rows grew, pointer stale) must fail the
	// one-sided point sum — the audit is the safety net the soak window
	// watches. The edit is a direct insert: since Phase 3 the upsert can no
	// longer change rows.
	db := rawTestHandle(t)
	if _, err := db.Exec("INSERT INTO timeseries (user_id, label_id, timestamp) VALUES (?, 'p1', 99)", uid); err != nil {
		t.Fatalf("out-of-band edit: %v", err)
	}
	db.Close()
	drifted, err := auditor.Run(ctx)
	if err != nil {
		t.Fatalf("drift audit: %v", err)
	}
	if drifted.OK || drifted.PointSumOK {
		t.Fatalf("drifted rows passed the audit: %+v", drifted)
	}
}
