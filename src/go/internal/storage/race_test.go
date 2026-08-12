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
	defer func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Race{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	}()

	activities := []Activity{
		{UserID: uid, LabelID: "hm", Name: strptr("Half effort"), SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(20_900), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "fm-track", Name: strptr("Track marathon"), SportType: 100, Sport: strptr("run_track"), DistanceM: fptr(44_000), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "long-30k", SportType: 100, Sport: strptr("run_outdoor"), DistanceM: fptr(30_000), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
		{UserID: uid, LabelID: "indoor-hm", SportType: 100, Sport: strptr("run_indoor"), DistanceM: fptr(21_100), Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
	}
	for i := range activities {
		if err := st.UpsertActivity(ctx, &activities[i], nil, nil, nil); err != nil {
			t.Fatalf("upsert %s: %v", activities[i].LabelID, err)
		}
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
	empty, err := st.RaceCandidates(ctx, uid, []string{})
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty incremental scope = (%+v, %v), want no candidates", empty, err)
	}

	if err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "hm"}); err != nil {
		t.Fatalf("insert confirmed race: %v", err)
	}
	if err := st.InsertRace(ctx, &Race{UserID: uid, LabelID: "hm"}); err != nil {
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
