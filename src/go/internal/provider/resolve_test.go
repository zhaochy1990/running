// Tests for the pure relative/zone → absolute resolution. Baselines are always
// injected; a missing baseline required by the target kind is a hard error, and
// no default is ever invented.
package provider

import (
	"math"
	"strings"
	"testing"
)

func fullBaselines() Baselines {
	hrmax := 190.0
	rhr := 50.0
	lthr := 170.0
	ltpace := 300.0
	racepace := 280.0
	ftp := 300.0
	return Baselines{
		HRMaxBPM:    &hrmax,
		RHRBPM:      &rhr,
		LTHRBPM:     &lthr,
		LTPaceSKM:   &ltpace,
		RacePaceSKM: &racepace,
		FTPW:        &ftp,
		PaceZones: []ZoneBand{
			{Zone: 1, Min: 330, Max: 360},
			{Zone: 2, Min: 300, Max: 330},
			{Zone: 3, Min: 270, Max: 300},
		},
		HRZones: []ZoneBand{
			{Zone: 1, Min: 110, Max: 130},
			{Zone: 2, Min: 130, Max: 150},
			{Zone: 3, Min: 150, Max: 170},
		},
	}
}

func approxEqual(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestResolveTargetAbsoluteAndOpenPassThrough(t *testing.T) {
	for _, target := range []Target{
		PaceRangeSKM(340, 320),
		HRRangeBPM(130, 150),
		PowerRangeW(200, 250),
		OpenTarget(),
	} {
		got, err := ResolveTarget(target, Baselines{})
		if err != nil {
			t.Fatalf("ResolveTarget(%q) = %v, want pass-through", target.Kind, err)
		}
		if got.Kind != target.Kind {
			t.Errorf("kind = %q, want %q", got.Kind, target.Kind)
		}
	}
}

func TestResolveTargetRelativeKinds(t *testing.T) {
	cases := []struct {
		name     string
		target   Target
		wantKind TargetKind
		wantLow  float64
		wantHigh float64
	}{
		{"pct_max_hr", PctRange(TargetPctMaxHR, 0.70, 0.80), TargetHRBPM, 133, 152},
		{"pct_hrr", PctRange(TargetPctHRR, 0.60, 0.75), TargetHRBPM, 134, 155},
		{"pct_lt_hr", PctRange(TargetPctLTHR, 0.90, 1.00), TargetHRBPM, 153, 170},
		{"pct_lt_pace", PctRange(TargetPctLTPace, 0.87, 0.93), TargetPaceSKM, 300.0 / 0.87, 300.0 / 0.93},
		{"pct_race_pace", PctRange(TargetPctRacePace, 0.90, 1.00), TargetPaceSKM, 280.0 / 0.90, 280.0},
		{"pct_ftp", PctRange(TargetPctFTP, 0.80, 0.90), TargetPowerW, 240, 270},
	}
	b := fullBaselines()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveTarget(tc.target, b)
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}
			if got.Kind != tc.wantKind {
				t.Errorf("kind = %q, want %q", got.Kind, tc.wantKind)
			}
			if got.Low == nil || !approxEqual(*got.Low, tc.wantLow) {
				t.Errorf("low = %v, want %v", got.Low, tc.wantLow)
			}
			if got.High == nil || !approxEqual(*got.High, tc.wantHigh) {
				t.Errorf("high = %v, want %v", got.High, tc.wantHigh)
			}
		})
	}
}

func TestResolveTargetZoneKinds(t *testing.T) {
	b := fullBaselines()
	pace, err := ResolveTarget(ZoneRange(TargetPaceZone, 2, 3), b)
	if err != nil {
		t.Fatalf("pace zone: %v", err)
	}
	if pace.Kind != TargetPaceSKM {
		t.Errorf("pace zone kind = %q, want %q", pace.Kind, TargetPaceSKM)
	}
	// Numeric span is 270..330 s/km; pace convention puts the slower bound in Low.
	if pace.Low == nil || !approxEqual(*pace.Low, 330) {
		t.Errorf("pace zone low = %v, want 330", pace.Low)
	}
	if pace.High == nil || !approxEqual(*pace.High, 270) {
		t.Errorf("pace zone high = %v, want 270", pace.High)
	}

	hr, err := ResolveTarget(ZoneRange(TargetHRZone, 2, 3), b)
	if err != nil {
		t.Fatalf("hr zone: %v", err)
	}
	if hr.Kind != TargetHRBPM {
		t.Errorf("hr zone kind = %q, want %q", hr.Kind, TargetHRBPM)
	}
	if hr.Low == nil || !approxEqual(*hr.Low, 130) || hr.High == nil || !approxEqual(*hr.High, 170) {
		t.Errorf("hr zone range = %v..%v, want 130..170", hr.Low, hr.High)
	}
}

func TestResolveTargetMissingBaselineIsHardError(t *testing.T) {
	// Only HRmax present: everything that needs another baseline must fail.
	hrmax := 190.0
	partial := Baselines{HRMaxBPM: &hrmax}
	cases := []struct {
		name   string
		target Target
		want   string
	}{
		{"pct_max_hr", PctRange(TargetPctMaxHR, 0.7, 0.8), "HRmax"},
		{"pct_hrr", PctRange(TargetPctHRR, 0.6, 0.7), "HRmax"},
		{"pct_lt_hr", PctRange(TargetPctLTHR, 0.9, 1.0), "LT HR"},
		{"pct_lt_pace", PctRange(TargetPctLTPace, 0.87, 0.93), "LT pace"},
		{"pct_race_pace", PctRange(TargetPctRacePace, 0.9, 1.0), "race pace"},
		{"pct_ftp", PctRange(TargetPctFTP, 0.8, 0.9), "FTP"},
		{"pace_zone", ZoneRange(TargetPaceZone, 2, 3), "pace zones"},
		{"hr_zone", ZoneRange(TargetHRZone, 2, 3), "HR zones"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ResolveTarget(tc.target, Baselines{}); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("empty baselines: err = %v, want mention of %q", err, tc.want)
			}
			// pct_max_hr has its baseline in `partial`; the rest must still fail.
			if tc.name == "pct_max_hr" {
				return
			}
			if _, err := ResolveTarget(tc.target, partial); err == nil {
				t.Fatalf("partial baselines: err = nil, want hard error")
			}
		})
	}
}

// TestResolvePctLTPaceIsSpeedRatio pins the direction: a fraction below 1
// resolves to a pace *slower* (larger) than LT pace, and never faster.
func TestResolvePctLTPaceIsSpeedRatio(t *testing.T) {
	lt := 300.0
	got, err := ResolveTarget(PctRange(TargetPctLTPace, 0.87, 0.93), Baselines{LTPaceSKM: &lt})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got.Low == nil || got.High == nil {
		t.Fatalf("bounds = %v..%v, want both", got.Low, got.High)
	}
	if *got.Low <= lt {
		t.Errorf("low = %.2f, want > LT pace %.2f (87%% is slower than threshold)", *got.Low, lt)
	}
	if *got.High <= lt {
		t.Errorf("high = %.2f, want > LT pace %.2f (93%% is still slower than threshold)", *got.High, lt)
	}
	if *got.Low <= *got.High {
		t.Errorf("low %.2f must be the slower (larger) bound than high %.2f", *got.Low, *got.High)
	}
}

func TestResolveTargetZoneOutOfRangeIsError(t *testing.T) {
	b := fullBaselines()
	if _, err := ResolveTarget(ZoneRange(TargetHRZone, 9, 10), b); err == nil {
		t.Fatalf("zone 9..10 not in injected table: err = nil, want hard error")
	}
}
