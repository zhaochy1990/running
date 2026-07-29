package pb

import "testing"

func TestBestDistanceCandidatesConstantSpeed(t *testing.T) {
	// 4 m/s for 300 s -> 1200 m covered.
	var ts [][2]float64
	for i := 0; i <= 300; i++ {
		ts = append(ts, [2]float64{float64(i), 4.0 * float64(i)})
	}
	got := bestDistanceCandidates(ts, nil, map[string]float64{"1K": 1000})
	c, ok := got["1K"]
	if !ok {
		t.Fatal("expected a 1K candidate")
	}
	if c.durationS < 249.9 || c.durationS > 250.1 { // 1000m / 4 m/s
		t.Errorf("1K duration = %v, want ~250", c.durationS)
	}
	if c.distanceM != 1000 {
		t.Errorf("distance = %v, want 1000", c.distanceM)
	}
}

func TestBestDistanceCandidatesSkipsPausedSegment(t *testing.T) {
	var ts [][2]float64
	for i := 0; i <= 300; i++ {
		ts = append(ts, [2]float64{float64(i), 4.0 * float64(i)})
	}
	// Pause covering the whole first 260s forces a later (still 250s) window.
	got := bestDistanceCandidates(ts, [][2]float64{{0, 260}}, map[string]float64{"1K": 1000})
	if c, ok := got["1K"]; ok && c.startS < 259 {
		t.Errorf("candidate should start after the pause, got start=%v", c.startS)
	}
}

func TestNormalizeTimeseriesCentiseconds(t *testing.T) {
	ts := func(v int64) *int64 { return &v }
	d := func(v float64) *float64 { return &v }
	rows := []TSPoint{
		{Timestamp: ts(1000), Distance: d(0)},
		{Timestamp: ts(1100), Distance: d(400)},
		{Timestamp: ts(1050), Distance: d(200)}, // out-of-order distance? no, 200<400 -> kept only if >= last
		{Timestamp: ts(1200), Distance: d(800)},
	}
	got := normalizeTimeseries(rows, d(800))
	// (1000,0)->(0,0), (1100,400)->(1,400), (1050,200) dropped (200<400), (1200,800)->(2,800)
	want := [][2]float64{{0, 0}, {1, 400}, {2, 800}}
	if len(got) != len(want) {
		t.Fatalf("got %d points, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("point %d = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestParsePauses(t *testing.T) {
	raw := `[{"start_ts":1500,"end_ts":1600},{"start_ts":2000,"end_ts":1900}]`
	got := parsePauses(&raw, 1000)
	// first -> (5,6); second end<=start -> dropped.
	if len(got) != 1 || got[0] != [2]float64{5, 6} {
		t.Fatalf("parsePauses = %v, want [(5,6)]", got)
	}
}

func TestDetectPersonalBestsEndToEnd(t *testing.T) {
	ts := func(v int64) *int64 { return &v }
	d := func(v float64) *float64 { return &v }
	dur := 250.0
	dist := 1000.0
	// One activity with a clean 1000m @ 4 m/s timeseries.
	var points []TSPoint
	for i := int64(0); i <= 300; i++ {
		points = append(points, TSPoint{Timestamp: ts(i * 100), Distance: d(4.0 * float64(i))})
	}
	acts := []Activity{{LabelID: "a1", DistanceM: &dist, DurationS: &dur}}
	fetch := func(string) ([]TSPoint, error) { return points, nil }

	entries, err := DetectPersonalBests(acts, fetch)
	if err != nil {
		t.Fatal(err)
	}
	e, ok := entries["1K"]
	if !ok {
		t.Fatal("expected a 1K PB")
	}
	if e.Source != "segment" || e.PBTimeSec < 249.9 || e.PBTimeSec > 250.1 {
		t.Errorf("1K PB = %+v, want ~250 segment", e)
	}
}
