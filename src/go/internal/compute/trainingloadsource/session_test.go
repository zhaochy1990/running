package trainingloadsource

import (
	"context"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/storage"
)

type fakeEvidenceStore struct {
	laps  map[string][]storage.Lap
	zones []storage.RunningCalibrationPaceZone
	snap  *storage.RunningCalibrationSnapshot
	races map[string]bool
}

func (f *fakeEvidenceStore) ActivitiesInWindow(ctx context.Context, userID, provider string, start, end time.Time) ([]storage.Activity, error) {
	return nil, nil
}
func (f *fakeEvidenceStore) ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error) {
	return nil, nil
}
func (f *fakeEvidenceStore) ActivityLaps(ctx context.Context, userID, labelID string) ([]storage.Lap, error) {
	return f.laps[labelID], nil
}
func (f *fakeEvidenceStore) LatestCalibrationPaceZones(ctx context.Context, userID string) (*storage.RunningCalibrationSnapshot, []storage.RunningCalibrationPaceZone, error) {
	return f.snap, f.zones, nil
}
func (f *fakeEvidenceStore) LinkedRaceLabels(ctx context.Context, userID string, labelIDs []string) (map[string]bool, error) {
	return f.races, nil
}

func f64(v float64) *float64 { return &v }
func sPtr(v string) *string  { return &v }

func fakeZones() []storage.RunningCalibrationPaceZone {
	return []storage.RunningCalibrationPaceZone{
		{Name: "marathon", MinPaceSPerKm: f64(239), MaxPaceSPerKm: f64(276)},
		{Name: "threshold", MinPaceSPerKm: f64(225), MaxPaceSPerKm: f64(239)},
	}
}

func TestSessionClassWithEvidence(t *testing.T) {
	store := &fakeEvidenceStore{
		zones: fakeZones(),
		snap:  &storage.RunningCalibrationSnapshot{ThresholdHR: f64(167)},
		races: map[string]bool{"race-1": true},
		laps: map[string][]storage.Lap{
			"race-1": {
				{LapType: "type2", DistanceM: f64(1000), DurationS: f64(215)},
				{LapType: "type2", DistanceM: f64(1000), DurationS: f64(216)},
			},
		},
	}
	rows := []storage.Activity{
		{LabelID: "race-1", Sport: sPtr("run_outdoor"), SportType: 100, DistanceM: f64(21190), DurationS: f64(4560), TrainKind: sPtr("interval"), Name: sPtr("东营市 跑步")},
		{LabelID: "noise-1", Sport: sPtr("run_outdoor"), SportType: 100, DistanceM: f64(10050), DurationS: f64(3300), AvgPaceSKm: f64(295), AvgHR: nil, TrainKind: sPtr("tempo"), TrainType: sPtr("TEMPO"), Name: sPtr("青浦区 跑步")},
		{LabelID: "str-1", SportType: 800, TrainKind: sPtr("strength"), Name: sPtr("力量")},
	}
	ev := loadEvidence(context.Background(), store, "u1", rows)

	if got := SessionClassWithEvidence(context.Background(), ev, rows[0]); got != trainingload.SessionRace {
		t.Fatalf("races-linked run = %s, want race", got)
	}
	// Uncorroborated TEMPO on an easy run degrades to easy under the legacy
	// enum too (the old passthrough returned tempo here).
	if got := SessionClassWithEvidence(context.Background(), ev, rows[1]); got != trainingload.SessionEasy {
		t.Fatalf("vendor-noise run = %s, want easy", got)
	}
	if got := SessionClassWithEvidence(context.Background(), ev, rows[2]); got != trainingload.SessionStrength {
		t.Fatalf("strength row = %s, want strength", got)
	}
}

func TestLoadEvidenceDegradesWithoutReader(t *testing.T) {
	// A reader that does not implement evidenceReader must still classify
	// (degraded path) — Load type-asserts and falls back to nil evidence.
	ev := loadEvidence(context.Background(), nil, "u1", nil)
	_ = ev
	a := storage.Activity{LabelID: "x", Sport: sPtr("run_treadmill"), SportType: 101, DistanceM: f64(7700), DurationS: f64(2760), AnaerobicEffect: f64(3.1), Name: sPtr("跑步机")}
	if got := SessionClass(a); got != trainingload.SessionInterval {
		t.Fatalf("degraded treadmill intervals = %s, want interval", got)
	}
}
