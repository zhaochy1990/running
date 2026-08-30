package ability

import (
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/normalize"
)

// TestDanielsMarathonTableSelfConsistent locks the Daniels marathon table to the
// Daniel formulas: pct(T)*VDOT ~= vo2_req(42195, T) for each table entry. This is
// the property test_ability.py::test_daniels_table_matches_formula checks.
func TestDanielsMarathonTableSelfConsistent(t *testing.T) {
	for vdot, s := range DanielsVDOTToMarathonS {
		pct := danielsPctVO2Max(s)
		req := danielsVO2Required(42195, s)
		if got := math.Abs(pct*vdot - req); got > 0.5 {
			t.Errorf("vdot %.0f: |pct*VDOT - vo2_req| = %f, want < 0.5", vdot, got)
		}
	}
}

// TestDanielsHalfMarathonTableSelfConsistent does the same for the 21.0975 km table.
func TestDanielsHalfMarathonTableSelfConsistent(t *testing.T) {
	for vdot, s := range DanielsVDOTToHalfMarathonS {
		pct := danielsPctVO2Max(s)
		req := danielsVO2Required(21097.5, s)
		if got := math.Abs(pct*vdot - req); got > 0.5 {
			t.Errorf("vdot %.0f HM: |pct*VDOT - vo2_req| = %f, want < 0.5", vdot, got)
		}
	}
}

// TestDanielsRaceTimeSRecoversTable verifies DanielsRaceTimeS returns the table
// seconds at exact VDOT keys (FM/HM interpolate the table).
func TestDanielsRaceTimeSRecoversTable(t *testing.T) {
	if got := DanielsRaceTimeS(42195, 55); math.Abs(got-10557) > 0.5 {
		t.Errorf("FM vdot 55: got %v, want 10557", got)
	}
	if got := DanielsRaceTimeS(21097.5, 55); math.Abs(got-5057) > 0.5 {
		t.Errorf("HM vdot 55: got %v, want 5057", got)
	}
	// 5K solvable within the bounded window (should be a plausible 5K time).
	if got := DanielsRaceTimeS(5000, 55); got <= 600 || got > 3600 {
		t.Errorf("5K vdot 55: got %v, want in (600,3600]", got)
	}
	// Degenerate input → 0.
	if got := DanielsRaceTimeS(42195, 0); got != 0 {
		t.Errorf("vdot 0: got %v, want 0", got)
	}
}

// TestVdotFromScoreRoundTrip verifies the score↔VDOT inverse.
func TestVdotFromScoreRoundTrip(t *testing.T) {
	if got := VdotFromScore(60); math.Abs(got-62) > 1e-9 {
		t.Errorf("score 60 → vdot %v, want 62", got)
	}
	if got := VdotFromScore(80); math.Abs(got-72) > 1e-9 {
		t.Errorf("score 80 → vdot %v, want 72", got)
	}
	// Out-of-range clamps to [30,85].
	if got := VdotFromScore(0); got < 30 {
		t.Errorf("score 0 → vdot %v, want clamped to >=30", got)
	}
}

// TestScaledBoostEndpoints verifies the linear race-day boost decay.
func TestScaledBoostEndpoints(t *testing.T) {
	if got := ScaledBoost(7200, RaceDayBoostMax, TheoreticalMinMarathonS, BoostNormalizeRangeS); got != 0 {
		t.Errorf("at theoretical min, boost %v, want 0", got)
	}
	if got := ScaledBoost(14400, RaceDayBoostMax, TheoreticalMinMarathonS, BoostNormalizeRangeS); math.Abs(got-RaceDayBoostMax) > 1e-9 {
		t.Errorf("at max range, boost %v, want %v", got, RaceDayBoostMax)
	}
	if got := ScaledBoost(0, RaceDayBoostMax, TheoreticalMinMarathonS, BoostNormalizeRangeS); got != 0 {
		t.Errorf("training_s 0, boost %v, want 0", got)
	}
}

// TestL2FreshnessNeutral verifies the no-health neutral 50.
func TestL2FreshnessNeutral(t *testing.T) {
	r := ComputeL2Freshness(nil, nil, nil)
	if r.Total != 50.0 {
		t.Errorf("neutral L2 total = %v, want 50", r.Total)
	}
}

// TestL3AerobicFindsBestRun verifies a qualifying steady run scores off the anchor.
func TestL3AerobicFindsBestRun(t *testing.T) {
	pace := 290.0 // 4:50/km
	hr := 145
	dist := 10000.0
	acts := []Activity{{
		LabelID: "a1", SportType: 100, DistanceM: dist, DurationS: 3000,
		AvgPaceSKm: &pace, AvgHR: &hr, MaxHR: &hr,
		TrainKind: normalize.TrainAerobic,
	}}
	score, ev, det := ComputeL3Aerobic(acts, AerobicTargetHR)
	if score <= 0 {
		t.Fatalf("aerobic score = %v, want > 0", score)
	}
	if len(ev) != 1 || ev[0] != "a1" {
		t.Errorf("evidence = %v, want [a1]", ev)
	}
	if det["best_pace_s_km"] != 290.0 {
		t.Errorf("best_pace_s_km = %v, want 290", det["best_pace_s_km"])
	}
}

// TestKindFromLegacyTrainType is exercised indirectly; assert a known mapping.
func TestKindFromLegacyTrainTypeMapping(t *testing.T) {
	if k, ok := normalize.KindFromLegacyTrainType("VO2 Max"); !ok || k != normalize.TrainVO2Max {
		t.Errorf("'VO2 Max' → %v/%v, want vo2max/true", k, ok)
	}
	if k, ok := normalize.KindFromLegacyTrainType("AEROBIC_BASE"); !ok || k != normalize.TrainBase {
		t.Errorf("'AEROBIC_BASE' → %v/%v, want base/true", k, ok)
	}
	if _, ok := normalize.KindFromLegacyTrainType("garbage"); ok {
		t.Errorf("'garbage' should not map")
	}
}
