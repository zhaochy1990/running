// backfill_test.go covers the Garmin chunked backfill adapter (devops#1010)
// at the provider HTTP seam: budget-bounded activity chunks with day
// checkpoints and existence reuse, the ≤7-day health chunks resuming from
// the checkpoint's next day, and the deep-history undatable-entry gap record
// (continue, not block).
package garmin

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

// backfillPages builds a one-page list whose padding entries sit below the
// window (like fullRecentPage, dated for the 2026-08 window used here).
func backfillPage(items ...string) string {
	page := make([]string, 0, recentListPage)
	page = append(page, items...)
	for len(page) < recentListPage {
		page = append(page, recentActivityJSON(990000+len(page), "2026-05-01 08:00:00"))
	}
	return "[" + strings.Join(page, ",") + "]"
}

// AC2: the chunk budget bounds fetches, the checkpoint lands on the last
// processed day, and the next chunk resumes without re-downloading.
func TestSyncBackfillRange_ActivityChunkBudgetAndResume(t *testing.T) {
	base := garminMux()
	mux := http.NewServeMux()
	win := provider.DayWindow{From: "2026-08-01", To: "2026-08-18"}
	ids := []int{9001, 9002, 9003, 9004, 9005}
	dates := map[int]string{
		9001: "2026-08-18 06:00:00", 9002: "2026-08-16 06:00:00",
		9003: "2026-08-14 06:00:00", 9004: "2026-08-12 06:00:00",
		9005: "2026-08-10 06:00:00",
	}
	items := make([]string, 0, len(ids))
	for _, id := range ids {
		items = append(items, recentActivityJSON(id, dates[id]))
	}
	mux.HandleFunc("/activitylist-service/activities/search/activities",
		recentListHandler(map[string]string{"0": backfillPage(items...)}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, fw := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncBackfillRange(context.Background(), testUID, provider.BackfillRangeOptions{
		Activities: &win,
		Budget:     provider.BackfillBudget{MaxActivityFetches: 3},
	}, nil)
	if err != nil {
		t.Fatalf("chunk 1: %v", err)
	}
	a := rep.Activities
	if a == nil || a.Done || a.Fetches != 3 {
		t.Fatalf("chunk 1 = %+v, want 3 fetches not done", a)
	}
	if a.ScannedThrough != "2026-08-14" {
		t.Errorf("scanned through = %q, want 2026-08-14 (3rd item's day)", a.ScannedThrough)
	}
	if len(fw.activities) != 3 {
		t.Fatalf("stored = %d, want 3", len(fw.activities))
	}

	rep2, err := p.SyncBackfillRange(context.Background(), testUID, provider.BackfillRangeOptions{
		Activities:           &win,
		ActivitiesCheckpoint: a.Checkpoint,
		Budget:               provider.BackfillBudget{MaxActivityFetches: 3},
	}, nil)
	if err != nil {
		t.Fatalf("chunk 2: %v", err)
	}
	if !rep2.Activities.Done || rep2.Activities.Fetches != 2 {
		t.Fatalf("chunk 2 = %+v, want done with 2 fetches", rep2.Activities)
	}
	if len(fw.activities) != 5 {
		t.Errorf("stored = %d, want 5 (nothing re-downloaded)", len(fw.activities))
	}
}

// AC2: the health channel walks ≤ budget days per chunk and resumes at the
// checkpoint's next day; Done only after the window's last day.
func TestSyncBackfillRange_HealthDayChunks(t *testing.T) {
	base := garminMux()
	mux := http.NewServeMux()
	signalDates := map[string]bool{}
	for d := 1; d <= 10; d++ {
		signalDates[fmt.Sprintf("2026-09-%02d", d)] = true
	}
	perDayPrefixes := []string{
		"/metrics-service/metrics/trainingstatus/aggregated/",
		"/usersummary-service/usersummary/daily/",
		"/wellness-service/wellness/dailySleepData/",
		"/hrv-service/hrv/",
	}
	for _, prefix := range perDayPrefixes {
		mux.HandleFunc(prefix, func(w http.ResponseWriter, r *http.Request) {
			var date string
			for _, seg := range strings.Split(strings.Trim(r.URL.Path, "/"), "/") {
				if len(seg) == 10 && seg[4] == '-' && seg[7] == '-' {
					date = seg
				}
			}
			if !signalDates[date] {
				http.Error(w, "no data", http.StatusNotFound)
				return
			}
			base.ServeHTTP(w, r)
		})
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, fw := newTestProvider(t, mux, loggedInCreds())
	win := provider.DayWindow{From: "2026-09-01", To: "2026-09-10"}

	rep, err := p.SyncBackfillRange(context.Background(), testUID, provider.BackfillRangeOptions{
		Health: &win,
		Budget: provider.BackfillBudget{MaxHealthDays: 7},
	}, nil)
	if err != nil {
		t.Fatalf("chunk 1: %v", err)
	}
	h := rep.Health
	if h == nil || h.Done || h.DaysWalked != 7 {
		t.Fatalf("chunk 1 = %+v, want 7 days walked, not done", h)
	}
	if !strings.HasPrefix(h.Checkpoint, cpHealthPrefix) || !strings.HasSuffix(h.Checkpoint, "2026-09-08") {
		t.Errorf("checkpoint = %q, want next day 2026-09-08", h.Checkpoint)
	}
	if len(fw.health) != 7 {
		t.Fatalf("stored = %d, want 7", len(fw.health))
	}

	rep2, err := p.SyncBackfillRange(context.Background(), testUID, provider.BackfillRangeOptions{
		Health:           &win,
		HealthCheckpoint: h.Checkpoint,
		Budget:           provider.BackfillBudget{MaxHealthDays: 7},
	}, nil)
	if err != nil {
		t.Fatalf("chunk 2: %v", err)
	}
	if !rep2.Health.Done || rep2.Health.DaysWalked != 3 {
		t.Fatalf("chunk 2 = %+v, want done with 3 days", rep2.Health)
	}
	if len(fw.health) != 10 {
		t.Errorf("stored = %d, want 10", len(fw.health))
	}
}

// An undatable entry DEEP IN HISTORY records a gap event and the walk
// continues (devops#1010's documented deviation from the recent window's
// block): one vendor garbage row must not fail a years-deep backfill.
func TestSyncBackfillRange_UndatableDeepEntryRecordsGapAndContinues(t *testing.T) {
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities",
		recentListHandler(map[string]string{"0": backfillPage(
			recentActivityJSON(7001, "2026-08-15 06:00:00"),
			`{"activityId":7002,"activityType":{"typeKey":"running"},"startTimeGMT":"","distance":10000.0,"duration":3000.0}`,
		)}))
	// The detail endpoints answer garbage (no startTimeGMT) for 7002.
	mux.HandleFunc("/activity-service/activity/7002/details", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"activityDetailMetrics":[]}`))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, fw := newTestProvider(t, mux, loggedInCreds())

	win := provider.DayWindow{From: "2026-08-01", To: "2026-08-18"}
	rep, err := p.SyncBackfillRange(context.Background(), testUID, provider.BackfillRangeOptions{
		Activities: &win,
		Budget:     provider.BackfillBudget{MaxActivityFetches: 10},
	}, nil)
	if err != nil {
		t.Fatalf("backfill must not fail on the undatable entry: %v", err)
	}
	if !rep.Activities.Done {
		t.Fatalf("activities = %+v, want done", rep.Activities)
	}
	if fw.activities["7001"] == nil {
		t.Error("the healthy entry must be committed")
	}
	if len(rep.Activities.GapEvents) != 1 {
		t.Fatalf("gap events = %+v, want the one undatable entry", rep.Activities.GapEvents)
	}
}
