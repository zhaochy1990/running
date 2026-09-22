// Tests for the twelve-kind TargetKind matrix: JSON round-trips, the
// absolute-vs-relative-vs-zone families, and the parse-time validation gates
// (unknown kind, bad fraction, inverted speed-ratio contract).
package provider

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// runWorkoutWithTarget wraps a single work step around a target so it can cross
// the RunWorkoutFromJSON / json.Marshal boundary.
func runWorkoutWithTarget(target Target) RunWorkout {
	return RunWorkout{
		Schema: RunWorkoutSchema,
		Name:   "target matrix",
		Date:   "2026-05-01",
		Blocks: []WorkoutBlock{{
			Repeat: 1,
			Steps: []WorkoutStep{{
				StepKind: StepWork,
				Duration: DurationOfTimeS(600),
				Target:   target,
			}},
		}},
	}
}

func TestAllTargetKindsFamilyClassification(t *testing.T) {
	cases := []struct {
		kind     TargetKind
		relative bool
		zone     bool
		speed    bool
	}{
		{TargetPaceSKM, false, false, false},
		{TargetHRBPM, false, false, false},
		{TargetPowerW, false, false, false},
		{TargetOpen, false, false, false},
		{TargetPctMaxHR, true, false, false},
		{TargetPctHRR, true, false, false},
		{TargetPctLTHR, true, false, false},
		{TargetPctLTPace, true, false, true},
		{TargetPctRacePace, true, false, true},
		{TargetPctFTP, true, false, false},
		{TargetPaceZone, false, true, false},
		{TargetHRZone, false, true, false},
	}
	for _, tc := range cases {
		if !tc.kind.IsValid() {
			t.Errorf("%q: IsValid = false, want true", tc.kind)
		}
		if got := tc.kind.IsRelative(); got != tc.relative {
			t.Errorf("%q: IsRelative = %v, want %v", tc.kind, got, tc.relative)
		}
		if got := tc.kind.IsZone(); got != tc.zone {
			t.Errorf("%q: IsZone = %v, want %v", tc.kind, got, tc.zone)
		}
		if got := tc.kind.IsSpeedRatio(); got != tc.speed {
			t.Errorf("%q: IsSpeedRatio = %v, want %v", tc.kind, got, tc.speed)
		}
	}
	for _, bad := range []TargetKind{"cadence_spm", "rpe", "swim_pace_100m", "", "PACE_S_KM"} {
		if bad.IsValid() {
			t.Errorf("%q: IsValid = true, want false (candidate kinds are recorded, not added)", bad)
		}
	}
}

// TestAllTargetKindsRoundTrip locks the serialize→parse→serialize invariant for
// every kind: byte-identical JSON on the second pass and a deep-equal struct.
func TestAllTargetKindsRoundTrip(t *testing.T) {
	cases := []struct {
		name   string
		target Target
	}{
		{"pace_s_km", PaceRangeSKM(340, 320)},
		{"hr_bpm", HRRangeBPM(130, 150)},
		{"power_w", PowerRangeW(200, 250)},
		{"open", OpenTarget()},
		{"pct_max_hr", PctRange(TargetPctMaxHR, 0.70, 0.80)},
		{"pct_hrr", PctRange(TargetPctHRR, 0.60, 0.75)},
		{"pct_lt_hr", PctRange(TargetPctLTHR, 0.85, 0.95)},
		{"pct_lt_pace", PctRange(TargetPctLTPace, 0.87, 0.93)},
		{"pct_race_pace", PctRange(TargetPctRacePace, 0.90, 1.00)},
		{"pct_ftp", PctRange(TargetPctFTP, 0.80, 0.90)},
		{"pace_zone", ZoneRange(TargetPaceZone, 2, 3)},
		{"hr_zone", ZoneRange(TargetHRZone, 3, 3)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := runWorkoutWithTarget(tc.target)
			raw, err := json.Marshal(w)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			parsed, err := RunWorkoutFromJSON(raw)
			if err != nil {
				t.Fatalf("parse %s: %v", raw, err)
			}
			if !reflect.DeepEqual(parsed, &w) {
				t.Fatalf("parse(serialize(x)) = %+v, want %+v", parsed, w)
			}
			raw2, err := json.Marshal(parsed)
			if err != nil {
				t.Fatalf("re-marshal: %v", err)
			}
			if string(raw) != string(raw2) {
				t.Fatalf("serialize→parse→serialize not byte-identical:\n first = %s\nsecond = %s", raw, raw2)
			}
			if got := parsed.Blocks[0].Steps[0].Target; got.Kind != tc.target.Kind {
				t.Fatalf("kind = %q, want %q", got.Kind, tc.target.Kind)
			}
		})
	}
}

// TestTargetRoundTripOneSidedAndSinglePoint covers the valid degenerate shapes:
// a one-sided cap (one bound nil) and a single point (low == high).
func TestTargetRoundTripOneSidedAndSinglePoint(t *testing.T) {
	lo, hi := 0.70, 0.80
	zone := 3.0
	cases := []struct {
		name   string
		target Target
	}{
		{"relative_low_only", Target{Kind: TargetPctMaxHR, Low: &lo}},
		{"relative_high_only", Target{Kind: TargetPctMaxHR, High: &hi}},
		{"relative_single_point", Target{Kind: TargetPctHRR, Low: &lo, High: &lo}},
		{"zone_low_only", Target{Kind: TargetHRZone, Low: &zone}},
		{"zone_high_only", Target{Kind: TargetPaceZone, High: &zone}},
		{"zone_single_point", ZoneRange(TargetHRZone, 3, 3)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := runWorkoutWithTarget(tc.target)
			raw, err := json.Marshal(w)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			parsed, err := RunWorkoutFromJSON(raw)
			if err != nil {
				t.Fatalf("parse %s: %v", raw, err)
			}
			if !reflect.DeepEqual(parsed, &w) {
				t.Fatalf("round-trip = %+v, want %+v", parsed, w)
			}
		})
	}
}

func TestTargetValidateRejectsUnknownKind(t *testing.T) {
	for _, kind := range []string{"cadence_spm", "rpe", "swim_pace_100m", "bogus"} {
		raw := `{"schema":"run-workout/v1","name":"x","date":"2026-05-01","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"time_s","value":600},"target":{"kind":"` + kind + `","low":170,"high":180}}]}]}`
		_, err := RunWorkoutFromJSON([]byte(raw))
		if err == nil || !strings.Contains(err.Error(), "unknown target kind") {
			t.Fatalf("kind %q: err = %v, want unknown target kind", kind, err)
		}
	}
}

func TestTargetValidateRejectsBadFraction(t *testing.T) {
	for _, v := range []string{"0", "-0.1", "70", "100"} {
		raw := `{"schema":"run-workout/v1","name":"x","date":"2026-05-01","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"time_s","value":600},"target":{"kind":"pct_max_hr","low":` + v + `,"high":0.8}}]}]}`
		_, err := RunWorkoutFromJSON([]byte(raw))
		if err == nil || !strings.Contains(err.Error(), "fraction") {
			t.Fatalf("fraction %s: err = %v, want fraction validation", v, err)
		}
	}
}

func TestTargetValidateRejectsInvertedSpeedRatio(t *testing.T) {
	// pct_lt_pace is a speed ratio: low is the easier (slower) end and must not
	// exceed high. 0.93 slower than 0.87 is the dangerous inversion.
	raw := `{"schema":"run-workout/v1","name":"x","date":"2026-05-01","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"time_s","value":600},"target":{"kind":"pct_lt_pace","low":0.93,"high":0.87}}]}]}`
	_, err := RunWorkoutFromJSON([]byte(raw))
	if err == nil || !strings.Contains(err.Error(), "speed ratio") {
		t.Fatalf("err = %v, want speed-ratio contract violation", err)
	}
}

func TestTargetValidateRejectsBadZoneNumber(t *testing.T) {
	for _, v := range []string{"0", "-1", "2.5"} {
		raw := `{"schema":"run-workout/v1","name":"x","date":"2026-05-01","blocks":[{"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"time_s","value":600},"target":{"kind":"hr_zone","low":` + v + `,"high":3}}]}]}`
		_, err := RunWorkoutFromJSON([]byte(raw))
		if err == nil || !strings.Contains(err.Error(), "zone number") {
			t.Fatalf("zone %s: err = %v, want zone-number validation", v, err)
		}
	}
}

// TestExistingTargetKindsKeepParsing is the backward-compatibility gate: the
// original four kinds and their stored JSON shape must keep parsing unchanged.
func TestExistingTargetKindsKeepParsing(t *testing.T) {
	raw := `{
		"name": "legacy",
		"date": "2026-05-01",
		"blocks": [{"repeat": 1, "steps": [
			{"step_kind": "warmup", "duration": {"kind": "time_s", "value": 600}, "target": {"kind": "open", "low": null, "high": null}},
			{"step_kind": "work", "duration": {"kind": "distance_m", "value": 5000}, "target": {"kind": "pace_s_km", "low": 340, "high": 320}},
			{"step_kind": "work", "duration": {"kind": "time_s", "value": 600}, "target": {"kind": "hr_bpm", "low": 130, "high": 150}, "hr_cap_bpm": 167},
			{"step_kind": "work", "duration": {"kind": "time_s", "value": 600}, "target": {"kind": "power_w", "low": 200, "high": 250}}
		]}]
	}`
	if _, err := RunWorkoutFromJSON([]byte(raw)); err != nil {
		t.Fatalf("legacy four kinds must keep parsing: %v", err)
	}
}
