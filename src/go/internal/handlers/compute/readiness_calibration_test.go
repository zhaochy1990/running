package compute

import (
	"context"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// The public compute job must use the persisted day bundle, even on rest days;
// the watch's local health distribution is deliberately a different baseline.
func TestReadinessRestDayUsesCanonicalBundleAndFreezesSource(t *testing.T) {
	today := timefmt.ShanghaiToday()
	f := &fakeStore{snap: &storage.RunningCalibrationSnapshot{ID: 17, AlgorithmVersion: 3, AsOfDate: today.Format("2006-01-02"), RHRBaseline: floatPtr(50)}}
	for i := 1; i <= 20; i++ {
		f.health = append(f.health, storage.DailyHealth{Date: today.AddDate(0, 0, -i).Format("20060102"), RHR: intPtr(40)})
	}
	f.health = append(f.health, storage.DailyHealth{Date: today.Format("20060102"), RHR: intPtr(55)})
	if _, err := runJob(t, NewCompute(f), `{"mode":"incremental","health_dates":["`+today.Format("2006-01-02")+`"]}`); err != nil {
		t.Fatal(err)
	}
	if len(f.dailyRows) != 1 || f.dailyRows[0].ReadinessGate == nil || *f.dailyRows[0].ReadinessGate != "yellow" {
		t.Fatalf("canonical 50+5 should be yellow, not local P10+15: %+v", f.dailyRows)
	}
	p, state := storage.ReadCalibrationProvenance(f.dailyRows[0])
	if state != "available" || len(p.Inputs) != 1 || p.Inputs[0].SnapshotID != 17 || p.Inputs[0].ValuesUsed.RHRBaseline == nil || *p.Inputs[0].ValuesUsed.RHRBaseline != 50 {
		t.Fatalf("rest source lost: %s %+v", state, p)
	}
	if p.Seed == nil || p.Seed.State != "explicit_zero_anchor" {
		t.Fatalf("lost zero anchor: %+v", p.Seed)
	}
}

func TestReadinessMissingHistoricalRHRDoesNotBorrowHealthOrFutureBundle(t *testing.T) {
	today := timefmt.ShanghaiToday()
	past := today.AddDate(0, 0, -1)
	f := &fakeStore{snap: &storage.RunningCalibrationSnapshot{ID: 2, AsOfDate: today.Format("2006-01-02"), RHRBaseline: floatPtr(40)}, snapByDay: map[string]*storage.RunningCalibrationSnapshot{}, health: []storage.DailyHealth{{Date: past.Format("20060102"), RHR: intPtr(70)}}}
	f.snapByDay[today.Format("2006-01-02")] = f.snap
	// No historical snapshot at all: daily readiness may retain other signals,
	// but explicitly reports that the RHR comparison could not be performed.
	daily, err := computeDaily(storage.WithCalibrationCache(context.Background()), f, testUser, nil, past, past, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(daily) != 1 || !strings.Contains(strings.Join(daily[0].ReadinessReasons, ","), "rhr_baseline_unavailable") || strings.Contains(strings.Join(daily[0].ReadinessReasons, ","), "rhr_elevated") {
		t.Fatalf("missing baseline silently filled: %+v", daily)
	}
}
