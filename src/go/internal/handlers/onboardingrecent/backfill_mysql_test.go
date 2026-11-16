// backfill_mysql_test.go covers the devops#1010 backfill + auxiliary
// executors against a REAL MySQL store (STRIDE_WORKER_TEST_MYSQL_DSN): the
// chunk loop's checkpoint persistence, the storage-derived terminal coverage
// (observed windows and honest gaps read from what the store holds, never
// from chunk bookkeeping), the in_progress StageResult while work remains,
// and the isolation between stages (a historical failure never retracts the
// recent stage's recorded coverage — AC6).
package onboardingrecent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeBackfillProvider scripts per-chunk activities behaviour and writes real
// rows through the store so the executor's storage-derived coverage has
// something to observe.
type fakeBackfillProvider struct {
	fakeProvider
	st          *storage.Store
	chunks      []fakeChunk // consumed one per call (last one repeats)
	callCursors []string
}

type fakeChunk struct {
	checkpoint string // checkpoint returned when not done
	scanned    string // ScannedThrough
	done       bool
	fetches    int
	// days: activity days to actually store this chunk (Shanghai labels).
	days []string
	// healthDays: health days to store when the health channel runs.
	healthDays []string
	err        error
}

func (f *fakeBackfillProvider) SyncBackfillRange(ctx context.Context, user string, opts provider.BackfillRangeOptions, _ provider.ProgressCallback) (provider.BackfillRangeReport, error) {
	f.sawPublishSession = storage.PublishSessionFromContext(ctx)
	i := 0
	if len(f.chunks) > 1 {
		i = min(f.calls["backfill"], len(f.chunks)-1)
	}
	ch := f.chunks[i]
	f.calls["backfill"]++
	rep := provider.BackfillRangeReport{}
	if opts.Activities != nil {
		f.callCursors = append(f.callCursors, opts.ActivitiesCheckpoint)
		for _, d := range ch.days {
			day, err := time.Parse("2006-01-02", d)
			if err != nil {
				return rep, err
			}
			if err := f.st.UpsertActivityPreservingEmptyChildren(ctx, &storage.Activity{
				UserID: user, LabelID: "act-" + d, SportType: 100,
				Date: day.Add(12 * time.Hour).UTC(), SyncedAt: day.Add(12 * time.Hour).UTC(),
			}, nil, nil, nil); err != nil {
				return rep, err
			}
		}
		rep.Activities = &provider.ChannelBackfillReport{
			Done: ch.done, Checkpoint: ch.checkpoint, ScannedThrough: ch.scanned,
			Fetches: ch.fetches, Advanced: true,
		}
	}
	if opts.Health != nil {
		for _, d := range ch.healthDays {
			if err := f.st.UpsertDailyHealth(ctx, &storage.DailyHealth{
				UserID: user, Date: d, Provider: "coros",
			}); err != nil {
				return rep, err
			}
		}
		rep.Health = &provider.ChannelBackfillReport{Done: true, Advanced: true, DaysWalked: len(ch.healthDays)}
	}
	if ch.err != nil {
		return rep, ch.err
	}
	return rep, nil
}

// seedBackfillStage appends the extended stage (activities + health windows)
// to a claimed session and returns a dispatched-less dispatch (the executor
// job is synthesized directly).
func seedBackfillStage(t *testing.T, st *storage.Store, sess *storage.OnboardingSyncSession, actWin, healthWin provider.DayWindow) {
	t.Helper()
	items := []storage.OnboardingSyncWorkItemSpec{
		{Kind: storage.OnboardingSyncItemKindActivities, RangeFrom: actWin.From, RangeTo: actWin.To},
		{Kind: storage.OnboardingSyncItemKindHealth, RangeFrom: healthWin.From, RangeTo: healthWin.To},
	}
	created, err := st.AddOnboardingSyncStage(context.Background(), sess.SessionID,
		storage.OnboardingSyncStageExtendedRaw, "t1010:"+sess.SessionID+":extended", items)
	if err != nil || !created {
		t.Fatalf("add extended stage: created=%v err=%v", created, err)
	}
}

func backfillJob(sess *storage.OnboardingSyncSession, stage string) *job.Job {
	return &job.Job{
		ID: "job-" + sess.SessionID[:8] + "-" + stage, UserID: sess.UserID, Type: JobType,
		Status:    job.StatusRunning,
		InputJSON: fmt.Sprintf(`{"session_id":%q,"stage":%q}`, sess.SessionID, stage),
	}
}

func runExecutor(t *testing.T, cfg Config, j *job.Job) (string, error) {
	t.Helper()
	h := New(cfg)
	return h(context.Background(), j, func(string, int) error { return nil })
}

// The chunk loop: chunk 1 reports in_progress with a durable checkpoint and
// the health channel's storage-derived terminal; chunk 2 completes the
// activities channel and the final result derives observed windows and honest
// gaps from the store.
func TestOnboardingRecentBackfillExecutor_ChunksToCompletion(t *testing.T) {
	st := openStore(t)
	uid := mustUUID(t)
	sess := seedSession(t, st, uid)
	actWin := provider.DayWindow{From: "2026-05-20", To: "2026-08-18"}
	healthWin := provider.DayWindow{From: "2026-08-18", To: "2026-11-16"}
	seedBackfillStage(t, st, sess, actWin, healthWin)

	// A fully-covered health window (every day written once) so the channel
	// derives done; the activities window keeps holes for the gap assertions.
	healthDays := make([]string, 0, 91)
	for d := mustDay(t, "2026-08-18"); !d.After(mustDay(t, "2026-11-16")); d = d.AddDate(0, 0, 1) {
		healthDays = append(healthDays, d.Format("2006-01-02"))
	}
	fb := &fakeBackfillProvider{fakeProvider: fakeProvider{name: "coros", loggedIn: true, calls: map[string]int{}}, st: st,
		chunks: []fakeChunk{
			{checkpoint: "coros:v1:cp:act:done=2026-07-01", scanned: "2026-07-01", fetches: 20,
				days: []string{"2026-08-18", "2026-08-10", "2026-07-01"}, healthDays: healthDays},
			{done: true, fetches: 5, days: []string{"2026-06-15", "2026-05-20"}},
		},
	}
	cfg := Config{
		Resolve: func(context.Context, string) (Provider, error) { return fb, nil },
		Store:   st, Sessions: st, Jobs: 2,
		BackfillBudget: provider.BackfillBudget{MaxActivityFetches: 20, MaxHealthDays: 7},
	}

	out, err := runExecutor(t, cfg, backfillJob(sess, storage.OnboardingSyncStageExtendedRaw))
	if err != nil {
		t.Fatalf("chunk 1: %v", err)
	}
	var res onboardingsync.StageResult
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("chunk 1 result: %v", err)
	}
	if res.Status != onboardingsync.StageStatusInProgress {
		t.Fatalf("chunk 1 status = %s, want in_progress", res.Status)
	}
	items := listItems(t, st, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	act, hlth := itemOf(items, kindActivities), itemOf(items, kindHealth)
	if act.Status != storage.OnboardingSyncItemPending || act.Checkpoint == nil || !strings.Contains(*act.Checkpoint, "2026-07-01") {
		t.Fatalf("activities item after chunk 1 = %+v, want pending with checkpoint", act)
	}
	if hlth.Status != storage.OnboardingSyncItemDone || hlth.FetchCredential == nil ||
		!strings.Contains(*hlth.FetchCredential, "obs=2026-08-18..2026-11-16") {
		t.Fatalf("health item after chunk 1 = %+v, want done with the storage-derived observed window", hlth)
	}

	// Chunk 2 resumes from the persisted cursor.
	out2, err := runExecutor(t, cfg, backfillJob(sess, storage.OnboardingSyncStageExtendedRaw))
	if err != nil {
		t.Fatalf("chunk 2: %v", err)
	}
	if err := json.Unmarshal([]byte(out2), &res); err != nil {
		t.Fatalf("chunk 2 result: %v", err)
	}
	if res.Status != storage.OnboardingSyncCoverageCompletedWithGaps {
		t.Fatalf("chunk 2 status = %s, want completed_with_gaps (window has empty days)", res.Status)
	}
	// Observed window derives from storage via the done items' credentials
	// (the activities item is an honest gap item — holed windows carry no
	// complete-fetch credential), so the health window anchors observation.
	if res.ObservedFrom == nil || *res.ObservedFrom != "2026-08-18" || res.ObservedTo == nil || *res.ObservedTo != "2026-11-16" {
		t.Errorf("observed = %s..%s, want 2026-08-18..2026-11-16", fmtPtr(res.ObservedFrom), fmtPtr(res.ObservedTo))
	}
	if len(res.Gaps) == 0 {
		t.Error("empty target days must appear as honest gaps")
	}
	items = listItems(t, st, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	act = itemOf(items, kindActivities)
	if act.Status != storage.OnboardingSyncItemGap || act.Error == nil {
		t.Fatalf("activities item after chunk 2 = %+v, want gap with the empty-day reason", act)
	}
	// The provider saw chunk 2's cursor = chunk 1's checkpoint.
	if len(fb.callCursors) != 2 || fb.callCursors[1] != "coros:v1:cp:act:done=2026-07-01" {
		t.Errorf("provider cursors = %v, want resume from the persisted checkpoint", fb.callCursors)
	}
}

// AC6: a retryable historical failure fails the job, marks only the
// historical items failed, and leaves the recent stage's recorded coverage
// untouched (历史失败不撤回近期数据).
func TestOnboardingRecentBackfillExecutor_FailureDoesNotRetractRecent(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := mustUUID(t)
	sess := seedSession(t, st, uid)

	// Record the recent stage as completed with its items terminal.
	markAllItemsTerminal(t, st, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	setCoverage(t, st, sess.SessionID, storage.OnboardingSyncStageRecentRaw,
		storage.OnboardingSyncCoverageCompleted, "2026-08-18", "2026-11-16")

	items := []storage.OnboardingSyncWorkItemSpec{
		{Kind: storage.OnboardingSyncItemKindActivities, RangeFrom: "2000-01-01", RangeTo: "2026-05-19"},
	}
	if _, err := st.AddOnboardingSyncStage(ctx, sess.SessionID, storage.OnboardingSyncStageHistoricalRaw,
		"t1010:"+sess.SessionID+":historical", items); err != nil {
		t.Fatalf("add historical: %v", err)
	}

	fb := &fakeBackfillProvider{fakeProvider: fakeProvider{name: "coros", loggedIn: true, calls: map[string]int{}}, st: st,
		chunks: []fakeChunk{{err: errors.New("coros: network timeout")}},
	}
	cfg := Config{
		Resolve: func(context.Context, string) (Provider, error) { return fb, nil },
		Store:   st, Sessions: st, Jobs: 2,
	}
	_, err := runExecutor(t, cfg, backfillJob(sess, storage.OnboardingSyncStageHistoricalRaw))
	if err == nil {
		t.Fatal("the retryable failure must fail the job")
	}
	hist := listItems(t, st, sess.SessionID, storage.OnboardingSyncStageHistoricalRaw)
	if itemOf(hist, kindActivities).Status != storage.OnboardingSyncItemFailed {
		t.Errorf("historical activities item = %s, want failed", itemOf(hist, kindActivities).Status)
	}
	recentCov, _ := st.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if recentCov.Status != storage.OnboardingSyncCoverageCompleted {
		t.Fatalf("recent coverage = %s, want completed (not retracted)", recentCov.Status)
	}
}

// The auxiliary stage: race detection consumes its candidate chunks (negative
// results tracked in the checkpoint), route shapes settle in one pass, and
// the stage completes with both items done — without touching raw coverage.
func TestOnboardingRecentAuxiliaryExecutor_Completes(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := mustUUID(t)
	sess := seedSession(t, st, uid)
	markAllItemsTerminal(t, st, sess.SessionID, storage.OnboardingSyncStageRecentRaw)

	items := []storage.OnboardingSyncWorkItemSpec{
		{Kind: storage.OnboardingSyncItemKindRaceDetection, RangeFrom: "2000-01-01", RangeTo: "2026-11-16"},
		{Kind: storage.OnboardingSyncItemKindRouteShapes, RangeFrom: "2000-01-01", RangeTo: "2026-11-16"},
	}
	if _, err := st.AddOnboardingSyncStage(ctx, sess.SessionID, storage.OnboardingSyncStageAuxiliary,
		"t1010:"+sess.SessionID+":aux", items); err != nil {
		t.Fatalf("add auxiliary: %v", err)
	}
	// Seed two race candidates (unconfirmed HM-distance outdoor runs) so the
	// chunk bound leaves work behind: chunk 1 evaluates one, chunk 2 drains.
	for i, day := range []string{"2026-09-01", "2026-10-01"} {
		sport := "run_outdoor"
		if err := st.UpsertActivity(ctx, &storage.Activity{
			UserID: uid, LabelID: fmt.Sprintf("race-cand-%d", i+1), SportType: 100,
			Sport: &sport, Date: mustDay(t, day), DistanceM: ptrFloat(21000),
			SyncedAt: mustDay(t, day),
		}, nil, nil, nil); err != nil {
			t.Fatalf("seed activity: %v", err)
		}
	}

	var raceSaw [][]string
	raceHandler := func(_ context.Context, j *job.Job, _ job.Heartbeat) (string, error) {
		var in struct {
			LabelIDs []string `json:"label_ids"`
		}
		_ = json.Unmarshal([]byte(j.InputJSON), &in)
		raceSaw = append(raceSaw, in.LabelIDs)
		// The detector rejects the candidate (no race row inserted): a
		// negative result stays in the query; the checkpoint settles it.
		return `{"confirmed":0}`, nil
	}
	shapesHandler := func(context.Context, *job.Job, job.Heartbeat) (string, error) {
		return `{"candidates":1,"generated":1,"no_gps":0,"failed":0}`, nil
	}
	cfg := Config{
		Resolve: func(context.Context, string) (Provider, error) { return nil, errors.New("no provider needed") },
		Store:   st, Sessions: st,
		Aux: &AuxiliaryConfig{Race: raceHandler, Shapes: shapesHandler, RaceChunk: 1},
	}

	// Chunk 1: the race candidate is evaluated (checkpointed), shapes settle.
	out, err := runExecutor(t, cfg, backfillJob(sess, storage.OnboardingSyncStageAuxiliary))
	if err != nil {
		t.Fatalf("auxiliary chunk 1: %v", err)
	}
	var res onboardingsync.StageResult
	_ = json.Unmarshal([]byte(out), &res)
	if res.Status != onboardingsync.StageStatusInProgress {
		t.Fatalf("chunk 1 status = %s, want in_progress (race item still settling)", res.Status)
	}
	if len(raceSaw) != 1 || len(raceSaw[0]) != 1 {
		t.Fatalf("race handler saw %v, want exactly one candidate in chunk 1", raceSaw)
	}
	auxItems := listItems(t, st, sess.SessionID, storage.OnboardingSyncStageAuxiliary)
	if itemOf(auxItems, storage.OnboardingSyncItemKindRouteShapes).Status != storage.OnboardingSyncItemDone {
		t.Fatalf("route shapes item = %s, want done after one pass", itemOf(auxItems, storage.OnboardingSyncItemKindRouteShapes).Status)
	}

	// Chunk 2: the evaluated candidate no longer blocks; the stage completes.
	out2, err := runExecutor(t, cfg, backfillJob(sess, storage.OnboardingSyncStageAuxiliary))
	if err != nil {
		t.Fatalf("auxiliary chunk 2: %v", err)
	}
	_ = json.Unmarshal([]byte(out2), &res)
	if res.Status != storage.OnboardingSyncCoverageCompleted {
		t.Fatalf("chunk 2 status = %s, want completed", res.Status)
	}
	if len(raceSaw) != 2 || len(raceSaw[1]) != 1 {
		t.Errorf("race handler batches = %v, want the second candidate alone in chunk 2", raceSaw)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

func listItems(t *testing.T, st *storage.Store, sessionID, stage string) []*storage.OnboardingSyncWorkItem {
	t.Helper()
	items, err := st.ListOnboardingSyncWorkItems(context.Background(), sessionID, stage)
	if err != nil {
		t.Fatalf("list items: %v", err)
	}
	return items
}

func itemOf(items []*storage.OnboardingSyncWorkItem, kind string) *storage.OnboardingSyncWorkItem {
	for _, it := range items {
		if it.Kind == kind {
			return it
		}
	}
	return nil
}

func markAllItemsTerminal(t *testing.T, st *storage.Store, sessionID, stage string) {
	t.Helper()
	items := listItems(t, st, sessionID, stage)
	for _, it := range items {
		cred := fmt.Sprintf("coros:v1:range:%s:%s..%s:obs=%s..%s:n=1", it.Kind, it.RangeFrom, it.RangeTo, it.RangeFrom, it.RangeTo)
		if err := st.MarkOnboardingSyncWorkItem(context.Background(), it.ID, storage.OnboardingSyncItemDone, cred, nil); err != nil {
			t.Fatalf("mark item: %v", err)
		}
	}
}

func mustUUID(t *testing.T) string {
	t.Helper()
	return uuid.NewString()
}

func mustDay(t *testing.T, day string) time.Time {
	t.Helper()
	tm, err := time.Parse("2006-01-02", day)
	if err != nil {
		t.Fatalf("day %q: %v", day, err)
	}
	return tm.Add(12 * time.Hour).UTC()
}

func ptrFloat(v float64) *float64 { return &v }

func fmtPtr(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func setCoverage(t *testing.T, st *storage.Store, sessionID, stage, status, from, to string) {
	t.Helper()
	cov, err := st.GetOnboardingSyncStageCoverage(context.Background(), sessionID, stage)
	if err != nil || cov == nil {
		t.Fatalf("coverage: %v", err)
	}
	cov.Status = status
	cov.ObservedFrom, cov.ObservedTo = &from, &to
	cov.ScannedFrom, cov.ScannedTo = &from, &to
	if err := st.UpdateOnboardingSyncStageCoverage(context.Background(), cov); err != nil {
		t.Fatalf("coverage update: %v", err)
	}
}
