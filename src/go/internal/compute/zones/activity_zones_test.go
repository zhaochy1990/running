package zones

import (
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func f64s(vals ...float64) []*float64 {
	out := make([]*float64, len(vals))
	for i, v := range vals {
		x := v
		out[i] = &x
	}
	return out
}

func f64ptr(v float64) *float64 { return &v }

func floatEq(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestDwellSeconds(t *testing.T) {
	t.Run("normal gaps plus last-sample median", func(t *testing.T) {
		got := DwellSeconds(f64s(0, 1, 3, 6))
		want := []float64{1, 2, 3, 2}
		for i := range want {
			floatEq(t, got[i], want[i])
		}
	})
	t.Run("pause gap clamped to median", func(t *testing.T) {
		got := DwellSeconds(f64s(0, 1, 2, 52))
		want := []float64{1, 1, 1, 1}
		for i := range want {
			floatEq(t, got[i], want[i])
		}
	})
	t.Run("missing timestamp gets median", func(t *testing.T) {
		got := DwellSeconds([]*float64{nil, f64ptr(1), f64ptr(2)})
		want := []float64{1, 1, 1}
		for i := range want {
			floatEq(t, got[i], want[i])
		}
	})
	t.Run("non-increasing gap gets median", func(t *testing.T) {
		got := DwellSeconds(f64s(0, 2, 2, 5))
		want := []float64{2, 3, 3, 3}
		for i := range want {
			floatEq(t, got[i], want[i])
		}
	})
	t.Run("empty input", func(t *testing.T) {
		if got := DwellSeconds(nil); got != nil {
			t.Errorf("got %v, want nil", got)
		}
	})
	t.Run("no valid deltas falls back to 1s", func(t *testing.T) {
		got := DwellSeconds([]*float64{nil, nil, nil})
		want := []float64{1, 1, 1}
		for i := range want {
			floatEq(t, got[i], want[i])
		}
	})
}

// testPaceZones mirrors a threshold-speed-derived ladder (easy ≈ 5:00–6:00/km).
// STRIDE convention: range_min = faster (smaller ms/km), range_max = slower
// (larger ms/km); recovery's slow edge is open (MaxPace nil), repetition's fast
// edge is open (MinPace nil).
func testPaceZones() []calibration.PaceZone {
	return []calibration.PaceZone{
		{Name: "recovery", MinPaceSPerKm: f64ptr(360), MaxPaceSPerKm: nil, MinSpeedMps: nil, MaxSpeedMps: f64ptr(2.778)},
		{Name: "easy", MinPaceSPerKm: f64ptr(300), MaxPaceSPerKm: f64ptr(360), MinSpeedMps: f64ptr(2.778), MaxSpeedMps: f64ptr(3.333)},
		{Name: "marathon", MinPaceSPerKm: f64ptr(270), MaxPaceSPerKm: f64ptr(300), MinSpeedMps: f64ptr(3.333), MaxSpeedMps: f64ptr(3.704)},
		{Name: "threshold", MinPaceSPerKm: f64ptr(255), MaxPaceSPerKm: f64ptr(270), MinSpeedMps: f64ptr(3.704), MaxSpeedMps: f64ptr(3.922)},
		{Name: "interval", MinPaceSPerKm: f64ptr(240), MaxPaceSPerKm: f64ptr(255), MinSpeedMps: f64ptr(3.922), MaxSpeedMps: f64ptr(4.167)},
		{Name: "repetition", MinPaceSPerKm: nil, MaxPaceSPerKm: f64ptr(240), MinSpeedMps: f64ptr(4.167), MaxSpeedMps: nil},
	}
}

func testHRZones() []calibration.HeartRateZone {
	return []calibration.HeartRateZone{
		{Name: "recovery", MinBpm: nil, MaxBpm: f64ptr(120)},
		{Name: "easy", MinBpm: f64ptr(120), MaxBpm: f64ptr(132)},
		{Name: "marathon", MinBpm: f64ptr(132), MaxBpm: f64ptr(141)},
		{Name: "threshold", MinBpm: f64ptr(141), MaxBpm: f64ptr(151.5)},
		{Name: "interval", MinBpm: f64ptr(151.5), MaxBpm: f64ptr(159)},
		{Name: "repetition", MinBpm: f64ptr(159), MaxBpm: nil},
	}
}

func zoneByIndex(rows []Zone, typ string, idx int) Zone {
	for _, r := range rows {
		if r.ZoneType == typ && r.ZoneIndex == idx {
			return r
		}
	}
	return Zone{}
}

func TestComputeActivityTimeInZone(t *testing.T) {
	pace := testPaceZones()
	hr := testHRZones()
	samples := []Sample{
		{DwellS: 60, SpeedMps: f64ptr(3.0), HRBpm: f64ptr(125)},   // easy / easy
		{DwellS: 30, SpeedMps: f64ptr(4.2), HRBpm: f64ptr(160)},   // repetition / repetition
		{DwellS: 10, SpeedMps: f64ptr(3.8), HRBpm: f64ptr(145)},   // threshold / threshold
		{DwellS: 20, SpeedMps: f64ptr(3.6), HRBpm: f64ptr(135.4)}, // marathon / marathon
	}
	rows := ComputeActivityTimeInZone(samples, pace, hr)

	if len(rows) != 12 {
		t.Fatalf("rows = %d, want 12 (6 pace + 6 HR)", len(rows))
	}

	// Every zone emitted (0-duration included), physiological index 1..6.
	for _, typ := range []string{"pace", "heartRate"} {
		for i := 1; i <= 6; i++ {
			z := zoneByIndex(rows, typ, i)
			if z.ZoneType != typ || z.ZoneIndex != i {
				t.Errorf("missing %s zone %d", typ, i)
			}
		}
	}

	// Pace dwell: easy 60 + marathon 20 + threshold 10 + repetition 30 = 120.
	pEasy := zoneByIndex(rows, "pace", 2)
	if pEasy.DurationS == nil || *pEasy.DurationS != 60 {
		t.Errorf("easy duration = %v, want 60", pEasy.DurationS)
	}
	if pEasy.Percent == nil || *pEasy.Percent != 50.0 {
		t.Errorf("easy percent = %v, want 50.0", pEasy.Percent)
	}
	// Ranges: easy = 5:00–6:00 → min(ms/km)=300000, max=360000 (min=faster).
	if pEasy.RangeMin == nil || *pEasy.RangeMin != 300000 {
		t.Errorf("easy range_min = %v, want 300000", pEasy.RangeMin)
	}
	if pEasy.RangeMax == nil || *pEasy.RangeMax != 360000 {
		t.Errorf("easy range_max = %v, want 360000", pEasy.RangeMax)
	}
	if pEasy.RangeUnit == nil || *pEasy.RangeUnit != "pace" {
		t.Errorf("easy range_unit = %v, want pace", pEasy.RangeUnit)
	}

	// Open edges: recovery slow edge open (range_max nil, fast edge = 360000),
	// fastest zone's fast edge open (repetition range_min nil).
	pRec := zoneByIndex(rows, "pace", 1)
	if pRec.RangeMax != nil || pRec.RangeMin == nil || *pRec.RangeMin != 360000 {
		t.Errorf("recovery pace ranges = %v/%v, want 360000/nil", pRec.RangeMin, pRec.RangeMax)
	}
	pRep := zoneByIndex(rows, "pace", 6)
	if pRep.RangeMin != nil || pRep.RangeMax == nil || *pRep.RangeMax != 240000 {
		t.Errorf("repetition pace ranges = %v/%v, want nil/240000", pRep.RangeMin, pRep.RangeMax)
	}

	// HR dwell/percent: easy 60 / 120 = 50%.
	hEasy := zoneByIndex(rows, "heartRate", 2)
	if hEasy.DurationS == nil || *hEasy.DurationS != 60 {
		t.Errorf("hr easy duration = %v, want 60", hEasy.DurationS)
	}
	if hEasy.Percent == nil || *hEasy.Percent != 50.0 {
		t.Errorf("hr easy percent = %v, want 50.0", hEasy.Percent)
	}
	if hEasy.RangeMin == nil || *hEasy.RangeMin != 120 || hEasy.RangeMax == nil || *hEasy.RangeMax != 132 {
		t.Errorf("hr easy ranges = %v/%v, want 120/132", hEasy.RangeMin, hEasy.RangeMax)
	}
	if hEasy.RangeUnit == nil || *hEasy.RangeUnit != "bpm" {
		t.Errorf("hr easy range_unit = %v, want bpm", hEasy.RangeUnit)
	}
	// HR open edges: recovery min nil, repetition max nil.
	hRec := zoneByIndex(rows, "heartRate", 1)
	if hRec.RangeMin != nil || hRec.RangeMax == nil || *hRec.RangeMax != 120 {
		t.Errorf("recovery hr ranges = %v/%v, want nil/120", hRec.RangeMin, hRec.RangeMax)
	}
	hRep := zoneByIndex(rows, "heartRate", 6)
	if hRep.RangeMax != nil || hRep.RangeMin == nil || *hRep.RangeMin != 159 {
		t.Errorf("repetition hr ranges = %v/%v, want 159/nil", hRep.RangeMin, hRep.RangeMax)
	}

	// Pace and HR percents each sum to ~100 independently.
	for _, typ := range []string{"pace", "heartRate"} {
		var sum float64
		for i := 1; i <= 6; i++ {
			z := zoneByIndex(rows, typ, i)
			if z.Percent != nil {
				sum += *z.Percent
			}
		}
		if sum < 99.9 || sum > 100.1 {
			t.Errorf("%s percents sum = %v, want ~100", typ, sum)
		}
	}
}

func TestComputeActivityTimeInZone_UnknownZoneNameSkipped(t *testing.T) {
	// A calibration zone name outside the fixed ladder must not emit a bogus
	// zone_index=0 row (mirrors the Python KeyError intent, without crashing).
	pace := testPaceZones()
	pace = append(pace, calibration.PaceZone{Name: "future_zone", MinPaceSPerKm: f64ptr(200), MaxPaceSPerKm: f64ptr(220), MinSpeedMps: f64ptr(4.5), MaxSpeedMps: f64ptr(5.0)})
	rows := ComputeActivityTimeInZone([]Sample{{DwellS: 5, SpeedMps: f64ptr(4.8)}}, pace, nil)
	for _, z := range rows {
		if z.ZoneIndex == 0 {
			t.Errorf("emitted a zone_index=0 row for unknown name: %+v", z)
		}
		if z.ZoneType == "pace" && z.ZoneIndex > 6 {
			t.Errorf("unexpected zone row: %+v", z)
		}
	}
}

func TestHalfOpenBoundaries(t *testing.T) {
	pace := testPaceZones()
	// speed exactly at easy's fast edge (3.333) must fall into marathon
	// ([3.333, 3.704)), not easy ([2.778, 3.333)).
	rows := ComputeActivityTimeInZone([]Sample{
		{DwellS: 5, SpeedMps: f64ptr(3.333)},
	}, pace, nil)
	if d := *zoneByIndex(rows, "pace", 3).DurationS; d != 5 {
		t.Errorf("marathon dwell = %d, want 5 (boundary goes to upper zone)", d)
	}
	// HR exactly at 120.0 falls into easy (>= 120); 119.9 into recovery.
	hr := testHRZones()
	rows = ComputeActivityTimeInZone([]Sample{{DwellS: 5, HRBpm: f64ptr(120)}}, nil, hr)
	if d := *zoneByIndex(rows, "heartRate", 2).DurationS; d != 5 {
		t.Errorf("hr easy dwell = %d, want 5 (120 >= min)", d)
	}
	rows = ComputeActivityTimeInZone([]Sample{{DwellS: 5, HRBpm: f64ptr(119.9)}}, nil, hr)
	if d := *zoneByIndex(rows, "heartRate", 1).DurationS; d != 5 {
		t.Errorf("hr recovery dwell = %d, want 5 (119.9 < easy min)", d)
	}
}

func TestComputeActivityTimeInZoneWithComputeTrainingZones(t *testing.T) {
	// Exercise the real boundary source: threshold-derived zones.
	snap := calibration.Snapshot{
		ThresholdHR:              f64ptr(150),
		ThresholdSpeedMps:        f64ptr(3.7),
		ThresholdHRConfidence:    calibration.ConfidenceHigh,
		ThresholdSpeedConfidence: calibration.ConfidenceHigh,
	}
	zs := calibration.ComputeTrainingZones(snap)
	if len(zs.PaceZones) != 6 || len(zs.HeartRateZones) != 6 {
		t.Fatalf("zone counts = %d/%d, want 6/6", len(zs.PaceZones), len(zs.HeartRateZones))
	}
	samples := []Sample{
		{DwellS: 100, SpeedMps: f64ptr(3.0), HRBpm: f64ptr(125)}, // easy
		{DwellS: 50, SpeedMps: f64ptr(4.2), HRBpm: f64ptr(165)},  // repetition
		{DwellS: 50, SpeedMps: f64ptr(2.0), HRBpm: f64ptr(105)},  // recovery
	}
	rows := ComputeActivityTimeInZone(samples, zs.PaceZones, zs.HeartRateZones)
	if len(rows) != 12 {
		t.Fatalf("rows = %d, want 12", len(rows))
	}
	// recovery: pace slow edge open (range_max nil, fast edge present), hr slow
	// edge open (range_min nil).
	pRec := zoneByIndex(rows, "pace", 1)
	if pRec.RangeMax != nil || pRec.RangeMin == nil || *pRec.RangeMin <= 0 {
		t.Errorf("recovery pace ranges = %v/%v, want <positive>/nil (open slow edge)", pRec.RangeMin, pRec.RangeMax)
	}
	hRec := zoneByIndex(rows, "heartRate", 1)
	if hRec.RangeMin != nil {
		t.Errorf("recovery hr range_min = %v, want nil (open slow edge)", hRec.RangeMin)
	}
	// recovery dwell 50 of 200 → 25%.
	if pRec.Percent == nil || *pRec.Percent != 25.0 {
		t.Errorf("recovery pace percent = %v, want 25.0", pRec.Percent)
	}
	// easy range_min = faster edge = 1000/3.108 ≈ 321.75 s/km → 321750 ms/km.
	pEasy := zoneByIndex(rows, "pace", 2)
	if pEasy.RangeMin == nil || *pEasy.RangeMin != 321750 {
		t.Errorf("easy pace range_min = %v, want 321750", pEasy.RangeMin)
	}
	if pEasy.RangeMax == nil {
		t.Errorf("easy pace range_max = %v, want a slow edge (not open)", pEasy.RangeMax)
	}
}
