package calibration

import (
	"fmt"
	"math"
)

// The runnable default prior set of the evolved v4 (#995). Every numeric
// prior is executable: finite mean/SD, declared truncation bounds, unit,
// source and the research_uncalibrated marker. There is deliberately no
// "calibrate later" empty entry; until population calibration exists these
// wide research priors ARE the defaults. See
// docs/calibration/estimation-contract-v2.md for losses and the joint
// objective; SPEC #993 R1/R2 are the modeling source of truth.

// PriorNormal is a truncated-normal prior in the named unit.
type PriorNormal struct {
	Mean   float64 `json:"mean"`
	SD     float64 `json:"sd"`
	Low    float64 `json:"low"`
	High   float64 `json:"high"`
	Unit   string  `json:"unit"`
	Source string  `json:"source"`
}

func (p PriorNormal) validate() error {
	if !(p.Mean == p.Mean) || math.IsInf(p.Mean, 0) || math.IsInf(p.SD, 0) || p.SD <= 0 {
		return fmt.Errorf("prior %s: nonfinite mean or nonpositive sd", p.Unit)
	}
	if !(p.Low <= p.Mean && p.Mean <= p.High) {
		return fmt.Errorf("prior %s: mean %.4g outside [%.4g, %.4g]", p.Unit, p.Mean, p.Low, p.High)
	}
	return nil
}

// EffortMarginPriors are the per-effort-class weak priors on the log-speed
// effort margin delta >= 0. They are weak by design: ordinary training enters
// the likelihood and only nudges delta; a verified all-out test moves the
// prior mean toward 0 but is never an on/off switch for estimation.
type EffortMarginPriors struct {
	ConfirmedMaximal PriorNormal `json:"confirmed_maximal"`
	ProbableMaximal  PriorNormal `json:"probable_maximal"`
	Submaximal       PriorNormal `json:"submaximal"`
	Unknown          PriorNormal `json:"unknown"`
}

// HRShapeKnot is one knot of the monotone Hsteady shape prior: the expected
// HR fraction of reserve at a relative intensity v/v60. The knot at
// RelativeIntensity 1.0 is the bridge constraint that stops the HR curve from
// freely absorbing the capability scale.
type HRShapeKnot struct {
	RelativeIntensity float64 `json:"relative_intensity"`
	HRFractionMean    float64 `json:"hr_fraction_mean"`
	HRFractionSD      float64 `json:"hr_fraction_sd"`
}

// EvolvedPriorSet is the complete default parameter set. Fields are part of
// the serialized contract; IdentityHash pins its identity in every lineage.
type EvolvedPriorSet struct {
	PriorSetVersion string `json:"prior_set_version"`
	Calibration     string `json:"calibration"`
	// LogV60: population prior on log(v60) in log(m/s) for recreational
	// runners; wide research prior, never a per-user cap.
	LogV60 PriorNormal `json:"log_v60"`
	// EnduranceK shares the frozen v3 Riegel-k domain [0.02, 0.10].
	EnduranceK PriorNormal `json:"endurance_k"`
	// EffortMargin: weak class priors on delta in log-speed units.
	EffortMargin EffortMarginPriors `json:"effort_margin"`
	// Historical capability prior spread: sd = hypot(floor, slope*age_days)
	// in log(m/s). The prior center is never a speed cap (SPEC #993 R1).
	HistoricalSDFloorLogV60 float64 `json:"historical_sd_floor_log_v60"`
	HistoricalSDSlopePerDay float64 `json:"historical_sd_slope_per_day"`
	HistoricalSource        string  `json:"historical_source"`
	// HR domain priors.
	HRMaxBpm         PriorNormal   `json:"hr_max_bpm"`
	RestingHRBpm     PriorNormal   `json:"resting_hr_bpm"`
	HRShape          []HRShapeKnot `json:"hr_shape"`
	HRTauS           PriorNormal   `json:"hr_tau_s"`
	HRDayEffectBpm   PriorNormal   `json:"hr_day_effect_bpm"`
	HRDriftBpmPerDay PriorNormal   `json:"hr_drift_bpm_per_day"`
	// OpticalHRWeight is the relative weight of wrist optical HR against
	// chest strap in the joint objective (down-weighted, never excluded).
	OpticalHRWeight float64  `json:"optical_hr_weight"`
	Limitations     []string `json:"limitations"`
}

// DefaultEvolvedPriors returns the frozen runnable defaults. Numbers are
// research choices motivated by the SPEC #993 method references (CS estimation
// from training/race data, first-order HR dynamics, fixed-intensity anchor
// error literature) and by the v1 conservative research domain; none of them
// is population-calibrated for this product.
func DefaultEvolvedPriors() EvolvedPriorSet {
	const speedSource = "spec993-R1; doi:10.1249/MSS.0000000000002412 (motivation only); v1 hour-capability domain"
	const hrSource = "spec993-R2; PMC4687158 first-order HR dynamics (motivation only); doi:10.1007/s00421-025-05748-8 anchor variability"
	return EvolvedPriorSet{
		PriorSetVersion: EvolvedPriorSetVersion,
		Calibration:     "research_uncalibrated",
		LogV60:          PriorNormal{Mean: math.Log(3.4), SD: 0.40, Low: math.Log(1.5), High: math.Log(8.5), Unit: "log_mps", Source: speedSource},
		EnduranceK:      PriorNormal{Mean: 0.06, SD: 0.03, Low: riegelKMin, High: riegelKMax, Unit: "log_speed_per_log_duration", Source: "frozen v3 riegel_k domain; spec993-R1"},
		EffortMargin: EffortMarginPriors{
			ConfirmedMaximal: PriorNormal{Mean: 0.01, SD: 0.02, Low: 0, High: 0.25, Unit: "log_speed", Source: speedSource},
			ProbableMaximal:  PriorNormal{Mean: 0.03, SD: 0.04, Low: 0, High: 0.35, Unit: "log_speed", Source: speedSource},
			Submaximal:       PriorNormal{Mean: 0.18, SD: 0.10, Low: 0, High: 0.70, Unit: "log_speed", Source: speedSource},
			Unknown:          PriorNormal{Mean: 0.14, SD: 0.12, Low: 0, High: 0.70, Unit: "log_speed", Source: speedSource},
		},
		HistoricalSDFloorLogV60: 0.15,
		HistoricalSDSlopePerDay: 0.002,
		HistoricalSource:        "spec993-R1 aged weak prior; same-source inputs never counted twice",
		HRMaxBpm:                PriorNormal{Mean: 188, SD: 12, Low: 140, High: 230, Unit: "bpm", Source: hrSource},
		RestingHRBpm:            PriorNormal{Mean: 55, SD: 10, Low: 35, High: 90, Unit: "bpm", Source: "daily RHR rows when present; else population research prior"},
		HRShape: []HRShapeKnot{
			{RelativeIntensity: 0.55, HRFractionMean: 0.68, HRFractionSD: 0.04},
			{RelativeIntensity: 0.75, HRFractionMean: 0.82, HRFractionSD: 0.04},
			{RelativeIntensity: 0.90, HRFractionMean: 0.88, HRFractionSD: 0.04},
			{RelativeIntensity: 1.00, HRFractionMean: 0.92, HRFractionSD: 0.04},
			{RelativeIntensity: 1.15, HRFractionMean: 0.97, HRFractionSD: 0.04},
		},
		HRTauS:           PriorNormal{Mean: 45, SD: 20, Low: 10, High: 180, Unit: "s", Source: "PMC4687158 first-order response timescale (motivation only)"},
		HRDayEffectBpm:   PriorNormal{Mean: 0, SD: 2, Low: -15, High: 15, Unit: "bpm", Source: hrSource},
		HRDriftBpmPerDay: PriorNormal{Mean: 0, SD: 0.5, Low: -10, High: 10, Unit: "bpm_per_day", Source: hrSource},
		OpticalHRWeight:  0.5,
		Limitations: []string{
			"research_uncalibrated_not_population_calibrated",
			"range_is_sensitivity_not_probability_interval",
			"environment_temperature_not_corrected",
			"hr_shape_knots_monotone_constraint_required",
		},
	}
}

// HRBridgeAtV60 returns the bridge knot at relative intensity 1.0: the soft
// constraint pinning HRsteady(v60) near 0.92 of HR reserve. This is what
// keeps the HR curve from absorbing the capability scale, and it propagates
// the v60 range into the HR range.
func (p EvolvedPriorSet) HRBridgeAtV60() *HRShapeKnot {
	for i, k := range p.HRShape {
		if k.RelativeIntensity == 1.0 {
			return &p.HRShape[i]
		}
	}
	return nil
}

// HistoricalCapabilitySD computes the aged prior sd in log(m/s).
func (p EvolvedPriorSet) HistoricalCapabilitySD(ageDays float64) float64 {
	if ageDays < 0 {
		ageDays = 0
	}
	return math.Hypot(p.HistoricalSDFloorLogV60, p.HistoricalSDSlopePerDay*ageDays)
}

// Validate enforces finiteness, bound containment and monotone knots so a
// broken prior set can never silently ship.
func (p EvolvedPriorSet) Validate() error {
	if p.PriorSetVersion == "" || p.Calibration != "research_uncalibrated" {
		return fmt.Errorf("prior set must name its version and research_uncalibrated marker")
	}
	for _, prior := range []PriorNormal{p.LogV60, p.EnduranceK, p.EffortMargin.ConfirmedMaximal, p.EffortMargin.ProbableMaximal, p.EffortMargin.Submaximal, p.EffortMargin.Unknown, p.HRMaxBpm, p.RestingHRBpm, p.HRTauS, p.HRDayEffectBpm, p.HRDriftBpmPerDay} {
		if err := prior.validate(); err != nil {
			return err
		}
	}
	if !(p.EffortMargin.Submaximal.Mean > p.EffortMargin.ConfirmedMaximal.Mean) {
		return fmt.Errorf("submaximal effort margin must exceed the all-out prior mean")
	}
	if !(p.HistoricalSDFloorLogV60 > 0 && p.HistoricalSDSlopePerDay >= 0) {
		return fmt.Errorf("historical prior spread must be positive with nonnegative ageing slope")
	}
	if len(p.HRShape) < 2 {
		return fmt.Errorf("hr shape needs at least two knots")
	}
	for i, k := range p.HRShape {
		if !(k.RelativeIntensity > 0) || !(k.HRFractionMean > 0 && k.HRFractionMean < 1) || !(k.HRFractionSD > 0) {
			return fmt.Errorf("hr shape knot %d out of domain", i)
		}
		if i > 0 {
			prev := p.HRShape[i-1]
			if !(k.RelativeIntensity > prev.RelativeIntensity) || !(k.HRFractionMean > prev.HRFractionMean) {
				return fmt.Errorf("hr shape must be strictly monotone at knot %d", i)
			}
		}
	}
	if p.HRBridgeAtV60() == nil {
		return fmt.Errorf("hr shape must pin the bridge knot at relative intensity 1.0")
	}
	if !(p.OpticalHRWeight > 0 && p.OpticalHRWeight < 1) {
		return fmt.Errorf("optical HR weight must down-weight, not exclude or exceed strap weight")
	}
	return nil
}

// IdentityHash is the deterministic digest of the serialized prior set. It is
// the parameter hash recorded in lineage and evaluation reports.
func (p EvolvedPriorSet) IdentityHash() string { return ReplayContentHash(p) }
