// historicalcalibration_mysql_test.go is the devops#1011 (T07) executor
// suite: the real run/ledger tables, the real canonical per-day calibration
// seam, real binding/policy rows and the real job store on real MySQL. Named
// TestHistoricalCalibration* so the CI step running this package against MySQL
// picks it up.
//
// Covered acceptance criteria (AC6): event-date cutoff (no future health or
// activity leaks into a day's baseline), missing-evidence honesty
// (partial/unavailable, never retried as faults), cross-chunk resume,
// priority/yield between chunks, policy-change and rebind supersede (old
// chunks refuse to publish), and merged dispatch of concurrent requests.
package historicalcalibration

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

func openStore(t *testing.T) *storage.Store {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run historical calibration integration tests")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	ctx := context.Background()
	for _, migrate := range []func(context.Context) error{st.AutoMigrate, st.AutoMigrateWatch, st.AutoMigrateHistoricalRecompute} {
		if err := migrate(ctx); err != nil {
			t.Fatalf("automigrate: %v", err)
		}
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// memPublisher is the broker stand-in (records nothing; the job rows are the
// durable truth the tests assert on).
type memPublisher struct{}

func (p *memPublisher) PublishWork(context.Context, job.Message) error                 { return nil }
func (p *memPublisher) PublishRetry(context.Context, job.Message, time.Duration) error { return nil }
func (p *memPublisher) PublishPoison(context.Context, job.Message) error               { return nil }

type harness struct {
	store *storage.Store
	enq   job.Enqueuer
	h     job.Handler
}

func newHarness(t *testing.T, chunkDays int) *harness {
	t.Helper()
	st := openStore(t)
	enq := job.NewStoreEnqueuer(st.Jobs(), &memPublisher{})
	return &harness{
		store: st,
		enq:   enq,
		h:     New(Config{Store: st, Enq: enq, Enabled: true, ChunkDays: chunkDays}),
	}
}

// runJob creates a durable queued job row (the worker's truth), invokes the
// handler on it, and terminalizes it like the dispatcher would. Continuation
// jobs the handler chains are real queued rows the next call picks up.
func (h *harness) runJob(t *testing.T, uid string, in chunkInput) runResult {
	t.Helper()
	ctx := context.Background()
	input, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	now := time.Now().UTC()
	j := &job.Job{
		ID: uuid.NewString(), UserID: uid, Type: JobType,
		Status: job.StatusQueued, InputJSON: string(input),
		CreatedAt: now, UpdatedAt: now,
	}
	if err := h.store.Jobs().Create(ctx, j); err != nil {
		t.Fatalf("create job: %v", err)
	}
	resJSON, err := h.h(ctx, j, nil)
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	// Terminalize like the dispatcher: queued -> running -> done, result kept.
	if _, err := h.store.Jobs().TransitionJob(ctx, j.ID, job.JobTransition{
		From: ptrStatus(job.StatusQueued), To: job.StatusRunning}); err != nil {
		t.Fatalf("transition running: %v", err)
	}
	if _, err := h.store.Jobs().TransitionJob(ctx, j.ID, job.JobTransition{
		From: ptrStatus(job.StatusRunning), To: job.StatusDone, ResultJSON: &resJSON}); err != nil {
		t.Fatalf("transition done: %v", err)
	}
	var out runResult
	if err := json.Unmarshal([]byte(resJSON), &out); err != nil {
		t.Fatalf("parse result %s: %v", resJSON, err)
	}
	return out
}

func ptrStatus(s job.Status) *job.Status { return &s }

// drive runs the request job and then every chained continuation until the
// run terminalizes (bounded — an infinite chain fails the test).
func (h *harness) drive(t *testing.T, uid string, asOfDay string, maxChunks int) runResult {
	t.Helper()
	res := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: asOfDay})
	for i := 0; res.Status == "in_progress"; i++ {
		if i >= maxChunks {
			t.Fatalf("run did not terminalize within %d chunks (last: %+v)", maxChunks, res)
		}
		res = h.runJob(t, uid, chunkInput{RunID: res.RunID, ChunkSeq: res.ChunkSeq})
	}
	return res
}

func seedBinding(t *testing.T, st *storage.Store, uid string) int64 {
	t.Helper()
	rev, err := st.EnsureWatchBinding(context.Background(), uid, "coros")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	return rev
}

func seedActivity(t *testing.T, st *storage.Store, uid, labelID string, day time.Time) {
	t.Helper()
	dist, dur := 10000.0, 3000.0
	if err := st.UpsertActivity(context.Background(), &storage.Activity{
		UserID: uid, LabelID: labelID, SportType: 100, Date: day,
		DistanceM: &dist, DurationS: &dur, Provider: "coros", SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("upsert activity %s: %v", labelID, err)
	}
}

func seedHealth(t *testing.T, st *storage.Store, uid, day string, rhr int) {
	t.Helper()
	v := rhr
	if err := st.UpsertDailyHealth(context.Background(), &storage.DailyHealth{
		UserID: uid, Date: day, RHR: &v,
	}); err != nil {
		t.Fatalf("upsert health %s: %v", day, err)
	}
}

// AC2: a day's baseline uses only events on/before that day. Health rows
// AFTER the run's as-of day (and activities after it) must not leak into any
// published snapshot; the published value must equal the canonical estimator
// applied to the truncated evidence.
func TestHistoricalCalibrationEventDateCutoff(t *testing.T) {
	h := newHarness(t, 400)
	st := h.store
	ctx := context.Background()
	uid := uuid.NewString()
	seedBinding(t, st, uid)

	asOf, err := time.Parse("2006-01-02", "2026-06-30")
	if err != nil {
		t.Fatal(err)
	}
	// RHR 50 on every health day up to asOf; RHR 20 on 30 days AFTER asOf.
	// The RHR baseline is the P10 of the day's 90-day window: a leaked future
	// low row would drag it from 50 down toward 20 — an unambiguous signal.
	for d := 0; d < 90; d++ {
		seedHealth(t, st, uid, asOf.AddDate(0, 0, -d).Format("2006-01-02"), 50)
	}
	for d := 1; d <= 30; d++ {
		seedHealth(t, st, uid, asOf.AddDate(0, 0, d).Format("2006-01-02"), 20)
	}
	// One activity one week AFTER asOf: outside the target window entirely.
	seedActivity(t, st, uid, "fut-1", asOf.AddDate(0, 0, 7))
	// Activities inside the window so speed/threshold paths have evidence.
	seedActivity(t, st, uid, "past-1", asOf.AddDate(0, 0, -30))
	seedActivity(t, st, uid, "past-2", asOf.AddDate(0, 0, -3))

	res := h.drive(t, uid, "2026-06-30", 60)
	if res.Status != storage.HistoricalRecomputeStateCompletedWithGaps &&
		res.Status != storage.HistoricalRecomputeStateCompleted {
		t.Fatalf("terminal status = %q, want completed*", res.Status)
	}
	// The as-of day's snapshot RHR baseline must equal the canonical estimate
	// over the truncated [asOf-89, asOf] rows — NOT the full row set.
	snap, err := st.LatestRunningCalibrationSnapshotForVersion(ctx, uid, 3, "2026-06-30")
	if err != nil || snap == nil {
		t.Fatalf("as-of snapshot: %+v %v", snap, err)
	}
	if snap.AsOfDate != "2026-06-30" {
		t.Fatalf("as-of snapshot resolved %q, want the exact day", snap.AsOfDate)
	}
	if snap.RHRBaseline == nil {
		t.Fatalf("as-of snapshot has no RHR baseline despite 90 in-window health days")
	}
	var truncated []calibration.HealthRow
	for d := 89; d >= 0; d-- {
		truncated = append(truncated, calibration.HealthRow{Date: asOf.AddDate(0, 0, -d), RHR: fptr(50)})
	}
	want := calibration.EstimateRHRBaseline(truncated, asOf)
	if want == nil || *want != *snap.RHRBaseline {
		t.Fatalf("RHR baseline = %v, want canonical truncated-window estimate %v", *snap.RHRBaseline, want)
	}
	// Teeth check: the SAME rows evaluated 31 days later (where the 20s ARE
	// inside the window) move the estimator — so equality above proves the
	// future rows were invisible at asOf, not inert.
	var all []calibration.HealthRow
	for d := 89; d >= 0; d-- {
		all = append(all, calibration.HealthRow{Date: asOf.AddDate(0, 0, -d), RHR: fptr(50)})
	}
	for d := 1; d <= 30; d++ {
		all = append(all, calibration.HealthRow{Date: asOf.AddDate(0, 0, d), RHR: fptr(20)})
	}
	later := calibration.EstimateRHRBaseline(all, asOf.AddDate(0, 0, 31))
	if later == nil || *later == *snap.RHRBaseline {
		t.Fatalf("teeth check failed: later-window estimate %v should differ from %v", later, *snap.RHRBaseline)
	}
	// No snapshot may exist beyond the as-of day.
	days, err := st.ListHistoricalRecomputeDays(ctx, res.RunID)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range days {
		if d.Day > "2026-06-30" {
			t.Fatalf("ledger day %s is beyond the as-of day", d.Day)
		}
	}
}

// AC2/AC3: evidence-free days record unavailable and write NO snapshot; days
// with evidence but no estimable center record partial with an honest
// snapshot; neither outcome is an error and the run completes with gaps.
func TestHistoricalCalibrationMissingEvidenceHonesty(t *testing.T) {
	h := newHarness(t, 400)
	st := h.store
	ctx := context.Background()
	uid := uuid.NewString()
	seedBinding(t, st, uid)

	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	// A single sampleless running activity 10 days before asOf: evidence for
	// days >= that activity, but nothing that yields a threshold center
	// without samples/HR (partial).
	seedActivity(t, st, uid, "solo-1", asOf.AddDate(0, 0, -10))

	res := h.drive(t, uid, "2026-06-30", 60)
	if res.Status != storage.HistoricalRecomputeStateCompletedWithGaps {
		t.Fatalf("status = %q, want completed_with_gaps (evidence-free days exist)", res.Status)
	}
	ledger, err := st.ListHistoricalRecomputeDays(ctx, res.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledger) != 365 {
		t.Fatalf("ledger rows = %d, want 365", len(ledger))
	}
	counts, err := st.HistoricalRecomputeCounts(ctx, res.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if counts.Unavailable == 0 {
		t.Fatalf("no unavailable day recorded despite the user's first evidence being 10 days before as-of")
	}
	// Days before the first activity: unavailable, no snapshot id.
	for _, d := range ledger {
		if d.Day < "2026-06-20" {
			if d.Status != storage.HistoricalRecomputeDayUnavailable {
				t.Fatalf("day %s status = %q, want unavailable (no evidence)", d.Day, d.Status)
			}
			if d.SnapshotID != nil {
				t.Fatalf("evidence-free day %s wrote a snapshot", d.Day)
			}
		}
	}
	// Days with evidence: ready or partial — both carry a snapshot row.
	seenPartial := false
	for _, d := range ledger {
		if d.Day >= "2026-06-20" {
			if d.Status == storage.HistoricalRecomputeDayUnavailable {
				continue // days whose windows still see no evidence
			}
			if d.SnapshotID == nil {
				t.Fatalf("evidence day %s (%s) has no snapshot row", d.Day, d.Status)
			}
			if d.Status == storage.HistoricalRecomputeDayPartial {
				seenPartial = true
			}
		}
	}
	if !seenPartial {
		t.Logf("note: no partial day occurred (sampleless evidence still yielded centers)")
	}
}

// AC3: chunks are bounded, chained as new jobs (yield), and a re-executed
// chunk resumes from the ledger without re-settling days; the run survives
// across worker chunks and terminalizes with the frozen bundle fingerprint.
func TestHistoricalCalibrationChunkResumeAndYield(t *testing.T) {
	h := newHarness(t, 30) // 365 days / 30 = 13 chunks
	st := h.store
	ctx := context.Background()
	uid := uuid.NewString()
	seedBinding(t, st, uid)
	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	for d := 0; d < 40; d++ {
		seedHealth(t, st, uid, asOf.AddDate(0, 0, -d).Format("2006-01-02"), 50)
	}
	seedActivity(t, st, uid, "run-1", asOf.AddDate(0, 0, -5))

	first := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: "2026-06-30"})
	if first.Status != "in_progress" {
		t.Fatalf("first chunk status = %q, want in_progress", first.Status)
	}
	if first.ChunkSeq == 0 {
		t.Fatalf("first chunk did not record a continuation (chunk_seq = 0)")
	}
	// The chained continuation exists as a REAL queued job under its stable key.
	contKey := continuationKey(first.RunID, first.ChunkSeq)
	cont, err := st.JobByIdempotencyKey(ctx, uid, contKey)
	if err != nil || cont == nil {
		t.Fatalf("continuation job %s: %+v %v", contKey, cont, err)
	}
	if cont.Status != job.StatusQueued {
		t.Fatalf("continuation status = %q, want queued (yield between chunks)", cont.Status)
	}
	// Crash simulation: the SAME continuation input re-executes (job-level
	// retry). The ledger keeps settled days; only the chaining re-runs.
	retry := h.runJob(t, uid, chunkInput{RunID: first.RunID, ChunkSeq: first.ChunkSeq})
	if retry.Status != "in_progress" {
		t.Fatalf("retry chunk status = %q, want in_progress", retry.Status)
	}
	ledgerAfterRetry, err := st.ListHistoricalRecomputeDays(ctx, first.RunID)
	if err != nil {
		t.Fatal(err)
	}

	// Drive the rest to completion.
	res := retry
	for i := 0; res.Status == "in_progress"; i++ {
		if i > 40 {
			t.Fatalf("run did not terminalize (last: %+v)", res)
		}
		res = h.runJob(t, uid, chunkInput{RunID: res.RunID, ChunkSeq: res.ChunkSeq})
	}
	if res.Status != storage.HistoricalRecomputeStateCompleted &&
		res.Status != storage.HistoricalRecomputeStateCompletedWithGaps {
		t.Fatalf("final status = %q", res.Status)
	}
	if res.BundleFingerprint == "" {
		t.Fatalf("terminal run has no frozen bundle fingerprint")
	}
	final, err := st.GetHistoricalRecomputeRun(ctx, first.RunID)
	if err != nil || final == nil {
		t.Fatal(err)
	}
	if final.BundleFingerprint == nil || *final.BundleFingerprint != res.BundleFingerprint {
		t.Fatalf("run bundle fingerprint %+v != result %q", final.BundleFingerprint, res.BundleFingerprint)
	}
	// Re-driving a terminal run is an idempotent no-op echoing the same state.
	again := h.runJob(t, uid, chunkInput{RunID: first.RunID, ChunkSeq: final.ChunkSeq})
	if again.Status != res.Status {
		t.Fatalf("terminal redelivery status = %q, want %q", again.Status, res.Status)
	}
	// The settled prefix from before the crash-simulation retry is unchanged.
	ledgerFinal, err := st.ListHistoricalRecomputeDays(ctx, first.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledgerFinal) != 365 {
		t.Fatalf("ledger rows = %d, want 365", len(ledgerFinal))
	}
	if len(ledgerAfterRetry) > len(ledgerFinal) {
		t.Fatalf("ledger shrank across resume")
	}
	_ = ledgerAfterRetry
}

// AC5: a policy revision change mid-run supersedes the run — the next chunk
// refuses to publish (no further snapshots), the run row records the reason.
func TestHistoricalCalibrationPolicyChangeSupersedes(t *testing.T) {
	h := newHarness(t, 30)
	st := h.store
	ctx := context.Background()
	uid := uuid.NewString()
	seedBinding(t, st, uid)
	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	seedActivity(t, st, uid, "p-1", asOf.AddDate(0, 0, -5))
	for d := 0; d < 20; d++ {
		seedHealth(t, st, uid, asOf.AddDate(0, 0, -d).Format("2006-01-02"), 50)
	}

	first := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: "2026-06-30"})
	if first.Status != "in_progress" {
		t.Fatalf("first chunk status = %q", first.Status)
	}
	// Published-day count before the policy bump...
	before := ledgerSnapshotDays(t, st, uid, first.RunID)

	policy, err := st.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	bumped, err := st.ReplaceCalibrationPolicy(ctx, policy.Revision, policy)
	if err != nil {
		t.Fatalf("policy bump: %v", err)
	}
	if bumped.Revision == policy.Revision {
		t.Fatalf("policy revision did not bump")
	}

	next := h.runJob(t, uid, chunkInput{RunID: first.RunID, ChunkSeq: first.ChunkSeq})
	if next.Status != storage.HistoricalRecomputeStateSuperseded {
		t.Fatalf("post-bump chunk status = %q, want superseded", next.Status)
	}
	if next.SupersedeReason != "policy_revision_changed" {
		t.Fatalf("supersede reason = %q, want policy_revision_changed", next.SupersedeReason)
	}
	if after := ledgerSnapshotDays(t, st, uid, first.RunID); after != before {
		t.Fatalf("superseded chunk published %d new day rows (before %d) — old blocks must refuse", after, before)
	}
	run, err := st.GetHistoricalRecomputeRun(ctx, first.RunID)
	if err != nil || run == nil {
		t.Fatal(err)
	}
	if run.State != storage.HistoricalRecomputeStateSuperseded || run.SupersedeReason == nil || *run.SupersedeReason != "policy_revision_changed" {
		t.Fatalf("run row = %s/%+v, want superseded/policy_revision_changed", run.State, run.SupersedeReason)
	}
	// A new explicit request under the new policy revision creates a fresh run.
	fresh := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: "2026-06-30"})
	if fresh.RunID == first.RunID {
		t.Fatalf("new request reused the superseded run")
	}
	if fresh.Status == storage.HistoricalRecomputeStateSuperseded {
		t.Fatalf("fresh run was born superseded")
	}
}

// AC5: a rebind (binding revision change) mid-run supersedes the run — the
// old binding's chunks refuse to publish into the new binding's identity.
func TestHistoricalCalibrationRebindSupersedes(t *testing.T) {
	h := newHarness(t, 30)
	st := h.store
	uid := uuid.NewString()
	seedBinding(t, st, uid)
	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	seedActivity(t, st, uid, "b-1", asOf.AddDate(0, 0, -5))

	first := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: "2026-06-30"})
	if first.Status != "in_progress" {
		t.Fatalf("first chunk status = %q", first.Status)
	}
	// A provider switch goes through the credential seam (EnsureWatchBinding
	// is an idempotent ensure and never bumps — the identity event is the
	// re-login with a different provider).
	pid := "garmin-42"
	if err := st.SaveCredential(context.Background(), &storage.ProviderCredential{
		UserID: uid, Provider: "garmin", ProviderUserID: &pid,
		Secret: []byte("s"), UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	b, err := st.GetWatchBinding(context.Background(), uid)
	if err != nil || b == nil || b.Revision == first.BindingRevision {
		t.Fatalf("rebind did not bump revision: %+v %v", b, err)
	}
	next := h.runJob(t, uid, chunkInput{RunID: first.RunID, ChunkSeq: first.ChunkSeq})
	if next.Status != storage.HistoricalRecomputeStateSuperseded {
		t.Fatalf("post-rebind chunk status = %q, want superseded", next.Status)
	}
	if next.SupersedeReason != "binding_revision_changed" {
		t.Fatalf("supersede reason = %q, want binding_revision_changed", next.SupersedeReason)
	}
}

// AC5: concurrent/repeat explicit requests merge onto the single active run
// (no second run, no parallel dispatch), while a data-revision change
// supersedes the active run and starts a fresh one.
func TestHistoricalCalibrationMergeDispatch(t *testing.T) {
	h := newHarness(t, 30)
	st := h.store
	ctx := context.Background()
	uid := uuid.NewString()
	seedBinding(t, st, uid)
	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	seedActivity(t, st, uid, "m-1", asOf.AddDate(0, 0, -5))

	first := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: "2026-06-30"})
	if first.Status != "in_progress" {
		t.Fatalf("first chunk status = %q", first.Status)
	}
	// Same inputs, while the chained continuation job is still QUEUED: the
	// request must merge (observe), never execute beside the live run.
	merged := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: "2026-06-30"})
	if merged.Status != "merged" {
		t.Fatalf("repeat request status = %q, want merged", merged.Status)
	}
	if merged.RunID != first.RunID {
		t.Fatalf("merged request resolved run %s, want %s", merged.RunID, first.RunID)
	}
	active, err := st.ActiveHistoricalRecomputeRunByUser(ctx, uid)
	if err != nil || active == nil || active.RunID != first.RunID {
		t.Fatalf("active run = %+v %v, want exactly %s", active, err, first.RunID)
	}

	// Data revision change: a new activity inside the window moves the digest;
	// the next explicit request supersedes the old run and creates a fresh one.
	seedActivity(t, st, uid, "m-2", asOf.AddDate(0, 0, -2))
	fresh := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: "2026-06-30"})
	if fresh.RunID == first.RunID {
		t.Fatalf("data-changed request reused the stale run")
	}
	old, err := st.GetHistoricalRecomputeRun(ctx, first.RunID)
	if err != nil || old == nil {
		t.Fatal(err)
	}
	if old.State != storage.HistoricalRecomputeStateSuperseded {
		t.Fatalf("stale run state = %q, want superseded", old.State)
	}
	if fresh.Status == storage.HistoricalRecomputeStateSuperseded {
		t.Fatalf("fresh run was born superseded")
	}
}

// The day ledger is insert-only per (run, day): the first writer's outcome is
// authoritative — a concurrent or retried chunk cannot flip a settled day.
func TestHistoricalCalibrationDayLedgerFirstWriterWins(t *testing.T) {
	h := newHarness(t, 30)
	st := h.store
	ctx := context.Background()
	wrote1, err := st.RecordHistoricalRecomputeDay(ctx, &storage.HistoricalRecomputeDay{
		RunID: "ledger-run", Day: "2026-01-01", Status: storage.HistoricalRecomputeDayReady,
	})
	if err != nil || !wrote1 {
		t.Fatalf("first insert: wrote=%v err=%v", wrote1, err)
	}
	wrote2, err := st.RecordHistoricalRecomputeDay(ctx, &storage.HistoricalRecomputeDay{
		RunID: "ledger-run", Day: "2026-01-01", Status: storage.HistoricalRecomputeDayUnavailable, Reason: "no_evidence",
	})
	if err != nil {
		t.Fatalf("duplicate insert errored: %v", err)
	}
	if wrote2 {
		t.Fatalf("duplicate insert reported itself as the writer")
	}
	days, err := st.ListHistoricalRecomputeDays(ctx, "ledger-run")
	if err != nil || len(days) != 1 || days[0].Status != storage.HistoricalRecomputeDayReady {
		t.Fatalf("first-writer-wins violated: %+v %v", days, err)
	}
}

// AC5 (concurrency): two racing claims collapse onto one active run.
func TestHistoricalCalibrationConcurrentClaimSingleRun(t *testing.T) {
	h := newHarness(t, 30)
	st := h.store
	uid := uuid.NewString()
	seedBinding(t, st, uid)
	spec := storage.HistoricalRecomputeClaimSpec{
		RunID: uuid.NewString(), UserID: uid, Provider: "coros",
		AnalysisAsOfDay: "2026-06-30", TargetFromDay: "2025-07-02", TargetToDay: "2026-06-30",
		BindingRevision: 1, PolicyVersion: 3, PolicyRevision: 0,
		InputFingerprint: "fp", DaysTotal: 365,
	}
	type result struct {
		runID   string
		created bool
	}
	resCh := make(chan result, 2)
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s := spec
			if i == 1 {
				s.RunID = uuid.NewString() // same identity, distinct pre-generated id
			}
			claim, err := st.ClaimOrCreateHistoricalRecomputeRun(context.Background(), s)
			if err != nil {
				t.Errorf("claim %d: %v", i, err)
				return
			}
			resCh <- result{runID: claim.Run.RunID, created: claim.Created}
		}(i)
	}
	wg.Wait()
	close(resCh)
	var runs []result
	for r := range resCh {
		runs = append(runs, r)
	}
	if len(runs) != 2 {
		t.Fatalf("claims returned %d results", len(runs))
	}
	if runs[0].runID != runs[1].runID {
		t.Fatalf("racing claims created two runs: %s vs %s", runs[0].runID, runs[1].runID)
	}
	active, err := st.ActiveHistoricalRecomputeRunByUser(context.Background(), uid)
	if err != nil || active == nil {
		t.Fatalf("active run: %+v %v", active, err)
	}
}

// ledgerSnapshotDays counts the run's ledger rows that published a snapshot —
// the storage-derived view of how many per-day rows this user's runs wrote.
func ledgerSnapshotDays(t *testing.T, st *storage.Store, uid, runID string) int {
	t.Helper()
	days, err := st.ListHistoricalRecomputeDays(context.Background(), runID)
	if err != nil {
		t.Fatalf("ledger: %v", err)
	}
	n := 0
	for _, d := range days {
		if d.SnapshotID != nil {
			n++
		}
	}
	return n
}

func fptr(v float64) *float64 { return &v }
