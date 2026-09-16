package storage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

// cleanupJobs removes every job for the user so runs stay isolated.
func cleanupJobs(t *testing.T, store *Store, userID string) {
	t.Helper()
	if err := store.db.Exec("DELETE FROM jobs WHERE user_id = ?", userID).Error; err != nil {
		t.Fatalf("cleanup jobs: %v", err)
	}
}

func TestTransitionJobCompareAndSet(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	userID := "transition-user"
	cleanupJobs(t, store, userID)
	defer cleanupJobs(t, store, userID)

	now := time.Now().UTC().Truncate(time.Millisecond)
	jobID := "transition-job-1"
	if err := store.Jobs().Create(ctx, &job.Job{
		ID: jobID, UserID: userID, Type: "generate_weekly_plan", Status: job.StatusQueued,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Claim: queued -> running guarded by From.
	attempts := 1
	stage := "planning"
	pct := 10
	updated, err := store.TransitionJob(ctx, jobID, job.JobTransition{
		From: ptr(job.StatusQueued), To: job.StatusRunning,
		Attempts: &attempts, Stage: &stage, ProgressPct: &pct, HeartbeatAt: &now,
	})
	if err != nil {
		t.Fatalf("claim transition: %v", err)
	}
	if updated.Status != job.StatusRunning || updated.Attempts != 1 || updated.Stage != "planning" || updated.ProgressPct != 10 {
		t.Fatalf("claimed = %+v", updated)
	}

	// A second claim with the same From guard fails the CAS.
	if _, err := store.TransitionJob(ctx, jobID, job.JobTransition{From: ptr(job.StatusQueued), To: job.StatusRunning}); !errors.Is(err, job.ErrStateChanged) {
		t.Fatalf("re-claim err = %v, want ErrStateChanged", err)
	}

	// Done stamps completed_at.
	done := job.JobTransition{From: ptr(job.StatusRunning), To: job.StatusDone}
	finished, err := store.TransitionJob(ctx, jobID, done)
	if err != nil {
		t.Fatalf("done transition: %v", err)
	}
	if finished.Status != job.StatusDone || finished.CompletedAt == nil {
		t.Fatalf("finished = %+v", finished)
	}

	// Unknown id is ErrNotFound.
	if _, err := store.TransitionJob(ctx, "missing", job.JobTransition{To: job.StatusRunning}); !job.IsNotFound(err) {
		t.Fatalf("missing err = %v, want ErrNotFound", err)
	}
}

func TestListAllJobsFiltersStandalone(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	userID := "list-jobs-user"
	cleanupJobs(t, store, userID)
	defer cleanupJobs(t, store, userID)

	now := time.Now().UTC().Truncate(time.Millisecond)
	seed := func(id, typ, status string, runID string, at time.Time) {
		if err := store.Jobs().Create(ctx, &job.Job{
			ID: id, UserID: userID, Type: typ, Status: job.Status(status), PipelineRunID: runID,
			CreatedAt: at, UpdatedAt: at,
		}); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	seed("standalone-weekly", "generate_weekly_plan", "running", "", now)
	seed("standalone-master", "generate_master_plan", "queued", "", now.Add(-time.Hour))
	seed("step-job", "watch_sync", "done", "run-1", now.Add(-2*time.Hour))

	jobs, total, err := store.ListAllJobs(ctx, job.PipelineListOptions{UserID: userID, Limit: 10})
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if total != 2 || len(jobs) != 2 {
		t.Fatalf("total=%d len=%d, want 2 standalone jobs for %s", total, len(jobs), userID)
	}
	if jobs[0].ID != "standalone-weekly" { // newest first
		t.Fatalf("jobs[0] = %s, want standalone-weekly", jobs[0].ID)
	}

	byType, _, err := store.ListAllJobs(ctx, job.PipelineListOptions{UserID: userID, PipelineName: "generate_master_plan", Limit: 10})
	if err != nil {
		t.Fatalf("list filtered: %v", err)
	}
	if len(byType) != 1 || byType[0].ID != "standalone-master" {
		t.Fatalf("filtered = %+v", byType)
	}
}

func TestFailStaleRunningJobsBackstop(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	userID := "stale-jobs-user"
	cleanupJobs(t, store, userID)
	defer cleanupJobs(t, store, userID)

	now := time.Now().UTC().Truncate(time.Millisecond)
	hb := func(at time.Time) *time.Time { return &at }
	seed := func(id string, status string, hbAt *time.Time) {
		if err := store.Jobs().Create(ctx, &job.Job{
			ID: id, UserID: userID, Type: "generate_weekly_plan", Status: job.Status(status), HeartbeatAt: hbAt,
			CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	seed("stale", "running", hb(now.Add(-10*time.Minute)))
	seed("fresh", "running", hb(now.Add(-1*time.Minute)))
	seed("no-heartbeat", "running", nil)
	seed("done", "done", hb(now.Add(-30*time.Minute)))

	count, err := store.FailStaleRunningJobs(ctx, now.Add(-2*time.Minute), now, "stale_running")
	if err != nil {
		t.Fatalf("fail stale: %v", err)
	}
	// The shared DB may hold other users' stale rows, so only the test's own
	// jobs are asserted for state; count must at least cover them.
	if count < 1 {
		t.Fatalf("count = %d, want >= 1", count)
	}
	j, err := store.Jobs().Get(ctx, "stale")
	if err != nil || j.Status != job.StatusFailed || j.ErrorCode != "stale_running" {
		t.Fatalf("stale after = %+v err=%v", j, err)
	}
	// A running row with no heartbeat never opted into the heartbeat contract, so
	// the plan-job reconcile must leave it alone (ADR 0033).
	for _, id := range []string{"no-heartbeat", "fresh"} {
		j, err := store.Jobs().Get(ctx, id)
		if err != nil {
			t.Fatalf("get %s: %v", id, err)
		}
		if j.Status != job.StatusRunning {
			t.Fatalf("%s after = %+v, want still running", id, j)
		}
	}
	done, _ := store.Jobs().Get(ctx, "done")
	if done.Status != job.StatusDone {
		t.Fatalf("done after = %+v, want still done", done)
	}
}

// RenewLease / ListStaleRunning / the LeaseBefore guard together form the
// stale-running reclaim's durable half. These run against CI's MySQL.
func TestRenewLeaseAndListStaleRunning(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	userID := "lease-user"
	cleanupJobs(t, store, userID)
	defer cleanupJobs(t, store, userID)

	now := time.Now().UTC().Truncate(time.Millisecond)
	old := now.Add(-10 * time.Minute)
	hb := func(at time.Time) *time.Time { return &at }
	seed := func(id string, status job.Status, hbAt *time.Time, updated time.Time) {
		if err := store.Jobs().Create(ctx, &job.Job{
			ID: id, UserID: userID, Type: "watch_sync", Status: status, HeartbeatAt: hbAt,
			CreatedAt: updated, UpdatedAt: updated,
		}); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	seed("lease-stale", job.StatusRunning, nil, old)       // NULL heartbeat falls back to updated_at
	seed("lease-expired", job.StatusRunning, hb(old), old) // heartbeat older than the cutoff
	seed("lease-fresh", job.StatusRunning, hb(now), now)   // live worker
	seed("lease-queued", job.StatusQueued, nil, old)       // not running

	stale, err := store.Jobs().ListStaleRunning(ctx, now.Add(-5*time.Minute), 1000)
	if err != nil {
		t.Fatalf("list stale: %v", err)
	}
	found := map[string]bool{}
	for _, j := range stale {
		found[j.ID] = true
	}
	if !found["lease-stale"] || !found["lease-expired"] {
		t.Fatalf("stale set missing expired rows: %v", found)
	}
	if found["lease-fresh"] || found["lease-queued"] {
		t.Fatalf("stale set must exclude fresh/queued rows: %v", found)
	}

	// RenewLease refreshes a running job and refuses a non-running one.
	if ok, err := store.Jobs().RenewLease(ctx, "lease-stale", now); err != nil || !ok {
		t.Fatalf("renew lease = %v, %v; want true", ok, err)
	}
	if got, err := store.Jobs().Get(ctx, "lease-stale"); err != nil || got.HeartbeatAt == nil {
		t.Fatalf("lease not stamped: %+v err=%v", got, err)
	}
	if ok, err := store.Jobs().RenewLease(ctx, "lease-queued", now); err != nil || ok {
		t.Fatalf("renew on queued = %v, %v; want false", ok, err)
	}

	// The LeaseBefore guard refuses a reclaim once the lease is fresh.
	fresh := now.Add(-time.Minute)
	if _, err := store.Jobs().TransitionJob(ctx, "lease-stale", job.JobTransition{
		From: ptr(job.StatusRunning), To: job.StatusQueued, LeaseBefore: &fresh,
	}); !errors.Is(err, job.ErrStateChanged) {
		t.Fatalf("guard err = %v, want ErrStateChanged", err)
	}
}

func ptr(v job.Status) *job.Status { return &v }
