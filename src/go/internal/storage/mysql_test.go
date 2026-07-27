package storage

import (
	"context"
	"os"
	"testing"
	"time"

	gomysql "github.com/go-sql-driver/mysql"

	"github.com/zhaochy1990/stride/internal/job"
)

// openTestStore connects to a real MySQL if STRIDE_WORKER_TEST_MYSQL_DSN is set,
// otherwise the test is skipped. Run locally against docker-compose MySQL.
func openTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run storage integration tests")
	}
	st, err := Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.AutoMigrate(context.Background()); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestJobStore_CreateGetUpdate(t *testing.T) {
	st := openTestStore(t)
	jobs := st.Jobs()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)

	j := &job.Job{
		ID: "it-" + now.Format("150405.000000"), PartitionKey: "u-it", Type: "greet",
		Status: job.StatusQueued, InputJSON: `{"x":1}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := jobs.Create(ctx, j); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := jobs.Get(ctx, j.PartitionKey, j.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.CreatedAt.Equal(now) {
		t.Fatalf("created_at not preserved as UTC: got %v want %v", got.CreatedAt, now)
	}
	if got.Status != job.StatusQueued {
		t.Fatalf("status = %s", got.Status)
	}

	got.Status = job.StatusDone
	got.ProgressPct = 100
	if err := jobs.Update(ctx, got); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, _ := jobs.Get(ctx, j.PartitionKey, j.ID)
	if again.Status != job.StatusDone || again.ProgressPct != 100 {
		t.Fatalf("update not persisted: %+v", again)
	}
}

func TestJobStore_GetNotFound(t *testing.T) {
	st := openTestStore(t)
	_, err := st.Jobs().Get(context.Background(), "nope", "nope")
	if _, ok := err.(*job.ErrNotFound); !ok {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestForceUTCDSN(t *testing.T) {
	out, err := forceUTCDSN("user:pass@tcp(h:3306)/db")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Re-parse to assert semantics: the driver omits loc=UTC from the string
	// because UTC is its default, so check the parsed config instead.
	cfg, err := gomysql.ParseDSN(out)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if !cfg.ParseTime {
		t.Fatalf("parseTime not set: %q", out)
	}
	if cfg.Loc != time.UTC {
		t.Fatalf("loc not UTC: %v", cfg.Loc)
	}
	if cfg.Params["time_zone"] != "'+00:00'" {
		t.Fatalf("session time_zone not forced: %q", cfg.Params["time_zone"])
	}
}
