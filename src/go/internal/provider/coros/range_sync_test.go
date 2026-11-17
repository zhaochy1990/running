// range_sync_test.go covers the COROS recent-range adapter (devops#1008, epic
// devops#1004 T04) at the provider HTTP seam: the independent window scan
// (never stopping at already-known activities), Shanghai-day boundaries, page
// ordering proof, backfill reconciliation, batch-health coverage honesty
// (keep what the vendor returns, gap what it does not), the strict dashboard
// channel, and the error taxonomy (transient vs permanent vs auth).
package coros

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// tsForShanghaiDay returns a COROS detail startTimestamp (centiseconds since
// epoch) for noon of the given Shanghai day, so observed windows are asserted
// on the same day labels the scan classifies by.
func tsForShanghaiDay(day string) int64 {
	t, err := time.ParseInLocation("2006-01-02", day, timefmt.Shanghai)
	if err != nil {
		panic(err)
	}
	return t.Add(12*time.Hour).Unix() * 100
}

// listItemJSON builds one activity/query entry. date is the vendor's YYYYMMDD
// list date (numbers in real payloads; strings parse identically).
func listItemJSON(label, date string, sport int) string {
	return fmt.Sprintf(`{"labelId":%q,"sportType":%d,"date":"%s"}`, label, sport, date)
}

func detailBody(day string) string {
	return fmt.Sprintf(`{"summary":{"sportType":100,"startTimestamp":%d,"distance":1000000,"totalTime":360000}}`, tsForShanghaiDay(day))
}

// rangeMux serves a paged activity list (listJSON per page; page numbers past
// the slice answer empty), a detail endpoint keyed by labelId, and optional
// analyse/dashboard payloads.
type rangeMux struct {
	pages      []string // full pages of the activity list, in page order
	listCalls  atomic.Int64
	detailFor  map[string]string // label -> detail body ("" = default ok)
	analyse    string
	dashboard  string
	dashErr    bool
	analyseErr bool
}

func newRangeMux(pages ...string) *rangeMux {
	return &rangeMux{pages: pages, detailFor: map[string]string{},
		analyse: `{"dayList":[]}`, dashboard: `{"summaryInfo":{"staminaLevel":65}}`}
}

func (m *rangeMux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/activity/query":
		m.listCalls.Add(1)
		page := 0
		fmt.Sscanf(r.URL.Query().Get("pageNumber"), "%d", &page)
		if page >= 1 && page <= len(m.pages) {
			writeEnvelope(w, resultSuccess, `{"dataList":[`+m.pages[page-1]+`]}`)
			return
		}
		writeEnvelope(w, resultSuccess, `{"dataList":[]}`)
	case "/activity/detail/query":
		label := r.URL.Query().Get("labelId")
		if body, ok := m.detailFor[label]; ok {
			if body == "" { // "" = permanent rejection
				writeEnvelope(w, "1031", `{"message":"parameter input error"}`)
			} else {
				writeEnvelope(w, resultSuccess, body)
			}
			return
		}
		writeEnvelope(w, resultSuccess, detailBody("2026-11-01"))
	case "/analyse/query":
		if m.analyseErr {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		writeEnvelope(w, resultSuccess, m.analyse)
	case "/dashboard/query":
		if m.dashErr {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		writeEnvelope(w, resultSuccess, m.dashboard)
	case "/dashboard/detail/query":
		writeEnvelope(w, resultSuccess, `{"currentWeekRecord":{"distanceRecord":50000,"durationRecord":18000}}`)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func runRangeSync(t *testing.T, m *rangeMux, fw storage.Writer, opts provider.RecentRangeOptions) (provider.RecentRangeReport, error) {
	t.Helper()
	p := newTestProvider(t, m, fw)
	return p.SyncRecentRange(context.Background(), testUID, opts, nil)
}

var actWin = provider.DayWindow{From: "2026-08-18", To: "2026-11-16"}
var healthWin = provider.DayWindow{From: "2026-10-19", To: "2026-11-16"}

// AC1: the window scan is independent of the incremental cursor — an activity
// that already exists in the store does not stop the scan; everything in the
// window is fetched, everything below the boundary is not.
func TestSyncRecentRange_ScanDoesNotStopAtExistingActivity(t *testing.T) {
	fw := newFakeWriter()
	// Pre-existing activity (as an earlier incremental sync would have left).
	fw.activities["OLD1"] = &storage.Activity{LabelID: "OLD1"}
	m := newRangeMux(
		// newest→oldest, newest first; OLD1 sits between two unknown labels.
		listItemJSON("NEW1", "20261110", 100) + "," +
			listItemJSON("OLD1", "20260901", 100) + "," +
			listItemJSON("MID1", "20260820", 100) + "," +
			listItemJSON("BELOW", "20260810", 100),
	)
	m.detailFor["NEW1"] = detailBody("2026-11-10")
	m.detailFor["OLD1"] = detailBody("2026-09-01")
	m.detailFor["MID1"] = detailBody("2026-08-20")

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Activities: &actWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	for _, label := range []string{"NEW1", "OLD1", "MID1"} {
		if _, ok := fw.activities[label]; !ok {
			t.Errorf("activity %s not stored", label)
		}
	}
	if _, ok := fw.activities["BELOW"]; ok {
		t.Error("below-window activity must not be fetched")
	}
	a := rep.Activities
	if a == nil {
		t.Fatal("activities report missing")
	}
	if a.Count != 3 {
		t.Errorf("count = %d, want 3", a.Count)
	}
	if a.ScannedFrom != actWin.From || a.ScannedTo != actWin.To {
		t.Errorf("scanned = %s..%s, want %s..%s", a.ScannedFrom, a.ScannedTo, actWin.From, actWin.To)
	}
	// Observed comes from the committed details' Shanghai start days.
	if a.ObservedFrom == nil || *a.ObservedFrom != "2026-08-20" {
		t.Errorf("observed_from = %v, want 2026-08-20", a.ObservedFrom)
	}
	if a.ObservedTo == nil || *a.ObservedTo != "2026-11-10" {
		t.Errorf("observed_to = %v, want 2026-11-10", a.ObservedTo)
	}
	if a.Credential == "" {
		t.Error("complete-fetch credential missing")
	}
	// The walk covered the window but data starts 08-20 and ends 11-10: the
	// uncovered prefix/suffix are recorded as honest gaps, not coverage.
	if a.Status != provider.RangeChannelGap || len(a.Gaps) != 2 ||
		a.Gaps[0].From != "2026-08-18" || a.Gaps[0].To != "2026-08-19" ||
		a.Gaps[1].From != "2026-11-11" || a.Gaps[1].To != "2026-11-16" {
		t.Errorf("status/gaps = %q %+v, want prefix 08-18..08-19 + suffix 11-11..11-16", a.Status, a.Gaps)
	}
	// Newest-first ordered commit（11-17 拍板）: the oldest in-window label (MID1,
	// 08-20) commits last.
	if got := fw.meta["last_label_id"]; got != "MID1" {
		t.Errorf("cursor = %q, want MID1", got)
	}
}

// AC1: the window boundary is the Shanghai natural day — a run starting
// 2026-08-18 01:00 Shanghai belongs to 08-18 even though it is 08-17 in UTC,
// and list dates straddling From decide fetch/no-fetch by the same rule.
func TestSyncRecentRange_BoundaryIsShanghaiNaturalDay(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux(
		listItemJSON("IN1", "20260818", 100) + "," +
			listItemJSON("OUT1", "20260817", 100),
	)
	// IN1's detail starts 2026-08-18 01:00 Shanghai = 2026-08-17 17:00 UTC.
	m.detailFor["IN1"] = fmt.Sprintf(`{"summary":{"sportType":100,"startTimestamp":%d}}`,
		time.Date(2026, 8, 17, 17, 0, 0, 0, time.UTC).Unix()*100)

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Activities: &actWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if _, ok := fw.activities["IN1"]; !ok {
		t.Error("boundary-day activity missing")
	}
	if _, ok := fw.activities["OUT1"]; ok {
		t.Error("day before boundary must not be fetched")
	}
	if got := rep.Activities.ObservedFrom; got == nil || *got != "2026-08-18" {
		t.Errorf("observed_from = %v, want 2026-08-18 (Shanghai day of start)", got)
	}
}

// AC1: when page ordering cannot be proven (an out-of-order item on a full
// page), the scan does NOT trust the first below-boundary item — it pages to
// the list's end and still collects a newer item that arrives on a later page.
func TestSyncRecentRange_UnorderedWalkDoesNotStopAtBoundary(t *testing.T) {
	fw := newFakeWriter()
	// Page 1: a FULL page (rangePageSize items) whose tail dips below the
	// boundary, with one undated item breaking the ordering chain.
	full := ""
	for i := 0; i < rangePageSize; i++ {
		if i > 0 {
			full += ","
		}
		if i == 3 {
			full += fmt.Sprintf(`{"labelId":"UNDATED%d","sportType":100}`, i) // no date → ordering unproven
			continue
		}
		// Days descend from 11-16 into below-boundary territory at the tail.
		day := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -i)
		full += listItemJSON(fmt.Sprintf("P1_%d", i), day.Format("20060102"), 100)
	}
	m := newRangeMux(full,
		// Page 2 carries a mid-window activity AFTER the boundary was crossed.
		listItemJSON("LATE", "20261005", 100),
	)

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Activities: &actWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if _, ok := fw.activities["LATE"]; !ok {
		t.Error("out-of-order walk must still collect the later page's in-window activity")
	}
	if _, ok := fw.activities["UNDATED3"]; !ok {
		t.Error("undated item must still be fetched (detail carries the real date)")
	}
	if rep.Activities.Status != provider.RangeChannelGap {
		// Data does not span the whole window (oldest in-window activity is
		// LATE on 10-05), so the channel honestly reads gap, not done.
		t.Errorf("status = %q, want gap", rep.Activities.Status)
	}
}

// AC1: backfill that appears while the scan paginates is reconciled — the
// end-of-stage pass re-walks the list head and picks up unseen in-window items.
func TestSyncRecentRange_BackfillReconciled(t *testing.T) {
	fw := newFakeWriter()
	var backfilled atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/activity/query", func(w http.ResponseWriter, r *http.Request) {
		page := 0
		fmt.Sscanf(r.URL.Query().Get("pageNumber"), "%d", &page)
		if page != 1 {
			writeEnvelope(w, resultSuccess, `{"dataList":[]}`)
			return
		}
		// First walk: one activity. After the walk, the vendor inserts an
		// older backfilled upload into the SAME page (list head shifted).
		if backfilled.Load() {
			writeEnvelope(w, resultSuccess,
				`{"dataList":[`+listItemJSON("NEW1", "20261115", 100)+`,`+listItemJSON("BACKFILL", "20260901", 100)+`]}`)
			return
		}
		backfilled.Store(true)
		writeEnvelope(w, resultSuccess, `{"dataList":[`+listItemJSON("NEW1", "20261115", 100)+`]}`)
	})
	mux.HandleFunc("/activity/detail/query", func(w http.ResponseWriter, r *http.Request) {
		label := r.URL.Query().Get("labelId")
		day := "2026-11-15"
		if label == "BACKFILL" {
			day = "2026-09-01"
		}
		writeEnvelope(w, resultSuccess, detailBody(day))
	})
	mux.HandleFunc("/analyse/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"dayList":[]}`)
	})
	p := newTestProvider(t, mux, fw)

	rep, err := p.SyncRecentRange(context.Background(), testUID, provider.RecentRangeOptions{Activities: &actWin}, nil)
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if _, ok := fw.activities["BACKFILL"]; !ok {
		t.Error("backfilled activity not reconciled")
	}
	if rep.Activities.Count != 2 {
		t.Errorf("count = %d, want 2", rep.Activities.Count)
	}
}

// AC3: a batch health payload larger than the target window is kept whole and
// the observed window reflects the actual coverage — never trimmed to target.
func TestSyncRecentRange_HealthKeepsMoreThanTarget(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux()
	m.analyse = `{"dayList":[
		{"date":"2026-09-01","testRhr":48},
		{"date":"2026-10-20","testRhr":50},
		{"date":"2026-11-16","testRhr":52}]}`

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Health: &healthWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if len(fw.health) != 3 {
		t.Errorf("stored health days = %d, want 3 (all returned days kept)", len(fw.health))
	}
	h := rep.Health
	if h.Status != provider.RangeChannelDone {
		t.Errorf("status = %q, want done", h.Status)
	}
	if h.ObservedFrom == nil || *h.ObservedFrom != "2026-09-01" || h.ObservedTo == nil || *h.ObservedTo != "2026-11-16" {
		t.Errorf("observed = %v..%v, want 2026-09-01..2026-11-16", h.ObservedFrom, h.ObservedTo)
	}
	if len(h.Gaps) != 0 {
		t.Errorf("gaps = %+v, want none (observed covers target)", h.Gaps)
	}
}

// AC3: a short vendor answer is not promised as coverage — the missing target
// prefix is recorded as a gap while the returned days are kept.
func TestSyncRecentRange_HealthShortWindowRecordsGap(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux()
	m.analyse = `{"dayList":[
		{"date":"2026-10-25","testRhr":50},
		{"date":"2026-11-16","testRhr":52}]}`

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Health: &healthWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if len(fw.health) != 2 {
		t.Errorf("stored health days = %d, want 2", len(fw.health))
	}
	h := rep.Health
	if h.Status != provider.RangeChannelGap {
		t.Errorf("status = %q, want gap", h.Status)
	}
	if len(h.Gaps) != 1 {
		t.Fatalf("gaps = %+v, want the missing prefix", h.Gaps)
	}
	if h.Gaps[0].From != "2026-10-19" || h.Gaps[0].To != "2026-10-24" {
		t.Errorf("gap = %s..%s, want 2026-10-19..2026-10-24", h.Gaps[0].From, h.Gaps[0].To)
	}
	if h.Gaps[0].Reason == "" {
		t.Error("gap reason missing")
	}
}

// Regression (devops#1008 D1): when the vendor leaves dayList's date empty and
// the happenDay number carries the day as a compact YYYYMMDD, the health
// channel's day labels must be normalized to ISO across the whole chain —
// ordering, observed window, credential and the stored daily_health primary
// key must never leak a compact label or produce an inverted gap range.
func TestSyncRecentRange_HealthCompactDayLabelsNormalizedToISO(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux()
	// Newest, an ISO-labelled day, and a compact-labelled day interleaved: the
	// mixed formats are exactly what breaks naive string ordering.
	m.analyse = `{"dayList":[
		{"happenDay":20261116,"testRhr":52},
		{"date":"2026-11-05","testRhr":51},
		{"happenDay":20261020,"testRhr":50}]}`

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Health: &healthWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	h := rep.Health
	if h == nil {
		t.Fatal("health report missing")
	}
	if h.ObservedFrom == nil || *h.ObservedFrom != "2026-10-20" ||
		h.ObservedTo == nil || *h.ObservedTo != "2026-11-16" {
		t.Errorf("observed = %v..%v, want 2026-10-20..2026-11-16 (compact labels normalized before ordering)",
			h.ObservedFrom, h.ObservedTo)
	}
	if !strings.Contains(h.Credential, "obs=2026-10-20..2026-11-16") {
		t.Errorf("credential = %q, want ISO observed window inside the credential", h.Credential)
	}
	// Only the target prefix 10-19 is missing: no inverted or widened gaps from
	// mis-ordered labels.
	if len(h.Gaps) != 1 || h.Gaps[0].From != "2026-10-19" || h.Gaps[0].To != "2026-10-19" {
		t.Errorf("gaps = %+v, want only the 2026-10-19 missing prefix", h.Gaps)
	}
	for _, day := range []string{"2026-10-20", "2026-11-05", "2026-11-16"} {
		if _, ok := fw.health[day]; !ok {
			t.Errorf("daily_health row %s not stored under its ISO date", day)
		}
	}
	if len(fw.health) != 3 {
		t.Errorf("stored health days = %d, want 3", len(fw.health))
	}
}

// A fully-walked window with nothing in it is a recorded no-data truth, not a
// silent full-coverage claim (observed stays nil; the gap carries the reason).
func TestSyncRecentRange_EmptyWindowsRecordNoDataGaps(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux() // empty list, empty analyse

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Activities: &actWin, Health: &healthWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if rep.Activities.Status != provider.RangeChannelGap || len(rep.Activities.Gaps) != 1 ||
		rep.Activities.Gaps[0].From != actWin.From || rep.Activities.Gaps[0].To != actWin.To {
		t.Errorf("activities = %+v, want window-wide no-data gap", rep.Activities)
	}
	if rep.Activities.ObservedFrom != nil {
		t.Error("observed must stay nil when nothing committed")
	}
	if rep.Health.Status != provider.RangeChannelGap || len(rep.Health.Gaps) != 1 {
		t.Errorf("health = %+v, want window-wide gap", rep.Health)
	}
}

// AC2/AC4: a permanently rejected detail (COROS 1031) becomes a one-day gap —
// the rest of the window still commits and the channel never errors out.
func TestSyncRecentRange_PermanentDetailRejectionRecordsGap(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux(listItemJSON("OK1", "20261101", 100) + "," + listItemJSON("REJ", "20261001", 100))
	m.detailFor["REJ"] = "" // permanent rejection
	m.detailFor["OK1"] = detailBody("2026-11-01")

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Activities: &actWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v (permanent rejection must not fail the run)", err)
	}
	if _, ok := fw.activities["OK1"]; !ok {
		t.Error("healthy activity must still commit")
	}
	if _, ok := fw.activities["REJ"]; ok {
		t.Error("rejected activity must not be stored")
	}
	a := rep.Activities
	if a.Status != provider.RangeChannelGap {
		t.Errorf("status = %q, want gap", a.Status)
	}
	// The rejection day falls inside the window's empty prefix (nothing older
	// than OK1 exists), so the coalesced gaps are prefix + suffix with the
	// rejection's reason folded in.
	if len(a.Gaps) != 2 {
		t.Fatalf("gaps = %+v, want coalesced prefix+suffix", a.Gaps)
	}
	if a.Gaps[0].From != actWin.From || a.Gaps[0].To != "2026-10-31" {
		t.Errorf("prefix gap = %s..%s, want %s..2026-10-31", a.Gaps[0].From, a.Gaps[0].To, actWin.From)
	}
	if !containsReason(a.Gaps, "REJ") {
		t.Errorf("gaps = %+v, want the rejection reason folded in", a.Gaps)
	}
	if a.Count != 1 {
		t.Errorf("count = %d, want 1", a.Count)
	}
}

func containsReason(gaps []provider.RangeGap, substr string) bool {
	for _, g := range gaps {
		if strings.Contains(g.Reason, substr) {
			return true
		}
	}
	return false
}

// AC4 (regression): a mid-window store failure must NOT yield a done
// activities report — a partial window never earns a complete-fetch
// credential; the error is the run's and the retry re-fetches idempotently.
func TestSyncRecentRange_PartialCommitNeverReportsDone(t *testing.T) {
	fw := newFakeWriter()
	var writes atomic.Int32
	fw.failUpsertOn = func(string) bool { return writes.Add(1) == 2 } // fail the 2nd write
	m := newRangeMux(listItemJSON("A1", "20261101", 100) + "," + listItemJSON("A2", "20261105", 100))
	m.detailFor["A1"] = detailBody("2026-11-01")
	m.detailFor["A2"] = detailBody("2026-11-05")

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Activities: &actWin})
	if err == nil {
		t.Fatal("mid-window store failure must surface as an error")
	}
	if rep.Activities != nil {
		t.Errorf("activities report = %+v, want nil (partial window is not done)", rep.Activities)
	}
}

// AC4: a transient failure (5xx) after the client's in-place retries fails the
// channel — but channels that already finished keep their reports so the
// executor can persist their complete-fetch credentials.
func TestSyncRecentRange_TransientFailureKeepsEarlierChannels(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux(listItemJSON("NEW1", "20261110", 100))
	m.analyseErr = true

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Activities: &actWin, Health: &healthWin})
	if err == nil {
		t.Fatal("transient health failure must surface as an error")
	}
	if rep.Activities == nil || rep.Activities.Count != 1 || rep.Activities.Credential == "" {
		t.Errorf("activities report = %+v, want a terminal outcome with credential (finished before the failure)", rep.Activities)
	}
	if rep.Health != nil {
		t.Errorf("health report = %+v, want nil (channel failed)", rep.Health)
	}
}

// AC4: the onboarding dashboard channel is strict — a fetch failure fails the
// run instead of the periodic sync's best-effort swallow.
func TestSyncRecentRange_DashboardFailureFailsRun(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux()
	m.dashErr = true
	day := provider.DayWindow{From: "2026-11-16", To: "2026-11-16"}

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Dashboard: &day})
	if err == nil {
		t.Fatal("dashboard fetch failure must fail the run")
	}
	if rep.Dashboard != nil {
		t.Errorf("dashboard report = %+v, want nil", rep.Dashboard)
	}
}

// AC4: auth failures classify through the provider sentinel so the executor
// maps them to permanent job errors.
func TestSyncRecentRange_AuthFailureClassifies(t *testing.T) {
	fw := newFakeWriter()
	mux := http.NewServeMux()
	tokenCode := func(w http.ResponseWriter, _ *http.Request) {
		writeEnvelope(w, "0101", `{}`) // token-invalid family
	}
	mux.HandleFunc("/activity/query", tokenCode)
	mux.HandleFunc("/account/login", func(w http.ResponseWriter, _ *http.Request) {
		writeEnvelope(w, "0101", `{}`) // relogin rejected → AuthError
	})
	p := newTestProvider(t, mux, fw)

	_, err := p.SyncRecentRange(context.Background(), testUID, provider.RecentRangeOptions{Activities: &actWin}, nil)
	if err == nil {
		t.Fatal("expected auth error")
	}
	if !provider.IsAuthError(err) {
		t.Errorf("err = %v, want provider.IsAuthError", err)
	}
}

// AC2: an activity whose detail legitimately carries no curves commits fine
// (empty timeseries ≠ fetch failure) — the channel stays error-free; only the
// window's honest empty ranges gap.
func TestSyncRecentRange_LegitimateNoCurvesCommits(t *testing.T) {
	fw := newFakeWriter()
	m := newRangeMux(listItemJSON("NOCURVE", "20261101", 100))
	m.detailFor["NOCURVE"] = `{"summary":{"sportType":100,"startTimestamp":` +
		fmt.Sprint(tsForShanghaiDay("2026-11-01")) + `}}` // no frequencyList

	rep, err := runRangeSync(t, m, fw, provider.RecentRangeOptions{Activities: &actWin})
	if err != nil {
		t.Fatalf("SyncRecentRange: %v", err)
	}
	if _, ok := fw.activities["NOCURVE"]; !ok {
		t.Error("no-curve activity must commit")
	}
	for _, g := range rep.Activities.Gaps {
		if strings.Contains(g.Reason, "NOCURVE") || strings.Contains(g.Reason, "permanently") {
			t.Errorf("gap = %+v; a legitimate no-curve activity is not a gap", g)
		}
	}
}
