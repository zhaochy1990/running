package compute

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// Real storage/FileStore + actual handlers. Verified protocols below are
// explicitly SYNTHETIC engineering inputs, never real accuracy references.
func TestActiveCandidateOptInRefreshDerivedAndRollbackMySQL(t *testing.T) {
	ctx, st := openCalibrationReviewMySQL(t)
	original, err := st.CalibrationPolicy(ctx)
	if err != nil || original.ActiveVersion != 3 || original.CandidateVersion == nil || *original.CandidateVersion != 4 || original.FallbackVersion != 3 {
		t.Fatal("requires exclusive 3/4/3 policy", original, err)
	}
	uid := uuid.NewString()
	today := timefmt.ShanghaiToday()
	dates := []time.Time{today.AddDate(0, 0, -1), today}
	var labels []string
	var metadata []calibration.CandidateMetadata
	defer func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Error(err)
		}
		p, e := st.CalibrationPolicy(ctx)
		if e == nil {
			_, e = st.ReplaceCalibrationPolicy(ctx, p.Revision, original)
		}
		if e != nil {
			t.Error(e)
		}
		acts, e := st.AllRunningActivities(ctx, uid)
		if e != nil || len(acts) != 0 {
			t.Error("cleanup activities", e)
		}
		for _, label := range labels {
			a, e := st.ActivityTrainingLoad(ctx, uid, label)
			if e != nil || a != nil {
				t.Error("cleanup load", e)
			}
			l, e := st.FetchActivityAbility(ctx, uid, label)
			if e != nil || l != nil {
				t.Error("cleanup L1", e)
			}
			z, e := st.ActivityZones(ctx, uid, label)
			if e != nil || len(z) != 0 {
				t.Error("cleanup zones", e)
			}
		}
		daily, e := st.DailyTrainingLoadSeries(ctx, uid, 730)
		if e != nil || len(daily) != 0 {
			t.Error("cleanup daily", e)
		}
		a, e := st.AbilitySnapshotWindow(ctx, uid, 730)
		if e != nil || len(a) != 0 {
			t.Error("cleanup ability", e)
		}
		for _, mode := range []storage.CalibrationMode{storage.CalibrationActive, storage.CalibrationCandidate} {
			b, e := st.ReadEffectiveRunningCalibration(ctx, uid, today.Format("2006-01-02"), mode)
			if e != nil || b.Snapshot != nil {
				t.Error("cleanup calibration", e)
			}
		}
		t.Log("cleanup verified: random user/blobs/five tables/snapshots removed; policy restored 3/4/3")
	}()
	for i := 21; i >= 0; i-- {
		rhr := 48
		if i == 0 {
			rhr = 55
		}
		if err := st.UpsertDailyHealth(ctx, &storage.DailyHealth{UserID: uid, Provider: "coros", Date: today.AddDate(0, 0, -i).Format("20060102"), RHR: &rhr}); err != nil {
			t.Fatal(err)
		}
	}
	for di, day := range dates {
		for _, duration := range []int{3600, 1800} {
			label := strings.Join([]string{"synthetic-active", day.Format("20060102"), fmt.Sprint(duration)}, "-")
			labels = append(labels, label)
			dur := float64(duration)
			speed := 4.0 + float64(di)*.2
			distance := dur * speed
			sport := "run_outdoor"
			maxHR := 184
			row := storage.Activity{UserID: uid, LabelID: label, Provider: "coros", SyncedAt: time.Now().UTC(), Sport: &sport, SportType: 100, Date: day.Add(12 * time.Hour).UTC(), DurationS: &dur, DistanceM: &distance, MaxHR: &maxHR}
			var points []storage.TimeseriesPoint
			for second := 0; second <= duration; second += 5 {
				clock := int64(second * 100)
				d := float64(second) * speed * 100
				hr := 165
				points = append(points, storage.TimeseriesPoint{Timestamp: &clock, Distance: &d, Speed: &speed, HeartRate: &hr})
			}
			if err := st.UpsertActivity(ctx, &row, nil, points, nil); err != nil {
				t.Fatal(err)
			}
			m := calibration.CandidateMetadata{ActivityID: label, RootActivityID: label, SourceVersion: "SYNTHETIC-engineering-verified-v1", EvidenceRef: "SYNTHETIC-protocol-not-accuracy", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: dur, StartS: floatPtr(0), EndS: floatPtr(dur)}
			if duration == 1800 {
				m.HR = &calibration.CandidateHRMetadata{Protocol: "field_30min_last20_v1", Verified: true, Sensor: "chest_strap"}
			}
			metadata = append(metadata, m)
		}
	}
	run := func(h job.Handler, input string) string {
		t.Helper()
		out, err := h(ctx, &job.Job{UserID: uid, InputJSON: input}, func(string, int) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	input, _ := json.Marshal(map[string]any{"mode": "full", "ref_date": today.Format("2006-01-02"), "label_ids": labels, "health_dates": []string{today.Format("20060102")}})
	for _, day := range dates {
		if _, _, err := runCalibrationVersion(ctx, st, uid, day, 3); err != nil {
			t.Fatal(err)
		}
	}
	run(NewCompute(st), string(input))
	run(NewAbility(st), string(input))
	readFive := func() []any {
		t.Helper()
		var out []any
		for _, label := range labels {
			a, e := st.ActivityTrainingLoad(ctx, uid, label)
			if e != nil || a == nil {
				t.Fatal("missing load", e)
			}
			out = append(out, *a)
			l, e := st.FetchActivityAbility(ctx, uid, label)
			if e != nil || l == nil {
				t.Fatal("missing L1", e)
			}
			out = append(out, *l)
			z, e := st.ActivityZones(ctx, uid, label)
			if e != nil || len(z) == 0 {
				t.Fatal("missing zones", e)
			}
			for _, r := range z {
				out = append(out, r)
			}
		}
		d, e := st.DailyTrainingLoadSeries(ctx, uid, 2)
		if e != nil || len(d) < 2 {
			t.Fatal("missing daily", e)
		}
		for _, r := range d {
			if r.Date < dates[0].Format("2006-01-02") {
				continue
			}
			out = append(out, r)
		}
		a, e := st.AbilitySnapshotForDate(ctx, uid, today.Format("2006-01-02"))
		if e != nil || len(a) == 0 {
			t.Fatal("missing ability", e)
		}
		for _, r := range a {
			out = append(out, r)
		}
		return out
	}
	before := readFive()
	// Shadow job refreshes only its snapshot/zones and cannot touch five tables.
	run(NewCalibrationWithOptions(st, CalibrationOptions{AllowCandidatePersistence: true}), `{"selection_mode":"candidate"}`)
	if !reflect.DeepEqual(before, readFive()) {
		t.Fatal("shadow changed active derived rows")
	}
	p, err := st.ReplaceCalibrationPolicy(ctx, original.Revision, storage.RunningCalibrationPolicy{ActiveVersion: 4, CandidateVersion: original.CandidateVersion, FallbackVersion: 3})
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range []job.Handler{NewCalibration(st), NewCalibrationWithOptions(st, CalibrationOptions{AllowCandidatePersistence: true}), NewCompute(st), NewAbility(st)} {
		if _, err := h(ctx, &job.Job{UserID: uid, InputJSON: string(input)}, func(string, int) error { return nil }); err == nil {
			t.Fatal("default/shadow opt-in allowed active4")
		}
	}
	refresh := run(NewCalibrationWithOptions(st, CalibrationOptions{AllowActiveCandidate: true}), string(input))
	var echoed calibrationResult
	if err := json.Unmarshal([]byte(refresh), &echoed); err != nil || !reflect.DeepEqual(echoed.LabelIDs, labels) || !reflect.DeepEqual(echoed.HealthDates, []string{today.Format("20060102")}) {
		t.Fatal("active refresh lost pipeline echo", err)
	}
	if !strings.Contains(refresh, `"algorithm_version":4`) || strings.Contains(refresh, `"candidate_only":true`) {
		t.Fatal("active refresh intent lost", refresh)
	}
	missing, err := st.ReadEffectiveRunningCalibration(ctx, uid, today.Format("2006-01-02"), storage.CalibrationActive)
	if err != nil || missing.Snapshot == nil || missing.Snapshot.ThresholdSpeedMps != nil || missing.Source.Speed.EvidenceCount == 0 {
		t.Fatal("ordinary storage metadata falsely asserted maximality", err)
	}
	opts := ActiveCalibrationOptions{AllowActiveCandidate: true}
	for _, h := range []job.Handler{NewComputeWithOptions(st, opts), NewAbilityWithOptions(st, opts)} {
		out := run(h, refresh)
		if !strings.Contains(out, "unavailable_active_calibration") {
			t.Fatal("missing support not explicit", out)
		}
		if _, err := h(ctx, &job.Job{UserID: uid, InputJSON: `{"selection_mode":"candidate"}`}, func(string, int) error { return nil }); err == nil {
			t.Fatal("active option bypassed candidate payload guard")
		}
	}
	if !reflect.DeepEqual(before, readFive()) {
		t.Fatal("missing support overwrote valid v3 rows")
	}
	if _, err := NewCalibrationWithOptions(st, CalibrationOptions{AllowActiveCandidate: true, AllowCandidatePersistence: true})(ctx, &job.Job{UserID: uid, InputJSON: `{"selection_mode":"candidate"}`}, func(string, int) error { return nil }); err == nil {
		t.Fatal("shadow reused active snapshot key")
	}
	// Real read -> existing producer + explicit SYNTHETIC protocols -> storage publication.
	for _, day := range dates {
		history, health, _, err := calibrationsource.LoadCandidate(ctx, st, uid, "", day, 180)
		if err != nil {
			t.Fatal(err)
		}
		r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, history, day, health, metadata)
		if err != nil || r.Snapshot.ThresholdSpeedMps == nil || r.Snapshot.ThresholdHR == nil {
			t.Fatal("synthetic positive fixture not supported", err)
		}
		source := calibration.SummarizeSource(r)
		raw, _ := json.Marshal(source)
		text := string(raw)
		row := toStorageSnapshot(uid, r.Snapshot)
		row.SourceJSON = &text
		pz, hz := toStorageZones(calibration.ComputeTrainingZones(r.Snapshot))
		if _, err := st.PublishRunningCalibration(ctx, row, pz, hz); err != nil {
			t.Fatal(err)
		}
	}
	run(NewComputeWithOptions(st, opts), refresh)
	run(NewAbilityWithOptions(st, opts), refresh)
	for _, row := range readFive() {
		provenance, state := storage.ReadCalibrationProvenance(row)
		if state != "available" || len(provenance.Inputs) != 1 {
			t.Fatalf("missing active4 lineage: %T %s", row, state)
		}
		in := provenance.Inputs[0]
		if in.AlgorithmVersion != 4 || in.Fingerprint == "" {
			t.Fatalf("wrong active source %+v", in)
		}
		day := today.Format("2006-01-02")
		v := reflect.ValueOf(row)
		if f := v.FieldByName("ActivityDate"); f.IsValid() {
			day = f.String()
		} else if f := v.FieldByName("Date"); f.IsValid() {
			day = f.String()
		} else if f := v.FieldByName("LabelID"); f.IsValid() {
			for i, label := range labels {
				if f.String() == label {
					day = dates[i/2].Format("2006-01-02")
				}
			}
		}
		b, e := st.ReadEffectiveRunningCalibration(ctx, uid, day, storage.CalibrationActive)
		if e != nil || in.AsOfDate != day || b.Fingerprint != in.Fingerprint {
			t.Fatalf("per-day source mismatch %T %+v", row, in)
		}
	}
	// A pointer rollback alone does not recompute rows. Then explicit full v3
	// recomputation restores every derived value (timestamps/revisions differ).
	_, err = st.ReplaceCalibrationPolicy(ctx, p.Revision, original)
	if err != nil {
		t.Fatal(err)
	}
	run(NewCompute(st), string(input))
	run(NewAbility(st), string(input))
	normalize := func(rows []any) []map[string]any {
		var out []map[string]any
		for _, row := range rows {
			raw, _ := json.Marshal(row)
			var fields map[string]any
			_ = json.Unmarshal(raw, &fields)
			for _, key := range []string{"ID", "ComputedAt", "CalibrationProvenanceJSON"} {
				delete(fields, key)
			}
			out = append(out, fields)
		}
		return out
	}
	after := readFive()
	if !reflect.DeepEqual(normalize(before), normalize(after)) {
		t.Fatal("explicit rollback did not restore original v3 outputs")
	}
	for _, row := range after {
		pr, state := storage.ReadCalibrationProvenance(row)
		if state != "available" || len(pr.Inputs) != 1 || pr.Inputs[0].AlgorithmVersion != 3 {
			t.Fatal("rollback lineage not v3")
		}
	}
	t.Logf("active4 opt-in: %d concrete rows across all five tables, per-day fingerprints; explicit rollback outputs equal original v3", len(after))
}

// Shared local review harness: exact loopback/root/database guard precedes all
// migrations. The caller owns random identity cleanup and policy restoration.
func openCalibrationReviewMySQL(t *testing.T) (context.Context, *storage.Store) {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("explicit isolated MySQL DSN required")
	}
	if err := calibrationStackGuard(dsn, "amqp://guest:guest@127.0.0.1:13384/"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	for _, migrate := range []func(context.Context) error{st.AutoMigrate, st.AutoMigrateWatch, st.AutoMigrateUsers, st.AutoMigrateGoals, st.AutoMigrateMasterPlan, st.AutoMigrateWeeklyPlan, st.AutoMigrateWeeklyFeedback, st.AutoMigrateBodyComposition, st.AutoMigrateTeamLikes, st.AutoMigrateScheduledWorkout, st.AutoMigrateRaceFavorites, st.AutoMigrateRacePlans, st.AutoMigrateRaceStrategies, st.AutoMigrateUserCustomRaces, st.AutoMigrateHomeCity, st.AutoMigratePlanAdjustment, st.AutoMigratePlanInjury, st.AutoMigrateWorkout, st.AutoMigrateFeedback, st.AutoMigrateRoadmap, st.AutoMigrateProviderEvents, st.AutoMigrateCheckIn, st.AutoMigratePoints, st.AutoMigrateAddresses, st.AutoMigrateRaceCalendar} {
		if err := migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	blobs, err := tsstore.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.SetTSBlobStore(blobs)
	return ctx, st
}
