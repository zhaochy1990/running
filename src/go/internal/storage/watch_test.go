package storage

import (
	"context"
	"testing"
	"time"
)

func TestCanonicalUserID(t *testing.T) {
	const canonical = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"canonical passes", canonical, canonical, false},
		{"uppercase is lowered", "F10BC353-01AB-4DB1-AF9F-D9305EA9A532", canonical, false},
		{"coros numeric id rejected", "1234567890", "", true},
		{"garbage rejected", "not-a-uuid", "", true},
		{"empty rejected", "", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := canonicalUserID(tt.in)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %q", tt.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("canonicalUserID(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestWatchModelTableNames(t *testing.T) {
	cases := map[string]string{
		Activity{}.TableName():           "activities",
		Lap{}.TableName():                "laps",
		TimeseriesPoint{}.TableName():    "timeseries",
		ActivityWatchZone{}.TableName():  "activity_watch_zones",
		DailyHealth{}.TableName():        "daily_health",
		Dashboard{}.TableName():          "dashboard",
		DailyHRV{}.TableName():           "daily_hrv",
		RacePrediction{}.TableName():     "race_predictions",
		SyncMeta{}.TableName():           "sync_meta",
		ProviderCredential{}.TableName(): "provider_credentials",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("TableName = %q, want %q", got, want)
		}
	}
}

func strptr(s string) *string { return &s }
func fptr(f float64) *float64 { return &f }

// TestWatch_UpsertRoundTrip is gated on a live MySQL (STRIDE_WORKER_TEST_MYSQL_DSN).
// It exercises AutoMigrateWatch, an activity+children upsert, idempotent
// re-upsert (children replaced not duplicated), and the sync cursor.
func TestWatch_UpsertRoundTrip(t *testing.T) {
	st := openTestStore(t) // skips without the env var
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}

	const uid = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
	const label = "test-label-1"
	a := &Activity{
		UserID: uid, LabelID: label, SportType: 100,
		Date:      time.Date(2026, 5, 9, 1, 2, 3, 0, time.UTC),
		Sport:     strptr("run_outdoor"),
		DistanceM: fptr(10000),
		Provider:  "coros", SyncedAt: time.Now().UTC(),
	}
	laps := []Lap{{LapIndex: 1, LapType: "autoKm", DistanceM: fptr(1000)}}
	ts := []TimeseriesPoint{{Timestamp: func() *int64 { v := int64(1); return &v }(), HeartRate: func() *int { v := 140; return &v }()}}
	zones := []ActivityWatchZone{{ZoneType: "hr", ZoneIndex: 1, ZoneTypeRaw: 0, Percent: fptr(25)}}

	if err := st.UpsertActivity(ctx, a, laps, ts, zones); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// re-upsert must not duplicate children (delete-then-insert).
	if err := st.UpsertActivity(ctx, a, laps, ts, zones); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	var lapCount int64
	if err := st.db.WithContext(ctx).Model(&Lap{}).
		Where("user_id = ? AND label_id = ?", uid, label).Count(&lapCount).Error; err != nil {
		t.Fatalf("count laps: %v", err)
	}
	if lapCount != 1 {
		t.Errorf("lap count after re-upsert = %d, want 1 (children must be replaced)", lapCount)
	}

	exists, err := st.ActivityExists(ctx, uid, label)
	if err != nil || !exists {
		t.Fatalf("ActivityExists = (%v, %v), want (true, nil)", exists, err)
	}

	if err := st.SetMeta(ctx, uid, "last_label_id", label); err != nil {
		t.Fatalf("set meta: %v", err)
	}
	got, ok, err := st.GetMeta(ctx, uid, "last_label_id")
	if err != nil || !ok || got != label {
		t.Fatalf("GetMeta = (%q, %v, %v), want (%q, true, nil)", got, ok, err, label)
	}
}

// TestProviderForUser is gated on a live MySQL (STRIDE_WORKER_TEST_MYSQL_DSN).
// It verifies the binding read: none -> not found; dual-watch -> most-recent wins.
func TestProviderForUser(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}

	const uid = "a1b2c3d4-0000-4000-8000-0000000000af"

	// No credential yet.
	if _, found, err := st.ProviderForUser(ctx, uid); err != nil || found {
		t.Fatalf("ProviderForUser (empty) = (found=%v, %v), want (false, nil)", found, err)
	}

	// coros first, then garmin later -> most-recent (garmin) wins.
	if err := st.SaveCredential(ctx, &ProviderCredential{UserID: uid, Provider: "coros", Secret: []byte("{}")}); err != nil {
		t.Fatalf("save coros: %v", err)
	}
	time.Sleep(3 * time.Millisecond)
	if err := st.SaveCredential(ctx, &ProviderCredential{UserID: uid, Provider: "garmin", Secret: []byte("{}")}); err != nil {
		t.Fatalf("save garmin: %v", err)
	}

	name, found, err := st.ProviderForUser(ctx, uid)
	if err != nil || !found {
		t.Fatalf("ProviderForUser = (found=%v, %v), want found", found, err)
	}
	if name != "garmin" {
		t.Errorf("ProviderForUser = %q, want garmin (most recent)", name)
	}
}
