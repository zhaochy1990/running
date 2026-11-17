package calibration

import (
	"fmt"
	"math"
)

// contract_priors.go carries the runnable default parameter set of the
// in-place evolved v4 rev3 (docs/calibration/v4.md, 2026-11-17). Every number
// below is a literal transcription of the v4.md §5.1/§5.2/§6.2/§8 tables:
// effort-margin (mu, sigma) pairs, log-speed measurement scales, the k
// regularizer and domain, the Hsteady parameter priors and boxes, the lambda_H
// feedback weight, HR sensor scales and the sensitivity-scenario constants.
// They are first-round research initials ("research_uncalibrated"), not
// calibrated population values; v4.md §11 keeps them revocable.

// PriorNormal is a bounded normal prior in the named unit. For parameters
// declared in log space (log beta, log tau) Mean/SD/Low/High live in the log
// domain and Unit names it.
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

// EffortMarginPriors are the v4.md §5.1 effort-class margin priors on the
// log-speed reserve delta >= 0: mu_delta / sigma_delta per sourced class.
type EffortMarginPriors struct {
	// ConfirmedMaximal: 核验的持续全力表现 — mu 0, sigma 0.015.
	ConfirmedMaximal PriorNormal `json:"confirmed_maximal"`
	// ProbableMaximal: 可能全力、仍有不确定性 — mu 0, sigma 0.05.
	ProbableMaximal PriorNormal `json:"probable_maximal"`
	// Ordinary: 普通训练，努力未知 — mu 0, sigma 0.12.
	Ordinary PriorNormal `json:"ordinary"`
	// SteadyReserve: 明确连续稳态、报告尚有余力 — mu log(1.03), sigma 0.08.
	SteadyReserve PriorNormal `json:"steady_reserve"`
	// Easy: 明确轻松跑 — mu log(1.08), sigma 0.15.
	Easy PriorNormal `json:"easy"`
}

// HRDynamicPriors are the v4.md §6.2 Hsteady parameter priors (center, SD and
// allowed domain). eta is stored in logit space over q60 = sigmoid(eta).
type HRDynamicPriors struct {
	// Eta: center logit(0.85), sd 0.6, q60 domain [0.65, 0.98].
	Eta PriorNormal `json:"eta"`
	// LogBeta: center log(3), sd 0.5, beta domain [1, 8] (log domain bounds).
	LogBeta PriorNormal `json:"log_beta"`
	// LogTauS: center log(60 s), sd 0.5, tau domain 15-180 s (log domain bounds).
	LogTauS PriorNormal `json:"log_tau_s"`
	// DayEffectU: u_j center 0, sd 0.25, domain [-0.75, 0.75].
	DayEffectU PriorNormal `json:"day_effect_u"`
	// DriftDPerHour: d_j center 0, sd 0.15/hour, domain [-0.3, 0.5]/hour.
	DriftDPerHour PriorNormal `json:"drift_d_per_hour"`
}

// EvolvedPriorSet is the complete serialized default parameter set of the rev3
// evolved v4. Its IdentityHash pins the parameter identity in every lineage.
type EvolvedPriorSet struct {
	PriorSetVersion string `json:"prior_set_version"`
	Calibration     string `json:"calibration"`
	// EffortMargin: §5.1 margin table (log-speed units).
	EffortMargin EffortMarginPriors `json:"effort_margin"`
	// MeasurementSigma{High,Medium,Low}: §5.1 log-speed measurement error
	// initials 0.01 / 0.025 / 0.06. Loss scales, not device error rates; low
	// never produces a hard lower bound.
	MeasurementSigmaHigh   float64 `json:"measurement_sigma_high"`
	MeasurementSigmaMedium float64 `json:"measurement_sigma_medium"`
	MeasurementSigmaLow    float64 `json:"measurement_sigma_low"`
	// EnduranceK: §5.2 L_k = 0.5*((k-0.06)/0.02)^2 over k in [0.02, 0.10]
	// (the frozen v3 Riegel domain).
	EnduranceK PriorNormal `json:"endurance_k"`
	// V60SearchLow/HighMps: §8.1 numerical search domain 0.5-12 m/s (a
	// computational bound, not a physiological population limit).
	V60SearchLowMps  float64 `json:"v60_search_low_mps"`
	V60SearchHighMps float64 `json:"v60_search_high_mps"`
	// HR: §6.2 joint Hsteady priors and scales.
	HR                HRDynamicPriors `json:"hr"`
	LambdaH           float64         `json:"lambda_h"`             // §6.3 lambda_H = 0.5
	HRSigmaStrapBpm   float64         `json:"hr_sigma_strap_bpm"`   // 3 bpm chest strap
	HRSigmaOpticalBpm float64         `json:"hr_sigma_optical_bpm"` // 6 bpm optical/unknown
	HRDomainLowBpm    float64         `json:"hr_domain_low_bpm"`    // §6.4 [80, 230]
	HRDomainHighBpm   float64         `json:"hr_domain_high_bpm"`
	HRMinSegmentS     float64         `json:"hr_min_segment_s"` // §6.1 >= 8 min segments
	HRSegmentGapS     float64         `json:"hr_segment_gap_s"` // §6.2 > 10 s re-segment
	// Regression branch (§6.4): H = c + b*log v with b = 60±30 bpm on
	// [10, 150]; scenario slopes 30/60/90 and measurement offsets ±6 bpm.
	RegressionSlope          PriorNormal `json:"regression_slope"`
	RegressionSlopeScenarios []float64   `json:"regression_slope_scenarios"`
	RegressionOffsetSigmaBpm float64     `json:"regression_offset_sigma_bpm"`
	// Sensitivity conventions (§8.2): the fixed profile threshold Delta L = 2,
	// prior-dominance thresholds (pace 3%, HR 5 bpm) and the HR profile grid.
	ProfileDeltaL         float64  `json:"profile_delta_l"`
	PriorDominancePaceRel float64  `json:"prior_dominance_pace_rel"`
	PriorDominanceHRBpm   float64  `json:"prior_dominance_hr_bpm"`
	HRProfileGridBpm      float64  `json:"hr_profile_grid_bpm"`
	Limitations           []string `json:"limitations"`
}

// DefaultEvolvedPriors returns the frozen rev3 defaults, transcribed from
// docs/calibration/v4.md §5-§8. Nothing here is population calibrated.
func DefaultEvolvedPriors() EvolvedPriorSet {
	const speedSource = "docs/calibration/v4.md §5.1/§5.2 (2026-11-17); first-round research initials"
	const hrSource = "docs/calibration/v4.md §6.2/§6.3 (2026-11-17); first-round research initials"
	logit := func(q float64) float64 { return math.Log(q / (1 - q)) }
	return EvolvedPriorSet{
		PriorSetVersion: EvolvedPriorSetVersion,
		Calibration:     "research_uncalibrated",
		EffortMargin: EffortMarginPriors{
			ConfirmedMaximal: PriorNormal{Mean: 0, SD: 0.015, Low: 0, High: 0.5, Unit: "log_speed", Source: speedSource},
			ProbableMaximal:  PriorNormal{Mean: 0, SD: 0.05, Low: 0, High: 0.5, Unit: "log_speed", Source: speedSource},
			Ordinary:         PriorNormal{Mean: 0, SD: 0.12, Low: 0, High: 0.5, Unit: "log_speed", Source: speedSource},
			SteadyReserve:    PriorNormal{Mean: math.Log(1.03), SD: 0.08, Low: 0, High: 0.5, Unit: "log_speed", Source: speedSource},
			Easy:             PriorNormal{Mean: math.Log(1.08), SD: 0.15, Low: 0, High: 0.5, Unit: "log_speed", Source: speedSource},
		},
		MeasurementSigmaHigh:   0.01,
		MeasurementSigmaMedium: 0.025,
		MeasurementSigmaLow:    0.06,
		EnduranceK:             PriorNormal{Mean: 0.06, SD: 0.02, Low: riegelKMin, High: riegelKMax, Unit: "log_speed_per_log_duration", Source: speedSource},
		V60SearchLowMps:        0.5,
		V60SearchHighMps:       12.0,
		HR: HRDynamicPriors{
			Eta:           PriorNormal{Mean: logit(0.85), SD: 0.6, Low: logit(0.65), High: logit(0.98), Unit: "logit_q60", Source: hrSource},
			LogBeta:       PriorNormal{Mean: math.Log(3), SD: 0.5, Low: math.Log(1), High: math.Log(8), Unit: "log_slope", Source: hrSource},
			LogTauS:       PriorNormal{Mean: math.Log(60), SD: 0.5, Low: math.Log(15), High: math.Log(180), Unit: "log_seconds", Source: hrSource},
			DayEffectU:    PriorNormal{Mean: 0, SD: 0.25, Low: -0.75, High: 0.75, Unit: "logit_shift", Source: hrSource},
			DriftDPerHour: PriorNormal{Mean: 0, SD: 0.15, Low: -0.3, High: 0.5, Unit: "logit_shift_per_hour", Source: hrSource},
		},
		LambdaH:                  0.5,
		HRSigmaStrapBpm:          3,
		HRSigmaOpticalBpm:        6,
		HRDomainLowBpm:           80,
		HRDomainHighBpm:          230,
		HRMinSegmentS:            480,
		HRSegmentGapS:            10,
		RegressionSlope:          PriorNormal{Mean: 60, SD: 30, Low: 10, High: 150, Unit: "bpm_per_log_mps", Source: hrSource},
		RegressionSlopeScenarios: []float64{30, 60, 90},
		RegressionOffsetSigmaBpm: 6,
		ProfileDeltaL:            2,
		PriorDominancePaceRel:    0.03,
		PriorDominanceHRBpm:      5,
		HRProfileGridBpm:         1,
		Limitations: []string{
			"research_uncalibrated_not_population_calibrated",
			"range_is_model_sensitivity_not_probability_interval",
			"environment_temperature_not_corrected",
			"q60_beta_tau_are_revocable_research_priors",
		},
	}
}

// MarginPriorFor maps an effort support class onto the §5.1 margin prior. The
// steady-reserve class (明确连续稳态、报告尚有余力) has no input channel in the
// rev3 metadata vocabulary and is therefore unreachable from live evidence; it
// stays declared for completeness and scenario use.
func (p EvolvedPriorSet) MarginPriorFor(e EffortSupport) PriorNormal {
	switch e {
	case EffortConfirmedMaximal:
		return p.EffortMargin.ConfirmedMaximal
	case EffortProbableMaximal:
		return p.EffortMargin.ProbableMaximal
	case EffortSubmaximal:
		return p.EffortMargin.Easy
	default:
		return p.EffortMargin.Ordinary
	}
}

// MeasurementSigma maps a measurement-quality label onto the §5.1 log-speed
// measurement scale.
func (p EvolvedPriorSet) MeasurementSigma(q Confidence) float64 {
	switch q {
	case ConfidenceHigh:
		return p.MeasurementSigmaHigh
	case ConfidenceMedium:
		return p.MeasurementSigmaMedium
	default:
		return p.MeasurementSigmaLow
	}
}

// EndurancePenalty is §5.2 L_k = 0.5*((k-0.06)/0.02)^2.
func (p EvolvedPriorSet) EndurancePenalty(k float64) float64 {
	return 0.5 * math.Pow((k-p.EnduranceK.Mean)/p.EnduranceK.SD, 2)
}

// Validate enforces finiteness, bound containment and the §5.1/§6.2 table
// shapes so a broken prior set can never silently ship.
func (p EvolvedPriorSet) Validate() error {
	if p.PriorSetVersion == "" || p.Calibration != "research_uncalibrated" {
		return fmt.Errorf("prior set must name its version and research_uncalibrated marker")
	}
	margin := []PriorNormal{p.EffortMargin.ConfirmedMaximal, p.EffortMargin.ProbableMaximal, p.EffortMargin.Ordinary, p.EffortMargin.SteadyReserve, p.EffortMargin.Easy}
	for _, prior := range margin {
		if err := prior.validate(); err != nil {
			return err
		}
	}
	if !(p.EffortMargin.Ordinary.SD > p.EffortMargin.ProbableMaximal.SD && p.EffortMargin.ProbableMaximal.SD > p.EffortMargin.ConfirmedMaximal.SD) {
		return fmt.Errorf("§5.1 margin sigma ordering 0.015 < 0.05 < 0.12 violated")
	}
	if !(p.EffortMargin.Easy.Mean > p.EffortMargin.SteadyReserve.Mean && p.EffortMargin.SteadyReserve.Mean > p.EffortMargin.Ordinary.Mean) {
		return fmt.Errorf("§5.1 margin mean ordering 0 < log1.03 < log1.08 violated")
	}
	for _, prior := range append([]PriorNormal{p.EnduranceK, p.HR.Eta, p.HR.LogBeta, p.HR.LogTauS, p.HR.DayEffectU, p.HR.DriftDPerHour, p.RegressionSlope}, margin...) {
		if err := prior.validate(); err != nil {
			return err
		}
	}
	if !(p.MeasurementSigmaHigh > 0 && p.MeasurementSigmaMedium > p.MeasurementSigmaHigh && p.MeasurementSigmaLow > p.MeasurementSigmaMedium) {
		return fmt.Errorf("§5.1 measurement sigma ordering 0.01 < 0.025 < 0.06 violated")
	}
	if !(p.EnduranceK.Low == riegelKMin && p.EnduranceK.High == riegelKMax && p.EnduranceK.Mean == 0.06 && p.EnduranceK.SD == 0.02) {
		return fmt.Errorf("endurance prior must keep the §5.2 0.06/0.02 center over [0.02,0.10]")
	}
	if !(p.V60SearchLowMps > 0 && p.V60SearchHighMps > p.V60SearchLowMps) {
		return fmt.Errorf("v60 numerical search domain must be a positive interval")
	}
	if !(p.LambdaH >= 0 && p.LambdaH <= 1) {
		return fmt.Errorf("lambda_H must stay in [0,1]")
	}
	if !(p.HRSigmaStrapBpm > 0 && p.HRSigmaOpticalBpm >= p.HRSigmaStrapBpm) {
		return fmt.Errorf("HR sensor scales must be positive with optical >= strap")
	}
	if !(p.HRDomainLowBpm < p.HRDomainHighBpm) {
		return fmt.Errorf("HR computation domain must be ordered")
	}
	if len(p.RegressionSlopeScenarios) == 0 || p.ProfileDeltaL <= 0 || p.PriorDominancePaceRel <= 0 || p.PriorDominanceHRBpm <= 0 || p.HRProfileGridBpm <= 0 {
		return fmt.Errorf("sensitivity conventions must be positive and nonempty")
	}
	return nil
}

// IdentityHash is the deterministic digest of the serialized prior set; it is
// the parameter hash recorded in lineage and evaluation reports.
func (p EvolvedPriorSet) IdentityHash() string { return ReplayContentHash(p) }
