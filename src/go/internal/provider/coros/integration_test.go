package coros

import (
	"context"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// openMySQL connects to a real MySQL if STRIDE_WORKER_TEST_MYSQL_DSN is set,
// otherwise the test is skipped. Matches the storage package's gate.
func openMySQL(t *testing.T) *storage.Store {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run the real-MySQL sync test")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

// TestSyncUser_RealMySQL exercises the entire write pipeline end to end against a
// live MySQL: credential store round-trip, SyncUser (httptest COROS) → real
// GORM upserts → ReconcileActivityRows read-back.
func TestSyncUser_RealMySQL(t *testing.T) {
	st := openMySQL(t)
	ctx := context.Background()
	cs := NewStorageCredentialStore(st)

	const uid = "aa000000-0000-4000-8000-00000000e2e1"
	if err := cs.Save(ctx, uid, Credentials{
		Email: "a@b.com", PwdHash: "h", AccessToken: "tok", Region: "global", UserID: "1",
	}); err != nil {
		t.Fatalf("save creds: %v", err)
	}
	// Credential round-trip through MySQL.
	got, err := cs.Load(ctx, uid)
	if err != nil || got.AccessToken != "tok" || got.UserID != "1" {
		t.Fatalf("load creds = %+v, %v", got, err)
	}

	srv := httptest.NewServer(syncMux(`[{"labelId":"A","sportType":100},{"labelId":"B","sportType":100}]`))
	defer srv.Close()
	factory := func(c Credentials, save CredentialSaver) *Client {
		return NewClient(c,
			WithBases(map[string]string{"global": srv.URL, "cn": srv.URL, "eu": srv.URL}),
			WithHTTPClient(srv.Client()), WithRequestDelay(0), WithCredentialSaver(save))
	}
	p := New(st, cs, WithClientFactory(factory))

	res, err := p.SyncUser(ctx, uid, provider.SyncOptions{Mode: provider.SyncFull, Content: provider.ContentAll})
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	// health = 1 daily_health + 1 dashboard + 1 daily_hrv row (syncMux fixtures).
	if res.Activities != 2 || res.Health != 3 {
		t.Fatalf("result = %+v, want 2 activities / 3 health", res)
	}

	rows, err := st.ReconcileActivityRows(ctx, uid)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	for _, label := range []string{"A", "B"} {
		row, ok := rows[label]
		if !ok {
			t.Fatalf("activity %s not persisted", label)
		}
		if row["sport"] != "run_outdoor" {
			t.Errorf("%s sport = %v, want run_outdoor", label, row["sport"])
		}
		if d, _ := row["distance_m"].(float64); d != 10000 {
			t.Errorf("%s distance_m = %v, want 10000 (cm→m through MySQL)", label, d)
		}
	}

	// Health-domain read-back through MySQL: dashboard singleton, per-day HRV,
	// and race predictions all round-trip via the reconcile readers.
	dash, err := st.ReconcileDashboardRows(ctx, uid)
	if err != nil {
		t.Fatalf("read dashboard: %v", err)
	}
	drow, ok := dash["coros"]
	if !ok {
		t.Fatalf("dashboard row not persisted")
	}
	if v, _ := drow["threshold_hr"].(int64); v != 165 {
		t.Errorf("dashboard threshold_hr = %v, want 165", drow["threshold_hr"])
	}
	if v, _ := drow["weekly_distance_m"].(float64); v != 50000 {
		t.Errorf("dashboard weekly_distance_m = %v, want 50000", drow["weekly_distance_m"])
	}

	hrv, err := st.ReconcileDailyHRVRows(ctx, uid)
	if err != nil {
		t.Fatalf("read daily_hrv: %v", err)
	}
	if hrow, ok := hrv["2026-05-16"]; !ok {
		t.Errorf("daily_hrv row not persisted")
	} else if v, _ := hrow["last_night_avg"].(int64); v != 42 {
		t.Errorf("daily_hrv last_night_avg = %v, want 42", hrow["last_night_avg"])
	}

	preds, err := st.ReconcileRacePredictionRows(ctx, uid)
	if err != nil {
		t.Fatalf("read race_predictions: %v", err)
	}
	if len(preds) != 2 {
		t.Errorf("race_predictions = %d, want 2", len(preds))
	}
	if prow, ok := preds["Marathon"]; !ok {
		t.Errorf("Marathon prediction not persisted")
	} else if v, _ := prow["duration_s"].(float64); v != 10800 {
		t.Errorf("Marathon duration_s = %v, want 10800", prow["duration_s"])
	}
	// re-sync is idempotent: still 2 rows.
	if _, err := p.SyncUser(ctx, uid, provider.SyncOptions{Mode: provider.SyncFull, Content: provider.ContentActivities}); err != nil {
		t.Fatalf("re-sync: %v", err)
	}
	rows2, _ := st.ReconcileActivityRows(ctx, uid)
	if len(rows2) != 2 {
		t.Errorf("after re-sync activities = %d, want 2 (idempotent)", len(rows2))
	}
}
