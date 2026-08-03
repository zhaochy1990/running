package coros

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

const testUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

// fakeWriter is an in-memory storage.Writer.
type fakeWriter struct {
	activities map[string]*storage.Activity
	health     map[string]*storage.DailyHealth
	hrv        map[string]*storage.DailyHRV
	preds      map[string]*storage.RacePrediction
	dashboard  *storage.Dashboard
	meta       map[string]string
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{
		activities: map[string]*storage.Activity{},
		health:     map[string]*storage.DailyHealth{},
		hrv:        map[string]*storage.DailyHRV{},
		preds:      map[string]*storage.RacePrediction{},
		meta:       map[string]string{},
	}
}

func (f *fakeWriter) ActivityExists(_ context.Context, _, labelID string) (bool, error) {
	_, ok := f.activities[labelID]
	return ok, nil
}
func (f *fakeWriter) UpsertActivity(_ context.Context, a *storage.Activity, _ []storage.Lap, _ []storage.TimeseriesPoint, _ []storage.ActivityWatchZone) error {
	f.activities[a.LabelID] = a
	return nil
}
func (f *fakeWriter) UpsertDailyHealth(_ context.Context, h *storage.DailyHealth) error {
	f.health[h.Date] = h
	return nil
}
func (f *fakeWriter) UpsertDashboard(_ context.Context, d *storage.Dashboard) error {
	f.dashboard = d
	return nil
}
func (f *fakeWriter) UpsertDailyHRV(_ context.Context, h *storage.DailyHRV) error {
	f.hrv[h.Date] = h
	return nil
}
func (f *fakeWriter) UpsertRacePrediction(_ context.Context, p *storage.RacePrediction) error {
	f.preds[p.RaceType] = p
	return nil
}
func (f *fakeWriter) SetMeta(_ context.Context, _, key, value string) error {
	f.meta[key] = value
	return nil
}
func (f *fakeWriter) GetMeta(_ context.Context, _, key string) (string, bool, error) {
	v, ok := f.meta[key]
	return v, ok, nil
}

// fakeCreds returns a logged-in COROS credential.
type fakeCreds struct{}

func (fakeCreds) Load(context.Context, string) (Credentials, error) {
	return Credentials{AccessToken: "tok", Region: "global", UserID: "1", Email: "a@b.com", PwdHash: "h"}, nil
}
func (fakeCreds) Save(context.Context, string, Credentials) error { return nil }

func newTestProvider(t *testing.T, h http.Handler, fw storage.Writer) *Provider {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	factory := func(c Credentials, save CredentialSaver) *Client {
		return NewClient(c,
			WithBases(map[string]string{"global": srv.URL, "cn": srv.URL, "eu": srv.URL}),
			WithHTTPClient(srv.Client()), WithRequestDelay(0), WithCredentialSaver(save))
	}
	return New(fw, fakeCreds{}, WithClientFactory(factory))
}

func syncMux(list string) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/activity/query", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("pageNumber") == "1" {
			writeEnvelope(w, resultSuccess, `{"dataList":`+list+`}`)
			return
		}
		writeEnvelope(w, resultSuccess, `{"dataList":[]}`)
	})
	mux.HandleFunc("/activity/detail/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"summary":{"sportType":100,"startTimestamp":175000000000,"distance":1000000,"totalTime":360000}}`)
	})
	mux.HandleFunc("/analyse/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"dayList":[{"date":"2026-05-09","ati":10,"cti":20,"testRhr":45}]}`)
	})
	mux.HandleFunc("/dashboard/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"summaryInfo":{"staminaLevel":65,"lthr":165,"ltsp":280,`+
			`"sleepHrvData":{"avgSleepHrv":55,"sleepHrvAllIntervalList":[10,20,40,70],`+
			`"sleepHrvList":[{"avgSleepHrv":42,"happenDay":20260516,"sleepHrvIntervalList":[5,26,30,38]}]},`+
			`"runScoreList":[{"type":1,"duration":10800,"avgPace":257},{"type":4,"duration":2400,"avgPace":240}]}}`)
	})
	mux.HandleFunc("/dashboard/detail/query", func(w http.ResponseWriter, r *http.Request) {
		writeEnvelope(w, resultSuccess, `{"currentWeekRecord":{"distanceRecord":50000,"durationRecord":18000}}`)
	})
	return mux
}

func TestSyncUser_FullFlow(t *testing.T) {
	fw := newFakeWriter()
	p := newTestProvider(t, syncMux(`[{"labelId":"A","sportType":100},{"labelId":"B","sportType":100}]`), fw)

	res, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{Mode: provider.SyncIncremental, Content: provider.ContentAll})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Activities != 2 {
		t.Errorf("activities = %d, want 2", res.Activities)
	}
	// health = 1 daily_health + 1 dashboard + 1 daily_hrv row.
	if res.Health != 3 {
		t.Errorf("health = %d, want 3", res.Health)
	}
	if len(fw.activities) != 2 {
		t.Errorf("stored activities = %d, want 2", len(fw.activities))
	}
	if _, ok := fw.health["2026-05-09"]; !ok {
		t.Errorf("daily_health not stored")
	}
	// Detail commits are ordered oldest-first (fetchDetailsOrdered), so the
	// last_label_id cursor advances to the newest activity in the batch. The
	// list is newest-first [A, B], so B (oldest) commits first and A (newest)
	// commits last.
	if got := fw.meta["last_label_id"]; got != "A" {
		t.Errorf("cursor = %q, want A (newest, committed last)", got)
	}
	// health RHR should prefer testRhr (45)
	if h := fw.health["2026-05-09"]; h.RHR == nil || *h.RHR != 45 {
		t.Errorf("rhr = %v, want 45 (testRhr preferred)", h.RHR)
	}
	// dashboard singleton + weekly volume from the detail payload.
	if fw.dashboard == nil {
		t.Fatalf("dashboard not stored")
	}
	if got := derefInt(fw.dashboard.ThresholdHR); got != 165 {
		t.Errorf("dashboard threshold_hr = %v, want 165", got)
	}
	if fw.dashboard.WeeklyDistanceM == nil || *fw.dashboard.WeeklyDistanceM != 50000 {
		t.Errorf("dashboard weekly_distance_m = %v, want 50000", fw.dashboard.WeeklyDistanceM)
	}
	// per-day HRV row + race predictions.
	if _, ok := fw.hrv["2026-05-16"]; !ok {
		t.Errorf("daily_hrv row not stored")
	}
	if len(fw.preds) != 2 {
		t.Errorf("race_predictions = %d, want 2", len(fw.preds))
	}
	if _, ok := fw.preds["Marathon"]; !ok {
		t.Errorf("Marathon prediction not stored")
	}
}

func TestSyncActivities_IncrementalStop(t *testing.T) {
	fw := newFakeWriter()
	// Seed A as already-synced; incremental scan must stop at the first known.
	fw.activities["A"] = &storage.Activity{LabelID: "A"}
	p := newTestProvider(t, syncMux(`[{"labelId":"A","sportType":100},{"labelId":"B","sportType":100}]`), fw)

	res, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{Mode: provider.SyncIncremental, Content: provider.ContentActivities})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Activities != 0 {
		t.Errorf("activities synced = %d, want 0 (stop at known A)", res.Activities)
	}
}

func TestSyncActivities_FullRescanIgnoresKnown(t *testing.T) {
	fw := newFakeWriter()
	fw.activities["A"] = &storage.Activity{LabelID: "A"}
	p := newTestProvider(t, syncMux(`[{"labelId":"A","sportType":100},{"labelId":"B","sportType":100}]`), fw)

	res, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{Mode: provider.SyncFull, Content: provider.ContentActivities})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Activities != 2 {
		t.Errorf("full rescan activities = %d, want 2 (known not skipped)", res.Activities)
	}
}

func TestSyncActivities_DetailErrorCommitsOldestPrefix(t *testing.T) {
	fw := newFakeWriter()
	// List is newest-first: C (newest), B, A (oldest). B's detail fetch fails.
	// Because commits are ordered oldest-first and halt at the first failure,
	// only A (the contiguous prefix before B) is persisted — never C, even
	// though its own fetch succeeds concurrently. That is the invariant that
	// keeps an incremental re-scan (newest-first, stop at first known) from
	// leaving a hole: B and C are both re-fetched next run.
	mux := http.NewServeMux()
	mux.HandleFunc("/activity/query", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("pageNumber") == "1" {
			writeEnvelope(w, resultSuccess, `{"dataList":[`+
				`{"labelId":"C","sportType":100},`+
				`{"labelId":"B","sportType":100},`+
				`{"labelId":"A","sportType":100}]}`)
			return
		}
		writeEnvelope(w, resultSuccess, `{"dataList":[]}`)
	})
	mux.HandleFunc("/activity/detail/query", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("labelId") == "B" {
			writeEnvelope(w, "1234", `{}`) // terminal COROS API error
			return
		}
		writeEnvelope(w, resultSuccess, `{"summary":{"sportType":100,"startTimestamp":175000000000,"distance":1000000,"totalTime":360000}}`)
	})
	p := newTestProvider(t, mux, fw)

	res, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{
		Mode: provider.SyncIncremental, Content: provider.ContentActivities, Jobs: 3,
	})
	if err == nil {
		t.Fatal("want error from the failed B detail fetch")
	}
	if res.Activities != 1 {
		t.Errorf("committed activities = %d, want 1 (only A before the failure)", res.Activities)
	}
	if _, ok := fw.activities["A"]; !ok {
		t.Errorf("A (oldest, before the failure) must be committed")
	}
	if _, ok := fw.activities["B"]; ok {
		t.Errorf("B (failed fetch) must not be committed")
	}
	if _, ok := fw.activities["C"]; ok {
		t.Errorf("C (newer than the failure) must not be committed despite a successful fetch")
	}
	if got := fw.meta["last_label_id"]; got != "A" {
		t.Errorf("cursor = %q, want A (last committed before the failure)", got)
	}
}

func TestSyncUser_EmitsProgress(t *testing.T) {
	fw := newFakeWriter()
	p := newTestProvider(t, syncMux(`[{"labelId":"A","sportType":100},{"labelId":"B","sportType":100}]`), fw)

	var events []provider.SyncProgress
	_, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{
		Mode:    provider.SyncFull,
		Content: provider.ContentAll,
		Progress: func(pr provider.SyncProgress) {
			events = append(events, pr)
		},
	})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}

	var sawActivityFinal, sawHealth bool
	maxPct := -1
	for _, e := range events {
		if e["phase"] == "activities" && e["current"] == 2 && e["total"] == 2 {
			sawActivityFinal = true
		}
		if e["phase"] == "health" {
			sawHealth = true
		}
		if pct, ok := e["percent"].(int); ok && pct > maxPct {
			maxPct = pct
		}
	}
	if !sawActivityFinal {
		t.Errorf("missing activities current=2/total=2 event; got %v", events)
	}
	if !sawHealth {
		t.Errorf("missing health progress event; got %v", events)
	}
	if maxPct < 80 {
		t.Errorf("max percent = %d, want >= 80", maxPct)
	}
}

func TestSyncUser_NilProgressIsSafe(t *testing.T) {
	fw := newFakeWriter()
	p := newTestProvider(t, syncMux(`[{"labelId":"A","sportType":100}]`), fw)
	// Progress unset (nil) must not panic.
	if _, err := p.SyncUser(context.Background(), testUID, provider.SyncOptions{Mode: provider.SyncFull, Content: provider.ContentAll}); err != nil {
		t.Fatalf("sync: %v", err)
	}
}
