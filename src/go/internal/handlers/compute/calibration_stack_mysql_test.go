package compute

import (
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	mysql "github.com/go-sql-driver/mysql"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
	"github.com/zhaochy1990/stride/internal/compute/trainingloadsource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/mq"
	"github.com/zhaochy1990/stride/internal/pipeline"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
	"go.uber.org/zap"
)

func TestCalibrationStackGuard(t *testing.T) {
	valid := "root:local@tcp(127.0.0.1:13383)/stride_983_test?parseTime=true"
	for _, tc := range []struct {
		dsn, broker string
		want        bool
	}{
		{valid, "amqp://guest:guest@127.0.0.1:13384/", true},
		{"reader:x@tcp(127.0.0.1:13383)/stride_983_test", "amqp://guest:guest@127.0.0.1:13384/", false},
		{"root:x@tcp(localhost:13383)/stride_983_test", "amqp://guest:guest@127.0.0.1:13384/", false},
		{"root:x@tcp(127.0.0.1:3306)/stride_983_test", "amqp://guest:guest@127.0.0.1:13384/", false},
		{"root:x@tcp(127.0.0.1:13383)/stride", "amqp://guest:guest@127.0.0.1:13384/", false},
		{valid, "amqp://guest:guest@127.0.0.1:5672/", false},
		{valid, "amqp://guest:guest@remote:13384/", false},
	} {
		if got := calibrationStackGuard(tc.dsn, tc.broker); (got == nil) != tc.want {
			t.Errorf("isolated stack guard allowed=%v, want %v", got == nil, tc.want)
		}
	}
}

// Refuse other databases/brokers before migrations or fixture import. The owner
// must reserve the database's single policy-writer window before running this.
func calibrationStackGuard(dsn, broker string) error {
	c, err := mysql.ParseDSN(dsn)
	if err != nil || c.User != "root" || c.Net != "tcp" || c.Addr != "127.0.0.1:13383" || c.DBName != "stride_983_test" {
		return fmt.Errorf("requires dedicated root TCP loopback stride_983_test")
	}
	u, err := url.Parse(broker)
	if err != nil || u.Scheme != "amqp" || u.Host != "127.0.0.1:13384" || (u.Path != "" && u.Path != "/") {
		return fmt.Errorf("requires own RabbitMQ TCP loopback port 13384")
	}
	return nil
}

type stackManifest struct {
	AsOf       time.Time `json:"as_of"`
	Activities []struct {
		Split    string               `json:"split"`
		Activity calibration.Activity `json:"activity"`
	} `json:"activities"`
	Health []struct {
		Row calibration.HealthRow `json:"row"`
	} `json:"health"`
}

func stackWrite(t *testing.T, path string, value any) {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
}

// Captured private NONFINAL engineering data only. This harness exercises the
// real sync persistence API, FileStore codec, Rabbit publisher/consumer, durable
// jobs and pipeline dispatcher, canonical calibration/compute/ability handlers,
// RS256/Gin HTTP and external read-only consumers. It is not live watch sync,
// normal production binary/COS wiring or an independent accuracy evaluation.
func TestCalibrationCapturedStack(t *testing.T) {
	input, output := os.Getenv("STRIDE_991_NONFINAL_MANIFEST"), os.Getenv("STRIDE_991_STACK_OUTPUT")
	if input == "" || output == "" {
		t.Skip("explicit private nonfinal manifest and output required")
	}
	dsn, broker := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN"), os.Getenv("STRIDE_991_AMQP_URL")
	if err := calibrationStackGuard(dsn, broker); err != nil {
		t.Fatal(err)
	}
	// Allowlist the two reviewed, nonfinal inputs; holdout paths are never opened.
	clean := filepath.Clean(input)
	if clean != "/tmp/stride-983/private/fresh-manifest.json.gz" && clean != "/tmp/stride-983/private/t3-reviewed-input-manifest.json.gz" {
		t.Fatal("only reviewed private NONFINAL input paths are allowed")
	}
	if !filepath.IsAbs(output) || !strings.HasPrefix(filepath.Clean(output), "/tmp/stride-983/private/") {
		t.Fatal("output must be private absolute path")
	}
	file, err := os.Open(clean)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	zipped, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(zipped)
	z, err := gzip.NewReader(strings.NewReader(string(zipped)))
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	var manifest stackManifest
	if err = json.NewDecoder(z).Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	executionDay := timefmt.ShanghaiToday()
	if len(manifest.Activities) == 0 {
		t.Fatal("captured-stack requires nonempty data")
	}
	if err := validateCapturedStackDay(manifest.AsOf, executionDay); err != nil {
		t.Fatal(err)
	}
	// Preserve the immutable capture and its dates. Jobs run on the real current
	// execution day; a past capture is not silently shifted into today's data.
	t.Logf("capture_asof=%s execution_asof=%s input_sha256=%s", manifest.AsOf.Format("2006-01-02"), executionDay.Format("2006-01-02"), hex.EncodeToString(digest[:]))
	for _, a := range manifest.Activities {
		if strings.Contains(strings.ToLower(a.Split), "holdout") || (strings.Contains(strings.ToLower(a.Split), "final") && !strings.Contains(strings.ToLower(a.Split), "nonfinal")) {
			t.Fatal("final/holdout data forbidden")
		}
	}
	ctx := context.Background()
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
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
	original, err := st.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if original.ActiveVersion != 3 || original.CandidateVersion == nil || *original.CandidateVersion != 4 || original.FallbackVersion != 3 {
		t.Fatal("exclusive window must begin at policy 3/4/3")
	}
	uid := uuid.NewString()
	var labels []string
	defer func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Errorf("storage cleanup: %v", err)
		}
		p, e := st.CalibrationPolicy(ctx)
		if e == nil {
			_, e = st.ReplaceCalibrationPolicy(ctx, p.Revision, original)
		}
		if e != nil {
			t.Errorf("policy restore: %v", e)
		}
		rows, e := st.AllRunningActivities(ctx, uid)
		if e != nil || len(rows) != 0 {
			t.Errorf("cleanup activities remain: %d %v", len(rows), e)
		}
		for _, mode := range []storage.CalibrationMode{storage.CalibrationActive, storage.CalibrationCandidate} {
			b, e := st.ReadEffectiveRunningCalibration(ctx, uid, timefmt.ShanghaiToday().Format("2006-01-02"), mode)
			if e != nil || b.Snapshot != nil {
				t.Errorf("cleanup bundle remains: %v", e)
			}
		}
		for _, label := range labels {
			load, e := st.ActivityTrainingLoad(ctx, uid, label)
			if e != nil || load != nil {
				t.Error("cleanup activity load remains")
			}
			l1, e := st.FetchActivityAbility(ctx, uid, label)
			if e != nil || l1 != nil {
				t.Error("cleanup L1 remains")
			}
			zones, e := st.ActivityZones(ctx, uid, label)
			if e != nil || len(zones) != 0 {
				t.Error("cleanup zones remain")
			}
		}
		daily, e := st.DailyTrainingLoadSeries(ctx, uid, 730)
		if e != nil || len(daily) != 0 {
			t.Error("cleanup PMC remains")
		}
		abilities, e := st.AbilitySnapshotWindow(ctx, uid, 730)
		if e != nil || len(abilities) != 0 {
			t.Error("cleanup ability remains")
		}
		t.Log("cleanup: random identity/five tables removed via storage, policy restored 3/4/3")
	}()
	for i := range manifest.Activities {
		manifest.Activities[i].Activity.LabelID = fmt.Sprintf("captured-%03d", i+1)
		labels = append(labels, manifest.Activities[i].Activity.LabelID)
	}
	var pointCount int
	importCaptured := func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		for _, item := range manifest.Activities {
			a := item.Activity
			sport := a.Sport
			// Manifest dates are Shanghai civil days. Place at Shanghai noon to retain
			// exactly that day through UTC storage and the canonical provider mapper.
			day := a.ActivityDate.Format("2006-01-02")
			local, e := time.ParseInLocation("2006-01-02", day, time.FixedZone("Asia/Shanghai", 8*3600))
			if e != nil {
				return "", e
			}
			row := storage.Activity{UserID: j.UserID, LabelID: a.LabelID, Provider: "coros", SportType: 100, Sport: &sport, Date: local.Add(12 * time.Hour).UTC(), SyncedAt: time.Now().UTC(), DurationS: a.DurationS, DistanceM: a.DistanceM, AvgHR: stackInt(a.AvgHR), MaxHR: stackInt(a.MaxHR), AvgPower: stackInt(a.AvgPowerW)}
			var points []storage.TimeseriesPoint
			for _, s := range a.Samples {
				ts := s.ElapsedS
				if ts == nil {
					ts = s.TimestampS
				}
				var sec *int64
				if ts != nil {
					if math.Trunc(*ts*100) != *ts*100 {
						return "", fmt.Errorf("sub-centisecond captured timestamps cannot be silently rounded")
					}
					v := int64(*ts * 100)
					sec = &v
				}
				points = append(points, storage.TimeseriesPoint{Timestamp: sec, Distance: s.DistanceM, Speed: s.SpeedMps, HeartRate: stackInt(s.HeartRateBpm), Power: stackInt(s.PowerW), Altitude: s.AltitudeM})
			}
			var laps []storage.Lap
			for _, l := range a.Laps {
				kind := ""
				if l.LapType != nil {
					kind = *l.LapType
				}
				laps = append(laps, storage.Lap{LapIndex: l.LapIndex, LapType: kind, DurationS: l.DurationS, DistanceM: l.DistanceM, AvgHR: stackInt(l.AvgHR), MaxHR: stackInt(l.MaxHR), AvgPower: stackInt(l.AvgPowerW), AvgPace: l.AvgSpeedMps})
			}
			if e := st.UpsertActivity(ctx, &row, laps, points, nil); e != nil {
				return "", e
			}
			pointCount += len(points)
		}
		var healthDates []string
		for _, h := range manifest.Health {
			day := h.Row.Date.Format("20060102")
			if e := st.UpsertDailyHealth(ctx, &storage.DailyHealth{UserID: j.UserID, Provider: "coros", Date: day, RHR: stackInt(h.Row.RHR)}); e != nil {
				return "", e
			}
			healthDates = append(healthDates, day)
		}
		raw, _ := json.Marshal(map[string]any{"mode": "full", "label_ids": labels, "health_dates": healthDates})
		return string(raw), nil
	}
	conn, err := mq.Dial(broker)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	prefix := "stride991-" + uuid.NewString()
	topo := mq.Topology{Work: prefix, Retry: prefix + "-retry", Poison: prefix + "-poison"}
	if err = conn.DeclareTopology(topo); err != nil {
		t.Fatal(err)
	}
	pub, err := conn.NewPublisher(topo)
	if err != nil {
		t.Fatal(err)
	}
	defer pub.Close()
	consumer, err := conn.NewConsumer(topo, 1, mq.WithConsumerLogger(zap.NewNop()))
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	enq := job.NewStoreEnqueuer(st.Jobs(), pub)
	defs := pipeline.NewRegistry()
	defs.MustRegister(pipeline.Def{Name: "captured-import", Steps: []pipeline.StepDef{{Name: "captured-sync-persistence", JobType: "captured-sync-persistence"}, {Name: "calibration", JobType: "calibration"}, {Name: "compute", JobType: "compute"}}})
	defs.MustRegister(pipeline.Def{Name: "explicit-recompute", Steps: []pipeline.StepDef{{Name: "compute", JobType: "compute"}, {Name: "ability", JobType: "ability"}}})
	orch := pipeline.New(st.Pipelines(), enq, defs, pipeline.WithLogger(zap.NewNop()))
	reg := job.NewRegistry()
	reg.MustRegister("captured-sync-persistence", importCaptured)
	reg.MustRegister("calibration", NewCalibration(st))
	reg.MustRegister("compute", NewCompute(st))
	reg.MustRegister("ability", NewAbility(st))
	dispatch := job.NewDispatcher(st.Jobs(), reg, pub, orch, job.RetryPolicy{MaxAttempts: 1}, job.WithLogger(zap.NewNop()))
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- consumer.Run(workerCtx, dispatch.Dispatch) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("consumer did not stop")
		}
	}()
	runPipeline := func(name string) *job.PipelineRun {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"mode": "full", "ref_date": timefmt.ShanghaiToday().Format("2006-01-02"), "label_ids": labels})
		id, e := orch.StartPipeline(ctx, name, uid, uid, "", string(raw))
		if e != nil {
			t.Fatal(e)
		}
		deadline := time.Now().Add(3 * time.Minute)
		for time.Now().Before(deadline) {
			r, e := st.Pipelines().Get(ctx, id)
			if e != nil {
				t.Fatal(e)
			}
			if r.Status.Terminal() {
				if r.Status != job.StatusDone {
					t.Fatalf("pipeline failed: %+v", r)
				}
				return r
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("pipeline timed out")
		return nil
	}
	first := runPipeline("captured-import")
	missing, err := st.Jobs().Get(ctx, first.Steps[2].JobID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(missing.ResultJSON, `"derived_rows_written":0`) || !strings.Contains(missing.ResultJSON, "unavailable_historical_calibration") {
		t.Fatal("fresh import silently populated history", missing.ResultJSON)
	}
	readFive := func() []any {
		t.Helper()
		var loads []*storage.ActivityTrainingLoad
		var l1 []*storage.ActivityAbility
		var zones []storage.ActivityZone
		for _, label := range labels {
			a, e := st.ActivityTrainingLoad(ctx, uid, label)
			if e != nil {
				t.Fatal(e)
			}
			if a != nil {
				loads = append(loads, a)
			}
			b, e := st.FetchActivityAbility(ctx, uid, label)
			if e != nil {
				t.Fatal(e)
			}
			if b != nil {
				l1 = append(l1, b)
			}
			z, e := st.ActivityZones(ctx, uid, label)
			if e != nil {
				t.Fatal(e)
			}
			zones = append(zones, z...)
		}
		daily, e := st.DailyTrainingLoadSeries(ctx, uid, 730)
		if e != nil {
			t.Fatal(e)
		}
		ability, e := st.AbilitySnapshotForDate(ctx, uid, timefmt.ShanghaiToday().Format("2006-01-02"))
		if e != nil {
			t.Fatal(e)
		}
		return []any{loads, daily, ability, l1, zones}
	}
	empty := readFive()
	for _, rows := range empty {
		if reflect.ValueOf(rows).Len() != 0 {
			t.Fatal("historical missing wrote derived rows")
		}
	}
	// Validate all immutable captured observations at their original cutoff,
	// independently of the current job's rolling input window.
	history, health, err := calibrationsource.Load(ctx, st, uid, "", manifest.AsOf, 180)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != len(manifest.Activities) {
		t.Fatalf("roundtrip lost activities: %d vs %d", len(history), len(manifest.Activities))
	}
	// Check actual storage codec/provider roundtrip preserves captured observations.
	byLabel := map[string]calibration.Activity{}
	for _, a := range history {
		byLabel[a.LabelID] = a
	}
	for _, item := range manifest.Activities {
		a := byLabel[item.Activity.LabelID]
		if len(a.Samples) != len(item.Activity.Samples) || len(a.Laps) != len(item.Activity.Laps) {
			t.Fatal("captured sample/lap counts changed in sync persistence roundtrip", item.Activity.LabelID)
		}
		for i := range a.Samples {
			if !reflect.DeepEqual(a.Samples[i], item.Activity.Samples[i]) {
				t.Fatalf("captured sample values changed at %s/%d", a.LabelID, i)
			}
		}
		for i := range a.Laps {
			if !reflect.DeepEqual(a.Laps[i], item.Activity.Laps[i]) {
				t.Fatalf("captured lap values changed at %s/%d", a.LabelID, i)
			}
		}
	}
	days := map[string]bool{timefmt.ShanghaiToday().Format("2006-01-02"): true}
	for _, a := range history {
		days[a.ActivityDate.Format("2006-01-02")] = true
	}
	ordered := make([]string, 0, len(days))
	for d := range days {
		ordered = append(ordered, d)
	}
	sort.Strings(ordered)
	centers := map[string]int{"v3_speed": 0, "v3_hr": 0, "candidate_speed": 0, "candidate_hr": 0}
	for _, day := range ordered {
		asof, _ := time.Parse("2006-01-02", day)
		var prior []calibration.Activity
		for _, a := range history {
			if !a.ActivityDate.After(asof) {
				prior = append(prior, a)
			}
		}
		for _, strategy := range []calibration.Strategy{calibration.StrategyV3, calibration.StrategyCandidate} {
			var metadata []calibration.CandidateMetadata
			if strategy == calibration.StrategyCandidate {
				var e error
				metadata, e = calibrationsource.LoadCandidateMetadata(ctx, st, uid, "", asof, 180)
				if e != nil {
					t.Fatal(e)
				}
			}
			result, e := calibration.EstimateOfflineWithEvidence(strategy, prior, asof, health, metadata)
			if e != nil {
				t.Fatal(e)
			}
			keyPrefix := "v3"
			if strategy == calibration.StrategyCandidate {
				keyPrefix = "candidate"
			}
			if result.Snapshot.ThresholdSpeedMps != nil {
				centers[keyPrefix+"_speed"]++
			}
			if result.Snapshot.ThresholdHR != nil {
				centers[keyPrefix+"_hr"]++
			}
			row := toStorageSnapshot(uid, result.Snapshot)
			source := calibration.SummarizeSource(result)
			raw, e := json.Marshal(source)
			if e != nil {
				t.Fatal(e)
			}
			text := string(raw)
			row.SourceJSON = &text
			pace, hr := toStorageZones(calibration.ComputeTrainingZones(result.Snapshot))
			if _, e = st.PublishRunningCalibration(ctx, row, pace, hr); e != nil {
				t.Fatal(e)
			}
		}
	}
	runPipeline("explicit-recompute")
	before := readFive()
	for _, rows := range before {
		if reflect.ValueOf(rows).Len() == 0 {
			t.Fatal("real captured pipeline did not populate every derived table")
		}
	}
	auditLineage := func(rowsByTable []any) {
		for _, rows := range rowsByTable {
			v := reflect.ValueOf(rows)
			for i := 0; i < v.Len(); i++ {
				row := v.Index(i)
				if row.Kind() == reflect.Pointer {
					row = row.Elem()
				}
				p, state := storage.ReadCalibrationProvenance(row.Interface())
				if state != "available" {
					t.Fatal("unavailable derived lineage", state)
				}
				for _, in := range p.Inputs {
					cutoff := timefmt.ShanghaiToday().Format("2006-01-02")
					switch r := row.Interface().(type) {
					case storage.ActivityTrainingLoad:
						cutoff = r.ActivityDate
					case storage.DailyTrainingLoad:
						cutoff = r.Date
					case storage.ActivityAbility:
						cutoff = byLabel[r.LabelID].ActivityDate.Format("2006-01-02")
					case storage.ActivityZone:
						cutoff = byLabel[r.LabelID].ActivityDate.Format("2006-01-02")
					}
					expected, e := st.ReadEffectiveRunningCalibration(ctx, uid, cutoff, storage.CalibrationActive)
					if e != nil {
						t.Fatal(e)
					}
					if expected.Snapshot == nil {
						// S2 freezes unavailable day bundles on pre-history rest
						// days too. Absence must remain explicit, never future-filled.
						if _, ok := row.Interface().(storage.DailyTrainingLoad); !ok || in.SnapshotID != 0 || in.Selection.State != "unavailable" {
							t.Fatal("non-daily missing history or fabricated bundle")
						}
						continue
					}
					if in.SnapshotID == 0 || in.AlgorithmVersion != 3 || in.AsOfDate > cutoff || expected.Snapshot.ID != in.SnapshotID || expected.Fingerprint != in.Fingerprint {
						t.Fatal("derived input differs from effective historical bundle")
					}
				}
			}
		}
	}
	auditLineage(before)
	acts, err := trainingloadsource.Load(ctx, st, uid, "", timefmt.ShanghaiToday().AddDate(-1, 0, 0), timefmt.ShanghaiToday())
	if err != nil {
		t.Fatal(err)
	}
	preview, err := PreviewCandidateCalibration(ctx, st, uid, timefmt.ShanghaiToday().Format("2006-01-02"), acts, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, readFive()) {
		t.Fatal("candidate preview changed five derived tables")
	}
	stackWrite(t, output+".preview.json", preview)
	loadsByLabel := map[string]*storage.ActivityTrainingLoad{}
	for _, row := range before[0].([]*storage.ActivityTrainingLoad) {
		loadsByLabel[row.LabelID] = row
	}
	paired, missingDose, changedDose, largeDose := 0, 0, 0, 0
	var relative []float64
	for _, row := range preview.ActivityLoads {
		old := loadsByLabel[row.LabelID]
		if old == nil || old.TrainingDose == nil || row.TrainingDose == nil {
			missingDose++
			continue
		}
		paired++
		difference := *row.TrainingDose - *old.TrainingDose
		if math.Abs(difference) > 1e-9 {
			changedDose++
		}
		if *old.TrainingDose > 0 {
			delta := math.Abs(difference / *old.TrainingDose)
			relative = append(relative, delta)
			if delta > 0.20 {
				largeDose++
			}
		}
	}
	sort.Float64s(relative)
	var median, p90 *float64
	if len(relative) > 0 {
		m := relative[(len(relative)-1)/2]
		q := relative[int(math.Ceil(float64(len(relative))*.9))-1]
		median, p90 = &m, &q
	}
	impact := map[string]any{"paired_loads": paired, "missing_dose": missingDose, "changed_dose": changedDose, "absolute_relative_change_median": median, "absolute_relative_change_p90": p90, "above_20pct_engineering_inventory": largeDose}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	svc := api.NewService(api.Config{Auth: api.NewAuthenticator("", api.NewJWTVerifierFromKey(&key.PublicKey, "stride-local-t8", "stride-local-client")), StrideStore: st, HealthStore: st, ActivityStore: st, AbilityStore: st})
	listener, err := net.Listen("tcp", "127.0.0.1:19892")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: svc.Router(), ReadHeaderTimeout: 5 * time.Second}
	go server.Serve(listener)
	defer server.Shutdown(ctx)
	token, err := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"sub": uid, "iss": "stride-local-t8", "aud": "stride-local-client", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix()}).SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	get := func(path string) json.RawMessage {
		t.Helper()
		r, e := http.NewRequest("GET", "http://127.0.0.1:19892/api/"+uid+path, nil)
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Authorization", "Bearer "+token)
		resp, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		raw, e := io.ReadAll(resp.Body)
		if e != nil || resp.StatusCode != 200 {
			t.Fatalf("signed GET %s: %d %v", path, resp.StatusCode, e)
		}
		return raw
	}
	var phases []any
	for _, phase := range []string{"active3", "active4", "rollback3"} {
		if err := os.Remove(output + "." + phase + ".continue"); err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
	}
	for _, phase := range []struct {
		name    string
		version int
	}{{"active3", 3}, {"active4", 4}, {"rollback3", 3}} {
		p, e := st.CalibrationPolicy(ctx)
		if e != nil {
			t.Fatal(e)
		}
		p.ActiveVersion = phase.version
		if _, e = st.ReplaceCalibrationPolicy(ctx, p.Revision, p); e != nil {
			t.Fatal(e)
		}
		bundle, e := st.ReadEffectiveRunningCalibration(ctx, uid, timefmt.ShanghaiToday().Format("2006-01-02"), storage.CalibrationActive)
		if e != nil {
			t.Fatal(e)
		}
		zones := get("/stride/zones?mode=candidate&algorithm_version=99")
		healthJSON := get("/health")
		var healthWire struct {
			Calibration struct {
				CalibrationID    uint64 `json:"calibration_id"`
				AlgorithmVersion int    `json:"algorithm_version"`
				Fingerprint      string `json:"fingerprint"`
			} `json:"calibration"`
		}
		if e = json.Unmarshal(healthJSON, &healthWire); e != nil {
			t.Fatal(e)
		}
		if healthWire.Calibration.CalibrationID != bundle.Snapshot.ID || healthWire.Calibration.AlgorithmVersion != phase.version || healthWire.Calibration.Fingerprint != bundle.Fingerprint {
			t.Fatal("health/storage bundle identity mismatch")
		}

		get("/stride/training-load")
		get("/ability/current")
		var wire struct {
			Threshold struct {
				CalibrationID    uint64   `json:"calibration_id"`
				AlgorithmVersion int      `json:"algorithm_version"`
				Fingerprint      string   `json:"fingerprint"`
				Speed            *float64 `json:"speed_mps"`
				HR               *float64 `json:"hr_bpm"`
			} `json:"threshold"`
		}
		if e = json.Unmarshal(zones, &wire); e != nil {
			t.Fatal(e)
		}
		if wire.Threshold.CalibrationID != bundle.Snapshot.ID || wire.Threshold.AlgorithmVersion != phase.version || wire.Threshold.Fingerprint != bundle.Fingerprint {
			t.Fatal("Gin/storage identity mismatch")
		}
		if phase.version == 4 && (bundle.Snapshot.ThresholdSpeedMps != nil || bundle.Snapshot.ThresholdHR != nil || wire.Threshold.Speed != nil || wire.Threshold.HR != nil) {
			t.Fatal("unlabelled captured training gained unsupported centers")
		}
		if phase.version == 4 {
			_, abilityErr := NewAbility(st)(ctx, &job.Job{UserID: uid}, func(string, int) error { return nil })
			if abilityErr == nil {
				t.Fatal("active4 ability wrote active derived namespace")
			}
			_, e = NewCompute(st)(ctx, &job.Job{UserID: uid, InputJSON: `{"mode":"full"}`}, func(string, int) error { return nil })
			if e == nil {
				t.Fatal("active4 overwrote unnamespaced derived tables")
			}
			if !reflect.DeepEqual(before, readFive()) {
				t.Fatal("active4 read/gated compute changed derived tables")
			}
		}
		sum := sha256.Sum256(zones)
		stackWrite(t, output, map[string]any{"phase": phase.name, "url": "http://127.0.0.1:19892", "user_id": uid, "token": token, "cutoff": timefmt.ShanghaiToday().Format("2006-01-02"), "bundle": bundle, "zones": zones, "health": healthJSON, "sha256": hex.EncodeToString(sum[:])})
		deadline := time.Now().Add(15 * time.Minute)
		ack := output + "." + phase.name + ".continue"
		for {
			if _, e = os.Stat(ack); e == nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("external readonly consumers did not acknowledge phase", phase.name)
			}
			time.Sleep(100 * time.Millisecond)
		}
		if !reflect.DeepEqual(before, readFive()) {
			t.Fatal("readonly phase changed five derived tables", phase.name)
		}
		phases = append(phases, map[string]any{"phase": phase.name, "algorithm_version": phase.version, "response_sha256": hex.EncodeToString(sum[:]), "source": bundle.Source, "pace_zones": len(bundle.PaceZones), "hr_zones": len(bundle.HRZones)})
	}
	// Pointer rollback alone does not recalculate old derived outputs. Explicit
	// full compute uses a zero anchor, then ability/L1; history is already v3.
	runPipeline("explicit-recompute")
	after := readFive()
	auditLineage(after)
	// Compare all persisted output fields independently of generated row IDs,
	// execution times and newly frozen policy revision metadata.
	outputs := func(tables []any) [][]any {
		result := [][]any{}
		for _, table := range tables {
			rows := reflect.ValueOf(table)
			projected := []any{}
			for i := 0; i < rows.Len(); i++ {
				v := rows.Index(i)
				if v.Kind() == reflect.Pointer {
					v = v.Elem()
				}
				copy := reflect.New(v.Type()).Elem()
				copy.Set(v)
				for _, name := range []string{"ID", "ComputedAt", "CalibrationProvenanceJSON"} {
					field := copy.FieldByName(name)
					if field.IsValid() {
						field.SetZero()
					}
				}
				projected = append(projected, copy.Interface())
			}
			result = append(result, projected)
		}
		return result
	}
	if !reflect.DeepEqual(outputs(before), outputs(after)) {
		t.Fatal("v3 rollback recompute changed persisted outputs")
	}

	if len(before[0].([]*storage.ActivityTrainingLoad)) != len(after[0].([]*storage.ActivityTrainingLoad)) {
		t.Fatal("rollback lost activity loads")
	}
	oldLoads, newLoads := before[0].([]*storage.ActivityTrainingLoad), after[0].([]*storage.ActivityTrainingLoad)
	for i := range oldLoads {
		if !reflect.DeepEqual(oldLoads[i].TrainingDose, newLoads[i].TrainingDose) {
			t.Fatal("v3 recompute failed to reproduce activity dose")
		}
	}
	counts := []int{}
	for _, rows := range after {
		counts = append(counts, reflect.ValueOf(rows).Len())
	}
	stackWrite(t, output+".summary.json", map[string]any{"capture_asof": manifest.AsOf.Format("2006-01-02"), "execution_asof": executionDay.Format("2006-01-02"), "input_gzip_sha256": hex.EncodeToString(digest[:]), "activities": len(history), "samples": pointCount, "health": len(health), "historical_days": len(ordered), "derived_rows": counts, "rollback_lineage_checked": true, "center_coverage_by_day": centers, "load_impact": impact, "preview_activities": len(preview.ActivityLoads), "preview_unavailable_days": len(preview.UnavailableDays), "phases": phases, "rabbit_dispatched": dispatch.Stats(), "release_ready": false})
	t.Logf("captured-stack PASS activities=%d samples=%d days=%d derived=%v dispatched=%+v", len(history), pointCount, len(ordered), counts, dispatch.Stats())
}

func stackInt(v *float64) *int {
	if v == nil {
		return nil
	}
	x := int(math.Round(*v))
	return &x
}

func validateCapturedStackDay(capture, execution time.Time) error {
	if capture.IsZero() || capture.Format("2006-01-02") > execution.Format("2006-01-02") {
		return fmt.Errorf("capture cutoff must be nonzero and not after execution day")
	}
	return nil
}
func TestCapturedStackRetainsPastCaptureAndRejectsFuture(t *testing.T) {
	execution := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		day     time.Time
		allowed bool
	}{{execution.AddDate(0, 0, -1), true}, {execution, true}, {execution.AddDate(0, 0, 1), false}, {time.Time{}, false}} {
		if got := validateCapturedStackDay(tc.day, execution); (got == nil) != tc.allowed {
			t.Errorf("capture=%s allowed=%v want=%v", tc.day.Format("2006-01-02"), got == nil, tc.allowed)
		}
	}
}
