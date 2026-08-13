package storage

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRaceTableStoresOnlyActivityReference(t *testing.T) {
	if got := (Race{}).TableName(); got != "races" {
		t.Fatalf("table = %q", got)
	}
	if got := reflect.TypeOf(Race{}).NumField(); got != 3 {
		t.Fatalf("Race has %d fields, want only user_id, label_id, created_at", got)
	}
}

func TestRaceCandidatesFiltersAndSkipsConfirmed(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid := uuid.NewString()
	pauses := `[{"startTimestamp":171002790000,"endTimestamp":171002791234,"duration":1234}]`
	defer func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Race{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	}()

	activities := []Activity{
		{UserID: uid, LabelID: "hm", Name: strptr("Half effort"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(20_900), Pauses: &pauses, Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "fm-track", Name: strptr("Track marathon"), SportType: 100, Sport: strptr("run_track"), DistanceM: fptr(44_000), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "long-30k", SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(30_000), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "indoor-hm", SportType: 100, Sport: strptr("run_indoor"), DistanceM: fptr(21_100), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
	}
	for i := range activities {
		var points []TimeseriesPoint
		if activities[i].LabelID == "hm" {
			points = []TimeseriesPoint{
				{GPSLat: fptr(0), GPSLon: fptr(0)},
				{GPSLat: fptr(95), GPSLon: fptr(121.47)},
				{GPSLat: fptr(31.2304), GPSLon: fptr(121.4737)},
				{GPSLat: fptr(31.2400), GPSLon: fptr(121.4800)},
			}
		} else if activities[i].LabelID == "fm-track" {
			points = []TimeseriesPoint{{GPSLat: fptr(39.9042), GPSLon: fptr(116.4074)}}
		}
		if err := st.UpsertActivity(ctx, &activities[i], nil, points, nil); err != nil {
			t.Fatalf("upsert %s: %v", activities[i].LabelID, err)
		}
	}

	starts, err := st.ActivityStartCoordinates(ctx, uid)
	if err != nil {
		t.Fatalf("activity start coordinates: %v", err)
	}
	if len(starts) != 2 || starts[0].Latitude != 31.2304 || starts[0].Longitude != 121.4737 || starts[1].Latitude != 39.9042 {
		t.Fatalf("activity start coordinates = %+v, want first valid point from each activity", starts)
	}

	all, err := st.RaceCandidates(ctx, uid, nil)
	if err != nil {
		t.Fatalf("all-history candidates: %v", err)
	}
	allIDs := map[string]bool{}
	for _, candidate := range all {
		allIDs[candidate.LabelID] = true
	}
	if len(all) != 2 || !allIDs["hm"] || !allIDs["fm-track"] {
		t.Fatalf("all-history candidates = %+v", all)
	}
	for _, candidate := range all {
		if candidate.LabelID == "hm" && (candidate.Pauses == nil || *candidate.Pauses != pauses) {
			t.Fatalf("HM pause data = %v, want stored activity pauses", candidate.Pauses)
		}
	}
	empty, err := st.RaceCandidates(ctx, uid, []string{})
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty incremental scope = (%+v, %v), want no candidates", empty, err)
	}

	inserted, err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "hm"})
	if err != nil || !inserted {
		t.Fatalf("insert confirmed race: %v", err)
	}
	inserted, err = st.InsertRace(ctx, &Race{UserID: uid, LabelID: "hm"})
	if err != nil || inserted {
		t.Fatalf("duplicate confirmed race: %v", err)
	}
	var raceCount int64
	if err := st.db.WithContext(ctx).Model(&Race{}).Where("user_id = ? AND label_id = ?", uid, "hm").Count(&raceCount).Error; err != nil {
		t.Fatalf("count confirmed race: %v", err)
	}
	if raceCount != 1 {
		t.Fatalf("confirmed race count = %d, want idempotent singleton", raceCount)
	}
	remaining, err := st.RaceCandidates(ctx, uid, []string{"hm", "fm-track", "long-30k"})
	if err != nil {
		t.Fatalf("incremental candidates: %v", err)
	}
	if len(remaining) != 1 || remaining[0].LabelID != "fm-track" {
		t.Fatalf("remaining candidates = %+v", remaining)
	}
}
