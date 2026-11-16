// onboardinganalysis_test.go covers the executor's pure decision surface:
// the canonical-result → domain-outcome mapping and the aggregate status.
// The MySQL suite (onboardinganalysis_mysql_test.go) covers the end-to-end
// semantics.
package onboardinganalysis

import (
	"testing"
)

func TestCalibrationOutcome(t *testing.T) {
	for _, tc := range []struct {
		json   string
		status string
		reason string
	}{
		{`{"status":"ok","calibration_snapshot_id":7}`, "ready", ""},
		{`{"status":"skipped_no_new_data"}`, "ready", ""},
		{`{"status":"weird"}`, "unavailable", "weird"},
		{`{}`, "unavailable", ""},
	} {
		got := calibrationOutcome(tc.json)
		if got.Status != tc.status {
			t.Errorf("calibrationOutcome(%s).Status = %s, want %s", tc.json, got.Status, tc.status)
		}
		if got.Reason != tc.reason {
			t.Errorf("calibrationOutcome(%s).Reason = %q, want %q", tc.json, got.Reason, tc.reason)
		}
	}
}

func TestComputeOutcomes(t *testing.T) {
	// Missing historical calibration is explicit unavailability — the
	// canonical handler wrote nothing derived, and the domains say so.
	load, zones := computeOutcomes(`{"status":"unavailable_historical_calibration"}`)
	if load.Status != "unavailable" || load.Reason != "historical_calibration_missing" {
		t.Errorf("load = %+v, want unavailable/historical_calibration_missing", load)
	}
	if zones.Status != "unavailable" || zones.Reason != "historical_calibration_missing" {
		t.Errorf("zones = %+v, want unavailable/historical_calibration_missing", zones)
	}
	load, zones = computeOutcomes(`{"status":"full","activities":3}`)
	if load.Status != "ready" || zones.Status != "ready" {
		t.Errorf("load/zones = %+v/%+v, want ready/ready", load, zones)
	}
	load, _ = computeOutcomes(`{"status":"unavailable_active_calibration"}`)
	if load.Reason != "candidate_baseline_incomplete" {
		t.Errorf("active-candidate reason = %q", load.Reason)
	}
}

func TestAbilityOutcome(t *testing.T) {
	if got := abilityOutcome(`{"status":"ok"}`); got.Status != "ready" {
		t.Errorf("ok → %+v", got)
	}
	if got := abilityOutcome(`{"status":"unavailable_historical_calibration"}`); got.Status != "unavailable" || got.Reason != "historical_calibration_missing" {
		t.Errorf("historical → %+v", got)
	}
}

func TestAggregateStatus(t *testing.T) {
	ready := domainOutcome{Status: "ready"}
	unavail := domainOutcome{Status: "unavailable", Reason: "x"}
	cases := []struct {
		domains map[string]domainOutcome
		want    string
	}{
		{map[string]domainOutcome{"a": ready, "b": ready}, "ready"},
		{map[string]domainOutcome{"a": unavail, "b": unavail}, "unavailable"},
		{map[string]domainOutcome{"a": ready, "b": unavail}, "partial"},
		{map[string]domainOutcome{}, "partial"}, // degenerate: not all-ready, not all-unavailable
	}
	for _, tc := range cases {
		if got := aggregateStatus(tc.domains); got != tc.want {
			t.Errorf("aggregateStatus(%v) = %s, want %s", tc.domains, got, tc.want)
		}
	}
}
