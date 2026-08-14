package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestActivityStartGPSBackfillOptionsValidate(t *testing.T) {
	valid := ActivityStartGPSBackfillOptions{
		UserIDs: []string{uuid.NewString()}, BatchSize: 25, Delay: 25 * time.Millisecond,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid options: %v", err)
	}

	tests := []struct {
		name string
		edit func(*ActivityStartGPSBackfillOptions)
	}{
		{"no users", func(o *ActivityStartGPSBackfillOptions) { o.UserIDs = nil }},
		{"invalid user", func(o *ActivityStartGPSBackfillOptions) { o.UserIDs = []string{"not-a-uuid"} }},
		{"zero batch", func(o *ActivityStartGPSBackfillOptions) { o.BatchSize = 0 }},
		{"large batch", func(o *ActivityStartGPSBackfillOptions) { o.BatchSize = 501 }},
		{"negative delay", func(o *ActivityStartGPSBackfillOptions) { o.Delay = -time.Millisecond }},
		{"negative limit", func(o *ActivityStartGPSBackfillOptions) { o.Limit = -1 }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			o := valid
			o.UserIDs = append([]string(nil), valid.UserIDs...)
			tt.edit(&o)
			if err := o.Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestBackfillActivityStartGPS_DryRunCommitAndRerun(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}

	uid := uuid.NewString()
	const fillable = "gps-backfill-fillable"
	const empty = "gps-backfill-empty"
	defer func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&TimeseriesPoint{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	}()

	activities := []struct {
		activity Activity
		points   []TimeseriesPoint
	}{
		{
			activity: Activity{UserID: uid, LabelID: fillable, SportType: 100, Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
			points: []TimeseriesPoint{
				{GPSLat: fptr(0), GPSLon: fptr(0)},
				{GPSLat: fptr(95), GPSLon: fptr(121)},
				{GPSLat: fptr(31.2304), GPSLon: fptr(121.4737)},
			},
		},
		{
			activity: Activity{UserID: uid, LabelID: empty, SportType: 100, Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()},
			points:   []TimeseriesPoint{{GPSLat: fptr(0), GPSLon: fptr(0)}},
		},
	}
	for i := range activities {
		if err := st.UpsertActivity(ctx, &activities[i].activity, nil, activities[i].points, nil); err != nil {
			t.Fatalf("seed %s: %v", activities[i].activity.LabelID, err)
		}
	}

	options := ActivityStartGPSBackfillOptions{UserIDs: []string{uid}, BatchSize: 1}
	dry, err := st.BackfillActivityStartGPS(ctx, options)
	if err != nil {
		t.Fatalf("dry-run: %v", err)
	}
	if dry.Scanned != 2 || dry.Fillable != 1 || dry.Updated != 0 || dry.NoValidGPS != 1 {
		t.Fatalf("dry-run report = %+v", dry)
	}
	var before Activity
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, fillable).First(&before).Error; err != nil {
		t.Fatalf("read dry-run row: %v", err)
	}
	if before.StartGPSLat != nil || before.StartGPSLon != nil {
		t.Fatalf("dry-run wrote coordinates: (%v, %v)", before.StartGPSLat, before.StartGPSLon)
	}

	options.Commit = true
	committed, err := st.BackfillActivityStartGPS(ctx, options)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if committed.Updated != 1 || committed.Verified != 1 || committed.NoValidGPS != 1 {
		t.Fatalf("commit report = %+v", committed)
	}
	var stored Activity
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, fillable).First(&stored).Error; err != nil {
		t.Fatalf("read committed row: %v", err)
	}
	if stored.StartGPSLat == nil || stored.StartGPSLon == nil || *stored.StartGPSLat != 31.2304 || *stored.StartGPSLon != 121.4737 {
		t.Fatalf("stored coordinates = (%v, %v)", stored.StartGPSLat, stored.StartGPSLon)
	}

	rerun, err := st.BackfillActivityStartGPS(ctx, options)
	if err != nil {
		t.Fatalf("rerun: %v", err)
	}
	if rerun.AlreadyCached != 1 || rerun.Updated != 0 || rerun.Scanned != 1 {
		t.Fatalf("rerun report = %+v", rerun)
	}
}
