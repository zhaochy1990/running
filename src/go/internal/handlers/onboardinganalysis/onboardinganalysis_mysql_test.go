// onboardinganalysis_mysql_test.go is the devops#1009 (T05) executor suite:
// real session/coverage/result tables on real MySQL, the REAL canonical
// calibration/compute/ability handlers wherever a step actually runs (AC2:
// canonical reuse, explicit unavailability, no fabricated rest), and scripted
// stage handlers where the test drives one seam at a time. Named
// TestOnboardingAnalysis* so the CI step running this package against MySQL
// picks it up.
//
// Covered acceptance criteria (AC6): zero activities, missing history, input
// change supersede, cross-midnight top-up, and old-result protection on
// analysis failure.
package onboardinganalysis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	handlerscompute "github.com/zhaochy1990/stride/internal/handlers/compute"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

func openStore(t *testing.T) *storage.Store {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run analysis executor integration tests")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	ctx := context.Background()
	if err := st.AutoMigrate(ctx); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	if err := st.AutoMigrateUsers(ctx); err != nil {
		t.Fatalf("automigrate user: %v", err)
	}
	if err := st.AutoMigrateOnboardingSync(ctx); err != nil {
		t.Fatalf("automigrate onboarding sync: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// countingHandler wraps a canonical (or scripted) handler and counts calls.
type countingHandler struct {
	inner job.Handler
	mu    sync.Mutex
	calls int
}

func (c *countingHandler) Call(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
	c.mu.Lock()
	c.calls++
	c.mu.Unlock()
	return c.inner(ctx, j, hb)
}

func (c *countingHandler) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// handler adapts Call to the job.Handler func type.
func (c *countingHandler) handler() job.Handler { return c.Call }

// scriptedHandler returns a fixed result JSON (a canonical handler's output
// shape) without touching any store.
func scriptedHandler(resultJSON string) job.Handler {
	return func(_ context.Context, _ *job.Job, _ job.Heartbeat) (string, error) {
		return resultJSON, nil
	}
}

// rawStub stands in for the onboarding_recent_sync executor: it records the
// synthetic stage invocation and answers the merged-coverage contract.
type rawStub struct {
	mu     sync.Mutex
	calls  int
	inputs []string
	users  []string
	report func(sessionID string) string
	err    error
}

func (r *rawStub) Call(_ context.Context, j *job.Job, _ job.Heartbeat) (string, error) {
	r.mu.Lock()
	r.calls++
	r.inputs = append(r.inputs, j.InputJSON)
	r.users = append(r.users, j.UserID)
	r.mu.Unlock()
	if r.err != nil {
		return "", r.err
	}
	var in struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal([]byte(j.InputJSON), &in)
	return r.report(in.SessionID), nil
}

func rawStageResult(sessionID string, from, to string) string {
	b, _ := json.Marshal(map[string]any{
		"stage": storage.OnboardingSyncStageRecentRaw, "status": "completed",
		"scanned_from": from, "scanned_to": to, "observed_from": from, "observed_to": to,
	})
	return string(b)
}

// seedSession claims a session anchored on anchorDay, hand-completes its raw
// coverage (the orchestrator suite covers the real completion path) and arms
// the analysis stage rows exactly like the sweep's advance pass.
func seedSession(t *testing.T, st *storage.Store, uid, anchorDay string) *storage.OnboardingSyncSession {
	t.Helper()
	ctx := context.Background()
	anchor, err := time.Parse("2006-01-02", anchorDay)
	if err != nil {
		t.Fatalf("anchor: %v", err)
	}
	actFrom := anchor.AddDate(0, 0, -89).Format("2006-01-02")
	hlthFrom := anchor.AddDate(0, 0, -27).Format("2006-01-02")
	res, err := st.ClaimOrCreateOnboardingSyncSession(ctx, storage.OnboardingSyncClaimSpec{
		UserID: uid, Provider: "coros",
		AnchorDay: anchorDay, AnchorAtUTC: anchor,
		StageNames: []string{storage.OnboardingSyncStageRecentRaw},
		WorkItems: map[string][]storage.OnboardingSyncWorkItemSpec{
			storage.OnboardingSyncStageRecentRaw: {
				{Kind: "activities", RangeFrom: actFrom, RangeTo: anchorDay},
				{Kind: "health", RangeFrom: hlthFrom, RangeTo: anchorDay},
				{Kind: "dashboard", RangeFrom: anchorDay, RangeTo: anchorDay},
			},
		},
		IdempotencyKey: func(stage, sessionID string, rev int64) string {
			return fmt.Sprintf("t1009:%s:%s:rev%d", sessionID, stage, rev)
		},
	})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	sess := res.Session
	cov, err := st.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if err != nil || cov == nil {
		t.Fatalf("raw coverage: %+v %v", cov, err)
	}
	cov.Status = storage.OnboardingSyncCoverageCompleted
	cov.ScannedFrom, cov.ScannedTo = &actFrom, &anchorDay
	cov.ObservedFrom, cov.ObservedTo = &actFrom, &anchorDay
	if err := st.UpdateOnboardingSyncStageCoverage(ctx, cov); err != nil {
		t.Fatalf("complete raw coverage: %v", err)
	}
	if err := st.EnsureOnboardingSyncStage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentAnalysis,
		actFrom, anchorDay, "t1009:"+sess.SessionID+":recent_analysis"); err != nil {
		t.Fatalf("arm analysis stage: %v", err)
	}
	return sess
}

func analysisJob(t *testing.T, sess *storage.OnboardingSyncSession) *job.Job {
	t.Helper()
	input, err := json.Marshal(map[string]string{
		"session_id": sess.SessionID, "stage": storage.OnboardingSyncStageRecentAnalysis,
	})
	if err != nil {
		t.Fatalf("marshal input: %v", err)
	}
	return &job.Job{ID: "job-" + uuid.NewString()[:8], UserID: sess.UserID, InputJSON: string(input)}
}

func noopHeartbeat(string, int) error { return nil }

func seedRunningActivity(t *testing.T, st *storage.Store, uid, labelID string, day time.Time) {
	t.Helper()
	dist, dur := 10000.0, 3000.0
	if err := st.UpsertActivity(context.Background(), &storage.Activity{
		UserID: uid, LabelID: labelID, SportType: 100, Date: day,
		DistanceM: &dist, DurationS: &dur, Provider: "coros", SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("upsert activity %s: %v", labelID, err)
	}
}

func seedCompletedOnboarding(t *testing.T, st *storage.Store, uid string) {
	t.Helper()
	ctx := context.Background()
	if err := st.SetProfileReady(ctx, uid); err != nil {
		t.Fatalf("profile ready: %v", err)
	}
	if _, err := st.FinalizeOnboardingRun(ctx, uid); err != nil {
		t.Fatalf("finalize onboarding: %v", err)
	}
}

// Zero inputs everywhere: every domain reports explicit unavailability with a
// reason, no canonical step runs at all, and nothing derived is written — no
// fabricated analysis for a user with no data (AC2/AC6).
func TestOnboardingAnalysisZeroInputsExplicitUnavailable(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	seedCompletedOnboarding(t, st, uid)
	today := timefmt.ShanghaiToday().Format("2006-01-02")
	sess := seedSession(t, st, uid, today)

	// The canonical handlers must NOT run for a zero-input user.
	mustNotRun := func(name string) job.Handler {
		return func(context.Context, *job.Job, job.Heartbeat) (string, error) {
			t.Fatalf("%s must not run with zero inputs", name)
			return "", nil
		}
	}
	h := New(Config{
		Store:       st,
		RawStage:    mustNotRun("raw top-up"),
		Calibration: mustNotRun("calibration"),
		Compute:     mustNotRun("compute"),
		Ability:     mustNotRun("ability"),
	})
	resJSON, err := h(ctx, analysisJob(t, sess), noopHeartbeat)
	if err != nil {
		t.Fatalf("handler: %v", err)
	}

	row, err := st.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if err != nil || row == nil {
		t.Fatalf("analysis row: %+v %v", row, err)
	}
	if row.Status != storage.OnboardingAnalysisStatusUnavailable {
		t.Errorf("status = %s, want unavailable", row.Status)
	}
	if row.AsOfDay != today || row.AnchorDay != today {
		t.Errorf("as-of/anchor = %s/%s, want %s/%s", row.AsOfDay, row.AnchorDay, today, today)
	}
	if row.CoverageFrom != nil || row.CoverageTo != nil {
		t.Errorf("coverage = %v..%v, want none observed", row.CoverageFrom, row.CoverageTo)
	}
	var domains map[string]domainOutcome
	if err := json.Unmarshal([]byte(*row.DomainsJSON), &domains); err != nil {
		t.Fatalf("domains json: %v", err)
	}
	for _, d := range []string{DomainCalibration, DomainLoad, DomainZones, DomainAbility} {
		if domains[d].Status != "unavailable" || domains[d].Reason != "no_inputs" {
			t.Errorf("domain %s = %+v, want unavailable/no_inputs", d, domains[d])
		}
	}
	// Nothing derived was written and nothing raw was retracted.
	if snap, err := st.LatestRunningCalibrationSnapshotForVersion(ctx, uid, calibration.ModelVersion, today); err != nil || snap != nil {
		t.Errorf("calibration snapshot = %+v err=%v, want none published", snap, err)
	}
	if pbs, err := st.PersonalBests(ctx, uid); err != nil || len(pbs) != 0 {
		t.Errorf("personal bests = %v err=%v, want none", pbs, err)
	}
	if view, err := st.GetOnboardingSyncSessionByID(ctx, sess.SessionID); err != nil || view.State != storage.OnboardingSyncStateDispatching {
		t.Errorf("session state = %s err=%v (raw completion untouched by analysis)", view.State, err)
	}
	var out analysisOutput
	if err := json.Unmarshal([]byte(resJSON), &out); err != nil {
		t.Fatalf("result json: %v", err)
	}
	if out.Stage != storage.OnboardingSyncStageRecentAnalysis || out.PublishedStatus != storage.OnboardingAnalysisStatusUnavailable {
		t.Errorf("result = %+v", out)
	}
}

// A health-only user (zero activities): the health-based calibration lands,
// load/zones/L1 stay explicitly unavailable — no fake rest rows, no empty
// replace-all over PB/PMC (AC2/AC6).
func TestOnboardingAnalysisZeroActivitiesPartial(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	today := timefmt.ShanghaiToday()
	sess := seedSession(t, st, uid, today.Format("2006-01-02"))
	// Health days prove coverage but no activities exist.
	rhr := 48
	for i := 0; i < 3; i++ {
		day := today.AddDate(0, 0, -i).Format("2006-01-02")
		if err := st.UpsertDailyHealth(ctx, &storage.DailyHealth{UserID: uid, Date: day, RHR: &rhr}); err != nil {
			t.Fatalf("health %s: %v", day, err)
		}
	}

	cal := &countingHandler{inner: handlerscompute.NewCalibration(st)}
	comp := &countingHandler{inner: handlerscompute.NewCompute(st)}
	h := New(Config{
		Store: st,
		RawStage: func(context.Context, *job.Job, job.Heartbeat) (string, error) {
			t.Fatal("raw top-up must not run on the anchor day")
			return "", nil
		},
		Calibration: cal.handler(),
		Compute:     comp.handler(),
		Ability:     scriptedHandler(`{"status":"ok"}`),
	})
	if _, err := h(ctx, analysisJob(t, sess), noopHeartbeat); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if comp.count() != 0 {
		t.Fatalf("compute ran %d times with zero activities, want 0 (no empty replace-all)", comp.count())
	}
	if cal.count() != 1 {
		t.Fatalf("calibration ran %d times, want 1 (health-based baseline is legitimate)", cal.count())
	}
	row, err := st.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if err != nil || row == nil {
		t.Fatalf("analysis row: %+v %v", row, err)
	}
	if row.Status != storage.OnboardingAnalysisStatusPartial {
		t.Errorf("status = %s, want partial (calibration ready, rest unavailable)", row.Status)
	}
	var domains map[string]domainOutcome
	_ = json.Unmarshal([]byte(*row.DomainsJSON), &domains)
	if domains[DomainCalibration].Status != "ready" {
		t.Errorf("calibration = %+v, want ready", domains[DomainCalibration])
	}
	for _, d := range []string{DomainLoad, DomainZones, DomainAbility} {
		if domains[d].Status != "unavailable" || domains[d].Reason != "no_activities" {
			t.Errorf("domain %s = %+v, want unavailable/no_activities", d, domains[d])
		}
	}
	if pbs, _ := st.PersonalBests(ctx, uid); len(pbs) != 0 {
		t.Errorf("personal bests = %d rows, want 0", len(pbs))
	}
}

// Recent activities exist but no historical calibration covers their days
// (exactly the fresh-onboarding state): the canonical calibration publishes
// TODAY's baseline, the canonical compute refuses to borrow it backwards and
// reports explicit unavailability writing NOTHING — pre-existing PB/PMC rows
// survive untouched (AC1/AC2/AC6).
func TestOnboardingAnalysisMissingHistoryProtectsOldResults(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	today := timefmt.ShanghaiToday()
	sess := seedSession(t, st, uid, today.Format("2006-01-02"))
	seedCompletedOnboarding(t, st, uid)

	// A recent running activity with NO calibration snapshot as-of its day.
	seedRunningActivity(t, st, uid, "act-old", today.AddDate(0, 0, -5))
	// Pre-existing published results an analysis failure must not wipe.
	pbTime := 2400.0
	if err := st.UpsertPersonalBests(ctx, uid, []storage.PersonalBest{{
		Distance: "5km", PBTimeSec: pbTime,
	}}); err != nil {
		t.Fatalf("seed pb: %v", err)
	}
	priorDay := today.AddDate(0, 0, -10).Format("2006-01-02")
	if err := st.ReplaceDailyTrainingLoad(ctx, uid, []storage.DailyTrainingLoad{{
		UserID: uid, Date: priorDay, TrainingDose: 42, AcuteLoad: 10, ChronicLoad: 8,
	}}); err != nil {
		t.Fatalf("seed daily: %v", err)
	}

	h := New(Config{
		Store: st,
		RawStage: func(context.Context, *job.Job, job.Heartbeat) (string, error) {
			t.Fatal("raw top-up must not run on the anchor day")
			return "", nil
		},
		Calibration: handlerscompute.NewCalibration(st),
		Compute:     handlerscompute.NewCompute(st),
		Ability:     handlerscompute.NewAbility(st),
	})
	if _, err := h(ctx, analysisJob(t, sess), noopHeartbeat); err != nil {
		t.Fatalf("handler: %v", err)
	}

	row, err := st.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if err != nil || row == nil {
		t.Fatalf("analysis row: %+v %v", row, err)
	}
	if row.Status == storage.OnboardingAnalysisStatusReady {
		t.Fatalf("status = ready, want partial (load/zones unavailable for missing history)")
	}
	var domains map[string]domainOutcome
	_ = json.Unmarshal([]byte(*row.DomainsJSON), &domains)
	if domains[DomainCalibration].Status != "ready" {
		t.Errorf("calibration = %+v, want ready (today's baseline from the recent window)", domains[DomainCalibration])
	}
	for _, d := range []string{DomainLoad, DomainZones} {
		if domains[d].Status != "unavailable" || domains[d].Reason != "historical_calibration_missing" {
			t.Errorf("domain %s = %+v, want unavailable/historical_calibration_missing", d, domains[d])
		}
	}
	// Old results survived: no replace-all wipe from the unavailable compute.
	pbs, err := st.PersonalBests(ctx, uid)
	if err != nil || len(pbs) != 1 || pbs[0].PBTimeSec != pbTime {
		t.Errorf("personal bests = %+v err=%v, want the pre-existing row intact", pbs, err)
	}
	prior, err := st.DailyTrainingLoadBefore(ctx, uid, today.Format("2006-01-02"))
	if err != nil || prior == nil || prior.Date != priorDay {
		t.Errorf("prior daily row = %+v err=%v, want the pre-existing row intact", prior, err)
	}
	// Analysis never touched onboarding completion or the raw stage.
	if cov, err := st.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw); err != nil ||
		cov.Status != storage.OnboardingSyncCoverageCompleted || cov.TargetTo != today.Format("2006-01-02") {
		t.Errorf("raw coverage = %+v err=%v, want untouched completed", cov, err)
	}
}

// Crossing midnight: the as-of day moves past the fixed anchor, the executor
// first tops the raw window up through the raw executor (extension items +
// same-day dashboard/health), extends the raw target ONLY on success, and
// publishes an analysis whose as-of differs from the anchor (AC3).
func TestOnboardingAnalysisCrossMidnightTopUp(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	today := timefmt.ShanghaiToday()
	anchorDay := today.AddDate(0, 0, -1).Format("2006-01-02")
	sess := seedSession(t, st, uid, anchorDay)
	rhr := 50
	if err := st.UpsertDailyHealth(ctx, &storage.DailyHealth{UserID: uid, Date: anchorDay, RHR: &rhr}); err != nil {
		t.Fatalf("health: %v", err)
	}

	raw := &rawStub{report: func(sessionID string) string {
		return rawStageResult(sessionID, today.AddDate(0, 0, -90).Format("2006-01-02"), today.Format("2006-01-02"))
	}}
	cal := &countingHandler{inner: scriptedHandler(`{"status":"ok","calibration_snapshot_id":9}`)}
	h := New(Config{
		Store: st, RawStage: raw.Call,
		Calibration: cal.handler(),
		Compute:     scriptedHandler(`{"status":"full","activities":2}`),
		Ability:     scriptedHandler(`{"status":"ok","l1_written":2}`),
	})
	if _, err := h(ctx, analysisJob(t, sess), noopHeartbeat); err != nil {
		t.Fatalf("handler: %v", err)
	}

	if raw.calls != 1 {
		t.Fatalf("raw top-up calls = %d, want 1", raw.calls)
	}
	var rawInput struct {
		SessionID string `json:"session_id"`
		Stage     string `json:"stage"`
	}
	if err := json.Unmarshal([]byte(raw.inputs[0]), &rawInput); err != nil {
		t.Fatalf("raw input: %v", err)
	}
	if rawInput.Stage != storage.OnboardingSyncStageRecentRaw || rawInput.SessionID != sess.SessionID {
		t.Errorf("raw input = %+v, want the recent_raw stage of the session", rawInput)
	}
	if raw.users[0] != uid {
		t.Errorf("raw subject = %s, want %s", raw.users[0], uid)
	}
	// Extension work items were appended for the days after the anchor.
	items, _ := st.ListOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	wantExt := map[string]bool{
		"activities:" + today.Format("2006-01-02"): false,
		"health:" + today.Format("2006-01-02"):     false,
		"dashboard:" + today.Format("2006-01-02"):  false,
	}
	for _, it := range items {
		key := it.Kind + ":" + it.RangeTo
		if _, ok := wantExt[key]; ok {
			wantExt[key] = true
		}
	}
	for key, seen := range wantExt {
		if !seen {
			t.Errorf("missing extension work item %s", key)
		}
	}
	// The raw coverage target extended to the as-of day and the merged result
	// was applied — target/scanned/observed moved together.
	rawCov, err := st.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if err != nil || rawCov.TargetTo != today.Format("2006-01-02") || rawCov.ObservedTo == nil || *rawCov.ObservedTo != today.Format("2006-01-02") {
		t.Errorf("raw coverage after top-up = %+v err=%v, want target/observed extended to %s", rawCov, err, today.Format("2006-01-02"))
	}
	// The published analysis carries its own as-of day, separate from the anchor.
	row, err := st.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if err != nil || row == nil {
		t.Fatalf("analysis row: %+v %v", row, err)
	}
	if row.AsOfDay != today.Format("2006-01-02") || row.AnchorDay != anchorDay {
		t.Errorf("as-of/anchor = %s/%s, want %s/%s (separate days)", row.AsOfDay, row.AnchorDay, today.Format("2006-01-02"), anchorDay)
	}
	// Health-only across midnight: calibration ready, load/zones/ability
	// explicitly unavailable (no activities) — partial, never fabricated.
	if row.Status != storage.OnboardingAnalysisStatusPartial {
		t.Errorf("status = %s, want partial (calibration ready, load/zones/ability no_activities)", row.Status)
	}
	var xmidDomains map[string]domainOutcome
	_ = json.Unmarshal([]byte(*row.DomainsJSON), &xmidDomains)
	if xmidDomains[DomainCalibration].Status != "ready" {
		t.Errorf("calibration = %+v, want ready", xmidDomains[DomainCalibration])
	}
	if xmidDomains[DomainLoad].Reason != "no_activities" {
		t.Errorf("load = %+v, want unavailable/no_activities", xmidDomains[DomainLoad])
	}

	// Idempotent redelivery with UNCHANGED inputs: no recompute.
	before := cal.count()
	if _, err := h(ctx, analysisJob(t, sess), noopHeartbeat); err != nil {
		t.Fatalf("handler 2: %v", err)
	}
	if cal.count() != before {
		t.Errorf("calibration ran again on unchanged fingerprint (%d → %d)", before, cal.count())
	}
	row2, _ := st.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if row2.InputFingerprint != row.InputFingerprint || row2.ComputedAt.Unix() != row.ComputedAt.Unix() {
		// ComputedAt may differ by the upsert — the fingerprint must not.
		t.Errorf("fingerprint changed on redelivery: %s → %s", row.InputFingerprint, row2.InputFingerprint)
	}
}

// A failed top-up must not retract raw readiness: the raw coverage keeps its
// completed status and original target, no analysis row is published, and the
// error propagates with the raw executor's classification (AC1).
func TestOnboardingAnalysisTopUpFailureProtectsRaw(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	today := timefmt.ShanghaiToday()
	anchorDay := today.AddDate(0, 0, -1).Format("2006-01-02")
	sess := seedSession(t, st, uid, anchorDay)
	seedCompletedOnboarding(t, st, uid)
	pbTime := 1800.0
	if err := st.UpsertPersonalBests(ctx, uid, []storage.PersonalBest{{Distance: "1km", PBTimeSec: pbTime}}); err != nil {
		t.Fatalf("seed pb: %v", err)
	}

	raw := &rawStub{err: errors.New("429 rate limited")}
	h := New(Config{
		Store: st, RawStage: raw.Call,
		Calibration: scriptedHandler(`{"status":"ok"}`),
		Compute:     scriptedHandler(`{"status":"full"}`),
		Ability:     scriptedHandler(`{"status":"ok"}`),
	})
	if _, err := h(ctx, analysisJob(t, sess), noopHeartbeat); err == nil {
		t.Fatal("top-up failure must fail the analysis job (retryable)")
	}

	// Raw coverage untouched: completed, original target.
	rawCov, err := st.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if err != nil || rawCov.Status != storage.OnboardingSyncCoverageCompleted || rawCov.TargetTo != anchorDay {
		t.Errorf("raw coverage = %+v err=%v, want completed with the original target %s", rawCov, err, anchorDay)
	}
	if row, err := st.GetOnboardingRecentAnalysis(ctx, sess.SessionID); err != nil || row != nil {
		t.Errorf("analysis row = %+v err=%v, want none published", row, err)
	}
	// Onboarding completion and old PBs survive the analysis failure.
	if pbs, _ := st.PersonalBests(ctx, uid); len(pbs) != 1 || pbs[0].PBTimeSec != pbTime {
		t.Errorf("personal bests = %+v, want the pre-existing row intact", pbs)
	}
	onboarded, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || onboarded == nil || onboarded.CompletedAt == nil {
		t.Errorf("onboarding completion = %+v err=%v, want completed_at intact", onboarded, err)
	}
}

// A same-day input change invalidates by fingerprint (no snapshot id moved):
// the re-run supersedes the published row, keeping a fresh as-of/fingerprint
// and clearing the stale flag (AC4/AC5).
func TestOnboardingAnalysisInputChangeSupersedes(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	today := timefmt.ShanghaiToday().Format("2006-01-02")
	sess := seedSession(t, st, uid, today)
	seedRunningActivity(t, st, uid, "act-1", timefmt.ShanghaiToday().AddDate(0, 0, -2))

	cal := &countingHandler{inner: scriptedHandler(`{"status":"ok"}`)}
	h := New(Config{
		Store: st,
		RawStage: func(context.Context, *job.Job, job.Heartbeat) (string, error) {
			t.Fatal("no top-up expected on the anchor day")
			return "", nil
		},
		Calibration: cal.handler(),
		Compute:     scriptedHandler(`{"status":"full","activities":1}`),
		Ability:     scriptedHandler(`{"status":"ok"}`),
	})
	if _, err := h(ctx, analysisJob(t, sess), noopHeartbeat); err != nil {
		t.Fatalf("handler: %v", err)
	}
	first, _ := st.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if first == nil || first.Status != storage.OnboardingAnalysisStatusReady {
		t.Fatalf("first row = %+v, want ready", first)
	}

	// Same-day change: another activity lands (no snapshot id moved).
	seedRunningActivity(t, st, uid, "act-2", timefmt.ShanghaiToday().AddDate(0, 0, -1))
	res2, err := h(ctx, analysisJob(t, sess), noopHeartbeat)
	if err != nil {
		t.Fatalf("handler 2: %v", err)
	}
	second, _ := st.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if second.InputFingerprint == first.InputFingerprint {
		t.Fatal("changed inputs must change the fingerprint")
	}
	if second.Stale {
		t.Error("superseding run must clear the stale flag")
	}
	if second.AsOfDay != today {
		t.Errorf("as-of = %s, want %s", second.AsOfDay, today)
	}
	if cal.count() != 2 {
		t.Errorf("calibration runs = %d, want 2 (the refresh recomputed)", cal.count())
	}
	var out analysisOutput
	if err := json.Unmarshal([]byte(res2), &out); err != nil {
		t.Fatalf("result 2: %v", err)
	}
	if out.SupersededFingerprint != first.InputFingerprint {
		t.Errorf("superseded fingerprint = %s, want %s", out.SupersededFingerprint, first.InputFingerprint)
	}
}
