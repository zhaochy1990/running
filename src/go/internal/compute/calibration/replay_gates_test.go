package calibration_test

import (
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"testing"
)

func TestReplayScalarGateClassificationIsNotAlwaysInsufficient(t *testing.T) {
	c := calibration.ReplayCohortEvaluation{Family: "direct_60min", EligibleActivities: 30, EligibleUsers: 10, PairedActivities: 30, PairedUsers: 10, MaxUserWeight: .1, ImplementationsValid: true}
	for _, s := range []calibration.Strategy{calibration.StrategyV3, calibration.StrategySegmentsOnly, calibration.StrategyCandidate} {
		median, p90 := 2.0, 4.0
		if s == calibration.StrategySegmentsOnly {
			median, p90 = 3, 6
		}
		c.Versions = append(c.Versions, calibration.ReplayScalarMetrics{Strategy: s, Available: 30, Coverage: 1, MedianAbsoluteError: &median, P90AbsoluteError: &p90})
	}
	status := func(id string) string {
		for _, g := range calibration.EvaluateReplayGates(c) {
			if g.ID == id {
				return g.Status
			}
		}
		t.Fatalf("missing %s", id)
		return ""
	}
	for _, id := range []string{"sample", "weight", "coverage", "failure", "v3.noninferior", "segments.improvement"} {
		if status(id) != "pass" {
			t.Fatalf("%s: %s", id, status(id))
		}
	}
	c.PairedActivities = 29
	if status("sample") != "insufficient" {
		t.Fatal("sample below frozen minimum accepted")
	}
	c.PairedActivities = 30
	bad := 4.0
	c.Versions[2].MedianAbsoluteError = &bad
	if status("v3.noninferior") != "fail" {
		t.Fatal("numeric failure hidden by other missing evidence")
	}
}

func TestReplayFrozenNumericBoundariesAndCompleteScalarPass(t *testing.T) {
	makeCohort := func(family string) calibration.ReplayCohortEvaluation {
		n, u := 30, 10
		if family == "race_prediction" {
			n, u = 60, 20
		}
		c := calibration.ReplayCohortEvaluation{Family: family, Unit: "s/km", EligibleActivities: n, EligibleUsers: u, PairedActivities: n, PairedUsers: u, MaxUserWeight: .1, ImplementationsValid: true, Uncertainty: &calibration.ReplayScalarUncertainty{Seed: 983984, Resamples: 2000}, Strata: []calibration.ReplayScalarStratum{{Name: "predeclared", Required: true, Gates: []calibration.ReplayGate{{ID: "strata.predeclared.sample", Status: "pass"}}}}}
		for i, s := range []calibration.Strategy{calibration.StrategyV3, calibration.StrategySegmentsOnly, calibration.StrategyCandidate} {
			m, p := 2.0, 4.0
			if i == 1 {
				m, p = 3, 6
			}
			c.Versions = append(c.Versions, calibration.ReplayScalarMetrics{Strategy: s, Available: n, Coverage: 1, MedianAbsoluteError: &m, P90AbsoluteError: &p})
		}
		return c
	}
	gate := func(c calibration.ReplayCohortEvaluation, id string) string {
		for _, g := range calibration.EvaluateReplayGates(c) {
			if g.ID == id {
				return g.Status
			}
		}
		t.Fatalf("missing %s", id)
		return ""
	}
	c := makeCohort("direct_60min")
	for _, g := range calibration.EvaluateReplayGates(c) {
		if g.Status != "pass" {
			t.Fatalf("complete synthetic classifier cannot pass: %+v", g)
		}
	}
	for _, tc := range []struct {
		value float64
		want  string
	}{{.90, "pass"}, {.90 - 1e-12, "fail"}} {
		for i := range c.Versions {
			c.Versions[i].Coverage = tc.value
		}
		if got := gate(c, "coverage"); got != tc.want {
			t.Fatalf("coverage %g: %s", tc.value, got)
		}
	}
	c = makeCohort("direct_60min")
	for _, tc := range []struct {
		value float64
		want  string
	}{{.01, "pass"}, {.01 + 1e-12, "fail"}} {
		c.Versions[2].FailureRate = tc.value
		if got := gate(c, "failure"); got != tc.want {
			t.Fatalf("failure rate %g: %s", tc.value, got)
		}
	}
	c = makeCohort("direct_60min")
	c.Uncertainty.P90CandidateMinusV3[1] = 1e-12
	if gate(c, "uncertainty") != "fail" {
		t.Fatal("CI upper endpoint epsilon accepted")
	}
	c = makeCohort("race_prediction")
	a, b := 0.0, .005
	c.Versions[0].MedianAbsoluteError = &a
	c.Versions[0].P90AbsoluteError = &a
	c.Versions[2].MedianAbsoluteError = &a
	c.Versions[2].P90AbsoluteError = &a
	c.Versions[1].MedianAbsoluteError = &b
	c.Versions[1].P90AbsoluteError = &b
	if gate(c, "segments.improvement") != "pass" {
		t.Fatal("0.5 percentage points rejected")
	}
	b = .005 - 1e-12
	if gate(c, "segments.improvement") != "fail" {
		t.Fatal("subthreshold race gain accepted")
	}
	c = makeCohort("lab_lthr")
	a, b = 3, 6
	c.Versions[0].MedianAbsoluteError = &a
	c.Versions[0].P90AbsoluteError = &b
	c.Versions[2].MedianAbsoluteError = &a
	c.Versions[2].P90AbsoluteError = &b
	if gate(c, "absolute_error") != "pass" {
		t.Fatal("HR 3/6 boundary rejected")
	}
	b = 6 + 1e-12
	if gate(c, "absolute_error") != "fail" {
		t.Fatal("HR limit relaxed")
	}
}
