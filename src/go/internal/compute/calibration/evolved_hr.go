package calibration

import (
	"math"
	"sort"
	"time"
)

// evolved_hr.go implements the #997 individual HR dynamic fit of the evolved
// v4: the monotone Hsteady(v) + first-order tau response + slow drift model
// frozen in estimation-contract-v2 section 2.2, fitted as ONE joint objective
// with the speed domain (section 2.3). The HR term enters the shared profile
// objective through evolvedFit.hr, so the capability (a), endurance exponent
// (k) and per-group effort margins ({delta}) are re-optimized with the HR
// evidence present - the HR -> capability soft feedback. The F(1.0)=0.92+/-0.04
// reserve bridge keeps the HR curve from freely absorbing the capability
// scale: HR can only constrain a through that finite-width channel. Every HR
// block enters the joint objective exactly once (init blocks enter through
// filter initialization only), each activity root contributes one budgeted
// unit shared by its blocks, and duplicated rows are dropped by identity.
// Optical wrist HR is down-weighted (OpticalHRWeight), never excluded. See
// docs/calibration/evolved-hr-rev2.md.

const (
	evolvedHRMethodJoint   = "joint_map_hr_dynamic_fit"
	evolvedHRMethodPrior   = "aged_prior_only_HR"
	evolvedHRMethodRef     = "measured_reference_median"
	evolvedHRMethodNone    = "unavailable"
	evolvedHRReferenceText = "flat_no_wind_temperate_no_heat_correction_constant_speed_steady_state_ge_6tau_last20min_abs_drift_le_8bpm"
)

// Implementation parameters (research choices; the frozen contract numbers
// live in contract_priors.go and are never duplicated here except as reads).
const (
	// evolvedHRBlockS: fixed aggregation block of the per-sample series. 30s
	// blocks keep the fit insensitive to single-sample optical spikes while
	// preserving step/recovery transitions for the tau fit.
	evolvedHRBlockS = 30.0
	// evolvedHRSigmaBpm: observation scale of one 30s block mean (Huber
	// likelihood). Robust loss absorbs spikes beyond 1.5 sigma.
	evolvedHRSigmaBpm = 4.0
	// evolvedHRMinBlockCoverage: a block needs at least this fraction of
	// covered HR seconds to enter; the speed channel needs half of that.
	evolvedHRMinBlockCoverage = 0.5
	// evolvedHRMaxCarryGapS: a coverage gap longer than this re-initializes
	// the response filter from the next observed block (the block is then an
	// init block: it sets the state and carries no residual).
	evolvedHRMaxCarryGapS = 60.0
	// evolvedHRMinBlocks: minimum non-init blocks for a usable series.
	evolvedHRMinBlocks = 2
	// evolvedHRMaxBlocksPerActivity: deterministic per-activity block cap
	// (cost guard; the activity's budgeted weight unit is preserved by
	// re-normalizing over the kept blocks).
	evolvedHRMaxBlocksPerActivity = 40
	// evolvedHRTauGridStepS / evolvedHRTauGridStepLargeS: deterministic tau
	// grid over the frozen truncation [10,180] s; the large-input guard halves
	// resolution above evolvedHRLargeBlockThreshold blocks.
	evolvedHRTauGridStepS       = 5.0
	evolvedHRTauGridStepLargeS  = 10.0
	evolvedHRLargeBlockThreshol = 4000
	evolvedHRTauGridCoarsened   = "HR_tau_grid_coarsened_large_input"
	// evolvedHRJointRounds: max joint alternation rounds (theta block vs
	// (a,k,delta) block) of the SAME joint objective.
	evolvedHRJointRounds = 3
	// evolvedHRKnotSteps: knot coordinate-search candidates in units of the
	// bridge prior sd (0.04), from -2 to +2.
	evolvedHRKnotStepUnits = 2.0
	evolvedHRKnotSteps     = 4
	// evolvedHRIRLSIters / evolvedHRScalarIters / evolvedHRInnerPasses:
	// deterministic iteration caps of the conditional theta solver.
	evolvedHRIRLSIters    = 15
	evolvedHRScalarIters  = 45
	evolvedHRInnerPasses  = 3
	evolvedHRSpeedMissing = "speed_basis_absent_v60_prior_only"
)

// EvolvedHRObservation is the bounded per-activity audit row of the HR fit.
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

// EvolvedHRReport is the joint HR output of the evolved v4: HRsteady(v60)
// under the declared reference conditions plus its sensitivity range, the
// fitted individual dynamic parameters, and the recomputable dominance basis.
// It is a model prediction, never a lab LTHR.
type EvolvedHRReport struct {
	ParameterVersion     string          `json:"parameter_version"`
	Method               string          `json:"method"`
	State                EstimationState `json:"state"`
	CenterBpm            *float64        `json:"center_bpm,omitempty"`
	RangeLowBpm          *float64        `json:"range_low_bpm,omitempty"`
	RangeHighBpm         *float64        `json:"range_high_bpm,omitempty"`
	RangeMeaning         string          `json:"range_meaning"`
	TargetType           string          `json:"target_type"`
	ReferenceCondition   string          `json:"reference_condition,omitempty"`
	MeasurementSource    string          `json:"measurement_source,omitempty"`
	ModelCenterBpm       *float64        `json:"model_center_bpm,omitempty"`
	SpeedEnvelopeLowBpm  *float64        `json:"speed_envelope_low_bpm,omitempty"`
	SpeedEnvelopeHighBpm *float64        `json:"speed_envelope_high_bpm,omitempty"`
	PosteriorSDBpm       float64         `json:"posterior_sd_bpm"`
	// Fitted individual dynamics (all clamped to the frozen prior bounds).
	HRMaxBpm       *float64           `json:"hr_max_bpm,omitempty"`
	RestingHRBpm   *float64           `json:"resting_hr_bpm,omitempty"`
	TauS           *float64           `json:"tau_s,omitempty"`
	DriftBpmPerDay *float64           `json:"drift_bpm_per_day,omitempty"`
	BridgeFraction *float64           `json:"bridge_fraction,omitempty"`
	HRShapeKnots   []EvolvedHRKnotFit `json:"hr_shape_knots,omitempty"`
	// Recomputable dominance basis (same vocabulary as the speed report).
	PriorCurvature      float64 `json:"prior_curvature"`
	DataCurvature       float64 `json:"data_curvature"`
	EffectiveCurvature  float64 `json:"effective_curvature"`
	PriorCurvatureShare float64 `json:"prior_curvature_share"`
	PriorsIdentityHash  string  `json:"priors_identity_hash"`
	InputIdentityHash   string  `json:"input_identity_hash"`
	IndependentRoots    int     `json:"independent_roots"`
	IndependentDays     int     `json:"independent_days"`
	// EvidenceDate is the latest admitted model-series day;
	// LatestRejectedEvidenceDate keeps rejected reference-protocol history
	// (stale or unverified tiers) separated from the current estimate.
	EvidenceDate               string                 `json:"evidence_date,omitempty"`
	LatestRejectedEvidenceDate string                 `json:"latest_rejected_evidence_date,omitempty"`
	ReferenceCount             int                    `json:"reference_count,omitempty"`
	SolverRounds               int                    `json:"solver_rounds"`
	SolverConverged            bool                   `json:"solver_converged"`
	SolverObjective            float64                `json:"solver_objective"`
	TauGridCoarsened           bool                   `json:"tau_grid_coarsened,omitempty"`
	Observations               []EvolvedHRObservation `json:"observations"`
	Reasons                    []string               `json:"reasons"`
	Limitations                []string               `json:"limitations"`
}

// EvolvedHRKnotFit publishes one fitted shape knot for recomputability.
type EvolvedHRKnotFit struct {
	RelativeIntensity float64 `json:"relative_intensity"`
	HRFraction        float64 `json:"hr_fraction"`
	PriorFraction     float64 `json:"prior_fraction"`
}

// evolvedHRBlock is one aggregated observation of an activity's HR series.
type evolvedHRBlock struct {
	tStartS   float64
	DurationS float64
	SpeedMps  float64
	HRBpm     float64
	Weight    float64
	Init      bool
}

// evolvedHRActivity is one admitted HR series (one budgeted support unit).
type evolvedHRActivity struct {
	ActivityID   string
	Root         string
	Day          string
	AgeDays      float64
	Sensor       string
	SensorWeight float64
	Blocks       []evolvedHRBlock
	Role         string
	Reasons      []string
}

// evolvedHRTheta is the conditional HR parameter block of the joint objective.
type evolvedHRTheta struct {
	hrMax, hrRest float64
	tau, drift    float64
	knots         []float64
	day           map[string]float64
}

// evolvedHRTerm is the HR block of the joint profile objective, attached to
// evolvedFit by the joint assembly; nil keeps the T2 pure-speed behavior.
type evolvedHRTerm struct {
	acts       []evolvedHRActivity
	theta      evolvedHRTheta
	largeInput bool
	// state (#998) shares the capability state with the speed fit: each
	// activity's relative intensity uses its own effective capability
	// a_i = a_now - trend*age_i + dayShift[d_i]. nil keeps the stationary
	// per-activity anchor (identical to the scalar a of #997). This is the
	// CAPABILITY-side day channel in log-speed units; theta.day below stays
	// the separate HR-domain day channel in bpm - the two never fold into
	// each other.
	state *evolvedCapabilityState
	// digest of the admitted series, hashed once at admission.
	inputDigest interface{}
}

// FitEvolvedJoint runs the speed-domain fit and the joint HR fit of #997 and
// returns both reports. hrEvidence is the v1 observation report (buildCandidateHR):
// its Selected rows carry the verified reference tiers, its quality reasons
// gate the series admission, and its observations feed the contract
// adjudication. health rows qualify the physiological prior (resting HR).
func FitEvolvedJoint(evidence []CandidateEvidence, history []Activity, metadata []CandidateMetadata, hrEvidence *CandidateHRReport, health []HealthRow, asOf time.Time, priors EvolvedPriorSet, historical *HistoricalCapabilityPrior) (EvolvedSpeedReport, EvolvedHRReport) {
	restPrior := evolvedRestingHRPrior(health, asOf)
	hrOut := EvolvedHRReport{
		ParameterVersion:   EvolvedPriorSetVersion,
		Method:             evolvedHRMethodNone,
		State:              StateUnavailable,
		RangeMeaning:       contractRangeSemantics,
		TargetType:         "model_HRsteady_at_v60_declared_reference_conditions",
		ReferenceCondition: evolvedHRReferenceText,
		PriorsIdentityHash: priors.IdentityHash(),
		Reasons:            []string{},
		Limitations:        evolvedHRLimitations(),
	}
	if err := priors.Validate(); err != nil {
		hrOut.Reasons = append(hrOut.Reasons, ReasonSolverNumericalFailure)
		hrOut.Limitations = append(hrOut.Limitations, "prior_set_invalid")
		return FitEvolvedSpeed(evidence, asOf, priors, historical), hrOut
	}
	hrPriorQualified := restPrior != nil
	in := DeriveAdjudicationInput(evidence, hrEvidence, asOf, historical, hrPriorQualified)
	decision := AdjudicateEstimationContract(in)
	hrOut.Reasons = append(hrOut.Reasons, decision.HR.Reasons...)

	// Speed stage zero: the exact T2 fit. When the HR side cannot run, this
	// report is returned untouched.
	speedOut := FitEvolvedSpeed(evidence, asOf, priors, historical)

	// Admit the time-resolved HR series (ordinary training; protocol refs and
	// quality exclusions come from the shared v1 observation report).
	term := evolvedAdmitHRSeries(history, hrEvidence, metadata, asOf, priors)
	hrOut.Observations = term.rows(term.acts)
	hrOut.InputIdentityHash = ReplayContentHash(term.inputDigest)
	counted := term.countedActivities()
	hrOut.IndependentRoots, hrOut.IndependentDays = term.supportStructure()
	for i := range term.acts {
		if term.acts[i].Role == "model_series" && term.acts[i].Day > hrOut.EvidenceDate {
			hrOut.EvidenceDate = term.acts[i].Day
		}
	}
	refs := evolvedHRReferenceObservations(hrEvidence)
	hrOut.ReferenceCount = len(refs)
	if hrEvidence != nil {
		for _, o := range hrEvidence.Observations {
			// Rejected protocol history (stale or unverified field/lab rows
			// keep tier "training_hr" until selected): the protocol name is
			// the stable marker.
			if o.Selected || (o.Protocol != "field_30min_last20_v1" && o.Protocol != "lab_lthr_report_v1") {
				continue
			}
			if day := o.ActivityDate.Format("2006-01-02"); day > hrOut.LatestRejectedEvidenceDate {
				hrOut.LatestRejectedEvidenceDate = day
			}
		}
	}

	// #998: whenever the HR joint stage cannot run (no usable series, no
	// reference), the speed side still receives its time-structured
	// capability state through the standalone resolve - the state is a
	// property of the speed objective, not of the HR stage.
	if decision.HR.State == StateUnavailable || counted == 0 {
		speedOut = evolvedSpeedStateResolve(evidence, asOf, priors, historical, speedOut)
	}
	if decision.HR.State == StateUnavailable {
		return speedOut, hrOut
	}
	if counted == 0 && len(refs) == 0 {
		// No usable series and no measured reference. When the adjudication
		// saw a valid series but every row was excluded by the quality gates,
		// the estimate is a PRIOR composition and must be stamped
		// prior_dominated - never model_estimated dressed on a prior-only
		// output (contract section 6, review P1-2); without a qualified prior
		// it is unavailable with BOTH categorical reasons (the series existed,
		// the quality gates excluded it).
		seriesExcluded := in.HRSeriesValid
		if !hrPriorQualified {
			hrOut.Reasons = append(hrOut.Reasons, ReasonNoHRSeriesOrPrior)
			if seriesExcluded {
				hrOut.Reasons = append(hrOut.Reasons, ReasonHRSeriesQualityExcluded)
			}
			hrOut.State = StateUnavailable
			return speedOut, hrOut
		}
		state := decision.HR.State
		if seriesExcluded {
			hrOut.Reasons = append(hrOut.Reasons, ReasonHRSeriesQualityExcluded, ReasonPriorOnlyHR)
			state = StatePriorDominated
		}
		evolvedHRStampPriorOnly(&hrOut, priors, restPrior, state)
		return speedOut, hrOut
	}
	if len(refs) > 0 && counted == 0 {
		// Measured reference only: the center is the reference median; the
		// range stays the prior-composed sensitivity range.
		evolvedHRStampPriorOnly(&hrOut, priors, restPrior, decision.HR.State)
		evolvedHRStampReference(&hrOut, refs)
		return speedOut, hrOut
	}

	// Joint fit: one objective, staged blocks (theta | a,k,delta alternation).
	// Without a speed basis the v60 prior spread - not a speed-derived range -
	// is what propagates into the HR envelope; the reason names it.
	speedless := speedOut.CenterMps == nil
	hrOut.TauGridCoarsened = term.largeInput
	speedJoint, theta, rounds, objective, ok := evolvedHRJointSolve(evidence, asOf, priors, historical, term, speedOut, restPrior)
	if !ok {
		hrOut.Reasons = append(hrOut.Reasons, ReasonSolverNumericalFailure)
		hrOut.State = StateUnavailable
		return speedOut, hrOut
	}
	speedOut = speedJoint
	hrOut.Method = evolvedHRMethodJoint
	hrOut.State = decision.HR.State
	if speedless {
		hrOut.Reasons = append(hrOut.Reasons, evolvedHRSpeedMissing)
	}
	hrOut.SolverRounds = rounds
	hrOut.SolverConverged = true
	hrOut.SolverObjective = objective
	evolvedHRStampJoint(&hrOut, term, theta, priors, speedOut, refs, decision.HR.State)
	if term.largeInput {
		hrOut.Limitations = append(hrOut.Limitations, evolvedHRTauGridCoarsened)
	}
	return speedOut, hrOut
}

func evolvedHRLimitations() []string {
	return []string{
		"research_uncalibrated_not_population_calibrated",
		"range_is_sensitivity_not_probability_interval",
		"environment_temperature_not_corrected",
		"model_prediction_not_lab_LTHR",
		"hr_shape_knots_monotone_constraint_required",
		"cadence_lock_suspected_series_excluded",
	}
}

// evolvedRestingHRPrior qualifies the physiological prior from daily resting
// HR rows inside the evidence window (contract section 6): a real user
// measurement source, never a hardcoded truth.
func evolvedRestingHRPrior(health []HealthRow, asOf time.Time) *float64 {
	values := []float64{}
	for _, h := range health {
		if h.RHR == nil || !candidateFinite(h.RHR) || h.Date.IsZero() {
			continue
		}
		age := dayDiff(asOf, h.Date)
		if age < 0 || age > ContractEvidenceWindowDays {
			continue
		}
		if *h.RHR >= 35 && *h.RHR <= 90 {
			values = append(values, *h.RHR)
		}
	}
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	v := medianFloat(values)
	return &v
}

// evolvedHRReferenceObservations collects the verified reference measurements
// (field proxy / lab LTHR tiers selected by the shared v1 report). They keep
// their own source tier and never become model evidence.
func evolvedHRReferenceObservations(hr *CandidateHRReport) []float64 {
	if hr == nil {
		return nil
	}
	out := []float64{}
	for _, o := range hr.Observations {
		if o.Selected && o.ValueBpm != nil && (o.ReferenceTier == "lab_lthr" || o.ReferenceTier == "field_hr_proxy") {
			out = append(out, *o.ValueBpm)
		}
	}
	sort.Float64s(out)
	return out
}

// ---------------------------------------------------------------------------
// Series admission
// ---------------------------------------------------------------------------

// evolvedAdmitHRSeries walks the activity window with the same identity,
// ordering and dedup discipline as buildCandidateHR, inherits its per-activity
// quality verdicts (cadence lock, broken clock, root-day conflicts) and
// aggregates each series into fixed blocks. One activity root contributes one
// budgeted support unit shared by its blocks.
func evolvedAdmitHRSeries(history []Activity, hrEvidence *CandidateHRReport, metadata []CandidateMetadata, asOf time.Time, priors EvolvedPriorSet) *evolvedHRTerm {
	term := &evolvedHRTerm{}
	if hrEvidence == nil {
		term.inputDigest = []evolvedHRDigest{}
		return term
	}
	meta, _ := admittedCandidateMetadata(metadata, asOf)
	obs := map[string]*CandidateHRObservation{}
	for i := range hrEvidence.Observations {
		obs[hrEvidence.Observations[i].ActivityID] = &hrEvidence.Observations[i]
	}
	activities := append([]Activity(nil), history...)
	sort.Slice(activities, func(i, j int) bool {
		if activities[i].LabelID != activities[j].LabelID {
			return activities[i].LabelID < activities[j].LabelID
		}
		return ReplayContentHash(activities[i]) < ReplayContentHash(activities[j])
	})
	seen := map[string]bool{}
	for _, a := range activities {
		if a.LabelID == "" || seen[a.LabelID] {
			continue
		}
		seen[a.LabelID] = true
		o, ok := obs[a.LabelID]
		if !ok {
			continue // filtered by the shared report (window/sport/dedup)
		}
		act := evolvedHRActivity{ActivityID: a.LabelID, Root: o.RootActivityID, Day: o.ActivityDate.Format("2006-01-02"), AgeDays: float64(dayDiff(asOf, a.ActivityDate)), Sensor: o.Sensor, Role: "model_series", Reasons: []string{}}
		excluded := ""
		for _, r := range o.Reasons {
			if r == "root_activity_day_conflict" {
				excluded = r
			}
		}
		for _, r := range o.Quality.Reasons {
			if r == "suspected_HR_cadence_lock" {
				excluded = "suspected_HR_cadence_lock"
			}
			if r == "non_increasing_or_missing_HR_clock" {
				excluded = r
			}
		}
		m := meta[a.LabelID]
		if m.HR != nil && m.HR.SuspectedCadenceLock {
			excluded = "suspected_HR_cadence_lock"
		}
		if excluded == "" {
			act.Blocks = evolvedHRActivityBlocks(a, o)
			if len(act.Blocks) > evolvedHRMaxBlocksPerActivity {
				act.Blocks = evolvedHRDecimateBlocks(act.Blocks)
			}
			if len(act.Blocks) < evolvedHRMinBlocks+1 {
				excluded = "insufficient_HR_series"
			}
		}
		if excluded != "" {
			act.Role = "excluded_" + excluded
			act.Reasons = append(act.Reasons, excluded)
			act.Blocks = nil
		}
		if act.AgeDays >= 0 && act.AgeDays <= ContractEvidenceWindowDays {
			term.acts = append(term.acts, act)
		}
	}
	// Sensor weight and budget: chest straps keep full weight, everything
	// else (optical or unknown) is down-weighted, never excluded. Budget
	// semantics mirror the speed side exactly (review P1-1): activities of
	// one root share that root's unit, and roots on the same day share the
	// day's unit - re-uploading the same content under new activity IDs
	// (alias rows sharing a root) can never multiply support.
	rootDay := map[string]string{}
	rootActs := map[string]int{}
	for i := range term.acts {
		act := &term.acts[i]
		if act.Role != "model_series" {
			continue
		}
		act.SensorWeight = priors.OpticalHRWeight
		if act.Sensor == "chest_strap" {
			act.SensorWeight = 1
		}
		rootActs[act.Root]++
		if d, ok := rootDay[act.Root]; !ok || act.Day < d {
			rootDay[act.Root] = act.Day
		}
	}
	dayRoots := map[string]int{}
	for _, d := range rootDay {
		dayRoots[d]++
	}
	digests := make([]evolvedHRDigest, 0, len(term.acts))
	for i := range term.acts {
		act := &term.acts[i]
		if act.Role != "model_series" {
			digests = append(digests, evolvedHRDigest{ActivityID: act.ActivityID, Root: act.Root, Day: act.Day, Role: act.Role})
			continue
		}
		w := math.Exp2(-act.AgeDays/90) * act.SensorWeight / float64(rootActs[act.Root]*dayRoots[rootDay[act.Root]])
		counted := 0
		for j := range act.Blocks {
			if !act.Blocks[j].Init {
				counted++
			}
		}
		if counted > 0 {
			for j := range act.Blocks {
				act.Blocks[j].Weight = w / float64(counted)
			}
		}
		digests = append(digests, evolvedHRDigest{ActivityID: act.ActivityID, Root: act.Root, Day: act.Day, Role: act.Role, Sensor: act.Sensor, AgeDays: act.AgeDays, Blocks: act.blockDigests()})
	}
	term.largeInput = term.countedBlocks() > evolvedHRLargeBlockThreshol
	term.inputDigest = digests
	return term
}

// evolvedHRActivityBlocks aggregates one activity's samples into fixed blocks.
// The sample clock follows the shared v1 rule (timestamp preferred when
// present); intervals longer than 5 s contribute nothing (gaps), a coverage
// gap above evolvedHRMaxCarryGapS re-initializes the filter at the next block.
func evolvedHRActivityBlocks(a Activity, o *CandidateHRObservation) []evolvedHRBlock {
	type pair struct {
		t         float64
		hr, speed *float64
	}
	useTimestamp := 0
	for _, s := range a.Samples {
		if candidateFinite(s.TimestampS) {
			useTimestamp++
		}
	}
	pairs := make([]pair, 0, len(a.Samples))
	for _, s := range a.Samples {
		clock := s.ElapsedS
		if useTimestamp >= 2 {
			clock = s.TimestampS
		}
		if !candidateFinite(clock) {
			continue
		}
		pairs = append(pairs, pair{t: *clock, hr: s.HeartRateBpm, speed: s.SpeedMps})
	}
	if len(pairs) < 2 {
		return nil
	}
	start := pairs[0].t
	end := pairs[len(pairs)-1].t
	if !(end > start) {
		return nil
	}
	nBlocks := int(math.Floor((end - start) / evolvedHRBlockS))
	if nBlocks < 1 {
		return nil
	}
	hrCover := make([]float64, nBlocks)
	hrSum := make([]float64, nBlocks)
	spCover := make([]float64, nBlocks)
	spSum := make([]float64, nBlocks)
	for i := 1; i < len(pairs); i++ {
		x, y := pairs[i-1], pairs[i]
		dt := y.t - x.t
		if dt <= 0 || dt > 5 {
			continue
		}
		lo, hi := x.t, y.t
		b0 := int(math.Floor((lo - start) / evolvedHRBlockS))
		for b := b0; b < nBlocks; b++ {
			bl := start + float64(b)*evolvedHRBlockS
			br := bl + evolvedHRBlockS
			left, right := math.Max(lo, bl), math.Min(hi, br)
			if right <= left {
				if br > hi {
					break
				}
				continue
			}
			if x.hr != nil && y.hr != nil {
				hl := *x.hr + (*y.hr-*x.hr)*(left-lo)/dt
				hrr := *x.hr + (*y.hr-*x.hr)*(right-lo)/dt
				hrSum[b] += (hl + hrr) / 2 * (right - left)
				hrCover[b] += right - left
			}
			if x.speed != nil && y.speed != nil && candidateFinite(x.speed) && candidateFinite(y.speed) {
				sl := *x.speed + (*y.speed-*x.speed)*(left-lo)/dt
				sr := *x.speed + (*y.speed-*x.speed)*(right-lo)/dt
				if sl >= 0 && sr >= 0 {
					spSum[b] += (sl + sr) / 2 * (right - left)
					spCover[b] += right - left
				}
			}
			if br > hi {
				break
			}
		}
	}
	blocks := []evolvedHRBlock{}
	lastEnd := -1
	for b := 0; b < nBlocks; b++ {
		if hrCover[b] < evolvedHRMinBlockCoverage*evolvedHRBlockS || spCover[b] < 0.5*evolvedHRMinBlockCoverage*evolvedHRBlockS {
			continue
		}
		hr := hrSum[b] / hrCover[b]
		speed := spSum[b] / spCover[b]
		if !(hr >= contractHRValidLowBpm && hr <= contractHRValidHighBpm) || !(speed > 0 && speed <= contractMaxPlausibleSpeedMps) {
			continue
		}
		tStart := start + float64(b)*evolvedHRBlockS
		init := len(blocks) == 0 || tStart-(start+float64(lastEnd+1)*evolvedHRBlockS) > evolvedHRMaxCarryGapS
		blocks = append(blocks, evolvedHRBlock{tStartS: tStart, DurationS: evolvedHRBlockS, SpeedMps: speed, HRBpm: hr, Init: init})
		lastEnd = b
	}
	return blocks
}

// evolvedHRDecimateBlocks deterministically caps one activity's block count
// (cost guard for production-scale series): it keeps every init block plus an
// even stride of the rest, preserving warm-up/recovery anchors. The block
// weights are re-normalized later from the kept count, so the activity's
// budgeted support unit is unchanged by decimation.
func evolvedHRDecimateBlocks(blocks []evolvedHRBlock) []evolvedHRBlock {
	n := len(blocks)
	stride := (n + evolvedHRMaxBlocksPerActivity - 1) / evolvedHRMaxBlocksPerActivity
	out := make([]evolvedHRBlock, 0, evolvedHRMaxBlocksPerActivity+8)
	for i, b := range blocks {
		if b.Init || i%stride == 0 {
			out = append(out, b)
		}
	}
	return out
}

type evolvedHRDigest struct {
	ActivityID string              `json:"activity_id"`
	Root       string              `json:"root"`
	Day        string              `json:"day"`
	Role       string              `json:"role"`
	Sensor     string              `json:"sensor,omitempty"`
	AgeDays    float64             `json:"age_days,omitempty"`
	Blocks     []evolvedHRBlockDig `json:"blocks,omitempty"`
}

type evolvedHRBlockDig struct {
	T float64 `json:"t"`
	V float64 `json:"v"`
	H float64 `json:"h"`
	W float64 `json:"w"`
	I bool    `json:"i"`
}

func (a *evolvedHRActivity) blockDigests() []evolvedHRBlockDig {
	out := make([]evolvedHRBlockDig, 0, len(a.Blocks))
	for _, b := range a.Blocks {
		out = append(out, evolvedHRBlockDig{T: b.tStartS, V: b.SpeedMps, H: b.HRBpm, W: b.Weight, I: b.Init})
	}
	return out
}

func (t *evolvedHRTerm) countedActivities() int {
	n := 0
	for i := range t.acts {
		if t.acts[i].Role == "model_series" {
			n++
		}
	}
	return n
}

func (t *evolvedHRTerm) countedBlocks() int {
	n := 0
	for i := range t.acts {
		if t.acts[i].Role != "model_series" {
			continue
		}
		for _, b := range t.acts[i].Blocks {
			if !b.Init {
				n++
			}
		}
	}
	return n
}

func (t *evolvedHRTerm) supportStructure() (roots, days int) {
	rootSet, daySet := map[string]bool{}, map[string]bool{}
	for i := range t.acts {
		if t.acts[i].Role != "model_series" {
			continue
		}
		rootSet[t.acts[i].Root] = true
		daySet[t.acts[i].Day] = true
	}
	return len(rootSet), len(daySet)
}

func (t *evolvedHRTerm) rows(acts []evolvedHRActivity) []EvolvedHRObservation {
	out := make([]EvolvedHRObservation, 0, len(acts))
	for i := range acts {
		a := &acts[i]
		row := EvolvedHRObservation{ActivityID: a.ActivityID, RootActivityID: a.Root, ActivityDay: a.Day, Role: a.Role, Sensor: a.Sensor}
		for _, b := range a.Blocks {
			row.Blocks++
			if b.Init {
				row.InitBlocks++
			} else {
				row.Weight += b.Weight
			}
		}
		out = append(out, row)
	}
	return out
}

// ---------------------------------------------------------------------------
// Shape interpolation and the joint objective term
// ---------------------------------------------------------------------------

// evolvedHRShape evaluates F(r) and its derivative under the fitted knots:
// piecewise linear, strictly monotone by construction; below/above the knot
// support the outer slopes extrapolate with the fraction clamped to [0,1.05]
// (steady HR at rest is the resting value, and no steady HR exceeds ~HRmax).
func evolvedHRShape(knots []HRShapeKnot, r float64) (f, dfdr float64) {
	n := len(knots)
	slope := func(i int) float64 {
		if i < 0 {
			return (knots[1].HRFractionMean - knots[0].HRFractionMean) / (knots[1].RelativeIntensity - knots[0].RelativeIntensity)
		}
		if i >= n-1 {
			return (knots[n-1].HRFractionMean - knots[n-2].HRFractionMean) / (knots[n-1].RelativeIntensity - knots[n-2].RelativeIntensity)
		}
		return (knots[i+1].HRFractionMean - knots[i].HRFractionMean) / (knots[i+1].RelativeIntensity - knots[i].RelativeIntensity)
	}
	switch {
	case r <= knots[0].RelativeIntensity:
		s := slope(0)
		f = knots[0].HRFractionMean + s*(r-knots[0].RelativeIntensity)
		dfdr = s
	case r >= knots[n-1].RelativeIntensity:
		s := slope(n - 2)
		f = knots[n-1].HRFractionMean + s*(r-knots[n-1].RelativeIntensity)
		dfdr = s
	default:
		for i := 0; i < n-1; i++ {
			if r >= knots[i].RelativeIntensity && r <= knots[i+1].RelativeIntensity {
				s := slope(i)
				f = knots[i].HRFractionMean + s*(r-knots[i].RelativeIntensity)
				dfdr = s
				break
			}
		}
	}
	if f < 0 {
		f, dfdr = 0, 0
	}
	if f > 1.05 {
		f, dfdr = 1.05, 0
	}
	return f, dfdr
}

// evolvedHRFitKnots rebuilds the interpolation knots with fitted fractions
// (positions and monotonicity stay frozen from the contract prior).
func evolvedHRFitKnots(priors EvolvedPriorSet, fractions []float64) []HRShapeKnot {
	out := make([]HRShapeKnot, len(priors.HRShape))
	for i, k := range priors.HRShape {
		out[i] = HRShapeKnot{RelativeIntensity: k.RelativeIntensity, HRFractionMean: fractions[i], HRFractionSD: k.HRFractionSD}
	}
	return out
}

// evaluate adds the HR block of the joint profile objective at capability
// anchor a (per-activity effective capability when a #998 state is
// attached): Huber residuals of every non-init block plus the analytic
// dJ/da sensitivity (the channel through which HR constrains the shared
// capability). HR prior terms are constants in a; they are added only when
// withPriors reports the full objective so reported objective values are the
// honest joint ones.
func (t *evolvedHRTerm) evaluate(priors EvolvedPriorSet, a float64, withPriors bool) (j, grad float64) {
	j, grad, _, _ = t.evaluateFull(priors, a, withPriors)
	return j, grad
}

// evaluateFull additionally returns the dJ/dtrend and dJ/ddayShift
// sensitivities of the #998 capability state (zero/nil contributions when no
// state is attached). The filter sensitivities propagate analytically: the
// trend enters each activity through a_i = a - trend*age_i + dayShift, so
// its chain is the a-sensitivity recursion scaled by -age per activity, and
// the capability-side day shift shares the a-sensitivity chain of its own
// activity (both are activity-level constants).
func (t *evolvedHRTerm) evaluateFull(priors EvolvedPriorSet, a float64, withPriors bool) (j, gA, gTrend float64, gDay map[string]float64) {
	theta := &t.theta
	knots := evolvedHRFitKnots(priors, theta.knots)
	delta := theta.hrMax - theta.hrRest
	expA := math.Exp(-a)
	if t.state != nil {
		gDay = make(map[string]float64, len(t.state.days))
	}
	for i := range t.acts {
		act := &t.acts[i]
		if act.Role != "model_series" {
			continue
		}
		aEff := a
		if t.state != nil {
			aEff = t.state.capabilityAt(act.AgeDays, act.Day, a)
		}
		expEff := expA
		if t.state != nil {
			expEff = math.Exp(-aEff)
		}
		dayShift := theta.day[act.Day] + theta.drift*act.AgeDays
		var s, dsda, dsdT float64 // filter state, sensitivities to a_eff/trend
		initialized := false
		for k := range act.Blocks {
			b := &act.Blocks[k]
			r := b.SpeedMps * expEff
			f, dfdr := evolvedHRShape(knots, r)
			hss := theta.hrRest + delta*f + dayShift
			dhss := delta * dfdr * (-r)
			dhssT := -dhss * act.AgeDays // d hss / d trend = dhss * (-age)
			if b.Init {
				s, dsda, dsdT, initialized = b.HRBpm, 0, 0, true
				continue
			}
			if !initialized {
				// Defensive: a series always starts with an init block.
				s, dsda, dsdT, initialized = b.HRBpm, 0, 0, true
			}
			// Block-mean prediction integrates the response over the block;
			// the state transition advances over the actual elapsed time to
			// the next kept block (steady speed carried across decimated or
			// short gaps).
			uMean := b.DurationS / theta.tau
			eMean := math.Exp(-uMean)
			m := 1.0
			if uMean > 1e-9 {
				m = (1 - eMean) / uMean
			}
			pred := hss + (s-hss)*m
			dpred := dhss*(1-m) + m*dsda
			dpredT := dhssT*(1-m) + m*dsdT
			res := (b.HRBpm - pred) / evolvedHRSigmaBpm
			j += b.Weight * hourHuber(res)
			gA += -b.Weight * hourPsi(res) * dpred / evolvedHRSigmaBpm
			if t.state != nil {
				gTrend += -b.Weight * hourPsi(res) * dpredT / evolvedHRSigmaBpm
				// The capability-side day shift of this activity's day shares
				// the a_eff sensitivity chain (d a_eff / d dayShift = 1).
				gDay[act.Day] += -b.Weight * hourPsi(res) * dpred / evolvedHRSigmaBpm
			}
			uStep := b.DurationS / theta.tau
			if k+1 < len(act.Blocks) {
				uStep = (act.Blocks[k+1].tStartS - b.tStartS) / theta.tau
			}
			e := math.Exp(-uStep)
			s = hss + (s-hss)*e
			dsda = dhss*(1-e) + e*dsda
			dsdT = dhssT*(1-e) + e*dsdT
		}
	}
	if withPriors {
		j += 0.5 * math.Pow((theta.hrMax-priors.HRMaxBpm.Mean)/priors.HRMaxBpm.SD, 2)
		j += 0.5 * math.Pow((theta.hrRest-priors.RestingHRBpm.Mean)/priors.RestingHRBpm.SD, 2)
		j += 0.5 * math.Pow((theta.tau-priors.HRTauS.Mean)/priors.HRTauS.SD, 2)
		j += 0.5 * math.Pow(theta.drift/priors.HRDriftBpmPerDay.SD, 2)
		for i := range theta.knots {
			j += 0.5 * math.Pow((theta.knots[i]-priors.HRShape[i].HRFractionMean)/priors.HRShape[i].HRFractionSD, 2)
		}
		// Sorted keys: float summation must not depend on map iteration
		// order (review P2-1, determinism hygiene).
		dayKeys := make([]string, 0, len(theta.day))
		for d := range theta.day {
			dayKeys = append(dayKeys, d)
		}
		sort.Strings(dayKeys)
		for _, d := range dayKeys {
			j += 0.5 * math.Pow(theta.day[d]/priors.HRDayEffectBpm.SD, 2)
		}
	}
	return j, gA, gTrend, gDay
}

// rowGradients emits one Gauss-Newton row per counted HR block: the
// standardized residual and its analytic derivative chain with respect to
// the shared capability anchor, the state trend and the capability-side day
// shift of the block's day (the same recursions evaluateFull aggregates).
func (t *evolvedHRTerm) rowGradients(priors EvolvedPriorSet, a float64) []evolvedHRRowGrad {
	theta := &t.theta
	knots := evolvedHRFitKnots(priors, theta.knots)
	delta := theta.hrMax - theta.hrRest
	out := []evolvedHRRowGrad{}
	for i := range t.acts {
		act := &t.acts[i]
		if act.Role != "model_series" {
			continue
		}
		aEff := a
		if t.state != nil {
			aEff = t.state.capabilityAt(act.AgeDays, act.Day, a)
		}
		expEff := math.Exp(-aEff)
		dayShift := theta.day[act.Day] + theta.drift*act.AgeDays
		var s, dsda, dsdT float64
		initialized := false
		for k := range act.Blocks {
			b := &act.Blocks[k]
			r := b.SpeedMps * expEff
			f, dfdr := evolvedHRShape(knots, r)
			hss := theta.hrRest + delta*f + dayShift
			dhss := delta * dfdr * (-r)
			dhssT := -dhss * act.AgeDays
			if b.Init || !initialized {
				s, dsda, dsdT, initialized = b.HRBpm, 0, 0, true
				if b.Init {
					continue
				}
			}
			uMean := b.DurationS / theta.tau
			eMean := math.Exp(-uMean)
			m := 1.0
			if uMean > 1e-9 {
				m = (1 - eMean) / uMean
			}
			pred := hss + (s-hss)*m
			dpred := dhss*(1-m) + m*dsda
			dpredT := dhssT*(1-m) + m*dsdT
			res := (b.HRBpm - pred) / evolvedHRSigmaBpm
			out = append(out, evolvedHRRowGrad{res: res, dpredA: dpred, dpredT: dpredT, w: b.Weight, day: act.Day})
			uStep := b.DurationS / theta.tau
			if k+1 < len(act.Blocks) {
				uStep = (act.Blocks[k+1].tStartS - b.tStartS) / theta.tau
			}
			e := math.Exp(-uStep)
			s = hss + (s-hss)*e
			dsda = dhss*(1-e) + e*dsda
			dsdT = dhssT*(1-e) + e*dsdT
		}
	}
	return out
}

// linearCoefficients computes, per counted block, the exact affine
// decomposition pred = alpha*hrRest + beta*hrMax + gamma of the response
// filter under the current knots/tau/day/drift. It is the machinery behind
// the conditional (hrRest, hrMax) IRLS and the day/drift scalar updates.
type evolvedHRBlockCoeff struct {
	alpha, beta, gamma float64
	y, w               float64
	day                string
	age                float64
}

func (t *evolvedHRTerm) linearCoefficients(priors EvolvedPriorSet, theta *evolvedHRTheta, a float64) []evolvedHRBlockCoeff {
	out := make([]evolvedHRBlockCoeff, 0, t.countedBlocks())
	knots := evolvedHRFitKnots(priors, theta.knots)
	for i := range t.acts {
		act := &t.acts[i]
		if act.Role != "model_series" {
			continue
		}
		aEff := a
		if t.state != nil {
			aEff = t.state.capabilityAt(act.AgeDays, act.Day, a)
		}
		dayShift := theta.day[act.Day] + theta.drift*act.AgeDays
		var alpha, beta, gamma float64
		initialized := false
		for k := range act.Blocks {
			b := &act.Blocks[k]
			f, _ := evolvedHRShape(knots, b.SpeedMps*math.Exp(-aEff))
			uMean := b.DurationS / theta.tau
			eMean := math.Exp(-uMean)
			m := 1.0
			if uMean > 1e-9 {
				m = (1 - eMean) / uMean
			}
			if b.Init {
				alpha, beta, gamma, initialized = 0, 0, b.HRBpm, true
				continue
			}
			if !initialized {
				alpha, beta, gamma, initialized = 0, 0, b.HRBpm, true
			}
			out = append(out, evolvedHRBlockCoeff{
				alpha: (1-m)*(1-f) + m*alpha,
				beta:  (1-m)*f + m*beta,
				gamma: (1-m)*dayShift + m*gamma,
				y:     b.HRBpm,
				w:     b.Weight,
				day:   act.Day,
				age:   act.AgeDays,
			})
			uStep := b.DurationS / theta.tau
			if k+1 < len(act.Blocks) {
				uStep = (act.Blocks[k+1].tStartS - b.tStartS) / theta.tau
			}
			e := math.Exp(-uStep)
			alpha = (1-e)*(1-f) + e*alpha
			beta = (1-e)*f + e*beta
			gamma = (1-e)*dayShift + e*gamma
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Conditional theta solver (one block of the joint alternation)
// ---------------------------------------------------------------------------

// evolvedFitHRTheta minimizes the HR block of the joint objective over the HR
// parameters conditional on the capability anchor a: tau on the frozen
// truncation grid, and per tau a deterministic alternation of the exact
// (hrRest, hrMax) IRLS, per-day effect and drift scalar bisections and a
// monotonicity-preserving knot coordinate search. Every solution stays inside
// the frozen prior truncation bounds.
func evolvedFitHRTheta(term *evolvedHRTerm, a float64, priors EvolvedPriorSet, restPrior *float64) evolvedHRTheta {
	step := evolvedHRTauGridStepS
	knotStepUnits := 0.5 // candidate spacing in units of the knot prior sd
	if term.largeInput {
		step = evolvedHRTauGridStepLargeS
		knotStepUnits = 2
	}
	days := map[string]float64{}
	for i := range term.acts {
		if term.acts[i].Role == "model_series" {
			days[term.acts[i].Day] = 0
		}
	}
	best := evolvedHRTheta{
		hrMax:  priors.HRMaxBpm.Mean,
		hrRest: priors.RestingHRBpm.Mean,
		tau:    priors.HRTauS.Mean,
		knots:  evolvedHRPriorFractions(priors),
		day:    days,
	}
	if restPrior != nil {
		best.hrRest = *restPrior
	}
	bestJ := math.Inf(1)
	for tau := priors.HRTauS.Low; tau <= priors.HRTauS.High+1e-9; tau += step {
		theta := best
		theta.tau = tau
		theta.day = make(map[string]float64, len(days))
		for d := range days {
			theta.day[d] = 0
		}
		for pass := 0; pass < evolvedHRInnerPasses; pass++ {
			evolvedHRLevelSolve(term, priors, &theta, a)
			evolvedHRDayDriftSolve(term, priors, &theta, a)
			evolvedHRKnotSolve(term, priors, &theta, a, knotStepUnits)
		}
		evolvedHRLevelSolve(term, priors, &theta, a)
		if j := evolvedHRBlockObjective(term, priors, &theta, a); j < bestJ {
			bestJ, best = j, theta
		}
	}
	return best
}

func evolvedHRPriorFractions(priors EvolvedPriorSet) []float64 {
	out := make([]float64, len(priors.HRShape))
	for i, k := range priors.HRShape {
		out[i] = k.HRFractionMean
	}
	return out
}

// evolvedHRLevelSolve: exact Huber IRLS on (hrRest, hrMax) with their frozen
// priors, given knots/tau/day/drift. The prediction is affine in the pair, so
// each iteration is a closed 2x2 solve; iterations are capped deterministically.
func evolvedHRLevelSolve(term *evolvedHRTerm, priors EvolvedPriorSet, theta *evolvedHRTheta, a float64) {
	// The affine coefficients depend on (a, tau, knots, day, drift) only, so
	// they are computed once and the IRLS iterates the closed 2x2 system.
	coeffs := term.linearCoefficients(priors, theta, a)
	for it := 0; it < evolvedHRIRLSIters; it++ {
		var aa, bb, cc, dd, ee float64
		invS2 := 1 / (evolvedHRSigmaBpm * evolvedHRSigmaBpm)
		for _, c := range coeffs {
			pred := c.alpha*theta.hrRest + c.beta*theta.hrMax + c.gamma
			res := (c.y - pred) / evolvedHRSigmaBpm
			nu := 1.0
			if math.Abs(res) > 1.5 {
				nu = 1.5 / math.Abs(res)
			}
			w := c.w * nu * invS2
			aa += w * c.alpha * c.alpha
			bb += w * c.alpha * c.beta
			cc += w * c.beta * c.beta
			dd += w * c.alpha * (c.y - c.gamma)
			ee += w * c.beta * (c.y - c.gamma)
		}
		aa += 1 / (priors.RestingHRBpm.SD * priors.RestingHRBpm.SD)
		cc += 1 / (priors.HRMaxBpm.SD * priors.HRMaxBpm.SD)
		dd += priors.RestingHRBpm.Mean / (priors.RestingHRBpm.SD * priors.RestingHRBpm.SD)
		ee += priors.HRMaxBpm.Mean / (priors.HRMaxBpm.SD * priors.HRMaxBpm.SD)
		det := aa*cc - bb*bb
		if !(math.Abs(det) > 1e-12) {
			return
		}
		hrRest := (cc*dd - bb*ee) / det
		hrMax := (aa*ee - bb*dd) / det
		hrRest = math.Max(priors.RestingHRBpm.Low, math.Min(priors.RestingHRBpm.High, hrRest))
		hrMax = math.Max(priors.HRMaxBpm.Low, math.Min(priors.HRMaxBpm.High, hrMax))
		deltaR, deltaM := math.Abs(hrRest-theta.hrRest), math.Abs(hrMax-theta.hrMax)
		theta.hrRest, theta.hrMax = hrRest, hrMax
		if deltaR < 1e-9 && deltaM < 1e-9 {
			break
		}
	}
}

// evolvedHRDayDriftSolve updates the per-day effects and the drift scalar by
// exact 1-d bisections of their monotone subgradients (each day's shift only
// touches that day's activities; the filter re-composition happens in the
// next pass recomputation).
func evolvedHRDayDriftSolve(term *evolvedHRTerm, priors EvolvedPriorSet, theta *evolvedHRTheta, a float64) {
	coeffs := term.linearCoefficients(priors, theta, a)
	byDay := map[string][]int{}
	for i, c := range coeffs {
		byDay[c.day] = append(byDay[c.day], i)
	}
	dayKeys := make([]string, 0, len(byDay))
	for d := range byDay {
		dayKeys = append(dayKeys, d)
	}
	sort.Strings(dayKeys)
	for _, d := range dayKeys {
		idx := byDay[d]
		cur := theta.day[d]
		solve := func(shift float64) float64 {
			s := 0.0
			for _, i := range idx {
				c := coeffs[i]
				res := (c.y - (c.alpha*theta.hrRest + c.beta*theta.hrMax + c.gamma) - shift) / evolvedHRSigmaBpm
				s -= c.w * hourPsi(res) / evolvedHRSigmaBpm
			}
			s += (cur + shift) / (priors.HRDayEffectBpm.SD * priors.HRDayEffectBpm.SD)
			return s
		}
		shift := evolvedHRScalarSolve(solve, priors.HRDayEffectBpm.Low-cur, priors.HRDayEffectBpm.High-cur)
		theta.day[d] = cur + shift
	}
	// drift: one scalar over all blocks, shifted proportionally to age.
	driftSolve := func(delta float64) float64 {
		s := 0.0
		for _, c := range coeffs {
			pred := c.alpha*theta.hrRest + c.beta*theta.hrMax + c.gamma
			res := (c.y - pred - delta*c.age) / evolvedHRSigmaBpm
			s -= c.w * hourPsi(res) * c.age / evolvedHRSigmaBpm
		}
		s += (theta.drift + delta) / (priors.HRDriftBpmPerDay.SD * priors.HRDriftBpmPerDay.SD)
		return s
	}
	theta.drift += evolvedHRScalarSolve(driftSolve, priors.HRDriftBpmPerDay.Low-theta.drift, priors.HRDriftBpmPerDay.High-theta.drift)
}

// evolvedHRScalarSolve bisects a monotone increasing subgradient over [lo,hi].
func evolvedHRScalarSolve(grad func(float64) float64, lo, hi float64) float64 {
	if grad(lo) >= 0 {
		return lo
	}
	if grad(hi) <= 0 {
		return hi
	}
	for n := 0; n < evolvedHRScalarIters; n++ {
		mid := (lo + hi) / 2
		if grad(mid) < 0 {
			lo = mid
		} else {
			hi = mid
		}
	}
	return (lo + hi) / 2
}

// evolvedHRKnotSolve: coordinate search over the shape knots in ascending
// order; candidate fractions are bounded to [previous knot, next knot] so the
// interpolation stays strictly monotone by construction.
func evolvedHRKnotSolve(term *evolvedHRTerm, priors EvolvedPriorSet, theta *evolvedHRTheta, a float64, stepUnits float64) {
	n := len(theta.knots)
	for i := 0; i < n; i++ {
		sd := priors.HRShape[i].HRFractionSD
		mean := priors.HRShape[i].HRFractionMean
		lo := mean - evolvedHRKnotStepUnits*sd
		if i > 0 && theta.knots[i-1] > lo {
			lo = theta.knots[i-1]
		}
		hi := mean + evolvedHRKnotStepUnits*sd
		if i < n-1 && theta.knots[i+1] < hi {
			hi = theta.knots[i+1]
		}
		bestF, bestJ := theta.knots[i], evolvedHRBlockObjective(term, priors, theta, a)
		for u := -evolvedHRKnotStepUnits; u <= evolvedHRKnotStepUnits+1e-9; u += stepUnits {
			f := mean + u*sd
			if f < lo-1e-12 || f > hi+1e-12 {
				continue
			}
			prev := theta.knots[i]
			theta.knots[i] = f
			if j := evolvedHRBlockObjective(term, priors, theta, a); j < bestJ {
				bestJ, bestF = j, f
			}
			theta.knots[i] = prev
		}
		theta.knots[i] = bestF
	}
}

// evolvedHRBlockObjective evaluates the full HR block (data + every HR prior
// term) at capability a under theta.
func evolvedHRBlockObjective(term *evolvedHRTerm, priors EvolvedPriorSet, theta *evolvedHRTheta, a float64) float64 {
	saved := term.theta
	term.theta = *theta
	j, _ := term.evaluate(priors, a, true)
	term.theta = saved
	return j
}

// ---------------------------------------------------------------------------
// Joint alternation and report stamping
// ---------------------------------------------------------------------------

// evolvedSolveJointK re-solves (a, deltas) of the joint objective on a local
// deterministic k refinement around the speed-MAP exponent: the HR block has
// no k dependence, so the joint exponent can only drift by the small a-shift
// coupling, and the k uncertainty is already carried by the frozen-edge
// envelope. Coarse +/-0.006 at 0.001 then fine at the coarse resolution.
func evolvedSolveJointK(fit *evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64, kCenter float64) (evolvedSolution, bool) {
	coarseStep := 0.001
	half := 0.006
	best := evolvedSolution{k: riegelKMin, objective: math.Inf(1)}
	probes := 0
	evalK := func(k float64) {
		if k < riegelKMin || k > riegelKMax {
			return
		}
		sol := evolvedSolveAtK(fit, priors, histMean, histSD, k)
		probes += sol.probes
		if sol.objective < best.objective {
			best = sol
		}
	}
	lo := math.Max(riegelKMin, kCenter-half)
	for k := lo; k <= math.Min(riegelKMax, kCenter+half)+1e-12; k += coarseStep {
		evalK(k)
	}
	if !evolvedFinite(best.objective) {
		return best, false
	}
	for k := math.Max(riegelKMin, best.k-coarseStep); k <= math.Min(riegelKMax, best.k+coarseStep)+1e-12; k += coarseStep / (evolvedKFineSteps/2 + 1) {
		evalK(k)
	}
	best.probes = probes
	best.gridResolution = coarseStep / (evolvedKFineSteps/2 + 1)
	if !evolvedFinite(best.a) || !evolvedFinite(best.objective) {
		return best, false
	}
	return best, true
}

// evolvedHRJointSolve stages the ONE joint objective: stage zero is the exact
// T2 speed MAP (already computed by FitEvolvedSpeed), the HR theta block is
// fitted conditional on that capability anchor, and the (a,k,delta) block is
// then re-optimized with the HR term attached (local deterministic k
// refinement around the speed-MAP exponent) until the anchor converges. It
// returns the jointly re-stamped speed report (the HR -> capability soft
// feedback) plus the final theta.
func evolvedHRJointSolve(evidence []CandidateEvidence, asOf time.Time, priors EvolvedPriorSet, historical *HistoricalCapabilityPrior, term *evolvedHRTerm, speedOut EvolvedSpeedReport, restPrior *float64) (EvolvedSpeedReport, evolvedHRTheta, int, float64, bool) {
	// #998: attach the time-structured capability state to both domains of
	// the joint objective (the same state instance - one capability). The
	// initial theta fit runs at the stationary anchor with a zero state,
	// then the joint alternation re-optimizes (a_now, trend, day, k, deltas)
	// together with theta. The state weight policy replaces the stationary
	// admission's per-age staleness factors (evolvedStateReweight). The
	// state is an ENHANCEMENT of the proven #997 joint: if its solve fails
	// numerically, the whole joint re-runs without it (the #997 behavior)
	// and the fallback is disclosed - a state-extension failure must never
	// destroy the joint estimate itself.
	withState := false
	if speedOut.CenterMps != nil {
		if _, ok := evolvedAttachCapabilityState(evidence, asOf, priors, false); ok {
			withState = true
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		if attempt == 1 {
			if !withState {
				return EvolvedSpeedReport{}, evolvedHRTheta{}, 0, 0, false
			}
			withState = false
			speedOut.Limitations = append(speedOut.Limitations, evolvedStateSolveFallbackLimitation)
		}
		out, theta, rounds, objective, ok := evolvedHRJointSolveOnce(evidence, asOf, priors, historical, term, speedOut, restPrior, withState)
		if ok {
			return out, theta, rounds, objective, true
		}
		if attempt == 1 || !withState {
			// Both attempts exhausted (or nothing to retry): the honest
			// numerical failure of the #997 joint propagates.
			return EvolvedSpeedReport{}, evolvedHRTheta{}, 0, 0, false
		}
	}
	return EvolvedSpeedReport{}, evolvedHRTheta{}, 0, 0, false
}

func evolvedHRJointSolveOnce(evidence []CandidateEvidence, asOf time.Time, priors EvolvedPriorSet, historical *HistoricalCapabilityPrior, term *evolvedHRTerm, speedOut EvolvedSpeedReport, restPrior *float64, withState bool) (EvolvedSpeedReport, evolvedHRTheta, int, float64, bool) {
	fit := evolvedAdmitObservations(evidence, asOf, priors)
	histMean, histSD := evolvedHistoricalPriorTerms(priors, historical)
	speedAnchor := priors.LogV60.Mean
	speedless := speedOut.CenterMps == nil
	if !speedless {
		speedAnchor = math.Log(*speedOut.CenterMps)
	}
	if !speedless && withState {
		if stateFit, ok := evolvedAttachCapabilityState(evidence, asOf, priors, false); ok {
			fit = stateFit
			term.state = fit.state
		}
	} else {
		term.state = nil
	}
	theta := evolvedFitHRTheta(term, speedAnchor, priors, restPrior)
	term.theta = theta
	rounds := 0
	if len(fit.obs) > 0 && !speedless {
		fit.hr = term
		var last evolvedSolution
		var bestTheta evolvedHRTheta
		bestJ := math.Inf(1)
		bestSet := false
		for r := 0; r < evolvedHRJointRounds; r++ {
			sol, ok := evolvedSolveJointK(&fit, priors, histMean, histSD, speedOut.MapK)
			rounds++
			if !ok {
				if r == 0 && !bestSet {
					return speedOut, theta, rounds, 0, false
				}
				break
			}
			next := evolvedFitHRTheta(term, sol.a, priors, restPrior)
			// Keep-best guard (review P2-2): block-coordinate descent has no
			// formal monotonicity guarantee across rounds (theta cold starts,
			// local k window), so a round is accepted only when the joint
			// objective does not worsen; the published (solution, theta)
			// pair is always the best evaluated pair.
			saved := term.theta
			term.theta = next
			jRound, _ := evolvedProfile(&fit, priors, histMean, histSD, sol.k, sol.a, true)
			term.theta = saved
			if bestSet && jRound > bestJ {
				break
			}
			last, bestTheta, bestJ, bestSet = sol, next, jRound, true
			converged := math.Abs(next.hrRest-theta.hrRest) < 0.01 && math.Abs(next.hrMax-theta.hrMax) < 0.01 && math.Abs(sol.a-speedAnchor) < 1e-4
			theta, term.theta = next, next
			speedAnchor = sol.a
			if converged {
				break
			}
		}
		if bestSet {
			theta, term.theta = bestTheta, bestTheta
			// The published state must pair with the published solution: a
			// rejected round's solve has already mutated the shared state in
			// place, so restore every state block from the keep-best
			// solution snapshot.
			if fit.state != nil && last.dayShift != nil {
				fit.state.trend = last.trend
				for d, v := range last.dayShift {
					fit.state.dayShift[d] = v
				}
			}
			if fit.classShift != nil && last.classShift != nil {
				for c, v := range last.classShift {
					fit.classShift[c] = v
				}
			}
		}
		// Joint re-stamp of the speed report through the shared finalize path.
		out := evolvedJointSpeedOutShell(speedOut, fit, priors)
		out.JointHRRefit = true
		out.MapK = last.k
		out.SolverRounds = last.probes
		out.SolverConverged = last.converged
		out.SolverObjective = last.objective
		if last.gridResolution > 0 {
			out.SolverKGridResolution = last.gridResolution
		}
		if last.gridCoarsened {
			out.Limitations = append(out.Limitations, evolvedKGridCoarsenedLimitation)
		}
		if !evolvedFinalizeSpeedReport(&out, fit, priors, histMean, histSD, last, historical) {
			return speedOut, theta, rounds, 0, false
		}
		speedOut = out
	} else {
		// No speed basis: the capability anchor stays the population prior
		// (set above) and is NOT re-optimized on HR alone; the v60 prior
		// spread propagates into the HR range instead (contract sections
		// 2.3/6, implemented as the prior-sd envelope in evolvedHRStampJoint;
		// the caller stamps the speed_basis_absent reason).
	}
	hrJ, _ := term.evaluate(priors, speedAnchor, true)
	return speedOut, theta, rounds, hrJ, true
}

// evolvedHRStampJoint publishes the joint HR output: model center
// HRsteady(v60) under the declared reference conditions, the posterior sd from
// the (hrRest, hrMax) information system plus the frozen bridge width, the
// speed-envelope conditional evaluations, and the recomputable share basis.
func evolvedHRStampJoint(out *EvolvedHRReport, term *evolvedHRTerm, theta evolvedHRTheta, priors EvolvedPriorSet, speedOut EvolvedSpeedReport, refs []float64, state EstimationState) {
	f1 := evolvedHRBridgeFraction(priors, theta)
	hrRest, hrMax := theta.hrRest, theta.hrMax
	delta := hrMax - hrRest
	modelCenter := hrRest + delta*f1
	// Information system of the level pair at the final anchor.
	a := priors.LogV60.Mean
	if speedOut.CenterMps != nil {
		a = math.Log(*speedOut.CenterMps)
	}
	var m11, m12, m22 float64
	invS2 := 1 / (evolvedHRSigmaBpm * evolvedHRSigmaBpm)
	for _, c := range term.linearCoefficients(priors, &theta, a) {
		pred := c.alpha*hrRest + c.beta*hrMax + c.gamma
		res := (c.y - pred) / evolvedHRSigmaBpm
		nu := 1.0
		if math.Abs(res) > 1.5 {
			nu = 1.5 / math.Abs(res)
		}
		w := c.w * nu * invS2
		m11 += w * c.alpha * c.alpha
		m12 += w * c.alpha * c.beta
		m22 += w * c.beta * c.beta
	}
	m11 += 1 / (priors.RestingHRBpm.SD * priors.RestingHRBpm.SD)
	m22 += 1 / (priors.HRMaxBpm.SD * priors.HRMaxBpm.SD)
	det := m11*m22 - m12*m12
	l1, l2 := 1-f1, f1
	var sdLevel float64
	if math.Abs(det) > 1e-12 {
		v11, v22 := m22/det, m11/det
		sdLevel = math.Sqrt(math.Max(0, l1*l1*v11+l2*l2*v22))
	}
	bridge := priors.HRBridgeAtV60()
	sdOut := math.Hypot(sdLevel, delta*bridge.HRFractionSD)
	// Speed-range propagation: conditional level re-solve at the v60 range
	// edges (knots/tau/day/drift frozen) evaluates the envelope. Without a
	// speed basis the v60 prior spread must enter instead (contract sections
	// 2.3/6, review P1-3): the anchor is the population prior mean and the
	// edges are one prior sd of log v60 away, so the HR range can never be
	// narrower than the un-identified capability allows.
	env := [2]float64{modelCenter, modelCenter}
	if speedOut.RangeLowMps != nil && speedOut.RangeHighMps != nil {
		for i, edge := range []float64{math.Log(*speedOut.RangeLowMps), math.Log(*speedOut.RangeHighMps)} {
			t := theta
			evolvedHRLevelSolve(term, priors, &t, edge)
			env[i] = t.hrRest + (t.hrMax-t.hrRest)*evolvedHRBridgeFraction(priors, t)
		}
	} else {
		for i, edge := range []float64{a - priors.LogV60.SD, a + priors.LogV60.SD} {
			t := theta
			evolvedHRLevelSolve(term, priors, &t, edge)
			env[i] = t.hrRest + (t.hrMax-t.hrRest)*evolvedHRBridgeFraction(priors, t)
		}
	}
	loBpm := math.Min(env[0], math.Min(env[1], modelCenter)) - sdOut
	hiBpm := math.Max(env[0], math.Max(env[1], modelCenter)) + sdOut
	center := modelCenter
	out.ModelCenterBpm = &modelCenter
	out.MeasurementSource = "joint_model_HR_series"
	out.Method = evolvedHRMethodJoint
	if len(refs) > 0 {
		v := medianFloat(refs)
		center = v
		out.MeasurementSource = "measured_reference_median_verified_protocol"
		out.Method = evolvedHRMethodRef
		out.ModelCenterBpm = &modelCenter
	}
	loBpm, hiBpm = math.Max(loBpm, contractHRValidLowBpm), math.Min(hiBpm, contractHRValidHighBpm)
	if loBpm >= center {
		loBpm = center - 1
	}
	if hiBpm <= center {
		hiBpm = center + 1
	}
	out.CenterBpm = &center
	out.RangeLowBpm, out.RangeHighBpm = &loBpm, &hiBpm
	out.PosteriorSDBpm = sdOut
	out.SpeedEnvelopeLowBpm, out.SpeedEnvelopeHighBpm = &env[0], &env[1]
	out.HRMaxBpm, out.RestingHRBpm = &hrMax, &hrRest
	tau, drift := theta.tau, theta.drift
	out.TauS, out.DriftBpmPerDay, out.BridgeFraction = &tau, &drift, &f1
	knots := make([]EvolvedHRKnotFit, len(theta.knots))
	for i := range theta.knots {
		knots[i] = EvolvedHRKnotFit{RelativeIntensity: priors.HRShape[i].RelativeIntensity, HRFraction: theta.knots[i], PriorFraction: priors.HRShape[i].HRFractionMean}
	}
	out.HRShapeKnots = knots
	// Share basis in the output direction (same vocabulary as the speed side).
	priorVar := l1*l1*priors.RestingHRBpm.SD*priors.RestingHRBpm.SD +
		l2*l2*priors.HRMaxBpm.SD*priors.HRMaxBpm.SD +
		delta*delta*bridge.HRFractionSD*bridge.HRFractionSD
	if priorVar > 0 && sdOut > 0 {
		out.PriorCurvature = 1 / priorVar
		out.EffectiveCurvature = 1 / (sdOut * sdOut)
		out.DataCurvature = math.Max(0, out.EffectiveCurvature-out.PriorCurvature)
		out.PriorCurvatureShare = math.Min(1, out.PriorCurvature/out.EffectiveCurvature)
	}
	if out.PriorCurvatureShare >= evolvedPriorShareDominant {
		out.Reasons = append(out.Reasons, evolvedPriorShareReason)
	}
}

func evolvedHRBridgeFraction(priors EvolvedPriorSet, theta evolvedHRTheta) float64 {
	// Interpolating at r=1.0 returns the fitted bridge knot fraction (the
	// contract pins a knot exactly at relative intensity 1.0).
	f, _ := evolvedHRShape(evolvedHRFitKnots(priors, theta.knots), 1.0)
	return f
}

// evolvedHRStampPriorOnly publishes the finite prior_dominated HR estimate:
// bridge-composed center from the physiological priors (resting-HR rows when
// present) with the prior spread as the sensitivity range.
func evolvedHRStampPriorOnly(out *EvolvedHRReport, priors EvolvedPriorSet, restPrior *float64, state EstimationState) {
	hrRest := priors.RestingHRBpm.Mean
	if restPrior != nil {
		hrRest = *restPrior
	}
	bridge := priors.HRBridgeAtV60()
	delta := priors.HRMaxBpm.Mean - hrRest
	center := hrRest + delta*bridge.HRFractionMean
	l1, l2 := 1-bridge.HRFractionMean, bridge.HRFractionMean
	sd := math.Sqrt(l1*l1*priors.RestingHRBpm.SD*priors.RestingHRBpm.SD +
		l2*l2*priors.HRMaxBpm.SD*priors.HRMaxBpm.SD +
		delta*delta*bridge.HRFractionSD*bridge.HRFractionSD)
	lo := math.Max(center-sd, contractHRValidLowBpm)
	hi := math.Min(center+sd, contractHRValidHighBpm)
	out.CenterBpm, out.RangeLowBpm, out.RangeHighBpm = &center, &lo, &hi
	out.PosteriorSDBpm = sd
	out.PriorCurvatureShare = 1
	out.PriorCurvature, out.DataCurvature, out.EffectiveCurvature = 1/(sd*sd), 0, 1/(sd*sd)
	out.Method = evolvedHRMethodPrior
	out.State = state
	out.MeasurementSource = "physiological_prior_only"
	hrMax, tau := priors.HRMaxBpm.Mean, priors.HRTauS.Mean
	drift := priors.HRDriftBpmPerDay.Mean
	bf := bridge.HRFractionMean
	out.HRMaxBpm, out.RestingHRBpm = &hrMax, &hrRest
	out.TauS, out.DriftBpmPerDay, out.BridgeFraction = &tau, &drift, &bf
}

// evolvedHRStampReference publishes a measured reference center on top of the
// prior-composed range; the reference tier keeps its own source label.
func evolvedHRStampReference(out *EvolvedHRReport, refs []float64) {
	v := medianFloat(refs)
	out.CenterBpm = &v
	out.Method = evolvedHRMethodRef
	out.MeasurementSource = "measured_reference_median_verified_protocol"
}
