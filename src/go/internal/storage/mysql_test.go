package storage

import (
	"context"
	"errors"
	"fmt"
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
		ID: "it-" + now.Format("150405.000000"), UserID: "u-it", Type: "greet",
		Status: job.StatusQueued, InputJSON: `{"x":1}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := jobs.Create(ctx, j); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := jobs.Get(ctx, j.ID)
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
	again, _ := jobs.Get(ctx, j.ID)
	if again.Status != job.StatusDone || again.ProgressPct != 100 {
		t.Fatalf("update not persisted: %+v", again)
	}
}

func TestJobStore_GetNotFound(t *testing.T) {
	st := openTestStore(t)
	_, err := st.Jobs().Get(context.Background(), "nope")
	if _, ok := err.(*job.ErrNotFound); !ok {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestPipelineStore_ListByUser(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	runs := st.Pipelines()
	// Unique per-run suffix so repeated runs against a shared DB don't collide.
	tag := time.Now().UTC().Format("150405.000000")
	uid := "list-user-" + tag
	older := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	newer := older.Add(time.Minute)

	mk := func(id, user string, at time.Time) *job.PipelineRun {
		return &job.PipelineRun{
			RunID: id, UserID: user, CreatedBy: user, Name: "onboarding",
			Status: job.StatusRunning, CreatedAt: at, UpdatedAt: at,
		}
	}
	// Two runs for uid (different created_at), one for a different user.
	if err := runs.Create(ctx, mk("r-old-"+tag, uid, older)); err != nil {
		t.Fatalf("create old: %v", err)
	}
	if err := runs.Create(ctx, mk("r-new-"+tag, uid, newer)); err != nil {
		t.Fatalf("create new: %v", err)
	}
	if err := runs.Create(ctx, mk("r-other-"+tag, "other-"+tag, newer)); err != nil {
		t.Fatalf("create other: %v", err)
	}

	got, err := st.PipelineRunsByUser(ctx, uid)
	if err != nil {
		t.Fatalf("list by user: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d runs, want 2 (must exclude the other user)", len(got))
	}
	// Newest first.
	if got[0].RunID != "r-new-"+tag || got[1].RunID != "r-old-"+tag {
		t.Fatalf("order = [%s, %s], want newest first", got[0].RunID, got[1].RunID)
	}
	for _, r := range got {
		if r.UserID != uid {
			t.Fatalf("leaked run for user %q", r.UserID)
		}
	}

	// An empty user id must never scan the table.
	empty, err := st.PipelineRunsByUser(ctx, "")
	if err != nil {
		t.Fatalf("list empty: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("empty user id returned %d runs, want 0", len(empty))
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

func TestIsDeterministicWriteError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"dup entry 1062", &gomysql.MySQLError{Number: 1062, Message: "Duplicate entry"}, true},
		{"wrapped dup entry 1062", fmt.Errorf("storage: insert children: %w",
			&gomysql.MySQLError{Number: 1062, Message: "Duplicate entry"}), true},
		{"bad null 1048", &gomysql.MySQLError{Number: 1048}, true},
		{"data too long 1406", &gomysql.MySQLError{Number: 1406}, true},
		{"deadlock 1213 stays retryable", &gomysql.MySQLError{Number: 1213}, false},
		{"lock wait 1205 stays retryable", &gomysql.MySQLError{Number: 1205}, false},
		{"foreign key 1452 stays retryable", &gomysql.MySQLError{Number: 1452}, false},
		{"non-mysql error", errors.New("connection reset"), false},
		{"nil", nil, false},
	}
	for _, c := range cases {
		if got := IsDeterministicWriteError(c.err); got != c.want {
			t.Errorf("%s: IsDeterministicWriteError = %v, want %v", c.name, got, c.want)
		}
	}
}
