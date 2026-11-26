// recent_test.go covers the Garmin recent-range executor (devops#1007):
// the fixed-window scan rules (range-bounded stop, no exists/limit early
// stop, Shanghai-day partition, unclassifiable-date detail confirmation), the
// completeness policy (provider 404 vs real failure), resume reuse, and the
// anchor-based health/dashboard channels.
package garmin

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

// recentListHandler serves a fixed newest-first activity list.
func recentListHandler(pages map[string]string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := r.URL.Query().Get("start")
		body, ok := pages[start]
		if !ok {
			body = "[]"
		}
		w.Write([]byte(body))
	}
}

func recentActivityJSON(id int, startGMT string) string {
	return fmt.Sprintf(`{"activityId":%d,"activityType":{"typeKey":"running"},"startTimeGMT":%q,"distance":10000.0,"duration":3000.0,"averageSpeed":3.33,"averageHR":150}`, id, startGMT)
}

// fullRecentPage pads a page to the real page size with valid-dated OLDER
// entries (2026-07-15, before every test window), so the walk's paging
// semantics see production-shaped full pages.
func fullRecentPage(items ...string) string {
	page := make([]string, 0, recentListPage)
	page = append(page, items...)
	for len(page) < recentListPage {
		page = append(page, recentActivityJSON(990000+len(page), "2026-07-15 08:00:00"))
	}
	return "[" + strings.Join(page, ",") + "]"
}

func recentOpts(from, to string) provider.RecentRangeOptions {
	return provider.RecentRangeOptions{Activities: &provider.DayWindow{From: from, To: to}}
}

func TestSyncRecentRange_RangeBoundedScanOldToNew(t *testing.T) {
	// Window 2026-08-10..2026-11-07 (Shanghai days). The history spans years;
	// pages 0-1 mix in-range and older items — the walk must stop only at the
	// first ENTIRELY-older page, never at an existing row or a page count.
	pages := map[string]string{
		"0":  fullRecentPage(recentActivityJSON(9001, "2026-11-07 01:30:00"), recentActivityJSON(9002, "2026-10-15 10:00:00")),
		"20": fullRecentPage(recentActivityJSON(9003, "2026-08-10 17:30:00"), recentActivityJSON(9004, "2026-08-09 20:00:00"), recentActivityJSON(8001, "2026-08-09 12:00:00")),
		"40": fullRecentPage(recentActivityJSON(7001, "2024-03-01 08:00:00")), // entirely older page → stop
	}
	var listCalls int
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", func(w http.ResponseWriter, r *http.Request) {
		listCalls++
		recentListHandler(pages).ServeHTTP(w, r)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })

	var order []string
	p, fw := newTestProvider(t, mux, loggedInCreds())
	fw.onActivity = func(label string) { order = append(order, label) }

	rep, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-10", "2026-11-07"), nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	act := rep.Activities
	if act == nil || act.Count != 4 {
		t.Fatalf("activities report = %+v, want 4 written (in-range only, multi-year history not traversed)", act)
	}
	wantOrder := []string{"9001", "9002", "9003", "9004"} // new→old by Shanghai day（11-17 拍板：近期先落库）
	if strings.Join(order, ",") != strings.Join(wantOrder, ",") {
		t.Errorf("commit order = %v, want %v (新→旧有序提交)", order, wantOrder)
	}
	// Days present span the whole window (08-10 … 11-07): observed covers it,
	// no honest-emptiness gaps, channel done.
	if act.ObservedFrom == nil || *act.ObservedFrom != "2026-08-10" || *act.ObservedTo != "2026-11-07" {
		t.Errorf("observed = %+v..%+v, want the whole window", act.ObservedFrom, act.ObservedTo)
	}
	if act.Status != provider.RangeChannelDone || len(act.Gaps) != 0 {
		t.Errorf("status = %q gaps = %+v, want done/none", act.Status, act.Gaps)
	}
	if !strings.HasPrefix(act.Credential, "garmin:v1:range:activities:2026-08-10..2026-11-07:obs=2026-08-10..2026-11-07") {
		t.Errorf("credential = %q, want a range-scoped proof", act.Credential)
	}
	// Two walks (scan + end-of-stage reconciliation), each stopping at the
	// all-older page: 3 pages each.
	if listCalls != 6 {
		t.Errorf("list pages walked = %d, want 6 (2 walks x 3 pages)", listCalls)
	}
	if fw.existsCalls != 4 {
		t.Errorf("ActivityExists calls = %d, want 4 (one per in-range item)", fw.existsCalls)
	}
}

func TestSyncRecentRange_ZeroActivitiesIsAnHonestGap(t *testing.T) {
	// Every list entry predates the window: a fully-walked window with
	// nothing in it is recorded as a window-wide gap (observed ≠ scanned),
	// never silently read as covered.
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities",
		recentListHandler(map[string]string{"0": "[" + recentActivityJSON(1, "2024-01-05 08:00:00") + "]"}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, fw := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-10", "2026-11-07"), nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	act := rep.Activities
	if act == nil || act.Count != 0 || len(fw.activities) != 0 {
		t.Fatalf("report = %+v stored = %d, want 0 written", act, len(fw.activities))
	}
	if act.ObservedFrom != nil || act.ObservedTo != nil {
		t.Errorf("observed = %+v..%+v, want nil (nothing exists)", act.ObservedFrom, act.ObservedTo)
	}
	if act.Status != provider.RangeChannelGap || len(act.Gaps) != 1 ||
		act.Gaps[0].From != "2026-08-10" || act.Gaps[0].To != "2026-11-07" {
		t.Errorf("gaps = %+v status = %q, want one window-wide gap", act.Gaps, act.Status)
	}
}

func TestSyncRecentRange_HonestEmptyPrefixSuffixAreGaps(t *testing.T) {
	// Activities only on 2026-10-15: the empty prefix 08-10..10-14 and suffix
	// 10-16..11-07 are recorded as gaps, and the observed window is only the
	// days data actually exists for.
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities",
		recentListHandler(map[string]string{"0": "[" + recentActivityJSON(9100, "2026-10-15 10:00:00") + "]"}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, _ := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-10", "2026-11-07"), nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	act := rep.Activities
	if act.ObservedFrom == nil || *act.ObservedFrom != "2026-10-15" || *act.ObservedTo != "2026-10-15" {
		t.Fatalf("observed = %+v..%+v, want only 2026-10-15", act.ObservedFrom, act.ObservedTo)
	}
	if act.Status != provider.RangeChannelGap || len(act.Gaps) != 2 {
		t.Fatalf("gaps = %+v status = %q, want prefix+suffix gaps", act.Gaps, act.Status)
	}
	if act.Gaps[0].From != "2026-08-10" || act.Gaps[0].To != "2026-10-14" ||
		act.Gaps[1].From != "2026-10-16" || act.Gaps[1].To != "2026-11-07" {
		t.Errorf("gap ranges = %+v, want the empty prefix and suffix", act.Gaps)
	}
}

func TestSyncRecentRange_ShanghaiDayPartitionBoundary(t *testing.T) {
	// An activity starting 2026-08-16 17:30 GMT belongs to Shanghai day
	// 2026-08-17; a window of exactly 2026-08-17..2026-08-17 must include it
	// while excluding the same-GMT-day 10:00 run (Shanghai 08-16). Range
	// membership follows the Shanghai calendar day, never the GMT prefix.
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", recentListHandler(map[string]string{
		"0": "[" + recentActivityJSON(1001, "2026-08-16 17:30:00") + "," + recentActivityJSON(1002, "2026-08-16 10:00:00") + "]",
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, fw := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-17", "2026-08-17"), nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if rep.Activities.Count != 1 || fw.activities["1001"] == nil {
		t.Errorf("written = %d, want exactly the 17:30 GMT run (Shanghai 08-17)", rep.Activities.Count)
	}
	if fw.activities["1002"] != nil {
		t.Error("the 10:00 GMT run (Shanghai 08-16) must fall outside the window")
	}
}

func TestSyncRecentRange_UnclassifiableDatePhantom404Dropped(t *testing.T) {
	// An epoch-defaulted date is unclassifiable, not "old". A 404 detail is a
	// phantom list entry: dropped, and the rest of the window still commits.
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", recentListHandler(map[string]string{
		"0": "[" + recentActivityJSON(5001, "1970-01-01 00:00:00") + "," + recentActivityJSON(5002, "2026-10-01 08:00:00") + "]",
	}))
	mux.HandleFunc("/activity-service/activity/5001/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusNotFound)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, fw := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-10", "2026-11-07"), nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if rep.Activities.Count != 1 || fw.activities["5002"] == nil {
		t.Errorf("written = %d, want the classifiable activity only", rep.Activities.Count)
	}
	if fw.activities["5001"] != nil {
		t.Error("a phantom list entry must never be written")
	}
}

func TestSyncRecentRange_UnclassifiableDateRecoveredFromDetail(t *testing.T) {
	// The detail payload carries the real startTimeGMT: an undatable summary
	// whose detail dates cleanly rejoins the ordered window (详情确认).
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", recentListHandler(map[string]string{
		"0": "[" + recentActivityJSON(5100, "garbage") + "]",
	}))
	mux.HandleFunc("/activity-service/activity/5100/details", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"startTimeGMT":"2026-10-02 06:00:00","metricDescriptors":[{"key":"directHeartRate","metricsIndex":0}],"activityDetailMetrics":[{"metrics":[150.0]}]}`)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, fw := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-10-01", "2026-10-31"), nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if rep.Activities.Count != 1 || fw.activities["5100"] == nil {
		t.Fatalf("written = %d, want the detail-recovered activity", rep.Activities.Count)
	}
	if rep.Activities.ObservedFrom == nil || *rep.Activities.ObservedFrom != "2026-10-02" {
		t.Errorf("observed = %+v, want 2026-10-02 (the recovered day)", rep.Activities.ObservedFrom)
	}
}

func TestSyncRecentRange_UnclassifiableDateConfirmedBlocks(t *testing.T) {
	// The detail endpoint confirms the entry exists but carries no usable
	// date either: the channel blocks explicitly instead of guessing or
	// skipping (明确阻塞).
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", recentListHandler(map[string]string{
		"0": "[" + recentActivityJSON(6001, "not-a-date") + "]",
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, _ := newTestProvider(t, mux, loggedInCreds())

	_, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-10", "2026-11-07"), nil)
	if !errors.Is(err, provider.ErrUnrecoverableRangeData) {
		t.Fatalf("err = %v, want provider.ErrUnrecoverableRangeData", err)
	}
	if !strings.Contains(err.Error(), "6001") {
		t.Errorf("error must name the blocking ids: %v", err)
	}
}

func TestSyncRecentRange_OutOfOrderPageDoesNotStopEarly(t *testing.T) {
	// A single older item inside a recent page must not end the walk; only an
	// entirely-older page does. Page 0 carries an old item first (order not
	// provable) — page 1 is entirely older.
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", recentListHandler(map[string]string{
		"0":  fullRecentPage(recentActivityJSON(7100, "2024-01-01 00:00:00"), recentActivityJSON(7101, "2026-10-20 08:00:00")),
		"20": fullRecentPage(recentActivityJSON(7000, "2026-01-01 00:00:00")),
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, _ := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-10", "2026-11-07"), nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if rep.Activities.Count != 1 {
		t.Errorf("written = %d, want 1 — the out-of-order old item must not stop the scan", rep.Activities.Count)
	}
}

func TestSyncRecentRange_ProviderMissingDetail404(t *testing.T) {
	// A 404 on the detail endpoint is the vendor legitimately not providing
	// the detail: the activity is still written from its summary, the miss is
	// recorded on the credential, never fabricated and never fatal.
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", recentListHandler(map[string]string{
		"0": "[" + recentActivityJSON(8001, "2026-10-01 08:00:00") + "]",
	}))
	mux.HandleFunc("/activity-service/activity/8001/details", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusNotFound)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, fw := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-10", "2026-11-07"), nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if rep.Activities.Count != 1 {
		t.Errorf("written = %d, want 1", rep.Activities.Count)
	}
	if !strings.Contains(rep.Activities.Credential, "missing=1") {
		t.Errorf("credential = %q, want the provider-missing tally", rep.Activities.Credential)
	}
	if fw.activities["8001"] == nil {
		t.Error("summary row must still be written")
	}
}

func TestSyncRecentRange_DetailFailureFailsRunResumeSkipsExisting(t *testing.T) {
	// A 5xx on the detail endpoint fails the channel with NO report (a
	// partial window never earns a credential); the committed prefix stays;
	// the retried run skips the existing rows without re-downloading their
	// details (不重复下载成功详情).
	base := garminMux()
	failID := "9007"
	detailHits := map[string]int{}
	newList := func() *http.ServeMux {
		m := http.NewServeMux()
		m.HandleFunc("/activitylist-service/activities/search/activities", recentListHandler(map[string]string{
			"0": "[" + recentActivityJSON(9005, "2026-10-01 02:00:00") + "," + recentActivityJSON(9006, "2026-10-05 02:00:00") + "," + recentActivityJSON(9007, "2026-10-09 02:00:00") + "]",
		}))
		m.HandleFunc("/activity-service/activity/", func(w http.ResponseWriter, r *http.Request) {
			parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/activity-service/activity/"), "/")
			aid, suffix := parts[0], parts[len(parts)-1]
			if suffix == "details" {
				detailHits[aid]++
			}
			if aid == failID && suffix == "details" {
				http.Error(w, "boom", http.StatusInternalServerError)
				return
			}
			base.ServeHTTP(w, r)
		})
		m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
		return m
	}
	failMux := newList()
	p, fw := newTestProvider(t, failMux, loggedInCreds())

	opts := recentOpts("2026-09-01", "2026-11-07")
	rep, err := p.SyncRecentRange(context.Background(), testUID, opts, nil)
	if err == nil {
		t.Fatal("first run must fail on the 5xx detail")
	}
	if rep.Activities != nil {
		t.Error("a failed channel must carry no report (no credential for a partial window)")
	}
	// Newest-first（11-17）: the failed item (9007, 10-09, newest) sits at the
	// head of the commit order, so the commit halts before anything persists.
	if got := len(fw.activities); got != 0 {
		t.Fatalf("committed prefix = %d activities, want 0 (新→旧在最新的失败项处立即止步)", got)
	}
	hitsBefore := map[string]int{}
	for k, v := range detailHits {
		hitsBefore[k] = v
	}

	// Retry: the 5xx is gone; nothing was committed by the failed run, so all
	// three are fetched fresh and written.
	p2, fw2 := newTestProvider(t, newList(), loggedInCreds())
	failID = "" // the retried server is healthy
	_ = failID
	for k, v := range fw.activities {
		fw2.activities[k] = v // the retry resumes against the committed prefix
	}

	rep2, err := p2.SyncRecentRange(context.Background(), testUID, opts, nil)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if rep2.Activities.Count != 3 {
		t.Errorf("retry written = %d, want 3 (nothing reused: failed run committed 0)", rep2.Activities.Count)
	}
	if strings.Contains(rep2.Activities.Credential, "reused=") {
		t.Errorf("credential = %q, want no reuse tally (failed run committed nothing)", rep2.Activities.Credential)
	}
	if len(fw2.activities) != 3 {
		t.Errorf("stored = %d, want 3", len(fw2.activities))
	}
	// Nothing was committed by the failed run, so the retry re-fetches all
	// three details; counts grow for every id (the transport may retry the
	// 5xx in place, so "grows" not an exact count).
	for id := range hitsBefore {
		if detailHits[id] <= hitsBefore[id] {
			t.Errorf("detail hits[%s] = %d, want > %d (re-fetched fresh after a zero-commit run)", id, detailHits[id], hitsBefore[id])
		}
	}
	if detailHits["9007"] <= hitsBefore["9007"] {
		t.Errorf("detail hits[9007] = %d, want > %d (the failed activity is re-fetched)", detailHits["9007"], hitsBefore["9007"])
	}
}

func TestSyncRecentRange_HealthAnchorWindowNoFabrication(t *testing.T) {
	// The health walk uses the FIXED anchor window (here: 2026-10-01..10-04,
	// deliberately not "now"), writes only days with signal, and records
	// honestly-empty days as gaps — never fabricated rows. A day is empty
	// only when every per-day endpoint answers 404.
	base := garminMux()
	mux := http.NewServeMux()
	signalDates := map[string]bool{"2026-10-02": true, "2026-10-03": true}
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

	rep, err := p.SyncRecentRange(context.Background(), testUID, provider.RecentRangeOptions{
		Health: &provider.DayWindow{From: "2026-10-01", To: "2026-10-04"},
	}, nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	h := rep.Health
	if h == nil || h.Count != 2 {
		t.Fatalf("health report = %+v, want 2 signal days", h)
	}
	for _, d := range []string{"2026-10-01", "2026-10-04"} {
		if fw.health[d] != nil {
			t.Errorf("day %s must stay unwritten (合法无数据不伪造)", d)
		}
	}
	if fw.health["2026-10-02"] == nil || fw.health["2026-10-03"] == nil {
		t.Error("signal days must be written")
	}
	if h.ObservedFrom == nil || *h.ObservedFrom != "2026-10-02" || *h.ObservedTo != "2026-10-03" {
		t.Errorf("observed = %+v..%+v, want only the signal days", h.ObservedFrom, h.ObservedTo)
	}
	if h.Status != provider.RangeChannelGap || len(h.Gaps) != 2 {
		t.Fatalf("gaps = %+v status = %q, want the two empty days", h.Gaps, h.Status)
	}
	if h.Gaps[0].From != "2026-10-01" || h.Gaps[0].To != "2026-10-01" || h.Gaps[1].From != "2026-10-04" {
		t.Errorf("gap days = %+v, want 10-01 and 10-04", h.Gaps)
	}
}

func TestSyncRecentRange_HealthFailureFailsRun(t *testing.T) {
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/hrv-service/hrv/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	p, _ := newTestProvider(t, mux, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, provider.RecentRangeOptions{
		Health: &provider.DayWindow{From: "2026-10-01", To: "2026-10-02"},
	}, nil)
	if err == nil {
		t.Fatal("a non-404 health failure must fail the channel, not pass silently")
	}
	if rep.Health != nil {
		t.Error("a failed channel must carry no report")
	}
}

func TestSyncRecentRange_DashboardMixedErrorsRemainRetryable(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics-service/metrics/trainingstatus/aggregated/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotImplemented)
	})
	mux.HandleFunc("/hrv-service/hrv/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	})
	mux.Handle("/", garminMux())
	p, _ := newTestProvider(t, mux, loggedInCreds())
	day := provider.DayWindow{From: "2026-10-01", To: "2026-10-01"}
	rep, err := p.SyncRecentRange(context.Background(), testUID, provider.RecentRangeOptions{Dashboard: &day}, nil)
	if err == nil || provider.IsAuthError(err) || isRangeRejection(err) || rep.Dashboard != nil {
		t.Fatalf("dashboard report = %+v, error = %v, want retryable mixed error", rep.Dashboard, err)
	}
}

func TestSyncRecentRange_HealthRetainsRejectionBesideRetryableError(t *testing.T) {
	base := garminMux()
	mux := http.NewServeMux()
	var unsupportedCalls atomic.Int64
	var outage atomic.Bool
	outage.Store(true)
	mux.HandleFunc("/metrics-service/metrics/trainingstatus/aggregated/", func(w http.ResponseWriter, _ *http.Request) {
		unsupportedCalls.Add(1)
		w.WriteHeader(http.StatusNotImplemented)
	})
	mux.HandleFunc("/hrv-service/hrv/", func(w http.ResponseWriter, r *http.Request) {
		if outage.Load() {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		base.ServeHTTP(w, r)
	})
	mux.Handle("/", base)
	p, _ := newTestProvider(t, mux, loggedInCreds())
	day := provider.DayWindow{From: "2026-10-01", To: "2026-10-01"}
	first, err := p.SyncRecentRange(context.Background(), testUID, provider.RecentRangeOptions{Health: &day}, nil)
	if err == nil || first.Health == nil || first.Health.Credential != "" || len(first.Health.Gaps) != 1 {
		t.Fatalf("health = %+v, error = %v, want partial rejection and retryable error", first.Health, err)
	}
	gap := first.Health.Gaps[0]
	if gap.Kind != provider.RangeGapUnavailable || gap.Endpoint != "training_status" || unsupportedCalls.Load() != 1 {
		t.Fatalf("gap = %+v, calls = %d, want one terminal request", gap, unsupportedCalls.Load())
	}
	outage.Store(false)
	second, err := p.SyncRecentRange(context.Background(), testUID, provider.RecentRangeOptions{
		Health: &day, RejectedHealthEndpoints: map[string]map[string]bool{gap.From: {gap.Endpoint: true}},
	}, nil)
	if err != nil || second.Health == nil || second.Health.ObservedTo == nil || unsupportedCalls.Load() != 1 {
		t.Fatalf("health = %+v, error = %v, calls = %d, want successful retry without rejected endpoint", second.Health, err, unsupportedCalls.Load())
	}
}

func TestSyncRecentRange_DashboardOnAnchorDay(t *testing.T) {
	base := garminMux()
	p, fw := newTestProvider(t, base, loggedInCreds())

	rep, err := p.SyncRecentRange(context.Background(), testUID, provider.RecentRangeOptions{
		Dashboard: &provider.DayWindow{From: "2026-10-04", To: "2026-10-04"},
	}, nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	d := rep.Dashboard
	if d == nil || d.Status != provider.RangeChannelDone || d.Count == 0 || fw.dashboards != 1 {
		t.Fatalf("dashboard report = %+v rows = %d, want done/1", d, fw.dashboards)
	}
	if d.ObservedFrom == nil || *d.ObservedFrom != "2026-10-04" {
		t.Errorf("observed = %+v, want anchor day", d.ObservedFrom)
	}
}

func TestSyncRecentRange_AuthFailurePropagates(t *testing.T) {
	p, _ := newTestProvider(t, garminMux(), &captureCreds{seed: Credentials{Email: "a@b.com", Region: "global"}})
	_, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-08-10", "2026-11-07"), nil)
	if !errors.Is(err, provider.ErrAuthRequired) {
		t.Fatalf("err = %v, want provider.ErrAuthRequired", err)
	}
}

func TestSyncRecentRange_SameSecondTieBreaksByLabel(t *testing.T) {
	// Same-instant uploads (same second) order deterministically by label id.
	base := garminMux()
	mux := http.NewServeMux()
	mux.HandleFunc("/activitylist-service/activities/search/activities", recentListHandler(map[string]string{
		"0": "[" + recentActivityJSON(9202, "2026-10-05 02:00:00") + "," + recentActivityJSON(9201, "2026-10-05 02:00:00") + "]",
	}))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { base.ServeHTTP(w, r) })
	var order []string
	p, fw := newTestProvider(t, mux, loggedInCreds())
	fw.onActivity = func(label string) { order = append(order, label) }

	if _, err := p.SyncRecentRange(context.Background(), testUID, recentOpts("2026-10-01", "2026-10-31"), nil); err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if strings.Join(order, ",") != "9201,9202" {
		t.Errorf("same-second commit order = %v, want ascending label ids", order)
	}
}
