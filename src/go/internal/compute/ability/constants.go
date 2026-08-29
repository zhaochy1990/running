package ability

// Module constants, kept 1:1 with stride_core/ability.py. Grouped the same way
// so a future diff against the Python file is easy to eyeball.

// ─── Calibration anchors ────────────────────────────────────────────────────
const (
	DefaultMarathonTargetS = 2*3600 + 50*60
	DefaultHMTargetS       = 1*3600 + 22*60

	TheoreticalMinHMS      = 3400
	BoostNormalizeRangeHMS = 3400

	VO2MaxReferenceVDOT = 62.0
	VO2MaxScoreAtRef    = 60.0
	VO2MaxPointsPerVDOT = 2.0

	AerobicAnchorPaceSKm = 300.0 // 5:00/km → score 80
	AerobicPointsPerSec  = 0.3

	LTAnchorPaceSKm = 250.0 // 4:10/km → score 80
	LTPointsPerSec  = 0.5

	EnduranceAnchorKM     = 42
	EndurancePointsPerKM  = 2.0
	EnduranceDriftPenalty = 10.0

	EconomyAnchorCadence = 180
	EconomyPointsPerSPM  = 1.0

	EasyHRLowFactor             = 0.65
	EasyHRHighFactor            = 0.85
	LTMinDurationS              = 30 * 60
	VO2MaxIntervalMinReps       = 3
	VO2MaxIntervalMinDistM      = 900.0
	EnduranceMinDistanceKM      = 25.0
	AerobicTargetHR             = 145
	AerobicHRTolerance          = 7
	AerobicMinDistanceKM        = 5.0
	AerobicMaxHRDrift           = 0.08
	AerobicMaxPeakHRAboveTarget = 25

	// Interval lap-structure fallback.
	IntervalLapCountThreshold = 10
	IntervalLapMaxKM          = 1.5
	IntervalLapUniformity     = 0.25

	AbilityModelVersion = 8

	SecondaryMinPoints = 5
	SecondaryHRSpanMin = 30.0
	SecondaryMinR2     = 0.7
	FloorMinRHRDays    = 7

	VDOTClampMin = 30.0
	VDOTClampMax = 85.0

	UthSorensenCorrection = 0.93

	PBDecayPctPerMonth = 0.005
	PBMaxAgeMonths     = 18.0

	AbilityLookbackDays = 90

	RaceDayBoostMax         = 0.02
	BestCaseBoostMax        = 0.03
	TheoreticalMinMarathonS = 7200
	BoostNormalizeRangeS    = 7200

	AerobicScoreBase = 80.0
)

// L1_WEIGHTS mirror ability.L1_WEIGHTS.
var L1Weights = map[string]float64{
	"pace_adherence":    0.30,
	"hr_zone_adherence": 0.25,
	"pace_stability":    0.20,
	"hr_decoupling":     0.15,
	"cadence_stability": 0.10,
}

// L2_WEIGHTS mirror ability.L2_WEIGHTS.
var L2Weights = map[string]float64{
	"tsb_score":     0.30,
	"rhr_score":     0.25,
	"hrv_score":     0.20,
	"fatigue_score": 0.25,
}

// L4_WEIGHTS mirror ability.L4_WEIGHTS.
var L4Weights = map[string]float64{
	"aerobic":   0.20,
	"lt":        0.25,
	"vo2max":    0.20,
	"endurance": 0.20,
	"economy":   0.10,
	"recovery":  0.05,
}

// TrainKindHRTargets maps a normalized train_kind (as string) to the fallback
// target-HR band (fraction of HRmax). Mirrors ability.TRAIN_KIND_HR_TARGETS.
var TrainKindHRTargets = map[string][2]float64{
	"base":      {0.65, 0.78},
	"aerobic":   {0.65, 0.78},
	"long_run":  {0.65, 0.78},
	"tempo":     {0.80, 0.87},
	"threshold": {0.82, 0.89},
	"interval":  {0.87, 0.95},
	"vo2max":    {0.90, 0.98},
	"anaerobic": {0.92, 1.00},
	"sprint":    {0.92, 1.00},
	"race":      {0.85, 0.95},
	"recovery":  {0.55, 0.70},
}

// IntervalLikeKinds are train_kinds where activity-level avg_pace is
// contaminated by rest jogs. Mirrors ability._INTERVAL_LIKE_KINDS.
var intervalLikeKinds = map[string]bool{
	"threshold": true, "interval": true, "vo2max": true,
}

// AerobicExcludedTrainKinds disqualify an activity from the AEROBIC dimension.
// Mirrors ability.AEROBIC_EXCLUDED_TRAIN_KINDS.
var aerobicExcludedTrainKinds = map[string]bool{
	"threshold": true, "interval": true, "vo2max": true,
	"anaerobic": true, "sprint": true, "tempo": true,
}

// Daniels VDOT → predicted marathon time (seconds). VDOT 30..85 step 5 (12
// entries). Derived from the Daniels formulas; see ability.py's self-consistency
// note. Intermediate VDOT interpolates linearly.
var DanielsVDOTToMarathonS = map[float64]float64{
	30: 17392, 35: 15369, 40: 13780, 45: 12498, 50: 11442,
	55: 10557, 60: 9804, 65: 9157, 70: 8594, 75: 8101, 80: 7665, 85: 7276,
}

// Daniels VDOT → predicted half-marathon time (seconds). Same derivation.
var DanielsVDOTToHalfMarathonS = map[float64]float64{
	30: 8479, 35: 7454, 40: 6655, 45: 6015, 50: 5492,
	55: 5057, 60: 4689, 65: 4375, 70: 4103, 75: 3866, 80: 3657, 85: 3472,
}

// marathonDistanceAliases map a user profile target_distance string to a
// full-marathon target (used by marathonTargetFromProfile).
var marathonDistanceAliases = map[string]bool{
	"fm": true, "marathon": true, "full": true, "full marathon": true,
	"全马": true, "马拉松": true,
}

// hmDistanceAliases map a profile target_distance to a half-marathon target.
var hmDistanceAliases = map[string]bool{
	"HM": true, "HALF": true, "HALF MARATHON": true, "半马": true,
}
