package compute

import (
	"context"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	mysql "github.com/go-sql-driver/mysql"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

type replayV3Store struct {
	*storage.Store
	builds int
}

func (r *replayV3Store) VisitV3CalibrationWindow(ctx context.Context, user string, start, end time.Time, version int, v storage.V3EvidenceVisitor) ([]storage.DailyHealth, error) {
	build := v.Build
	v.Build = func(a storage.Activity, p []storage.TimeseriesPoint, l []storage.Lap) ([]byte, error) {
		r.builds++
		return build(a, p, l)
	}
	return r.Store.VisitV3CalibrationWindow(ctx, user, start, end, version, v)
}

// Opt-in retrospective replay. Point ONLY at a seeded disposable MySQL DB
// and its local blob directory: both production paths publish a same-day row.
func TestV3DailyReplayMySQL(t *testing.T) {
	user := os.Getenv("STRIDE_V3_REPLAY_USER")
	if user == "" {
		t.Skip("private local replay fixture required")
	}
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal("invalid local replay DSN")
	}
	host, _, err := net.SplitHostPort(cfg.Addr)
	if err != nil || cfg.Net != "tcp" || !net.ParseIP(host).IsLoopback() || !strings.Contains(cfg.DBName, "replay") {
		t.Fatal("daily replay writes snapshots and requires a loopback MySQL replay database")
	}
	open := func() *storage.Store {
		t.Helper()
		st, err := storage.Open(dsn)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { st.Close() })
		fs, err := tsstore.NewFileStore(os.Getenv("STRIDE_V3_REPLAY_BLOBS"))
		if err != nil {
			t.Fatal(err)
		}
		st.SetTSBlobStore(fs)
		return st
	}
	parseDay := func(key string) time.Time {
		t.Helper()
		day, err := time.Parse("2006-01-02", os.Getenv(key))
		if err != nil {
			t.Fatal(err)
		}
		return day
	}
	full, delta := open(), &replayV3Store{Store: open()}
	start, end := parseDay("STRIDE_V3_REPLAY_START"), parseDay("STRIDE_V3_REPLAY_END")
	if start.After(end) {
		t.Fatal("inverted replay window")
	}
	var warmDays int
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		var f, d CalibrationDayOutcome
		var tf, td time.Duration
		delta.builds = 0
		for i := 0; i < 2; i++ {
			before := time.Now()
			var err error
			// Alternate order to balance first-publish vs same-day republish cost.
			if (day.YearDay()+i)%2 == 0 {
				f, err = runCalibrationVersion(t.Context(), full, user, day, calibration.ModelVersion)
				tf = time.Since(before)
			} else {
				d, err = runIncrementalV3(t.Context(), delta, user, day)
				td = time.Since(before)
			}
			if err != nil {
				t.Fatal(err)
			}
		}
		if f.Activities != d.Activities || f.Fingerprint == "" || f.Fingerprint != d.Fingerprint || f.SnapshotID != d.SnapshotID {
			t.Fatalf("%s full=%+v delta=%+v", day, f, d)
		}
		if delta.builds < d.Activities {
			warmDays++
		}
		t.Logf("day=%s runs=%d rebuilt=%d full_ms=%.3f delta_ms=%.3f", day.Format("2006-01-02"), f.Activities, delta.builds, float64(tf.Microseconds())/1000, float64(td.Microseconds())/1000)
	}
	if warmDays == 0 {
		t.Fatal("no date reused activity evidence")
	}
}
