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
	meta       map[string]string
}

func newFakeWriter() *fakeWriter {
	return &fakeWriter{
		activities: map[string]*storage.Activity{},
		health:     map[string]*storage.DailyHealth{},
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
func (f *fakeWriter) UpsertDashboard(context.Context, *storage.Dashboard) error           { return nil }
func (f *fakeWriter) UpsertDailyHRV(context.Context, *storage.DailyHRV) error             { return nil }
func (f *fakeWriter) UpsertRacePrediction(context.Context, *storage.RacePrediction) error { return nil }
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
	if res.Health != 1 {
		t.Errorf("health = %d, want 1", res.Health)
	}
	if len(fw.activities) != 2 {
		t.Errorf("stored activities = %d, want 2", len(fw.activities))
	}
	if _, ok := fw.health["2026-05-09"]; !ok {
		t.Errorf("daily_health not stored")
	}
	if got := fw.meta["last_label_id"]; got != "B" {
		t.Errorf("cursor = %q, want B", got)
	}
	// health RHR should prefer testRhr (45)
	if h := fw.health["2026-05-09"]; h.RHR == nil || *h.RHR != 45 {
		t.Errorf("rhr = %v, want 45 (testRhr preferred)", h.RHR)
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
