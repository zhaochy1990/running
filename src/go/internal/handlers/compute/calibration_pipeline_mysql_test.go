package compute

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/trainingloadsource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestCalibrationRealPipelineAndCandidatePreviewIsolation(t *testing.T) {
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("real disposable MySQL required")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ctx := context.Background()
	for _, migrate := range []func(context.Context) error{st.AutoMigrate, st.AutoMigrateWatch, st.AutoMigrateUsers, st.AutoMigrateGoals, st.AutoMigrateMasterPlan, st.AutoMigrateWeeklyPlan, st.AutoMigrateWeeklyFeedback, st.AutoMigrateBodyComposition, st.AutoMigrateTeamLikes, st.AutoMigrateScheduledWorkout, st.AutoMigrateRaceFavorites, st.AutoMigrateRacePlans, st.AutoMigrateRaceStrategies, st.AutoMigrateUserCustomRaces, st.AutoMigrateHomeCity, st.AutoMigratePlanAdjustment, st.AutoMigratePlanInjury, st.AutoMigrateWorkout, st.AutoMigrateFeedback, st.AutoMigrateRoadmap, st.AutoMigrateProviderEvents, st.AutoMigrateCheckIn, st.AutoMigratePoints, st.AutoMigrateAddresses} {
		if err := migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	blob, err := tsstore.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.SetTSBlobStore(blob)
	uid := uuid.NewString()
	t.Cleanup(func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Error(err)
		}
	})
	day := timefmt.ShanghaiToday()
	label := "synthetic-local-pipeline"
	duration, distance := 3600.0, 14400.0
	activity := storage.Activity{UserID: uid, LabelID: label, Provider: "coros", SportType: 100, Date: day.Add(12 * time.Hour), SyncedAt: time.Now().UTC(), DurationS: &duration, DistanceM: &distance}
	var samples []storage.TimeseriesPoint
	for i := 0; i <= 120; i++ {
		elapsed := float64(i * 30)
		timestamp := int64(i * 30)
		speed := 4.0
		distance := elapsed * 4
		hr := 155 + i%20
		samples = append(samples, storage.TimeseriesPoint{Timestamp: &timestamp, Distance: &distance, Speed: &speed, HeartRate: &hr})
	}
	if err := st.UpsertActivity(ctx, &activity, nil, samples, nil); err != nil {
		t.Fatal(err)
	}
	rhr := 48
	if err := st.UpsertDailyHealth(ctx, &storage.DailyHealth{UserID: uid, Provider: "coros", Date: day.Format("20060102"), RHR: &rhr}); err != nil {
		t.Fatal(err)
	}
	run := func(h job.Handler, input string) string {
		t.Helper()
		out, err := h(ctx, &job.Job{UserID: uid, InputJSON: input}, func(string, int) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	out := run(NewCalibration(st), `{"mode":"incremental","label_ids":["synthetic-local-pipeline"],"health_dates":["`+day.Format("20060102")+`"]}`)
	var result calibrationResult
	if json.Unmarshal([]byte(out), &result) != nil || len(result.LabelIDs) != 1 || len(result.HealthDates) != 1 {
		t.Fatalf("sync echo lost %s", out)
	}
	run(NewCompute(st), `{"mode":"incremental","label_ids":["synthetic-local-pipeline"]}`)
	run(NewAbility(st), `{"ref_date":"`+day.Format("2006-01-02")+`","label_ids":["synthetic-local-pipeline"]}`)
	active, err := st.ReadEffectiveRunningCalibration(ctx, uid, day.Format("2006-01-02"), storage.CalibrationActive)
	if err != nil || active.Snapshot == nil || active.Fingerprint == "" {
		t.Fatalf("active source %+v %v", active, err)
	}
	load, err := st.ActivityTrainingLoad(ctx, uid, label)
	if err != nil || load == nil {
		t.Fatalf("no real load %v", err)
	}
	p, state := storage.ReadCalibrationProvenance(*load)
	if state != "available" || p.Inputs[0].Fingerprint != active.Fingerprint {
		t.Fatalf("load lineage %s", state)
	}
	read := func() []any {
		a, e := st.ActivityTrainingLoad(ctx, uid, label)
		if e != nil {
			t.Fatal(e)
		}
		d, e := st.DailyTrainingLoadSeries(ctx, uid, 365)
		if e != nil {
			t.Fatal(e)
		}
		ab, e := st.AbilitySnapshotForDate(ctx, uid, day.Format("2006-01-02"))
		if e != nil {
			t.Fatal(e)
		}
		l1, e := st.FetchActivityAbility(ctx, uid, label)
		if e != nil {
			t.Fatal(e)
		}
		z, e := st.ActivityZones(ctx, uid, label)
		if e != nil {
			t.Fatal(e)
		}
		return []any{a, d, ab, l1, z}
	}
	before := read()
	if len(before[1].([]storage.DailyTrainingLoad)) == 0 || len(before[2].([]storage.AbilitySnapshot)) == 0 || before[3].(*storage.ActivityAbility) == nil || len(before[4].([]storage.ActivityZone)) == 0 {
		t.Fatalf("fixture did not populate all five active derived tables")
	}
	for _, r := range before[1].([]storage.DailyTrainingLoad) {
		if _, state := storage.ReadCalibrationProvenance(r); state != "available" {
			t.Fatal("daily provenance roundtrip", state)
		}
	}
	for _, r := range before[2].([]storage.AbilitySnapshot) {
		if _, state := storage.ReadCalibrationProvenance(r); state != "available" {
			t.Fatal("ability provenance roundtrip", state)
		}
	}
	if _, state := storage.ReadCalibrationProvenance(*before[3].(*storage.ActivityAbility)); state != "available" {
		t.Fatal("L1 provenance roundtrip", state)
	}
	for _, r := range before[4].([]storage.ActivityZone) {
		if _, state := storage.ReadCalibrationProvenance(r); state != "available" {
			t.Fatal("activity zone provenance roundtrip", state)
		}
	}
	run(NewCalibrationWithOptions(st, CalibrationOptions{AllowCandidatePersistence: true}), `{"selection_mode":"candidate"}`)
	acts, err := trainingloadsource.Load(ctx, st, uid, "", day, day)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := PreviewCandidateCalibration(ctx, st, uid, day.Format("2006-01-02"), acts, &ability.Source{})
	if err != nil || !preview.CandidateOnly || preview.Selection.EffectiveVersion == nil || *preview.Selection.EffectiveVersion != calibration.CandidateVersion {
		t.Fatalf("preview %+v %v", preview, err)
	}
	if !reflect.DeepEqual(before, read()) {
		t.Fatal("candidate published into active load/PMC/ability/activity ability/zones")
	}
}
