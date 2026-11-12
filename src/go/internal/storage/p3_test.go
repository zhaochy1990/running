// p3_test.go covers the post-migration storage behaviors (devops#787/#788):
// points go to the blob while laps and watch zones remain row-backed
// children, and account erasure sweeps the user's blob prefix.
package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/tsstore"
)

// TestUpsertActivity_BlobPointsRowBackedChildren: an upsert with points
// serves them from the blob (stamped pointer columns), while laps and watch
// zones — still relational children — are replaced as rows as before.
func TestUpsertActivity_BlobPointsRowBackedChildren(t *testing.T) {
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
	got := readActivity(t, st, uid, label)
	if got.TsBlobKey == nil || got.TsPointCount == nil || *got.TsPointCount != 2 {
		t.Fatalf("pointer columns = key:%v count:%v, want a stamped key and 2 points", got.TsBlobKey, got.TsPointCount)
	}
	if got.HasGPS == nil || !*got.HasGPS {
		t.Fatalf("has_gps = %v, want true (the points carry a valid fix)", got.HasGPS)
	}
	var lapRows, zoneRows int64
	for m, cnt := range map[any]*int64{&Lap{}: &lapRows, &ActivityWatchZone{}: &zoneRows} {
		if err := st.db.WithContext(ctx).Model(m).Where("user_id = ? AND label_id = ?", uid, label).Count(cnt).Error; err != nil {
			t.Fatalf("count: %v", err)
		}
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
		st.AutoMigratePlanAdjustment,
		st.AutoMigratePlanInjury,
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
