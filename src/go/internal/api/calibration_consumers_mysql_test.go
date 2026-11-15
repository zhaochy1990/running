package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	mysql "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/registry"
	"github.com/zhaochy1990/stride/internal/storage"
)

// This test owns the global policy for its duration. Run it serially, explicitly
// opted in, against the dedicated local database only. Seed/cleanup use storage
// interfaces; the HTTP and registry consumers never execute SQL.
func TestCalibrationConsumersMySQL(t *testing.T) {
	if os.Getenv("STRIDE_CALIBRATION_POLICY_TEST") != "1" {
		t.Skip("set STRIDE_CALIBRATION_POLICY_TEST=1 for serial local policy test")
	}
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil || cfg.Net != "tcp" || cfg.Addr != "127.0.0.1:13383" || cfg.DBName != "stride_983_test" {
		t.Fatal("calibration consumer test requires dedicated local stride_983_test database")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	for _, migrate := range []func(context.Context) error{st.AutoMigrate, st.AutoMigrateWatch, st.AutoMigrateUsers, st.AutoMigrateGoals, st.AutoMigrateMasterPlan, st.AutoMigrateWeeklyPlan, st.AutoMigrateWeeklyFeedback, st.AutoMigrateBodyComposition, st.AutoMigrateTeamLikes, st.AutoMigrateScheduledWorkout, st.AutoMigrateRaceFavorites, st.AutoMigrateRacePlans, st.AutoMigrateRaceStrategies, st.AutoMigrateUserCustomRaces, st.AutoMigrateHomeCity, st.AutoMigratePlanAdjustment, st.AutoMigratePlanInjury, st.AutoMigrateWorkout, st.AutoMigrateFeedback, st.AutoMigrateRoadmap, st.AutoMigrateProviderEvents, st.AutoMigrateCheckIn, st.AutoMigratePoints, st.AutoMigrateAddresses} {
		if err := migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	uid, emptyUser := uuid.NewString(), uuid.NewString()
	t.Cleanup(func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Errorf("cleanup calibration user: %v", err)
		}
	})
	original, err := st.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	policy := original
	t.Cleanup(func() {
		current, err := st.CalibrationPolicy(ctx)
		if err == nil {
			_, err = st.ReplaceCalibrationPolicy(ctx, current.Revision, original)
		}
		if err != nil {
			t.Errorf("restore policy values: %v", err)
		}
	})
	setVersion := func(v int) {
		t.Helper()
		policy.ActiveVersion = v
		var err error
		policy, err = st.ReplaceCalibrationPolicy(ctx, policy.Revision, policy)
		if err != nil {
			t.Fatal(err)
		}
	}
	day := apifmt.TodayShanghai()
	v3 := &storage.RunningCalibrationSnapshot{UserID: uid, AsOfDate: day, AlgorithmVersion: 3, ThresholdSpeedMps: fptr(4), ThresholdHR: fptr(166), RHRBaseline: fptr(48)}
	oldID, err := st.PublishRunningCalibration(ctx, v3, []storage.RunningCalibrationPaceZone{{Name: "threshold", MinSpeedMps: fptr(4), MaxSpeedMps: fptr(4.2)}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw := `{"schema_version":1,"state":"available","strategy":"candidate","data_cutoff_day":"` + day + `","speed":{"method":"constraints_only","target_type":"hour_speed","measurement_quality":"high","effort_support":"unknown","support":"insufficient","range_low":4.1,"range_meaning":"performance_lower_bound","reasons":["no_maximal_anchor"],"limitations":[]}}`
	candidate := &storage.RunningCalibrationSnapshot{UserID: uid, AsOfDate: day, AlgorithmVersion: 4, RHRBaseline: fptr(47), SourceJSON: &raw}
	candidateID, err := st.PublishRunningCalibration(ctx, candidate, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(Config{Auth: NewAuthenticator(testToken, nil), StrideStore: st, HealthStore: st})
	get := func(user, path string, body any) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "/api/"+user+path, nil)
		r.Header.Set("X-Internal-Token", testToken)
		w := httptest.NewRecorder()
		svc.Router().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("GET %s: %d %s", path, w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), body); err != nil {
			t.Fatal(err)
		}
	}
	assertConsumers := func(version int, id uint64, wantRHR int, wantCenter bool) {
		t.Helper()
		bundle, err := st.ReadEffectiveRunningCalibration(ctx, uid, day, storage.CalibrationActive)
		if err != nil {
			t.Fatal(err)
		}
		var zones strideZonesResponse
		get(uid, "/stride/zones?mode=candidate", &zones)
		var health healthResponse
		get(uid, "/health", &health)
		b, err := registry.LoadBaselines(ctx, st, uid)
		if err != nil {
			t.Fatal(err)
		}
		if bundle.Snapshot.ID != id || zones.Threshold == nil || zones.Threshold.CalibrationID != id || zones.Threshold.AlgorithmVersion != version || health.Calibration.CalibrationID != id || health.Calibration.AlgorithmVersion != version {
			t.Fatalf("consumers selected different snapshots: bundle=%+v zones=%+v health=%+v", bundle.Selection, zones.Threshold, health.Calibration)
		}
		if health.RHRBaseline == nil || *health.RHRBaseline != wantRHR || b.RHRBPM == nil || int(*b.RHRBPM) != wantRHR {
			t.Fatalf("RHR mismatch health=%+v baseline=%+v", health, b)
		}
		if (zones.Threshold.SpeedMps != nil) != wantCenter || (b.LTPaceSKM != nil) != wantCenter || (b.LTHRBPM != nil) != wantCenter {
			t.Fatalf("candidate missing center filled from v3: threshold=%+v baselines=%+v", zones.Threshold, b)
		}
		if !wantCenter && (len(zones.PaceZones) != 0 || zones.Threshold.SpeedRange == nil || zones.Threshold.SpeedRange.BoundKind != "speed_lower_bound" || zones.Threshold.Source.Speed.Method != "constraints_only") {
			t.Fatalf("candidate constraints lost: %+v", zones)
		}
		if zones.Threshold.Fingerprint != bundle.Fingerprint || health.Calibration.Fingerprint != bundle.Fingerprint {
			t.Fatal("fingerprint differs between consumers")
		}
	}
	setVersion(3)
	assertConsumers(3, oldID, 48, true)
	setVersion(4)
	assertConsumers(4, candidateID, 47, false)
	setVersion(3)
	assertConsumers(3, oldID, 48, true)
	var absent strideZonesResponse
	get(emptyUser, "/stride/zones", &absent)
	if absent.Threshold != nil || absent.Selection.State != "unavailable" || absent.Source.State != "snapshot_unavailable" || len(absent.PaceZones) != 0 {
		t.Fatalf("other user leaked baseline: %+v", absent)
	}
	historical, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2000-01-01", storage.CalibrationActive)
	if err != nil || historical.Snapshot != nil || historical.Selection.Reason != "no_historical_snapshot" {
		t.Fatalf("future baseline leaked into history: %+v %v", historical, err)
	}
	t.Logf("real MySQL: API health/zones, registry and storage agree; v3=%d candidate=%d; 3->4 constraints-only->3 rollback; tenant/history unavailable; cleanup public storage API", oldID, candidateID)
}
