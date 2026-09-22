// Tests for the COROS intensityPercent fix (#325): the field is the target
// speed relative to the athlete's calibrated LT pace, never the retired //5
// placeholder. Also covers push-time resolution of relative/zone targets.
package coros

import (
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/provider"
)

func TestPaceIntensityPercent(t *testing.T) {
	lt := func(v float64) *float64 { return &v }
	cases := []struct {
		name   string
		paceMS int
		lt     *float64
		want   int
	}{
		// LT 5:00/km = 300_000 ms. 5:20/km is slower → speed ratio < 1.
		{"slower than threshold", 320_000, lt(300), 938},
		{"threshold pace", 300_000, lt(300), 1000},
		{"faster than threshold", 280_000, lt(300), 1071},
		{"six minute pace", 360_000, lt(300), 833},
		{"no baseline", 320_000, nil, 0},
		{"zero baseline", 320_000, lt(0), 0},
		{"no pace", 0, lt(300), 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := paceIntensityPercent(tc.paceMS, tc.lt); got != tc.want {
				t.Errorf("paceIntensityPercent(%d, %v) = %d, want %d", tc.paceMS, tc.lt, got, tc.want)
			}
		})
	}
}

func TestPayloadComputesIntensityPercentFromLTPace(t *testing.T) {
	lt := 300.0 // 5:00/km
	b, err := NormalizedToCorosRun(easyRun10km(), provider.Baselines{LTPaceSKM: &lt})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	ex := b.BuildPayload(1)["programs"].([]any)[0].(map[string]any)["exercises"].([]map[string]any)[0]
	// Easy 10K is 5:40 slow / 5:20 fast; relative to a 5:00 LT pace that is
	// 88.2% / 93.8% of threshold speed.
	if ex["intensityPercent"] != 938 {
		t.Errorf("intensityPercent = %v, want 938 (fast bound)", ex["intensityPercent"])
	}
	if ex["intensityPercentExtend"] != 882 {
		t.Errorf("intensityPercentExtend = %v, want 882 (slow bound)", ex["intensityPercentExtend"])
	}
}

func TestPayloadLeavesIntensityPercentUnsetWithoutCalibration(t *testing.T) {
	b, err := NormalizedToCorosRun(easyRun10km(), provider.Baselines{})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	ex := b.BuildPayload(1)["programs"].([]any)[0].(map[string]any)["exercises"].([]map[string]any)[0]
	if ex["intensityPercent"] != 0 || ex["intensityPercentExtend"] != 0 {
		t.Errorf("intensityPercent = %v/%v, want 0/0 (never fabricated)",
			ex["intensityPercent"], ex["intensityPercentExtend"])
	}
}

func TestTranslateResolvesPctLTPaceTarget(t *testing.T) {
	lt := 300.0 // 5:00/km
	wo := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Threshold reps",
		Date:   "2026-05-08",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfTimeMin(20),
			Target:   provider.PctRange(provider.TargetPctLTPace, 0.87, 0.93),
		}}}},
	}
	b, err := NormalizedToCorosRun(wo, provider.Baselines{LTPaceSKM: &lt})
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	seg := b.segments[0]
	// 300 / 0.87 = 344.8 → 5:45 slow; 300 / 0.93 = 322.6 → 5:23 fast.
	if seg.paceLow == nil || *seg.paceLow != "5:45" {
		t.Errorf("pace_low = %v, want 5:45", seg.paceLow)
	}
	if seg.paceHigh == nil || *seg.paceHigh != "5:23" {
		t.Errorf("pace_high = %v, want 5:23", seg.paceHigh)
	}
	// The resulting percentage round-trips back to the authored fraction.
	ex := b.BuildPayload(1)["programs"].([]any)[0].(map[string]any)["exercises"].([]map[string]any)[0]
	if ex["intensityPercent"] != 929 || ex["intensityPercentExtend"] != 870 {
		t.Errorf("intensityPercent = %v/%v, want 929/870",
			ex["intensityPercent"], ex["intensityPercentExtend"])
	}
}

func TestTranslateRelativeTargetWithoutBaselineErrors(t *testing.T) {
	wo := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Threshold reps",
		Date:   "2026-05-08",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfTimeMin(20),
			Target:   provider.PctRange(provider.TargetPctLTPace, 0.87, 0.93),
		}}}},
	}
	_, err := NormalizedToCorosRun(wo, provider.Baselines{})
	if err == nil || !strings.Contains(err.Error(), "LT pace") {
		t.Fatalf("err = %v, want loud missing-baseline error mentioning LT pace", err)
	}
}

func TestTranslateZoneTargetWithoutZoneTableErrors(t *testing.T) {
	wo := provider.RunWorkout{
		Schema: provider.RunWorkoutSchema,
		Name:   "Zone run",
		Date:   "2026-05-09",
		Blocks: []provider.WorkoutBlock{{Repeat: 1, Steps: []provider.WorkoutStep{{
			StepKind: provider.StepWork,
			Duration: provider.DurationOfTimeMin(30),
			Target:   provider.ZoneRange(provider.TargetHRZone, 3, 3),
		}}}},
	}
	_, err := NormalizedToCorosRun(wo, provider.Baselines{LTHRBPM: floatPtrOf(165)})
	if err == nil || !strings.Contains(err.Error(), "HR zones") {
		t.Fatalf("err = %v, want loud missing-zone-table error", err)
	}
}
