// backfill_test.go covers the COROS chunked backfill adapter (devops#1010)
// at the provider HTTP seam: budget-bounded chunks with a day checkpoint,
// existence-skipping walks (already-stored rows — recent-stage or webhook
// writes — are never re-fetched), the full-list completion reconciliation
// including the overflow reset, and the single-request health channel.
package coros

import (
	"context"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// backfillWin spans 2026-05-20..2026-08-18 (the extended window shape).
var backfillWin = provider.DayWindow{From: "2026-05-20", To: "2026-08-18"}

func compactDate(day string) string { return day[0:4] + day[5:7] + day[8:10] }

// countingMux wraps the range mux and counts detail-endpoint hits.
type countingMux struct {
	*rangeMux
	details atomic.Int64
}

func (c *countingMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/activity/detail/query" {
		c.details.Add(1)
	}
	c.rangeMux.ServeHTTP(w, r)
}

// manyItems builds missing in-window list entries on the given days, newest
// first.
func manyItems(prefix string, days []string) string {
	out := ""
	for i, d := range days {
		if i > 0 {
			out += ","
		}
		out += listItemJSON(fmt.Sprintf("%s%d", prefix, i), compactDate(d), 100)
	}
	return out
}

func runBackfill(t *testing.T, m http.Handler, fw storage.Writer, opts provider.BackfillRangeOptions) (provider.BackfillRangeReport, error) {
	t.Helper()
	p := newTestProvider(t, m, fw)
	return p.SyncBackfillRange(context.Background(), testUID, opts, nil)
}

func TestSyncBackfillRange_DoesNotRequestRejectedDetailsDuringReconciliation(t *testing.T) {
	m := &countingMux{rangeMux: newRangeMux(manyItems("rejected", []string{"2026-08-18", "2026-08-17"}))}
	m.detailFor["rejected0"], m.detailFor["rejected1"] = "", ""
	writer := newFakeWriter()
	opts := provider.BackfillRangeOptions{Activities: &backfillWin, Budget: provider.BackfillBudget{MaxActivityFetches: 1}}

	first, err := runBackfill(t, m, writer, opts)
	if err != nil || first.Activities == nil || first.Activities.Done || len(first.Activities.GapEvents) != 1 || m.details.Load() != 1 {
		t.Fatalf("first chunk = %+v, requests = %d, err = %v", first.Activities, m.details.Load(), err)
	}
	opts.ActivitiesCheckpoint = first.Activities.Checkpoint
	opts.RejectedActivityIDs = make(map[string]bool)
	provider.RememberRejectedActivities(opts.RejectedActivityIDs, first.Activities.GapEvents)
	second, err := runBackfill(t, m, writer, opts)
	if err != nil || second.Activities == nil || !second.Activities.Done || len(second.Activities.GapEvents) != 1 || m.details.Load() != 2 {
		t.Fatalf("second chunk = %+v, requests = %d, err = %v", second.Activities, m.details.Load(), err)
	}
}

// AC2: one chunk fetches at most the budget, checkpoints at the last
// processed day, and the next chunk resumes behind it without re-fetching
// what the first chunk committed.
func TestSyncBackfillRange_ChunkBudgetCheckpointResume(t *testing.T) {
	fw := newFakeWriter()
	days := []string{
		"2026-08-18", "2026-08-17", "2026-08-16", "2026-08-15", "2026-08-14",
		"2026-08-13", "2026-08-12", "2026-08-11", "2026-08-10", "2026-08-09",
		"2026-08-08", "2026-08-07", "" + "2026-08-06", "2026-08-05", "2026-08-04",
		"2026-08-03", "2026-08-02", "2026-08-01", "2026-07-31", "2026-07-30",
		"2026-07-29", "2026-07-28", "2026-07-27", "2026-07-26", "2026-07-25",
	}
	m := &countingMux{rangeMux: newRangeMux(manyItems("L", days))}
	for i, d := range days {
		m.detailFor[fmt.Sprintf("L%d", i)] = detailBody(d)
	}

	rep, err := runBackfill(t, m, fw, provider.BackfillRangeOptions{
		Activities: &backfillWin,
		Budget:     provider.BackfillBudget{MaxActivityFetches: 20},
	})
	if err != nil {
		t.Fatalf("chunk 1: %v", err)
	}
	a := rep.Activities
	if a == nil || a.Done {
		t.Fatalf("chunk 1 activities = %+v, want not done", a)
	}
	if a.Fetches != 20 {
		t.Errorf("chunk 1 fetches = %d, want 20 (budget)", a.Fetches)
	}
	if !a.Advanced {
		t.Error("chunk 1 must report progress")
	}
	// Checkpoint = the 20th item's day; the five older days remain.
	if a.ScannedThrough != "2026-07-30" {
		t.Errorf("scanned through = %q, want 2026-07-30", a.ScannedThrough)
	}
	if len(fw.activities) != 20 {
		t.Fatalf("stored after chunk 1 = %d, want 20", len(fw.activities))
	}

	// Chunk 2 resumes from the checkpoint: the 20 committed rows are skipped
	// on date alone (no detail calls), the remaining five fetch, the walk
	// reaches the list end with a clean reconcile → Done.
	before := m.details.Load()
	rep2, err := runBackfill(t, m, fw, provider.BackfillRangeOptions{
		Activities:           &backfillWin,
		ActivitiesCheckpoint: a.Checkpoint,
		Budget:               provider.BackfillBudget{MaxActivityFetches: 20},
	})
	if err != nil {
		t.Fatalf("chunk 2: %v", err)
	}
	if !rep2.Activities.Done {
		t.Fatalf("chunk 2 = %+v, want done", rep2.Activities)
	}
	if rep2.Activities.Fetches != 5 {
		t.Errorf("chunk 2 fetches = %d, want 5", rep2.Activities.Fetches)
	}
	if got := m.details.Load() - before; got != 5 {
		t.Errorf("chunk 2 detail calls = %d, want 5 (resume skips committed rows)", got)
	}
	if n := len(fw.activities); n != 25 {
		t.Errorf("stored after chunk 2 = %d, want 25", n)
	}
}

// AC3: already-stored rows (recent-stage or webhook writes) are skipped
// without a re-fetch and still advance the walk.
func TestSyncBackfillRange_SkipsExistingWebhookWrites(t *testing.T) {
	fw := newFakeWriter()
	fw.activities["PRE1"] = &storage.Activity{LabelID: "PRE1"}
	m := &countingMux{rangeMux: newRangeMux(
		listItemJSON("NEW1", "20260810", 100) + "," +
			listItemJSON("PRE1", "20260801", 100) + "," +
			listItemJSON("NEW2", "20260715", 100) + "," +
			listItemJSON("BELOW", "20260501", 100),
	)}
	m.detailFor["NEW1"] = detailBody("2026-08-10")
	m.detailFor["NEW2"] = detailBody("2026-07-15")

	rep, err := runBackfill(t, m, fw, provider.BackfillRangeOptions{
		Activities: &backfillWin,
		Budget:     provider.BackfillBudget{MaxActivityFetches: 20},
	})
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !rep.Activities.Done {
		t.Fatalf("activities = %+v, want done (short window)", rep.Activities)
	}
	if rep.Activities.Fetches != 2 {
		t.Errorf("fetches = %d, want 2 (the stored row must be skipped)", rep.Activities.Fetches)
	}
	if n := m.details.Load(); n != 2 {
		t.Errorf("detail calls = %d, want 2 (no re-fetch of stored rows)", n)
	}
	if _, ok := fw.activities["BELOW"]; ok {
		t.Error("below-window activity must not be fetched")
	}
}

// AC4: when the completion reconciliation finds more missing than the
// remaining budget allows, the checkpoint resets (re-probe the window) instead
// of faking a done window; the next chunk completes.
func TestSyncBackfillRange_ReconcileOverflowResets(t *testing.T) {
	fw := newFakeWriter()
	days := []string{"2026-08-18", "2026-08-17", "2026-08-16", "2026-08-15", "2026-08-14"}
	m := newRangeMux(manyItems("L", days))
	for i, d := range days {
		m.detailFor[fmt.Sprintf("L%d", i)] = detailBody(d)
	}

	// Budget 3 of 5 on one short page: the walk ends, the reconcile finds the
	// two unfetched rows and 0 remaining budget — overflow, checkpoint reset.
	rep, err := runBackfill(t, m, fw, provider.BackfillRangeOptions{
		Activities: &backfillWin,
		Budget:     provider.BackfillBudget{MaxActivityFetches: 3},
	})
	if err != nil {
		t.Fatalf("chunk 1: %v", err)
	}
	if rep.Activities.Done {
		t.Fatal("overflow must not report done")
	}
	if rep.Activities.Checkpoint != "" {
		t.Fatalf("checkpoint after overflow = %q, want empty (full re-probe)", rep.Activities.Checkpoint)
	}
	if !rep.Activities.Advanced {
		t.Error("overflow chunk fetched its budget: it advanced")
	}

	// Chunk 2 (empty checkpoint): the three stored rows skip, the last two
	// fetch, the reconcile is clean → done. Nothing re-downloads.
	rep2, err := runBackfill(t, m, fw, provider.BackfillRangeOptions{
		Activities:           &backfillWin,
		ActivitiesCheckpoint: rep.Activities.Checkpoint,
		Budget:               provider.BackfillBudget{MaxActivityFetches: 3},
	})
	if err != nil {
		t.Fatalf("chunk 2: %v", err)
	}
	if !rep2.Activities.Done || rep2.Activities.Fetches != 2 {
		t.Fatalf("chunk 2 = %+v, want done with 2 fetches", rep2.Activities)
	}
	if n := len(fw.activities); n != 5 {
		t.Errorf("stored = %d, want 5", n)
	}
}

// The COROS health channel is one batch request regardless of the day budget
// (只声明实际可得范围 — the batch returns what it returns).
func TestSyncBackfillRange_HealthBatchSingleChunk(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux()
	m.analyse = `{"dayList":[
		{"date":"2026-11-15","testRhr":50},{"date":"2026-11-14","testRhr":51},
		{"date":"2026-11-13","testRhr":52},{"date":"2026-11-12","testRhr":53},
		{"date":"2026-11-11","testRhr":54},{"date":"2026-11-10","testRhr":55},
		{"date":"2026-11-09","testRhr":56},{"date":"2026-11-08","testRhr":57}
	]}`
	rep, err := runBackfill(t, m, fw, provider.BackfillRangeOptions{
		Health: &provider.DayWindow{From: "2026-08-20", To: "2026-11-16"},
		Budget: provider.BackfillBudget{MaxHealthDays: 7},
	})
	if err != nil {
		t.Fatalf("health chunk: %v", err)
	}
	if !rep.Health.Done || rep.Health.DaysWalked != 8 {
		t.Fatalf("health = %+v, want done with 8 days in one batch chunk", rep.Health)
	}
	if n := len(fw.health); n != 8 {
		t.Errorf("stored health days = %d, want 8", n)
	}
}
