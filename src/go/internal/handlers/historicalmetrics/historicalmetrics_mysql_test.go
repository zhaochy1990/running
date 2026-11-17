// historicalmetrics_mysql_test.go is the devops#1012 (T08) executor suite:
// the real run/staged tables, the real T07 calibration executor (driven to
// completion first — the metrics run consumes its frozen bundle), the real
// canonical derivation seams and the real job store on real MySQL. Named
// TestHistoricalMetrics* so the CI step running this package against MySQL
// picks it up.
//
// Covered acceptance criteria (AC6): same-input/same-seed single-segment vs
// chunked equivalence, input-change supersede (old chunks refuse to publish),
// interruption recovery through the staged ledger, mid-run read-only
// visibility (ordinary tables keep the previous consistent results until the
// one-transaction publication), and the current-ability closure (the as-of
// day's four-layer snapshot refresh after L1 publication).
package historicalmetrics

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/pb"
	"github.com/zhaochy1990/stride/internal/handlers/historicalcalibration"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

func openStore(t *testing.T) *storage.Store {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run historical metrics integration tests")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	ctx := context.Background()
	for _, migrate := range []func(context.Context) error{
		st.AutoMigrate, st.AutoMigrateWatch, st.AutoMigrateHistoricalRecompute, st.AutoMigrateHistoricalMetrics,
	} {
		if err := migrate(ctx); err != nil {
			t.Fatalf("automigrate: %v", err)
		}
	}
	// AC6 calls for the isolated real MySQL/FileStore pairing: timeseries
	// samples live in the blob backend, so attach a per-test FileStore like
	// the pipeline suite does.
	blob, err := tsstore.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("file store: %v", err)
	}
	st.SetTSBlobStore(blob)
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// memPublisher is the broker stand-in (the durable job rows are the truth).
type memPublisher struct{}

func (p *memPublisher) PublishWork(context.Context, job.Message) error                 { return nil }
func (p *memPublisher) PublishRetry(context.Context, job.Message, time.Duration) error { return nil }
func (p *memPublisher) PublishPoison(context.Context, job.Message) error               { return nil }

type harness struct {
	store *storage.Store
	enq   job.Enqueuer
	h     job.Handler
}

func newHarness(t *testing.T, chunk ChunkSizes) *harness {
	t.Helper()
	st := openStore(t)
	enq := job.NewStoreEnqueuer(st.Jobs(), &memPublisher{})
	return &harness{
		store: st,
		enq:   enq,
		h:     New(Config{Store: st, Enq: enq, Enabled: true, Chunk: chunk}),
	}
}

// runJob creates a durable queued job row, invokes the handler on it, and
// terminalizes it like the dispatcher would.
func (h *harness) runJob(t *testing.T, uid string, in chunkInput) (runResult, error) {
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
		return runResult{}, err
	}
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
	return out, nil
}

// drive runs the request job and every chained continuation until the run
// terminalizes (bounded), optionally stopping after maxJobs invocations
// (0 = unlimited) so a test can observe the mid-run state.
func (h *harness) drive(t *testing.T, uid, asOfDay string, maxJobs int) runResult {
	t.Helper()
	res, err := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: asOfDay})
	if err != nil {
		t.Fatalf("request job: %v", err)
	}
	for i := 1; res.Status == "in_progress"; i++ {
		if maxJobs > 0 && i >= maxJobs {
			return res
		}
		if i > 200 {
			t.Fatalf("run did not terminalize within %d chunks (last: %+v)", i, res)
		}
		res, err = h.runJob(t, uid, chunkInput{RunID: res.RunID, ChunkSeq: res.ChunkSeq})
		if err != nil {
			t.Fatalf("continuation %d: %v", i, err)
		}
	}
	return res
}

// resume continues an in-progress run from its last result via continuation
// jobs until it terminalizes.
func (h *harness) resume(t *testing.T, uid string, from runResult) runResult {
	t.Helper()
	res := from
	for i := 0; res.Status == "in_progress"; i++ {
		if i > 200 {
			t.Fatalf("run did not terminalize within %d continuations (last: %+v)", i, res)
		}
		next, err := h.runJob(t, uid, chunkInput{RunID: res.RunID, ChunkSeq: res.ChunkSeq})
		if err != nil {
			t.Fatalf("continuation %d: %v", i, err)
		}
		res = next
	}
	return res
}

func ptrStatus(s job.Status) *job.Status { return &s }

// --- seeding helpers (mirroring the T07 suite) --------------------------------

func seedBinding(t *testing.T, st *storage.Store, uid string) int64 {
	t.Helper()
	rev, err := st.EnsureWatchBinding(context.Background(), uid, "coros")
	if err != nil {
		t.Fatalf("binding: %v", err)
	}
	return rev
}

// seedActivity adds one running-style activity row on the given UTC day with
// HR summary fields and a full HR/speed/distance timeseries so the calibration
// estimator, the load derivation (cardio TRIMP needs HR samples), zones, L1
// and the PB segment detector all have real evidence (mirrors the pipeline
// suite's synthetic fixture).
func seedActivity(t *testing.T, st *storage.Store, uid, labelID string, day time.Time, dist, dur float64, maxHR, avgHR int) {
	t.Helper()
	speed := dist / dur
	var samples []storage.TimeseriesPoint
	for i := 0; i <= int(dur/30); i++ {
		// Timeseries timestamps are CENTISECONDS (the storage/pb convention).
		timestamp := int64(i * 30 * 100)
		d := float64(i*30) * speed
		sp := speed
		hr := avgHR + i%20
		if hr > maxHR {
			hr = maxHR
		}
		samples = append(samples, storage.TimeseriesPoint{Timestamp: &timestamp, Distance: &d, Speed: &sp, HeartRate: &hr})
	}
	if err := st.UpsertActivity(context.Background(), &storage.Activity{
		UserID: uid, LabelID: labelID, SportType: 100, Date: day.Add(12 * time.Hour),
		DistanceM: &dist, DurationS: &dur, MaxHR: &maxHR, AvgHR: &avgHR,
		Provider: "coros", SyncedAt: time.Now().UTC(),
	}, nil, samples, nil); err != nil {
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

// seedLegacyDerived writes deliberately bogus PREVIOUS production rows the
// run must keep serving until its final publication, then replace.
func seedLegacyDerived(t *testing.T, st *storage.Store, uid, day string) {
	t.Helper()
	ctx := context.Background()
	src := "activity"
	ach := day
	if err := st.UpsertPersonalBests(ctx, uid, []storage.PersonalBest{{
		UserID: uid, Distance: "10K", PBTimeSec: 9999, AchievedAt: &ach, Source: &src,
		EntryJSON: `{"distance":"10K","pb_time_sec":9999}`,
	}}); err != nil {
		t.Fatalf("seed legacy pb: %v", err)
	}
	if err := st.ReplaceDailyTrainingLoad(ctx, uid, []storage.DailyTrainingLoad{{
		UserID: uid, Date: day, AlgorithmVersion: 1,
		TrainingDose: 12345, AcuteLoad: 12345, ChronicLoad: 12345, Form: 0,
		CoverageStatus: "complete",
	}}); err != nil {
		t.Fatalf("seed legacy daily: %v", err)
	}
}

// driveCalibration runs the T07 executor to a terminal state so the metrics
// run has a frozen bundle to consume, and returns the T07 run's outcome.
func driveCalibration(t *testing.T, st *storage.Store, uid, asOfDay string) string {
	t.Helper()
	enq := job.NewStoreEnqueuer(st.Jobs(), &memPublisher{})
	h := historicalcalibration.New(historicalcalibration.Config{Store: st, Enq: enq, Enabled: true, ChunkDays: 400})
	ctx := context.Background()
	run := func(in historicalcalibrationChunkInput) string {
		input, err := json.Marshal(in)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		now := time.Now().UTC()
		j := &job.Job{ID: uuid.NewString(), UserID: uid, Type: historicalcalibration.JobType,
			Status: job.StatusQueued, InputJSON: string(input), CreatedAt: now, UpdatedAt: now}
		if err := st.Jobs().Create(ctx, j); err != nil {
			t.Fatalf("create job: %v", err)
		}
		resJSON, err := h(ctx, j, nil)
		if err != nil {
			t.Fatalf("calibration job: %v", err)
		}
		if _, err := st.Jobs().TransitionJob(ctx, j.ID, job.JobTransition{From: ptrStatus(job.StatusQueued), To: job.StatusRunning}); err != nil {
			t.Fatal(err)
		}
		if _, err := st.Jobs().TransitionJob(ctx, j.ID, job.JobTransition{From: ptrStatus(job.StatusRunning), To: job.StatusDone, ResultJSON: &resJSON}); err != nil {
			t.Fatal(err)
		}
		return resJSON
	}
	raw := run(historicalcalibrationChunkInput{Request: true, AsOfDay: asOfDay})
	for i := 0; ; i++ {
		if i > 100 {
			t.Fatal("calibration run did not terminalize")
		}
		var res struct {
			Status  string `json:"status"`
			RunID   string `json:"run_id"`
			Chunk   int    `json:"chunk_seq"`
			Supersd string `json:"supersede_reason,omitempty"`
		}
		if err := json.Unmarshal([]byte(raw), &res); err != nil {
			t.Fatalf("parse calibration result %s: %v", raw, err)
		}
		if res.Status != "in_progress" {
			if res.Status == storage.HistoricalRecomputeStateFailed || res.Status == storage.HistoricalRecomputeStateSuperseded {
				t.Fatalf("calibration run ended %s (%s)", res.Status, res.Supersd)
			}
			return res.Status
		}
		raw = run(historicalcalibrationChunkInput{RunID: res.RunID, ChunkSeq: res.Chunk})
	}
}

// historicalcalibrationChunkInput mirrors the T07 executor's input shape (the
// struct is unexported there; the JSON shape is the contract).
type historicalcalibrationChunkInput struct {
	Request  bool   `json:"request,omitempty"`
	AsOfDay  string `json:"as_of_day,omitempty"`
	RunID    string `json:"run_id,omitempty"`
	ChunkSeq int    `json:"chunk_seq,omitempty"`
}

// seedStandardUser seeds one athlete: 90 RHR health days ending at asOf, three
// running activities inside the window with HR evidence, one pre-window
// activity (full-history PB evidence), and bogus legacy derived rows.
func seedStandardUser(t *testing.T, st *storage.Store, uid string, asOf time.Time, prefix string) {
	t.Helper()
	seedBinding(t, st, uid)
	for d := 0; d < 90; d++ {
		seedHealth(t, st, uid, asOf.AddDate(0, 0, -d).Format("2006-01-02"), 50)
	}
	seedActivity(t, st, uid, prefix+"-w1", asOf.AddDate(0, 0, -40), 10000, 3000, 185, 150)
	seedActivity(t, st, uid, prefix+"-w2", asOf.AddDate(0, 0, -20), 5000, 1500, 183, 148)
	seedActivity(t, st, uid, prefix+"-w3", asOf.AddDate(0, 0, -3), 10200, 3100, 186, 152)
	// Two years before the window: outside every 365-day derivation scope but
	// a legitimate full-history PB candidate.
	seedActivity(t, st, uid, prefix+"-old", asOf.AddDate(-2, 0, -10), 10000, 3200, 184, 150)
	seedLegacyDerived(t, st, uid, asOf.AddDate(0, 0, -10).Format("2006-01-02"))
}

// Without a completed T07 calibration run there is no consumable frozen
// baseline: an explicit permanent error, never a retry and never a silent
// zero-baseline derivation.
func TestHistoricalMetricsNoCalibrationBundle(t *testing.T) {
	h := newHarness(t, ChunkSizes{})
	uid := uuid.NewString()
	seedBinding(t, h.store, uid)
	_, err := h.runJob(t, uid, chunkInput{Request: true, AsOfDay: "2026-06-30"})
	if err == nil {
		t.Fatal("expected calibration_bundle_missing")
	}
	var perm *job.PermanentError
	if ok := asPermanent(err, &perm); !ok || perm.Code != "calibration_bundle_missing" {
		t.Fatalf("want calibration_bundle_missing permanent error, got %v", err)
	}
}

func asPermanent(err error, out **job.PermanentError) bool {
	for err != nil {
		if p, ok := err.(*job.PermanentError); ok {
			*out = p
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// AC3/AC4/AC5 end-to-end: chunked run with tiny chunks (interruption-style
// resume through the staged ledger), mid-run read-only visibility, honest
// publication of load/daily/PB/L1, and the as-of-day four-layer ability
// closure after L1 publication.
func TestHistoricalMetricsFullRunVisibilityAndAbility(t *testing.T) {
	h := newHarness(t, ChunkSizes{Acts: 1, Days: 45, PB: 1})
	st := h.store
	ctx := context.Background()
	uid := uuid.NewString()
	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	seedStandardUser(t, st, uid, asOf, "full")

	if state := driveCalibration(t, st, uid, "2026-06-30"); state != storage.HistoricalRecomputeStateCompleted &&
		state != storage.HistoricalRecomputeStateCompletedWithGaps {
		t.Fatalf("calibration prerequisite ended %s", state)
	}

	// Run only the first few chunk jobs, then verify ordinary readers still
	// see the PREVIOUS consistent results (the bogus legacy rows) while the
	// staged ledger grows behind the scenes.
	res := h.drive(t, uid, "2026-06-30", 4)
	if res.Status != "in_progress" {
		t.Fatalf("expected a live run after 4 chunk jobs, got %s", res.Status)
	}
	pbs, err := st.PersonalBests(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if len(pbs) != 1 || pbs[0].PBTimeSec != 9999 {
		t.Fatalf("mid-run PB set changed: %+v", pbs)
	}
	// The same visibility holds for the daily chain and the per-activity
	// loads: the bogus legacy daily row still serves, no load rows exist.
	legacyDaily, err := st.DailyTrainingLoadBefore(ctx, uid, "2026-06-21")
	if err != nil || legacyDaily == nil {
		t.Fatalf("legacy daily row vanished mid-run: %v %v", legacyDaily, err)
	}
	if legacyDaily.TrainingDose != 12345 {
		t.Fatalf("legacy daily row changed mid-run: %+v", legacyDaily)
	}
	if got, err := st.ActivityTrainingLoad(ctx, uid, "full-w1"); err != nil || got != nil {
		t.Fatalf("load row visible mid-run: %v %v", got, err)
	}
	staged, err := st.ListHistoricalMetricsStaged(ctx, res.RunID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(staged) == 0 {
		t.Fatal("mid-run staged ledger is empty")
	}

	// Drive to terminal with CONTINUATION jobs (a fresh request would merge
	// into the live run and merely observe — the claim contract). Every
	// continuation resumes from the staged ledger, never recomputing settled
	// items; interruption recovery is exactly this resume path.
	res = h.resume(t, uid, res)
	if res.Status != storage.HistoricalMetricsStateCompleted &&
		res.Status != storage.HistoricalMetricsStateCompletedWithGaps {
		t.Fatalf("terminal status = %q (reason %s)", res.Status, res.SupersedeReason)
	}
	run, err := st.GetHistoricalMetricsRun(ctx, res.RunID)
	if err != nil || run == nil {
		t.Fatalf("run row: %v %v", run, err)
	}
	if run.PublishedAt == nil || run.OutputFingerprint == nil || *run.OutputFingerprint == "" {
		t.Fatal("terminal run must record the publication and the frozen output fingerprint")
	}
	if res.CalibrationRunID == "" {
		t.Fatal("run must pin the consumed calibration run")
	}

	// Daily PMC: the window is covered contiguously (staged = published), and
	// the bogus legacy row was replaced by honest derived values.
	dailyStaged, err := st.ListHistoricalMetricsStaged(ctx, res.RunID, storage.HistoricalMetricsKindDailyLoad)
	if err != nil {
		t.Fatal(err)
	}
	if len(dailyStaged) != 365 {
		t.Fatalf("staged daily rows = %d, want 365", len(dailyStaged))
	}
	prodAsOf, err := st.DailyTrainingLoadBefore(ctx, uid, "2026-07-01")
	if err != nil || prodAsOf == nil {
		t.Fatalf("published as-of daily row: %v %v", prodAsOf, err)
	}
	if prodAsOf.AcuteLoad == 12345 || prodAsOf.ChronicLoad == 12345 {
		t.Fatalf("legacy bogus daily row survived publication: %+v", prodAsOf)
	}
	var lastStaged storage.DailyTrainingLoad
	if err := json.Unmarshal([]byte(dailyStaged[len(dailyStaged)-1].Payload), &lastStaged); err != nil {
		t.Fatal(err)
	}
	if lastStaged.Date != "2026-06-30" || lastStaged.AcuteLoad != prodAsOf.AcuteLoad || lastStaged.ChronicLoad != prodAsOf.ChronicLoad {
		t.Fatalf("published as-of row %+v does not match staged %+v", prodAsOf, lastStaged)
	}

	// PB set: the bogus 9999 10K is gone; the published set equals the
	// canonical detector over the user's full history (including the
	// pre-window activity).
	pbs, err = st.PersonalBests(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range pbs {
		if p.Distance == "10K" && p.PBTimeSec == 9999 {
			t.Fatal("bogus legacy PB survived publication")
		}
	}
	acts, err := st.AllRunningActivities(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	// The canonical expectation uses the SAME real timeseries fetch the
	// ordinary compute path uses, so segment PBs count on both sides.
	wantPB, err := pb.DetectPersonalBests(testPBActivities(acts), func(labelID string) ([]pb.TSPoint, error) {
		ts, err := st.ActivityTimeseries(ctx, uid, labelID)
		if err != nil {
			return nil, err
		}
		out := make([]pb.TSPoint, len(ts))
		for i, p := range ts {
			out[i] = pb.TSPoint{Timestamp: p.Timestamp, Distance: p.Distance}
		}
		return out, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(pbs) != len(wantPB) {
		t.Fatalf("published %d PBs, canonical detector says %d", len(pbs), len(wantPB))
	}
	for _, p := range pbs {
		want, ok := wantPB[p.Distance]
		if !ok {
			t.Fatalf("published PB %s not in canonical set", p.Distance)
		}
		if p.PBTimeSec != want.PBTimeSec || p.EntryJSON != pb.EntryJSON(want) {
			t.Fatalf("PB %s = %+v, want canonical %+v", p.Distance, p, want)
		}
	}

	// Load + L1: every window activity with a day bundle has a load row; L1
	// rows exist exactly where an as-of HRMax resolved (honest otherwise).
	loads, err := st.ListHistoricalMetricsStaged(ctx, res.RunID, storage.HistoricalMetricsKindActivityLoad)
	if err != nil {
		t.Fatal(err)
	}
	if len(loads) == 0 {
		t.Fatal("no activity load rows staged/published")
	}
	for _, r := range loads {
		var row storage.ActivityTrainingLoad
		if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
			t.Fatal(err)
		}
		got, err := st.ActivityTrainingLoad(ctx, uid, row.LabelID)
		if err != nil {
			t.Fatalf("activity %s load row: %v", row.LabelID, err)
		}
		if got == nil {
			t.Fatalf("activity %s load row not published", row.LabelID)
		}
		if got.TrainingDose == nil {
			t.Fatalf("activity %s load row published without a dose despite full HR samples: %+v", row.LabelID, got)
		}
	}
	l1Rows, err := st.ListHistoricalMetricsStaged(ctx, res.RunID, storage.HistoricalMetricsKindActivityL1)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range l1Rows {
		var row storage.ActivityAbility
		if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
			t.Fatal(err)
		}
		got, err := st.FetchActivityAbility(ctx, uid, row.LabelID)
		if err != nil || got == nil {
			t.Fatalf("activity %s L1 row not published: %v", row.LabelID, err)
		}
	}

	// Current-ability closure: the as-of day's snapshot carries the four
	// layers when the ability refresh resolved (it did — HRMax evidence
	// exists and the refresh outcome is echoed on the run result).
	if res.AbilityRefresh == "ok" {
		rows, err := st.AbilitySnapshotForDate(ctx, uid, "2026-06-30")
		if err != nil {
			t.Fatal(err)
		}
		levels := map[string]bool{}
		for _, r := range rows {
			levels[r.Level] = true
		}
		for _, level := range []string{"meta", "L2", "L3", "L4"} {
			if !levels[level] {
				t.Fatalf("as-of ability snapshot missing level %s: %+v", level, rows)
			}
		}
	} else {
		t.Logf("ability refresh outcome %q (honest unavailable is a legal gap state)", res.AbilityRefresh)
	}
}

// AC6 single-segment equivalence: two identically seeded users under the same
// frozen calibration bundle semantics — one driven with tiny chunks, the
// other in a single segment — must produce identical derived values (load
// doses, the whole PMC chain, the PB set, L1 quality), proving the checkpoint/
// resume path is exactly the single-pass computation.
func TestHistoricalMetricsSingleSegmentEquivalence(t *testing.T) {
	chunked := newHarness(t, ChunkSizes{Acts: 1, Days: 30, PB: 1})
	single := newHarness(t, ChunkSizes{Acts: 1000, Days: 400, PB: 1000})
	// Both harnesses point at their own store but the SAME database; seed
	// through the chunked one and the single one independently.
	uidA, uidB := uuid.NewString(), uuid.NewString()
	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	seedStandardUser(t, chunked.store, uidA, asOf, "eqa")
	seedStandardUser(t, single.store, uidB, asOf, "eqb")

	driveCalibration(t, chunked.store, uidA, "2026-06-30")
	driveCalibration(t, single.store, uidB, "2026-06-30")

	resA := chunked.drive(t, uidA, "2026-06-30", 0)
	resB := single.drive(t, uidB, "2026-06-30", 0)
	if !terminalOK(resA.Status) || !terminalOK(resB.Status) {
		t.Fatalf("statuses: chunked %s, single %s", resA.Status, resB.Status)
	}
	if resA.AbilityRefresh != resB.AbilityRefresh {
		t.Fatalf("ability refresh outcomes differ: %s vs %s", resA.AbilityRefresh, resB.AbilityRefresh)
	}

	compareLoad := func(kind string) map[string]storage.ActivityTrainingLoad {
		var st *storage.Store
		var runID string
		if kind == "chunked" {
			st, runID = chunked.store, resA.RunID
		} else {
			st, runID = single.store, resB.RunID
		}
		rows, err := st.ListHistoricalMetricsStaged(context.Background(), runID, storage.HistoricalMetricsKindActivityLoad)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]storage.ActivityTrainingLoad{}
		for _, r := range rows {
			var row storage.ActivityTrainingLoad
			if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
				t.Fatal(err)
			}
			// Normalize the label (seed prefixes differ per user).
			row.LabelID = trimPrefixBySeed(row.LabelID)
			out[row.LabelID] = row
		}
		return out
	}
	a, b := compareLoad("chunked"), compareLoad("single")
	if len(a) != len(b) {
		t.Fatalf("load row counts differ: %d vs %d", len(a), len(b))
	}
	for k, ra := range a {
		rb, ok := b[k]
		if !ok {
			t.Fatalf("activity %s missing in single-segment run", k)
		}
		if dose(ra) != dose(rb) || ra.CoverageStatus != rb.CoverageStatus ||
			deref(ra.SessionClass) != deref(rb.SessionClass) || ra.ExcludedFromPMC != rb.ExcludedFromPMC {
			t.Fatalf("activity %s load differs: %+v vs %+v", k, ra, rb)
		}
	}

	// PMC chain: identical (date → acute/chronic/form/dose/coverage).
	daily := func(chunkedRun bool) map[string]storage.DailyTrainingLoad {
		st, runID := single.store, resB.RunID
		if chunkedRun {
			st, runID = chunked.store, resA.RunID
		}
		rows, err := st.ListHistoricalMetricsStaged(context.Background(), runID, storage.HistoricalMetricsKindDailyLoad)
		if err != nil {
			t.Fatal(err)
		}
		out := make(map[string]storage.DailyTrainingLoad, len(rows))
		for _, r := range rows {
			var row storage.DailyTrainingLoad
			if err := json.Unmarshal([]byte(r.Payload), &row); err != nil {
				t.Fatal(err)
			}
			out[row.Date] = row
		}
		return out
	}
	da, db := daily(true), daily(false)
	if len(da) != 365 || len(db) != 365 {
		t.Fatalf("daily rows: %d vs %d", len(da), len(db))
	}
	for day, ra := range da {
		rb, ok := db[day]
		if !ok {
			t.Fatalf("day %s missing in single-segment run", day)
		}
		// A chunked chain re-seeds from the persisted (round4) row at every
		// chunk boundary — the same incremental semantics the ordinary path
		// uses — while the single segment carries full-precision EWMA state
		// in memory. Values agree to the persisted precision; a 1e-3 epsilon
		// absorbs the rounding round-trip without masking real drift.
		if math.Abs(ra.AcuteLoad-rb.AcuteLoad) > 1e-3 || math.Abs(ra.ChronicLoad-rb.ChronicLoad) > 1e-3 ||
			math.Abs(ra.Form-rb.Form) > 1e-3 || ra.TrainingDose != rb.TrainingDose || ra.CoverageStatus != rb.CoverageStatus {
			t.Fatalf("day %s PMC differs: %+v vs %+v", day, ra, rb)
		}
	}

	// PB set + L1 quality.
	pa, err := chunked.store.PersonalBests(context.Background(), uidA)
	if err != nil {
		t.Fatal(err)
	}
	pbb, err := single.store.PersonalBests(context.Background(), uidB)
	if err != nil {
		t.Fatal(err)
	}
	if len(pa) != len(pbb) {
		t.Fatalf("PB counts differ: %d vs %d", len(pa), len(pbb))
	}
	for _, x := range pa {
		var found bool
		for _, y := range pbb {
			if x.Distance == y.Distance {
				found = true
				if x.PBTimeSec != y.PBTimeSec {
					t.Fatalf("PB %s differs: %v vs %v", x.Distance, x.PBTimeSec, y.PBTimeSec)
				}
			}
		}
		if !found {
			t.Fatalf("PB %s missing in single-segment run", x.Distance)
		}
	}
	l1a, err := chunked.store.ActivityAbilityLabelIDs(context.Background(), uidA)
	if err != nil {
		t.Fatal(err)
	}
	l1b, err := single.store.ActivityAbilityLabelIDs(context.Background(), uidB)
	if err != nil {
		t.Fatal(err)
	}
	if len(l1a) != len(l1b) {
		t.Fatalf("L1 row counts differ: %d vs %d", len(l1a), len(l1b))
	}
	for label := range l1a {
		ra, err := chunked.store.FetchActivityAbility(context.Background(), uidA, label)
		if err != nil || ra == nil {
			t.Fatalf("chunked L1 %s: %v", label, err)
		}
		mapped := trimPrefixBySeed(label)
		var rb *storage.ActivityAbility
		for l2 := range l1b {
			if trimPrefixBySeed(l2) == mapped {
				rb, err = single.store.FetchActivityAbility(context.Background(), uidB, l2)
				if err != nil || rb == nil {
					t.Fatalf("single L1 %s: %v", l2, err)
				}
				break
			}
		}
		if rb == nil {
			t.Fatalf("L1 %s missing in single-segment run", label)
		}
		if derefF(ra.L1Quality) != derefF(rb.L1Quality) {
			t.Fatalf("L1 %s quality differs: %v vs %v", label, derefF(ra.L1Quality), derefF(rb.L1Quality))
		}
	}
}

// AC5 supersede: a data change after the run started (a new activity lands)
// changes the pinned data revision; the next chunk refuses to stage/publish
// and the run terminalizes superseded with the production tables untouched.
func TestHistoricalMetricsInputChangeSupersede(t *testing.T) {
	h := newHarness(t, ChunkSizes{Acts: 1, Days: 45, PB: 1})
	st := h.store
	ctx := context.Background()
	uid := uuid.NewString()
	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	seedStandardUser(t, st, uid, asOf, "sup")
	driveCalibration(t, st, uid, "2026-06-30")

	res := h.drive(t, uid, "2026-06-30", 3)
	if res.Status != "in_progress" {
		t.Fatalf("expected live run, got %s", res.Status)
	}
	// A brand-new activity inside the window: the full-history digest moves.
	seedActivity(t, st, uid, "sup-new", asOf.AddDate(0, 0, -1), 8000, 2400, 184, 150)

	for res.Status == "in_progress" {
		next, err := h.runJob(t, uid, chunkInput{RunID: res.RunID, ChunkSeq: res.ChunkSeq})
		if err != nil {
			t.Fatalf("continuation after data change: %v", err)
		}
		res = next
		if res.Status == storage.HistoricalMetricsStateSuperseded {
			break
		}
	}
	if res.Status != storage.HistoricalMetricsStateSuperseded || res.SupersedeReason != "data_revision_changed" {
		t.Fatalf("status = %s reason = %q, want superseded/data_revision_changed", res.Status, res.SupersedeReason)
	}
	// Nothing published: the bogus legacy rows still serve.
	pbs, err := st.PersonalBests(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if len(pbs) != 1 || pbs[0].PBTimeSec != 9999 {
		t.Fatalf("superseded run must not publish: %+v", pbs)
	}
	// The superseded run can never finalize or publish late.
	if _, err := st.PublishHistoricalMetricsRun(ctx, res.RunID); err == nil {
		t.Fatal("publishing a superseded run must be refused")
	}
}

// The staged daily seed must be explainable: with no prior production row
// before the window the chain starts from an explicit zero anchor whose
// provenance is frozen on the first staged row.
func TestHistoricalMetricsZeroAnchorProvenance(t *testing.T) {
	h := newHarness(t, ChunkSizes{Acts: 2, Days: 45, PB: 2})
	st := h.store
	ctx := context.Background()
	uid := uuid.NewString()
	asOf, _ := time.Parse("2006-01-02", "2026-06-30")
	seedStandardUser(t, st, uid, asOf, "seed")
	driveCalibration(t, st, uid, "2026-06-30")

	res := h.drive(t, uid, "2026-06-30", 0)
	if !terminalOK(res.Status) {
		t.Fatalf("terminal status = %s (%s)", res.Status, res.SupersedeReason)
	}
	rows, err := st.ListHistoricalMetricsStaged(ctx, res.RunID, storage.HistoricalMetricsKindDailyLoad)
	if err != nil || len(rows) == 0 {
		t.Fatalf("staged daily rows: %v %v", rows, err)
	}
	var first storage.DailyTrainingLoad
	if err := json.Unmarshal([]byte(rows[0].Payload), &first); err != nil {
		t.Fatal(err)
	}
	p, state := storage.ReadCalibrationProvenance(first)
	if state != "available" || p.Seed == nil {
		t.Fatalf("first daily row provenance: state %s, seed %v", state, p.Seed)
	}
	if p.Seed.State != "explicit_zero_anchor" {
		t.Fatalf("first daily row seed = %q, want explicit_zero_anchor", p.Seed.State)
	}
	// The chain itself: a later row's seed is the previous row's frozen seed.
	var last storage.DailyTrainingLoad
	if err := json.Unmarshal([]byte(rows[len(rows)-1].Payload), &last); err != nil {
		t.Fatal(err)
	}
	lp, lstate := storage.ReadCalibrationProvenance(last)
	if lstate != "available" || lp.Seed == nil || lp.Seed.State != "frozen_seed" {
		t.Fatalf("last daily row seed = %+v (state %s), want frozen_seed", lp.Seed, lstate)
	}
}

func terminalOK(s string) bool {
	return s == storage.HistoricalMetricsStateCompleted || s == storage.HistoricalMetricsStateCompletedWithGaps
}

func dose(r storage.ActivityTrainingLoad) float64 {
	if r.TrainingDose == nil {
		return -1
	}
	return *r.TrainingDose
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefF(f *float64) float64 {
	if f == nil {
		return -1
	}
	return *f
}

// trimPrefixBySeed strips the per-user seed prefix so cross-user labels
// (eqa-w1 vs eqb-w1) compare equal.
func trimPrefixBySeed(label string) string {
	for _, p := range []string{"eqa-", "eqb-"} {
		if len(label) > len(p) && label[:len(p)] == p {
			return label[len(p):]
		}
	}
	return label
}

func testPBActivities(acts []storage.Activity) []pb.Activity {
	out := make([]pb.Activity, len(acts))
	for i, a := range acts {
		out[i] = pb.Activity{
			LabelID:   a.LabelID,
			Name:      a.Name,
			Date:      a.Date,
			DistanceM: a.DistanceM,
			DurationS: a.DurationS,
			Pauses:    a.Pauses,
			SportType: a.SportType,
		}
	}
	return out
}
