package calibration

import (
	"math"
	"sort"
	"time"
)

// evolved_v4_report.go assembles the rev3 evolved v4 reports per docs/
// calibration/v4.md §8.3 (output states) and §9 (minimum diagnostic fields):
// identity, the B_raw → B_repaired → B_eligible → v4 comparison chain, the
// result block (v60/p60/H60/ranges/k/per-metric states), the per-bucket
// proven lower bounds with binding/nominal/model-projected separation and
// constraint violations, the contribution block (pace-only vs joint, HR
// increment, source day/root counts, effort classes) and the limitation
// block (prior dominance, staleness, boundaries, failed scenarios,
// fallback reasons).

// EvolvedSpeedObservation is one auditable candidate row of the §3 pool.
type EvolvedSpeedObservation struct {
	ActivityID         string        `json:"activity_id"`
	RootActivityID     string        `json:"root_activity_id"`
	ActivityDay        string        `json:"activity_day"`
	DurationS          float64       `json:"duration_s"`
	ModelDurationS     float64       `json:"model_duration_s,omitempty"`
	Role               string        `json:"role"`
	Weight             float64       `json:"weight"`
	Contribution       float64       `json:"contribution"`
	EffortSupport      EffortSupport `json:"effort_support"`
	MeasurementQuality Confidence    `json:"measurement_quality"`
	SigmaLog           float64       `json:"sigma_log"`
	Residual           *float64      `json:"residual,omitempty"`
}

// V4BoundDiagnostic is one §9 lower-bound row (per bucket, trusted layer).
type V4BoundDiagnostic struct {
	BucketS             float64  `json:"bucket_s"`
	DurationS           float64  `json:"duration_s"`
	SpeedMps            *float64 `json:"speed_mps,omitempty"`
	ActivityDay         string   `json:"activity_day"`
	Binding             bool     `json:"binding"`
	BoundKind           string   `json:"bound_kind"`
	ConstraintViolation float64  `json:"constraint_violation"`
	InFitPool           bool     `json:"in_fit_pool"`
}

// EvolvedSpeedReport is the rev3 speed-domain output (§9 结果/下界/贡献).
type EvolvedSpeedReport struct {
	ParameterVersion     string          `json:"parameter_version"`
	Method               string          `json:"method"`
	State                EstimationState `json:"state"`
	CenterMps            *float64        `json:"center_mps,omitempty"`
	RangeLowMps          *float64        `json:"range_low_mps,omitempty"`
	RangeHighMps         *float64        `json:"range_high_mps,omitempty"`
	RangeMeaning         string          `json:"range_meaning"`
	RangeType            string          `json:"range_type"`
	RangeFastSideLimited bool            `json:"range_fast_side_prior_limited,omitempty"`
	RangeSlowSideLimited bool            `json:"range_slow_side_unidentified,omitempty"`
	PaceCenterSPerKm     *float64        `json:"pace_center_s_per_km,omitempty"`
	PaceRangeLowSPerKm   *float64        `json:"pace_range_low_s_per_km,omitempty"`
	PaceRangeHighSPerKm  *float64        `json:"pace_range_high_s_per_km,omitempty"`
	// k and its support label (§5.2: ordinary-training-only windows publish
	// k_support=prior_dominated).
	MapK     float64  `json:"map_k"`
	RiegelK  *float64 `json:"riegel_k,omitempty"`
	KSupport string   `json:"k_support"`
	// §4.1 comparison chain and §4.3 slowdown reasons.
	BRawMps         *float64 `json:"b_raw_mps,omitempty"`
	BRepairedMps    *float64 `json:"b_repaired_mps,omitempty"`
	BEligibleMps    *float64 `json:"b_eligible_mps,omitempty"`
	V4SlowerReasons []string `json:"v4_slower_reasons,omitempty"`
	NominalFloorMps *float64 `json:"nominal_floor_mps,omitempty"`
	// Contribution block.
	PaceOnlyCenterMps *float64 `json:"pace_only_center_mps,omitempty"`
	HRIncrementMps    *float64 `json:"hr_increment_mps,omitempty"`
	HRJoint           bool     `json:"hr_joint"`
	IndependentRoots  int      `json:"independent_roots"`
	IndependentDays   int      `json:"independent_days"`
	HRIndependentDays int      `json:"hr_independent_days"`
	MinDurationS      float64  `json:"min_duration_s,omitempty"`
	MaxDurationS      float64  `json:"max_duration_s,omitempty"`
	MaximalAnchors    int      `json:"maximal_anchors"`
	// Solver diagnostics (§8.1).
	SolverConverged       bool    `json:"solver_converged"`
	SolverObjective       float64 `json:"solver_objective"`
	SolverKGridResolution float64 `json:"solver_k_grid_resolution"`
	SearchBoundary        string  `json:"search_boundary,omitempty"`
	// §8.2 sensitivity block.
	ScenarioListHash          string              `json:"scenario_list_hash"`
	ScenarioTotal             int                 `json:"scenario_total"`
	ScenarioFailures          int                 `json:"scenario_failures"`
	Scenarios                 []v4ScenarioOutcome `json:"scenarios"`
	SensitivityIncludesCenter bool                `json:"sensitivity_includes_center"`
	// Identity.
	PriorsIdentityHash     string   `json:"priors_identity_hash"`
	InputIdentityHash      string   `json:"input_identity_hash"`
	HistoricalPriorMeanLog *float64 `json:"historical_prior_mean_log_v60,omitempty"`
	HistoricalPriorAgeDays float64  `json:"historical_prior_age_days,omitempty"`
	// §9 下界 rows.
	Bounds       []V4BoundDiagnostic       `json:"bounds,omitempty"`
	Observations []EvolvedSpeedObservation `json:"observations"`
	Reasons      []string                  `json:"reasons"`
	Limitations  []string                  `json:"limitations"`
}

// EvolvedHRObservation is one bounded per-day audit row of the HR fit.
type EvolvedHRObservation struct {
	ActivityID     string  `json:"activity_id"`
	RootActivityID string  `json:"root_activity_id"`
	ActivityDay    string  `json:"activity_day"`
	Role           string  `json:"role"`
	Sensor         string  `json:"sensor"`
	Weight         float64 `json:"weight"`
	Blocks         int     `json:"blocks"`
	InitBlocks     int     `json:"init_blocks"`
	ResidualBpm    float64 `json:"residual_bpm,omitempty"`
}

// EvolvedHRReport is the rev3 HR output: the model steady-state HR at v60
// under reference conditions (H60) and its sensitivity range.
type EvolvedHRReport struct {
	ParameterVersion         string          `json:"parameter_version"`
	Method                   string          `json:"method"`
	State                    EstimationState `json:"state"`
	Branch                   string          `json:"branch"`
	CenterBpm                *float64        `json:"center_bpm,omitempty"`
	RangeLowBpm              *float64        `json:"range_low_bpm,omitempty"`
	RangeHighBpm             *float64        `json:"range_high_bpm,omitempty"`
	RangeMeaning             string          `json:"range_meaning"`
	TargetType               string          `json:"target_type"`
	RangeFastSideLimited     bool            `json:"range_fast_side_unidentified,omitempty"`
	RangeSlowSideLimited     bool            `json:"range_slow_side_unidentified,omitempty"`
	LambdaH                  float64         `json:"lambda_h"`
	LambdaZeroCenterBpm      *float64        `json:"lambda_zero_center_bpm,omitempty"`
	RestingHRBpm             *float64        `json:"resting_hr_bpm,omitempty"`
	HRMaxBpm                 *float64        `json:"hr_max_bpm,omitempty"`
	HRMaxInputConflict       bool            `json:"hrmax_input_conflict,omitempty"`
	HRMaxConflictObservedBpm float64         `json:"hrmax_conflict_observed_bpm,omitempty"`
	Q60                      *float64        `json:"q60,omitempty"`
	Beta                     *float64        `json:"beta,omitempty"`
	TauS                     *float64        `json:"tau_s,omitempty"`
	DayEffectCount           int             `json:"day_effect_count"`
	DayEffectMaxAbs          float64         `json:"day_effect_max_abs"`
	DriftMaxAbsPerHour       float64         `json:"drift_max_abs_per_hour"`
	SolverRounds             int             `json:"solver_rounds"`
	SolverConverged          bool            `json:"solver_converged"`
	SolverObjective          float64         `json:"solver_objective"`
	IndependentRoots         int             `json:"independent_roots"`
	IndependentDays          int             `json:"independent_days"`
	EvidenceDate             string          `json:"evidence_date,omitempty"`
	// LatestRejectedEvidenceDate keeps rejected protocol history (stale or
	// unverified tiers) separated from the current estimate.
	LatestRejectedEvidenceDate string                 `json:"latest_rejected_evidence_date,omitempty"`
	PriorsIdentityHash         string                 `json:"priors_identity_hash"`
	InputIdentityHash          string                 `json:"input_identity_hash"`
	Observations               []EvolvedHRObservation `json:"observations"`
	Reasons                    []string               `json:"reasons"`
	Limitations                []string               `json:"limitations"`
}

// v4SpeedLimitations is the standing limitation block.
func v4SpeedLimitations() []string {
	return []string{
		"research_uncalibrated_not_population_calibrated",
		"range_is_model_sensitivity_not_probability_interval",
		"environment_temperature_not_corrected",
		"power_law_valid_only_180_to_7200s",
		"long_duration_uses_monotone_envelope",
		"steady_reserve_margin_class_has_no_input_channel",
	}
}

func v4HRLimitations() []string {
	return []string{
		"research_uncalibrated_not_population_calibrated",
		"range_is_model_sensitivity_not_probability_interval",
		"model_steady_state_hr_not_lab_LTHR",
		"q60_beta_tau_are_revocable_research_priors",
		"hr_series_aggregated_to_60s_bins",
	}
}

// buildV4Reports runs §9 steps 4-7 and returns the two reports.
func buildV4Reports(e *v4Estimate, prior *HistoricalCapabilityPrior) (EvolvedSpeedReport, EvolvedHRReport) {
	priors := e.priors
	main := e.runSolve(v4SolveConfig{})
	speed := EvolvedSpeedReport{
		ParameterVersion:      EvolvedPriorSetVersion,
		Method:                v4MethodUnavailable,
		State:                 StateUnavailable,
		RangeMeaning:          contractRangeSemantics,
		RangeType:             "model_sensitivity_range",
		PriorsIdentityHash:    priors.IdentityHash(),
		SolverKGridResolution: v4KGridStep,
		MapK:                  priors.EnduranceK.Mean,
		KSupport:              "prior_dominated",
		Reasons:               []string{},
		Limitations:           v4SpeedLimitations(),
	}
	hr := EvolvedHRReport{
		ParameterVersion:   EvolvedPriorSetVersion,
		Method:             v4MethodUnavailable,
		State:              StateUnavailable,
		Branch:             e.hrBranch,
		RangeMeaning:       contractRangeSemantics,
		TargetType:         "model_steady_state_HR_at_v60_reference_conditions",
		LambdaH:            priors.LambdaH,
		PriorsIdentityHash: priors.IdentityHash(),
		Reasons:            []string{},
		Limitations:        v4HRLimitations(),
	}
	// §5.3 lineage: the historical prior is recorded for audit only — it
	// never enters the objective (no "last snapshot × (1+margin)" loops).
	if prior != nil && prior.valid() {
		v := math.Log(prior.V60Mps)
		speed.HistoricalPriorMeanLog = &v
		speed.HistoricalPriorAgeDays = prior.AgeDays
	}

	// Pace side.
	if main.CenterMps != nil {
		speed.Method = main.Method
		speed.CenterMps = main.CenterMps
		speed.MapK = main.K
		speed.SolverConverged = main.Converged
		speed.SolverObjective = main.Obj
		pace, paceOnly := math.Exp(main.A), 0.0
		paceOnly = pace
		if e.mainPaceSol != nil && e.mainPaceSol.Converged {
			po := math.Exp(e.mainPaceSol.A)
			speed.PaceOnlyCenterMps = &po
			paceOnly = po
		}
		if main.HRBranch == "joint" {
			speed.HRJoint = true
			inc := pace - paceOnly
			speed.HRIncrementMps = &inc
		}
		if main.Reason != "" {
			speed.Reasons = append(speed.Reasons, main.Reason)
		}
		// k support: only ordinary training leaves k prior-dominated (§5.2).
		speed.KSupport = "identified"
		if e.noNearAllOut() {
			speed.KSupport = "prior_dominated"
		} else {
			k := main.K
			speed.RiegelK = &k
		}
		// §9 step 5: V3 comparison chain + §4.3 explanations.
		speed.BRawMps = e.baselines.BRawMps
		speed.BRepairedMps = e.baselines.BRepairedMps
		speed.BEligibleMps = e.baselines.BEligibleMps
		speed.V4SlowerReasons = v4ExplainSlowdown(main.CenterMps, e.baselines, e.evidence)
		// Nominal proven lower bound (trusted-only floor at the solved k).
		if f := e.mainFloorAt(main.K); f != nil {
			speed.NominalFloorMps = f
		}
	} else {
		speed.Reasons = append(speed.Reasons, main.Reason)
		speed.Method = main.Method
	}

	// Support structure + observation rows.
	speed.Observations, speed.IndependentRoots, speed.IndependentDays, speed.MinDurationS, speed.MaxDurationS, speed.MaximalAnchors = v4SpeedObservations(e)
	speed.InputIdentityHash = ReplayContentHash(v4SpeedInputDigest(e))

	// §8.2 sensitivity (only when a center exists; the main center must be
	// contained in its own range, §8.3).
	if main.CenterMps != nil {
		leaveOut := v4PoolDayList(e.evidence.Rows, e.evidence.Pool)
		if len(leaveOut) <= 1 {
			// Single selected day: no leave-one-day stability evidence
			// exists (§8.2 item 6) — reported, not faked.
			leaveOut = nil
		}
		sens := v4RunSensitivity(e, main, e.mainPace, e.mainJoint, priors, leaveOut)
		speed.Scenarios = sens.Scenarios
		speed.ScenarioListHash = sens.ScenarioHash
		speed.ScenarioTotal = len(sens.Scenarios)
		speed.ScenarioFailures = sens.FailedCount
		lo, hi := math.Exp(sens.PaceRangeLog[0]), math.Exp(sens.PaceRangeLog[1])
		if lo > *main.CenterMps {
			lo = *main.CenterMps
		}
		if hi < *main.CenterMps {
			hi = *main.CenterMps
		}
		speed.RangeLowMps, speed.RangeHighMps = &lo, &hi
		paceLo, paceHi := 1000/hi, 1000/lo
		paceC := 1000 / *main.CenterMps
		speed.PaceCenterSPerKm, speed.PaceRangeLowSPerKm, speed.PaceRangeHighSPerKm = &paceC, &paceLo, &paceHi
		speed.RangeFastSideLimited = sens.FastSidePriorLimited
		speed.RangeSlowSideLimited = sens.SlowSideLimited
		speed.SensitivityIncludesCenter = lo <= *main.CenterMps && *main.CenterMps <= hi
		// Per-bucket bound diagnostics.
		speed.Bounds = v4BoundDiagnostics(e, main)
	}

	// Pace state (§8.3).
	speed.State = v4PaceState(e, main, &speed)
	if e.staleWindow {
		speed.State = StateStale
		speed.Reasons = append(speed.Reasons, v4ReasonStaleWindow)
	}

	// HR side.
	v4AssembleHR(e, main, &hr, &speed)
	return speed, hr
}

// mainFloorAt exposes the trusted-only nominal floor at k (nil when no
// trusted term exists).
func (e *v4Estimate) mainFloorAt(k float64) *float64 {
	if e.mainPace == nil {
		return nil
	}
	f := e.mainPace.floor.aFloor(k)
	if !f.HasTrustedTerm || !f.finite() {
		return nil
	}
	v := math.Exp(f.TrustedOnly)
	return &v
}

// v4PaceState applies §8.3's four output states to the pace channel.
func v4PaceState(e *v4Estimate, main v4SolveResult, speed *EvolvedSpeedReport) EstimationState {
	if main.CenterMps == nil {
		return StateUnavailable
	}
	if main.Method == v4MethodLongFallback {
		return StatePriorDominated
	}
	// Prior-scenario dominance: any prior-family scenario moving the center
	// beyond 3% (§8.3).
	if speed.CenterMps != nil {
		for _, sc := range speed.Scenarios {
			if sc.Kind != "prior" || sc.CenterMps == nil {
				continue
			}
			if math.Abs(*sc.CenterMps-*speed.CenterMps) / *speed.CenterMps > e.priors.PriorDominancePaceRel {
				speed.Reasons = append(speed.Reasons, v4ReasonPriorScenarios)
				return StatePriorDominated
			}
		}
	}
	// 仅靠短时/低质量/单层信息: no trusted row in the pool (single-layer), or
	// every pool duration below one hour (short-time only), or every pool row
	// low quality.
	trustedInPool, anyHour, anyAboveLow := false, false, false
	for _, i := range e.evidence.Pool {
		r := &e.evidence.Rows[i]
		if r.Role == v4RoleTrustedBound {
			trustedInPool = true
		}
		if r.DurationS >= 3600 {
			anyHour = true
		}
		if candidateConfidenceRank(r.Quality) > candidateConfidenceRank(ConfidenceLow) {
			anyAboveLow = true
		}
	}
	if !trustedInPool || !anyHour || !anyAboveLow {
		speed.Reasons = append(speed.Reasons, v4ReasonSingleLayerOnly)
		return StatePriorDominated
	}
	return StateModelEstimated
}

// v4AssembleHR fills the HR report per the §6.4 branch taken.
func v4AssembleHR(e *v4Estimate, main v4SolveResult, hr *EvolvedHRReport, speed *EvolvedSpeedReport) {
	hr.RestingHRBpm = e.restPrior
	hr.HRMaxBpm = e.phys.M
	if e.phys.HRMaxConflict {
		hr.HRMaxInputConflict = true
		hr.HRMaxConflictObservedBpm = e.phys.HRMaxConflictObservedBpm
		hr.Reasons = append(hr.Reasons, v4ReasonHRMaxConflict)
	}
	// Observation rows (bounded).
	hr.Observations = v4HRObservations(e)
	hr.InputIdentityHash = ReplayContentHash(e.hrSeries.InputDigest)
	roots := map[string]bool{}
	days := 0
	newest := ""
	for _, d := range e.hrSeries.Days {
		days++
		if d.Day > newest {
			newest = d.Day
		}
		for _, s := range d.Series {
			roots[s.Root] = true
		}
	}
	hr.IndependentRoots, hr.IndependentDays = len(roots), days
	hr.EvidenceDate = newest
	speed.HRIndependentDays = days
	switch e.hrBranch {
	case "joint":
		hr.Method = "joint_constrained_hr_fit"
		hr.CenterBpm = main.H60
		hr.State = StateModelEstimated
		if main.HRBranch == "joint" && e.mainJoint != nil && e.mainWarmTheta != nil {
			q60 := sigmoid(e.mainWarmTheta.Eta)
			beta := math.Exp(e.mainWarmTheta.LogBeta)
			tau := math.Exp(e.mainWarmTheta.LogTau)
			hr.Q60, hr.Beta, hr.TauS = &q60, &beta, &tau
			maxU, maxD := 0.0, 0.0
			for _, v := range e.mainWarmTheta.U {
				maxU = math.Max(maxU, math.Abs(v))
			}
			for _, v := range e.mainWarmTheta.D {
				maxD = math.Max(maxD, math.Abs(v))
			}
			hr.DayEffectCount, hr.DayEffectMaxAbs, hr.DriftMaxAbsPerHour = len(e.mainWarmTheta.U), maxU, maxD
			hr.SolverConverged = true
		} else if degraded := e.h60Degraded(main.A, main.K, v4SolveConfig{}); degraded != nil {
			// §8.3: joint failed or its H60 left the computation domain —
			// HR walks the §6.4 available path at the pace-only solution.
			hr.CenterBpm = degraded
			hr.State = StatePriorDominated
			hr.Reasons = append(hr.Reasons, v4ReasonJointSolverFail)
		} else {
			hr.CenterBpm = nil
			hr.State = StateUnavailable
			hr.Reasons = append(hr.Reasons, v4ReasonJointSolverFail, v4ReasonHRDomainOut)
		}
	case "prior_only":
		hr.Method = "prior_only_R_M_085"
		hr.CenterBpm = main.H60
		hr.State = StatePriorDominated
		hr.Reasons = append(hr.Reasons, v4ReasonHRPriorOnly)
	case "regression":
		hr.Method = "regression_H_c_b_logv"
		hr.CenterBpm = main.H60
		hr.State = StatePriorDominated
		hr.Reasons = append(hr.Reasons, v4ReasonHRRegression)
		if e.hrSeries != nil && len(e.hrSeries.RegressionPoints) > 0 {
			minY, maxY := math.Inf(1), math.Inf(-1)
			for _, p := range e.hrSeries.RegressionPoints {
				minY = math.Min(minY, p.LogV)
				maxY = math.Max(maxY, p.LogV)
			}
			if maxY-minY < 0.01 {
				hr.Reasons = append(hr.Reasons, "regression_single_speed_layer_b_fixed")
			}
		}
	default:
		hr.Method = v4MethodUnavailable
		hr.State = StateUnavailable
		hr.Reasons = append(hr.Reasons, v4ReasonHRUnavailNoInput)
	}
	if hr.CenterBpm == nil && (e.hrBranch == "prior_only" || e.hrBranch == "regression") {
		hr.Reasons = append(hr.Reasons, v4ReasonHRDomainOut)
		hr.State = StateUnavailable
	}
	// HR range: prior/regression branches use their scenario families
	// (§8.2); the normalized branch merges the H60 profile with the HR
	// scenario centers — read from the sensitivity block.
	if e.hrBranch == "joint" && e.sensitivity != nil && v4Finite(e.sensitivity.HRRangeBpm[0]) && v4Finite(e.sensitivity.HRRangeBpm[1]) {
		lo, hi := e.sensitivity.HRRangeBpm[0], e.sensitivity.HRRangeBpm[1]
		if hr.CenterBpm != nil {
			lo, hi = math.Min(lo, *hr.CenterBpm), math.Max(hi, *hr.CenterBpm)
		}
		hr.RangeLowBpm, hr.RangeHighBpm = &lo, &hi
		hr.RangeFastSideLimited = e.sensitivity.HRProfileHigh == nil
		hr.RangeSlowSideLimited = e.sensitivity.HRProfileLow == nil
	} else if hr.CenterBpm != nil {
		lo, hi := *hr.CenterBpm, *hr.CenterBpm
		switch e.hrBranch {
		case "prior_only":
			r, m := *e.restPrior, *e.phys.M
			for _, q := range []float64{0.80, 0.90} {
				v := r + (m-r)*q
				lo, hi = math.Min(lo, v), math.Max(hi, v)
			}
		case "regression":
			// §6.4/§8.2: slope scenarios 30/60/90 (c re-fitted) plus ±6 bpm
			// measurement offsets — an explicit scenario range, never a
			// joint-profile range.
			if rlo, rhi := e.v4RegressionH60Range(main.A); rlo < rhi {
				lo, hi = math.Min(lo, rlo), math.Max(hi, rhi)
			} else {
				for _, d := range []float64{-e.priors.RegressionOffsetSigmaBpm, e.priors.RegressionOffsetSigmaBpm} {
					v := *hr.CenterBpm + d
					lo, hi = math.Min(lo, v), math.Max(hi, v)
				}
			}
		}
		hr.RangeLowBpm, hr.RangeHighBpm = &lo, &hi
	}
	// λ_H = 0 comparison center (§6.3 must-keep control).
	if e.sensitivity != nil {
		for _, sc := range e.sensitivity.Scenarios {
			if sc.Name == "hr_lambda_0" && sc.H60Bpm != nil {
				hr.LambdaZeroCenterBpm = sc.H60Bpm
				break
			}
		}
	}
	// HR stale (§7): all usable HR days older than the current window.
	if e.hrBranch != "unavailable" && hr.EvidenceDate != "" {
		if day, err := time.Parse("2006-01-02", hr.EvidenceDate); err == nil {
			if float64(dayDiff(e.asOf, day)) > float64(v4CurrentWindowDays) {
				hr.State = StateStale
				hr.Reasons = append(hr.Reasons, v4ReasonStaleWindow)
			}
		}
	}
	// Prior-scenario dominance for HR (§8.3: > 5 bpm).
	if hr.CenterBpm != nil && hr.State == StateModelEstimated && e.sensitivity != nil {
		for _, sc := range e.sensitivity.Scenarios {
			if sc.Kind != "prior" || sc.H60Bpm == nil {
				continue
			}
			if math.Abs(*sc.H60Bpm-*hr.CenterBpm) > e.priors.PriorDominanceHRBpm {
				hr.State = StatePriorDominated
				hr.Reasons = append(hr.Reasons, v4ReasonPriorScenarios)
				break
			}
		}
	}
}

// v4SpeedObservations stamps the per-row audit block (§9 贡献).
func v4SpeedObservations(e *v4Estimate) ([]EvolvedSpeedObservation, int, int, float64, float64, int) {
	rows := make([]EvolvedSpeedObservation, 0, len(e.evidence.Rows))
	roots, days := map[string]bool{}, map[string]bool{}
	minD, maxD := math.Inf(1), 0.0
	anchors := 0
	totalW := 0.0
	for _, i := range e.evidence.Pool {
		totalW += e.evidence.Rows[i].Weight
	}
	for i := range e.evidence.Rows {
		r := &e.evidence.Rows[i]
		row := EvolvedSpeedObservation{
			ActivityID: r.ActivityID, RootActivityID: r.Root, ActivityDay: r.Day,
			DurationS: r.DurationS, EffortSupport: r.Effort, MeasurementQuality: r.Quality,
			Role: string(r.Role), Weight: r.Weight,
		}
		if r.Selected {
			row.Role = string(r.Role) + ":frontier_pool"
			if totalW > 0 {
				row.Contribution = r.Weight / totalW
			}
			roots[r.Root] = true
			days[r.Day] = true
			if r.DurationS < minD {
				minD = r.DurationS
			}
			if r.DurationS > maxD {
				maxD = r.DurationS
			}
			if r.Effort == EffortConfirmedMaximal || r.Effort == EffortProbableMaximal {
				anchors++
			}
		} else if len(r.ExclusionReasons) > 0 {
			row.Role = string(r.Role) + ":" + r.ExclusionReasons[0]
		}
		if r.Long {
			row.ModelDurationS = v4LongDomainS
		}
		rows = append(rows, row)
	}
	if math.IsInf(minD, 1) {
		minD = 0
	}
	return rows, len(roots), len(days), minD, maxD, anchors
}

func v4SpeedInputDigest(e *v4Estimate) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(e.evidence.Rows))
	for i := range e.evidence.Rows {
		r := &e.evidence.Rows[i]
		out = append(out, map[string]interface{}{
			"root": r.Root, "day": r.Day, "duration_s": r.DurationS,
			"avg_speed_mps": r.AvgSpeedMps, "role": string(r.Role),
			"quality": string(r.Quality), "effort": string(r.Effort), "weight": r.Weight,
		})
	}
	return out
}

// v4BoundDiagnostics builds the §9 下界 rows: per bucket the fastest trusted
// in-window window with binding/nominal/model-projected separation and the
// constraint violation at the solved (a, k); long rows report the monotone
// envelope plus the k-independent direct relation.
func v4BoundDiagnostics(e *v4Estimate, main v4SolveResult) []V4BoundDiagnostic {
	out := []V4BoundDiagnostic{}
	best := map[float64]int{}
	for _, i := range e.evidence.TrustedConstraintIdx {
		r := &e.evidence.Rows[i]
		if prior, ok := best[r.Bucket]; !ok || r.AvgSpeedMps > e.evidence.Rows[prior].AvgSpeedMps {
			best[r.Bucket] = i
		}
	}
	buckets := make([]float64, 0, len(best))
	for b := range best {
		buckets = append(buckets, b)
	}
	sort.Float64s(buckets)
	for _, b := range buckets {
		i := best[b]
		r := &e.evidence.Rows[i]
		speed := r.AvgSpeedMps
		kind := "model_projected"
		if r.DurationS == 3600 {
			kind = "nominal"
		}
		if r.Long {
			kind = "long_monotone_envelope"
		}
		violation := math.Max(0, r.Y+main.K*r.X-main.A)
		binding := math.Abs(main.A-(r.Y+main.K*r.X)) < 1e-6
		out = append(out, V4BoundDiagnostic{
			BucketS: b, DurationS: r.DurationS, SpeedMps: &speed, ActivityDay: r.Day,
			Binding: binding, BoundKind: kind, ConstraintViolation: violation, InFitPool: r.Selected,
		})
	}
	return out
}

// v4HRObservations stamps the bounded per-day HR audit rows.
func v4HRObservations(e *v4Estimate) []EvolvedHRObservation {
	rows := []EvolvedHRObservation{}
	for _, d := range e.hrSeries.Days {
		for _, s := range d.Series {
			init := 0
			for _, b := range s.Bins {
				if b.Init {
					init++
				}
			}
			rows = append(rows, EvolvedHRObservation{
				ActivityID: s.Root, RootActivityID: s.Root, ActivityDay: d.Day,
				Role: "model_series", Sensor: s.Sensor, Weight: d.Weight,
				Blocks: len(s.Bins), InitBlocks: init,
			})
			if len(rows) >= 32 {
				return rows
			}
		}
	}
	return rows
}
