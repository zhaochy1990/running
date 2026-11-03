// p3_test.go covers the Phase 3 stop-writing-rows behaviors (devops#787):
// laps and watch zones remain row-backed children while timeseries rows are
// frozen, and account erasure sweeps the user's blob prefix.
package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/tsstore"
)

// TestUpsertActivity_Phase3FreezesRowsButKeepsChildTables: an upsert with
// points writes zero timeseries rows, while laps and watch zones — still
// relational children — are replaced as before.
func TestUpsertActivity_Phase3FreezesRowsButKeepsChildTables(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid, label := uuid.NewString(), "p3-rows"
	lat, lon := 31.1, 121.2
	laps := []Lap{{UserID: uid, LabelID: label, LapIndex: 1, LapType: "autoKm", DistanceM: fptr(1000)}}
	zones := []ActivityWatchZone{{UserID: uid, LabelID: label, ZoneType: "hr", ZoneIndex: 1, ZoneTypeRaw: 0, Percent: fptr(25)}}
	points := []TimeseriesPoint{
		{Timestamp: i64ptr(1), GPSLat: &lat, GPSLon: &lon},
		{Timestamp: i64ptr(2), GPSLat: &lat, GPSLon: &lon},
	}
	a := &Activity{UserID: uid, LabelID: label, SportType: 100, Date: time.Now().UTC(), Provider: "coros", SyncedAt: time.Now().UTC()}
	if err := st.UpsertActivity(ctx, a, laps, points, zones); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	var tsRows, lapRows, zoneRows int64
	for m, cnt := range map[any]*int64{&TimeseriesPoint{}: &tsRows, &Lap{}: &lapRows, &ActivityWatchZone{}: &zoneRows} {
		if err := st.db.WithContext(ctx).Model(m).Where("user_id = ? AND label_id = ?", uid, label).Count(cnt).Error; err != nil {
			t.Fatalf("count: %v", err)
		}
	}
	if tsRows != 0 {
		t.Fatalf("timeseries rows = %d, want 0 — the row table is frozen (devops#787)", tsRows)
	}
	if lapRows != 1 || zoneRows != 1 {
		t.Fatalf("lap/zone rows = %d/%d, want 1/1 — child tables stay row-backed", lapRows, zoneRows)
	}
}

// TestDeleteUserData_SweepsTSBlobPrefix: account erasure must clear the
// user's blob prefix on top of the row deletes; another user's blobs survive.
func TestDeleteUserData_SweepsTSBlobPrefix(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	// The erasure sweeps every user-owned table, so the schema must be complete:
	// the api process's boot migration set (minus legal documents, which are
	// not user-owned) — this test must not depend on other files' migrations.
	for _, migrate := range []func(context.Context) error{
		st.AutoMigrateWatch,
		st.AutoMigrateUsers,
		st.AutoMigrateInjuries,
		st.AutoMigrateBodyComposition,
		st.AutoMigrateGoals,
		st.AutoMigrateMasterPlan,
		st.AutoMigrateWeeklyPlan,
		st.AutoMigrateWorkout,
		st.AutoMigrateWeeklyFeedback,
		st.AutoMigrateTeamLikes,
		st.AutoMigrateUserDeletionAudit,
		st.AutoMigrateHomeCity,
		st.AutoMigrateScheduledWorkout,
		st.AutoMigrateRaceCalendar,
		st.AutoMigrateRaceFavorites,
		st.AutoMigrateRacePlans,
		st.AutoMigrateRaceStrategies,
		st.AutoMigrateUserCustomRaces,
		st.AutoMigrateRoadmap,
		st.AutoMigrateFeedback,
		st.AutoMigrateProviderEvents,
	} {
		if err := migrate(ctx); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	}
	erased, bystander := uuid.NewString(), uuid.NewString()
	lat := 31.1
	for _, uid := range []string{erased, bystander} {
		for _, label := range []string{"a1", "a2"} {
			a := &Activity{UserID: uid, LabelID: label, SportType: 100, Date: time.Now().UTC(), Provider: "coros", SyncedAt: time.Now().UTC()}
			if err := st.UpsertActivity(ctx, a, nil, []TimeseriesPoint{{Timestamp: i64ptr(1), GPSLat: &lat, GPSLon: &lat}}, nil); err != nil {
				t.Fatalf("seed %s/%s: %v", uid, label, err)
			}
		}
	}
	blob := st.tsBlob.(*tsstore.MemStore)
	for _, uid := range []string{erased, bystander} {
		for _, label := range []string{"a1", "a2"} {
			if _, err := blob.Get(ctx, tsstore.BlobKey(uid, label)); err != nil {
				t.Fatalf("pre-check blob %s/%s: %v", uid, label, err)
			}
		}
	}

	if err := st.DeleteUserData(ctx, erased); err != nil {
		t.Fatalf("delete user data: %v", err)
	}
	for _, label := range []string{"a1", "a2"} {
		if _, err := blob.Get(ctx, tsstore.BlobKey(erased, label)); err == nil {
			t.Fatalf("erased user's blob %s survived the erasure", label)
		}
		if _, err := blob.Get(ctx, tsstore.BlobKey(bystander, label)); err != nil {
			t.Fatalf("bystander blob %s swept by the erasure: %v", label, err)
		}
	}
}

// seedStockRows inserts timeseries rows directly, bypassing the upsert — the
// only way rows can appear since Phase 3 froze the row table. It simulates
// pre-migration stock for the fallback and reconciliation tests.
func seedStockRows(t *testing.T, st *Store, uid, label string, rows []TimeseriesPoint) {
	t.Helper()
	for i := range rows {
		rows[i].UserID, rows[i].LabelID = uid, label
	}
	if err := st.db.WithContext(context.Background()).Create(&rows).Error; err != nil {
		t.Fatalf("seed stock rows %s/%s: %v", uid, label, err)
	}
}
