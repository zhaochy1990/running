package garmin

import (
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/normalize"
)

func TestSportFromTypeKey(t *testing.T) {
	cases := map[string]normalize.Sport{
		"running":           normalize.SportRunOutdoor,
		"treadmill_running": normalize.SportRunTreadmill,
		"trail_running":     normalize.SportRunTrail,
		"lap_swimming":      normalize.SportSwimPool,
		"strength_training": normalize.SportStrength,
		"nonsense_sport":    normalize.SportUnknown,
	}
	for key, want := range cases {
		if got := sportFromTypeKey(key); got != want {
			t.Errorf("sportFromTypeKey(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestSyntheticSportType(t *testing.T) {
	if got := syntheticSportType("running"); got != 8001 {
		t.Errorf("running synthetic = %d, want 8001", got)
	}
	if got := syntheticSportType(""); got != garminSportTypeBase {
		t.Errorf("empty synthetic = %d, want %d", got, garminSportTypeBase)
	}
	if got := syntheticSportType("brand_new_sport"); got != garminSportTypeBase {
		t.Errorf("unknown synthetic = %d, want base", got)
	}
}

func TestTrainKindFromLabel(t *testing.T) {
	if k, ok := trainKindFromLabel("TEMPO"); !ok || k != normalize.TrainTempo {
		t.Errorf("TEMPO -> %q,%v want tempo,true", k, ok)
	}
	if k, ok := trainKindFromLabel("AEROBIC_BASE"); !ok || k != normalize.TrainBase {
		t.Errorf("AEROBIC_BASE -> %q,%v want base,true", k, ok)
	}
	if _, ok := trainKindFromLabel(""); ok {
		t.Errorf("empty label should be (_, false)")
	}
	if k, ok := trainKindFromLabel("SOMETHING_NEW"); !ok || k != normalize.TrainUnknown {
		t.Errorf("unknown label -> %q,%v want unknown,true", k, ok)
	}
}

func TestFeelFromScore(t *testing.T) {
	mk := func(v int) *int { return &v }
	cases := []struct {
		in   *int
		want *float64 // nil when unrated
	}{
		{nil, nil},
		{mk(0), nil},
		{mk(10), fptr(1.0)},
		{mk(30), fptr(3.0)},
		{mk(50), fptr(5.0)},
		{mk(70), fptr(7.0)},
		{mk(95), fptr(9.5)},
	}
	for _, c := range cases {
		got := feelFromScore(c.in)
		switch {
		case c.want == nil && got != nil:
			t.Errorf("feelFromScore(%v) = %v, want nil", c.in, *got)
		case c.want != nil && got == nil:
			t.Errorf("feelFromScore(%v) = nil, want %v", c.in, *c.want)
		case c.want != nil && got != nil && *got != *c.want:
			t.Errorf("feelFromScore(%v) = %v, want %v", c.in, *got, *c.want)
		}
	}
}

func TestMsToPaceSKm(t *testing.T) {
	if p := msToPaceSKm(nil); p != nil {
		t.Errorf("nil speed should stay nil")
	}
	zero := 0.0
	if p := msToPaceSKm(&zero); p != nil {
		t.Errorf("zero speed should be nil")
	}
	sp := 4.0 // m/s → 250 s/km
	if p := msToPaceSKm(&sp); p == nil || math.Abs(*p-250.0) > 1e-9 {
		t.Errorf("4 m/s -> %v, want 250", p)
	}
}

func TestFatigueFromGarmin(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	// ratio 1.0 → 45
	if got := fatigueFromGarmin(f(1.0), nil, nil); got == nil || *got != 45.0 {
		t.Errorf("ratio 1.0 -> %v, want 45", got)
	}
	// ratio 1.5 → 60
	if got := fatigueFromGarmin(f(1.5), nil, nil); got == nil || *got != 60.0 {
		t.Errorf("ratio 1.5 -> %v, want 60", got)
	}
	// clamp low: ratio 0.0 → 25 (45-30=15 clamped to 25)
	if got := fatigueFromGarmin(f(0.0), nil, nil); got == nil || *got != 25.0 {
		t.Errorf("ratio 0.0 -> %v, want 25 (clamped)", got)
	}
	// fallback to ati/cti
	if got := fatigueFromGarmin(nil, f(30), f(20)); got == nil || *got != 60.0 {
		t.Errorf("ati/cti 30/20 (ratio 1.5) -> %v, want 60", got)
	}
	// no signal → nil
	if got := fatigueFromGarmin(nil, nil, nil); got != nil {
		t.Errorf("no signal -> %v, want nil", got)
	}
}
