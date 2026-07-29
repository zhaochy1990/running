package calibrationsource

import (
	"context"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeReader serves fixed rows so Load is testable without a DB.
type fakeReader struct {
	acts   []storage.Activity
	ts     map[string][]storage.TimeseriesPoint
	laps   map[string][]storage.Lap
	health []storage.DailyHealth
}

func (r fakeReader) ActivitiesInWindow(_ context.Context, _, _ string, _, _ time.Time) ([]storage.Activity, error) {
	return r.acts, nil
}
func (r fakeReader) ActivityTimeseries(_ context.Context, _, labelID string) ([]storage.TimeseriesPoint, error) {
	return r.ts[labelID], nil
}
func (r fakeReader) ActivityLaps(_ context.Context, _, labelID string) ([]storage.Lap, error) {
	return r.laps[labelID], nil
}
func (r fakeReader) DailyHealthWithRHR(_ context.Context, _ string) ([]storage.DailyHealth, error) {
	return r.health, nil
}

func f(v float64) *float64 { return &v }
func i(v int) *int         { return &v }
func i64(v int64) *int64   { return &v }

func TestLoadDropsNonRunningAndMaps(t *testing.T) {
	run := "run"
	bike := "bike"
	asOf := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	r := fakeReader{
		acts: []storage.Activity{
			{LabelID: "r1", Date: time.Date(2026, 7, 20, 2, 0, 0, 0, time.UTC), Sport: &run, MaxHR: i(180), AvgPower: i(220), DistanceM: f(5000)},
			{LabelID: "b1", Date: time.Date(2026, 7, 21, 2, 0, 0, 0, time.UTC), Sport: &bike, AvgPower: i(250)},
		},
		ts: map[string][]storage.TimeseriesPoint{
			"r1": {{Timestamp: i64(100), HeartRate: i(150), Power: i(210), Speed: f(4.0)}},
		},
		health: []storage.DailyHealth{{Date: "20260728", RHR: i(48)}},
	}

	history, health, err := Load(context.Background(), r, "u", "coros", asOf, 180)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].LabelID != "r1" {
		t.Fatalf("history = %d activities, want 1 (r1 only, bike dropped)", len(history))
	}
	a := history[0]
	if a.MaxHR == nil || *a.MaxHR != 180 {
		t.Errorf("max_hr = %v, want 180", a.MaxHR)
	}
	if len(a.Samples) != 1 || a.Samples[0].SpeedMps == nil || *a.Samples[0].SpeedMps != 4.0 {
		t.Errorf("sample speed mapping wrong: %+v", a.Samples)
	}
	if len(health) != 1 || health[0].RHR == nil || *health[0].RHR != 48 {
		t.Fatalf("health = %+v, want one row rhr 48", health)
	}
	wantDay := time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC)
	if !health[0].Date.Equal(wantDay) {
		t.Errorf("health day = %v, want %v", health[0].Date, wantDay)
	}
}
