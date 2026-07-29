package calibrationsource

import (
	"context"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

func TestAsSpeedMps(t *testing.T) {
	if got := asSpeedMps(nil); got != nil {
		t.Errorf("nil -> %v, want nil", *got)
	}
	zero := 0.0
	if got := asSpeedMps(&zero); got != nil {
		t.Errorf("0 -> %v, want nil", *got)
	}
	ms := 5.0
	if got := asSpeedMps(&ms); got == nil || *got != 5.0 {
		t.Errorf("5 (m/s) -> %v, want 5", got)
	}
	pace := 300.0 // sec/km style -> 1000/300
	if got := asSpeedMps(&pace); got == nil || *got < 3.333 || *got > 3.334 {
		t.Errorf("300 (pace) -> %v, want ~3.3333", got)
	}
}

func TestNormalizeElapsedCentiseconds(t *testing.T) {
	ts := func(v int64) *int64 { return &v }
	rows := []storage.TimeseriesPoint{
		{Timestamp: ts(178523734600)},
		{Timestamp: ts(178523734700)},
		{Timestamp: ts(178523734800)},
		{Timestamp: nil},
	}
	got := normalizeElapsedSeconds(rows)
	want := []float64{0, 1.0, 2.0}
	for i, w := range want {
		if got[i] == nil || *got[i] != w {
			t.Errorf("elapsed[%d] = %v, want %v", i, got[i], w)
		}
	}
	if got[3] != nil {
		t.Errorf("elapsed[3] = %v, want nil", *got[3])
	}
}

func TestSportFromRow(t *testing.T) {
	run := "run"
	if got := sportFromRow(&run, 0); got != "run" {
		t.Errorf("explicit sport -> %q, want run", got)
	}
	empty := "  "
	if got := sportFromRow(&empty, 100); got != "run_outdoor" {
		t.Errorf("sport_type 100 -> %q, want run_outdoor", got)
	}
	if got := sportFromRow(nil, 102); got != "run_trail" {
		t.Errorf("sport_type 102 -> %q, want run_trail", got)
	}
	if got := sportFromRow(nil, 9999); got != "unknown" {
		t.Errorf("unknown sport_type -> %q, want unknown", got)
	}
}

func TestDistanceScale(t *testing.T) {
	rows := []storage.TimeseriesPoint{{Distance: f(1000)}, {Distance: f(5000)}}
	ad := 5000.0
	if got := distanceScale(rows, &ad, "coros"); got != 1.0 {
		t.Errorf("metres scale = %v, want 1.0", got)
	}
	// centimetre rows: max 500000 vs 5000m activity -> ratio 100 > 20 -> 0.01
	cm := []storage.TimeseriesPoint{{Distance: f(500000)}}
	if got := distanceScale(cm, &ad, "coros"); got != 0.01 {
		t.Errorf("cm scale = %v, want 0.01", got)
	}
}

func TestShanghaiDayCrossesMidnight(t *testing.T) {
	// 2026-07-28 20:00 UTC = 2026-07-29 04:00 Shanghai -> day 07-29.
	utc := time.Date(2026, 7, 28, 20, 0, 0, 0, time.UTC)
	got := shanghaiDay(utc)
	want := time.Date(2026, 7, 29, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Errorf("shanghaiDay = %v, want %v", got, want)
	}
}

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

func i64(v int64) *int64 { return &v }
