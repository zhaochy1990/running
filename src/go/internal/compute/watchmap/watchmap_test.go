package watchmap

import (
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

func f(v float64) *float64 { return &v }

func TestAsSpeedMps(t *testing.T) {
	if got := AsSpeedMps(nil); got != nil {
		t.Errorf("nil -> %v, want nil", *got)
	}
	if got := AsSpeedMps(f(0)); got != nil {
		t.Errorf("0 -> %v, want nil", *got)
	}
	if got := AsSpeedMps(f(5)); got == nil || *got != 5.0 {
		t.Errorf("5 (m/s) -> %v, want 5", got)
	}
	if got := AsSpeedMps(f(300)); got == nil || *got < 3.333 || *got > 3.334 {
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
	got := NormalizeElapsedSeconds(rows)
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
	if got := SportFromRow(&run, 0); got != "run" {
		t.Errorf("explicit sport -> %q, want run", got)
	}
	empty := "  "
	if got := SportFromRow(&empty, 100); got != "run_outdoor" {
		t.Errorf("sport_type 100 -> %q, want run_outdoor", got)
	}
	if got := SportFromRow(nil, 102); got != "run_trail" {
		t.Errorf("sport_type 102 -> %q, want run_trail", got)
	}
	if got := SportFromRow(nil, 9999); got != "unknown" {
		t.Errorf("unknown sport_type -> %q, want unknown", got)
	}
}

func TestDistanceScale(t *testing.T) {
	rows := []storage.TimeseriesPoint{{Distance: f(1000)}, {Distance: f(5000)}}
	if got := DistanceScale(rows, f(5000), "coros"); got != 1.0 {
		t.Errorf("metres scale = %v, want 1.0", got)
	}
	cm := []storage.TimeseriesPoint{{Distance: f(500000)}}
	if got := DistanceScale(cm, f(5000), "coros"); got != 0.01 {
		t.Errorf("cm scale = %v, want 0.01", got)
	}
}
