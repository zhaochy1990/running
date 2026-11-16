package calibration

import "testing"

// TestV2FrozenGateConstantsMatchProtocol pins the engine's numeric gate
// constants to the frozen protocol v2 document values. The document itself is
// hash-locked by TestEvaluationProtocolV2FrozenHashAndCopies; this test pins
// the engine's encoding of the same numbers so neither can drift silently.
// Changing any value here requires a new protocol version.
func TestV2FrozenGateConstantsMatchProtocol(t *testing.T) {
	cases := []struct {
		name   string
		got    float64
		frozen float64
	}{
		{"pace median max s/km", v2PaceMedianMaxSPerKm, 15},
		{"pace p90 max s/km", v2PaceP90MaxSPerKm, 30},
		{"noninferior median margin s/km", v2NonInferiorMedianSPerKm, 1},
		{"noninferior p90 margin s/km", v2NonInferiorP90SPerKm, 2},
		{"HR median max bpm", v2HRMedianMaxBpm, 5},
		{"HR p90 max bpm", v2HRP90MaxBpm, 10},
		{"failure rate max", v2FailureRateMax, 0.01},
		{"all-inputs coverage min", v2AllInputsCoverageMin, 0.90},
		{"min activities", v2MinActivities, 30},
		{"min users", v2MinUsers, 10},
		{"max user weight", v2MaxUserWeight, 0.20},
		{"stratum min activities", v2StratumMinActivities, 10},
		{"stratum min users", v2StratumMinUsers, 3},
		{"stratum median degrade s/km", v2StratumMedianDegradeS, 1},
		{"stratum p90 degrade s/km", v2StratumP90DegradeS, 2},
		{"speed eligible min roots", v2SpeedEligibleMinRoots, 3},
	}
	for _, c := range cases {
		if c.got != c.frozen {
			t.Fatalf("%s = %v, protocol v2 freezes %v", c.name, c.got, c.frozen)
		}
	}
	if v2BootstrapSeed != 993994 {
		t.Fatalf("bootstrap seed = %d, protocol v2 freezes 993994", v2BootstrapSeed)
	}
	if v2BootstrapResamples != 2000 {
		t.Fatalf("bootstrap resamples = %d, protocol v2 freezes 2000", v2BootstrapResamples)
	}
}
