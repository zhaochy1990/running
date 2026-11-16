package calibration

import (
	"math"
	"sort"
	"time"
)

// evolved_state.go implements the #998 time-structured capability state of
// the evolved v4, inside the SAME joint objective as #996/#997:
//
//	log v_i = a_i - k*log(t_i/3600) - delta_g + eps_i
//	a_i     = a_now - trend*age_i + dayShift[d_i]
//
// a_now is the capability at the as-of instant, trend the slow log-v60/day
// drift and dayShift[d] the capability-side day effect (log-speed units) of
// day d. Prior scale separation does the R3 work: a smooth multi-week drift
// is cheap for the trend prior (0 +/- 0.0005/day) and expensive for day
// priors (0 +/- 0.02 each), while a single hot/tired/sensor-shifted day is
// one cheap day shift - so day-level noise cannot all absorb into the
// capability trend, and a real trend is not fragmented into day effects.
//
// TWO DAY-CHANNEL BOUNDARY (#998): the HR-domain theta.day (#997, bpm,
// Hsteady level shift per day, see evolved_hr.go) and the capability-side
// dayShift here (log-speed) are DIFFERENT channels of the same joint
// objective. theta.day moves the HR level at fixed relative intensity;
// dayShift moves the speed-domain capability anchor (and with it the HR
// relative intensity v/v60). Neither may be folded into the other and
// neither is a correction of the other: theta.day is never converted into a
// capability change and dayShift is never converted into bpm.
//
// The state priors are #998 research choices frozen HERE (not in
// contract_priors.go): they regularize the TIME parameterization of the
// capability the same structural way delta >= 0 bounds the effort margin -
// without them the (trend, dayShift) ridge is unidentified - and the frozen
// #995 contract prior set and its IdentityHash stay untouched. The pure
// FitEvolvedSpeed seam keeps the stationary scalar capability bit-for-bit;
// the state is attached only by the joint assembly (FitEvolvedJoint), per
// the #997 hand-off note.

const (
	evolvedStateMethodFit        = "trend_day_state_joint_fit"
	evolvedStateMethodStationary = "stationary_scalar_fallback"

	// Capability trend prior: log-v60 per day, zero-mean, wide enough for a
	// real training-block drift (~+9% over 180 days at the clamp) and tight
	// enough that day-level wobble never masquerades as a trend.
	evolvedCapabilityTrendSDPerDay = 0.0005
	evolvedCapabilityTrendClamp    = 0.003
	// Capability-side day effect prior: log-speed units per distinct evidence
	// day (weather/fatigue/sensor day noise), one research fact per day.
	evolvedCapabilityDaySDLog = 0.02
	evolvedCapabilityDayClamp = 0.15

	// Deterministic alternation caps of the (a_now | trend | day) blocks.
	evolvedStateRounds       = 4
	evolvedStateConvergeA    = 1e-4
	evolvedStateConvergeT   = 1e-6
	evolvedStateConvergeDay  = 1e-5
	evolvedStateProbeCapIters = 45
	// Bounded day-effect disclosure in the report stamp.
	evolvedStateDayEffectsCap = 16

	evolvedStateTrendClampedLimitation    = "capability_trend_prior_clamped"
	evolvedStateSolveFallbackLimitation   = "capability_state_solve_failed_stationary_center_retained"
	evolvedStateRangeMarginLimitation     = "capability_state_range_widened_by_day_effects"
	evolvedStateNoNewDataReason           = "no_new_comparable_evidence_capability_predict_only"
	evolvedStatePriorPredictOnlyMethod    = "prior_predict_only"
	evolvedStateDayEffectSeparationReason = "capability_day_effects_separated_from_trend"
)

// EvolvedDayEffectStamp publishes one capability-side day effect.
type EvolvedDayEffectStamp struct {
	Day      string  `json:"day"`
	ShiftLog float64 `json:"shift_log_v60"`
}

// EvolvedCapabilityPriorPrediction publishes the FIXED-ORDER predict step of
// the state update (#998): the aged prior prediction actually applied in the
// objective (exactly once) before the new evidence update, with its lineage.
type EvolvedCapabilityPriorPrediction struct {
	CenterLog              float64 `json:"center_log_v60"`
	SDLog                  float64 `json:"sd_log_v60"`
	AgeDays                float64 `json:"age_days"`
	TrendPerDayUsed        float64 `json:"trend_per_day_used"`
	SourceAsOfDay          string  `json:"source_as_of_day,omitempty"`
	SourceInputFingerprint string  `json:"source_input_fingerprint,omitempty"`
}

// EvolvedCapabilityStateStamp is the auditable time-structure block of the
// speed report: trend, bounded day-effect disclosure, window span and the
// prior prediction channel.
type EvolvedCapabilityStateStamp struct {
	Method           string                               `json:"method"`
	TrendPerDay      float64                              `json:"trend_per_day_log_v60"`
	TrendClamped     bool                                 `json:"trend_clamped,omitempty"`
	DayEffects       []EvolvedDayEffectStamp              `json:"day_effects,omitempty"`
	DistinctDays     int                                  `json:"distinct_days"`
	FirstDay         string                               `json:"first_day,omitempty"`
	LastDay          string                               `json:"last_day,omitempty"`
	// WeightPolicy discloses that the state solve drops the stationary
	// admission's per-age staleness factors (weight decay and sigma age
	// inflation): with the explicit trend/day structure those factors would
	// double-count drift and erase the trend signal. Budget semantics stay.
	WeightPolicy    string                                `json:"weight_policy"`
	PriorPrediction *EvolvedCapabilityPriorPrediction     `json:"prior_prediction,omitempty"`
	Reasons         []string                              `json:"reasons,omitempty"`
}

// evolvedCapabilityState is the mutable solver block attached to evolvedFit
// (and referenced by the HR term so both domains see the same per-activity
// capability). nil keeps the stationary #996/#997 behavior bit-for-bit.
type evolvedCapabilityState struct {
	trend    float64
	dayShift map[string]float64
	days     []string // sorted distinct admitted evidence days
}

// capabilityAt returns the capability of an observation age days old on day
// d, anchored at aNow. nil state = stationary scalar capability.
func (st *evolvedCapabilityState) capabilityAt(age float64, day string, aNow float64) float64 {
	if st == nil {
		return aNow
	}
	return aNow - st.trend*age + st.dayShift[day]
}

// newEvolvedCapabilityState collects the distinct evidence days of the
// admitted model observations (sorted; zero-initialized shifts).
func newEvolvedCapabilityState(fit *evolvedFit) *evolvedCapabilityState {
	daySet := map[string]bool{}
	for i := range fit.obs {
		if !fit.obs[i].constraint {
			daySet[fit.obs[i].day] = true
		}
	}
	days := make([]string, 0, len(daySet))
	for d := range daySet {
		days = append(days, d)
	}
	sort.Strings(days)
	shifts := make(map[string]float64, len(days))
	for _, d := range days {
		shifts[d] = 0
	}
	return &evolvedCapabilityState{dayShift: shifts, days: days}
}

// evolvedStateEligible: the time structure needs model observations on at
// least two distinct days (single-day windows cannot separate trend from the
// anchor and stay stationary).
func evolvedStateEligible(fit *evolvedFit) bool {
	days := map[string]bool{}
	obs := 0
	for i := range fit.obs {
		if fit.obs[i].constraint {
			continue
		}
		days[fit.obs[i].day] = true
		obs++
	}
	return obs > 0 && len(days) >= 2
}

// stateSnapshot copies the current state into the solution for stamping.
func (st *evolvedCapabilityState) snapshot() (trend float64, dayShift map[string]float64) {
	if st == nil {
		return 0, nil
	}
	out := make(map[string]float64, len(st.dayShift))
	for d, v := range st.dayShift {
		out[d] = v
	}
	return st.trend, out
}

// ---------------------------------------------------------------------------
// State blocks (exact conditional minimizations; deltas held at their last
// profile values, priors included - the structural regularization of the
// time parameterization, on in both objective modes)
// ---------------------------------------------------------------------------

// evolvedStateGrad evaluates the trend/day subgradients of the joint
// objective at fixed deltas (speed residuals + constraint hinges + state
// priors + the HR term when attached). Each day's block touches only that
// day's observations, so per-day minimization given the trend is exact.
func evolvedStateGrad(fit *evolvedFit, priors EvolvedPriorSet, k, aNow float64) (gTrend float64, gDay map[string]float64) {
	st := fit.state
	gDay = make(map[string]float64, len(st.days))
	for i := range fit.obs {
		p := &fit.obs[i]
		aEff := st.capabilityAt(p.age, p.day, aNow)
		if p.constraint {
			v := (p.y - p.sigma - (aEff - k*p.x)) / p.sigma
			if v > 0 {
				gTrend += p.w * hourPsi(v) * p.age / p.sigma
				gDay[p.day] -= p.w * hourPsi(v) / p.sigma
			}
			continue
		}
		delta := fit.groups[p.group].delta
		r := (p.y - aEff + k*p.x + delta) / p.sigma
		gTrend += p.w * hourPsi(r) * p.age / p.sigma
		gDay[p.day] -= p.w * hourPsi(r) / p.sigma
	}
	if fit.hr != nil {
		_, _, gTrendHR, gDayHR := fit.hr.evaluateFull(priors, aNow, false)
		gTrend += gTrendHR
		for d, g := range gDayHR {
			gDay[d] += g
		}
	}
	gTrend += st.trend / (evolvedCapabilityTrendSDPerDay * evolvedCapabilityTrendSDPerDay)
	for _, d := range st.days {
		gDay[d] += st.dayShift[d] / (evolvedCapabilityDaySDLog * evolvedCapabilityDaySDLog)
	}
	return gTrend, gDay
}

// evolvedStateBlocks runs one profiled trend bisection (days fixed, the
// effort margins re-solved at every probe - without that marginalization the
// per-observation deltas are collinear with the trend and the conditional
// gradient vanishes at the stationary optimum, stalling the alternation) and
// one exact per-day pass (trend fixed, deltas held: the (delta, day) pair of
// one day is a prior-separated 2-d convex problem the rounds converge).
// Probes counted for the solver audit.
func evolvedStateBlocks(fit *evolvedFit, priors EvolvedPriorSet, k, aNow float64, withPriors bool, probes *int) {
	st := fit.state
	solveDeltas := func() {
		for g := range fit.groups {
			fit.groups[g].delta = evolvedGroupDelta(fit, g, aNow, k, withPriors)
		}
	}
	step := func(trend float64) float64 {
		st.trend = trend
		*probes++
		solveDeltas()
		g, _ := evolvedStateGrad(fit, priors, k, aNow)
		return g
	}
	st.trend = evolvedHRScalarSolve(step, -evolvedCapabilityTrendClamp, evolvedCapabilityTrendClamp)
	*probes++
	// The bisection's last probe leaves the deltas at a neighboring trend;
	// re-solve them at the published trend so the state and the margins stay
	// a consistent pair.
	solveDeltas()
	for _, d := range st.days {
		cur := st.dayShift[d]
		gDay := func(shift float64) float64 {
			st.dayShift[d] = shift
			*probes++
			_, g := evolvedStateGrad(fit, priors, k, aNow)
			return g[d]
		}
		st.dayShift[d] = evolvedHRScalarSolve(gDay,
			math.Max(-evolvedCapabilityDayClamp, math.Min(evolvedCapabilityDayClamp, cur-evolvedCapabilityDayClamp)),
			math.Max(-evolvedCapabilityDayClamp, math.Min(evolvedCapabilityDayClamp, cur+evolvedCapabilityDayClamp)))
		*probes++
	}
}

// evolvedStateConverged compares a saved state against the current one.
func evolvedStateConverged(st *evolvedCapabilityState, trend float64, dayShift map[string]float64, dA float64) bool {
	if math.Abs(st.trend-trend) > evolvedStateConvergeT {
		return false
	}
	for d, v := range dayShift {
		if math.Abs(st.dayShift[d]-v) > evolvedStateConvergeDay {
			return false
		}
	}
	return dA < evolvedStateConvergeA
}

// ---------------------------------------------------------------------------
// State-path admission (shared by the standalone resolve and the HR joint
// solve), standalone speed-only resolve, and report stamping
// ---------------------------------------------------------------------------

// evolvedStateReweight applies the state weight policy to a freshly admitted
// fit: the stationary admission models capability drift through measurement
// staleness (weight 2^(-age/90) and sigma inflation age*0.001); with the
// explicit trend/day state that drift is modeled structurally, and keeping
// the per-age factors would double-count it - suppressing the trend signal
// exactly the way the 180-day plateau this ticket removes. Within-window
// weights are flat and the age term is divided out of sigma exactly; the
// root/day contribution-budget semantics of the admission are untouched
// (every window keeps its root unit and day unit shares). The policy is
// disclosed on the capability state stamp.
func evolvedStateReweight(fit *evolvedFit) {
	for i := range fit.obs {
		p := &fit.obs[i]
		if p.wAge > 0 {
			p.w /= p.wAge
		}
		if p.ageSigma > 0 {
			s2 := p.sigma*p.sigma - p.ageSigma*p.ageSigma
			if s2 > 0 {
				p.sigma = math.Sqrt(s2)
			}
		}
	}
}

// evolvedAttachCapabilityState admits the evidence for a state solve (all
// valid continuous windows - see evolvedAdmitObservationsMode), applies the
// state weight policy and attaches the state when the window can structure
// time. Returns false for ineligible windows.
func evolvedAttachCapabilityState(evidence []CandidateEvidence, asOf time.Time, priors EvolvedPriorSet) (evolvedFit, bool) {
	fit := evolvedAdmitObservationsMode(evidence, asOf, priors, true)
	if !evolvedStateEligible(&fit) {
		return fit, false
	}
	evolvedStateReweight(&fit)
	fit.state = newEvolvedCapabilityState(&fit)
	return fit, true
}

// evolvedSpeedStateResolve re-solves the speed objective with the capability
// state attached (local deterministic k refinement around the stationary
// MAP exponent, same machinery as the joint re-solve). Ineligible windows
// keep the stationary report; a numerical failure falls back to the
// stationary center with an explicit limitation - never a fabricated state.
func evolvedSpeedStateResolve(evidence []CandidateEvidence, asOf time.Time, priors EvolvedPriorSet, historical *HistoricalCapabilityPrior, stationary EvolvedSpeedReport) EvolvedSpeedReport {
	if stationary.CenterMps == nil {
		return stationary
	}
	fit, ok := evolvedAttachCapabilityState(evidence, asOf, priors)
	if !ok {
		return stationary
	}
	histMean, histSD := evolvedHistoricalPriorTerms(priors, historical)
	sol, ok := evolvedSolveJointK(&fit, priors, histMean, histSD, stationary.MapK)
	if !ok {
		stationary.Limitations = append(stationary.Limitations, evolvedStateSolveFallbackLimitation)
		return stationary
	}
	out := evolvedJointSpeedOutShell(stationary, fit, priors)
	out.MapK = sol.k
	out.SolverRounds = sol.probes
	out.SolverConverged = sol.converged
	out.SolverObjective = sol.objective
	if sol.gridResolution > 0 {
		out.SolverKGridResolution = sol.gridResolution
	}
	if sol.gridCoarsened {
		out.Limitations = append(out.Limitations, evolvedKGridCoarsenedLimitation)
	}
	if !evolvedFinalizeSpeedReport(&out, fit, priors, histMean, histSD, sol, historical) {
		stationary.Limitations = append(stationary.Limitations, evolvedStateSolveFallbackLimitation)
		return stationary
	}
	return out
}

// evolvedJointSpeedOutShell builds the shared re-solved speed report shell
// (joint re-solve and standalone state resolve publish identically
// structured diagnostics).
func evolvedJointSpeedOutShell(stationary EvolvedSpeedReport, fit evolvedFit, priors EvolvedPriorSet) EvolvedSpeedReport {
	return EvolvedSpeedReport{
		ParameterVersion:       EvolvedPriorSetVersion,
		Method:                 evolvedSpeedMethodFit,
		State:                  stationary.State,
		RangeMeaning:           contractRangeSemantics,
		PriorsIdentityHash:     priors.IdentityHash(),
		SolverKGridResolution:  (riegelKMax - riegelKMin) / evolvedKCoarseSteps / (evolvedKFineSteps/2 + 1),
		Reasons:                append([]string{}, stationary.Reasons...),
		Limitations:            evolvedSpeedLimitations(),
		Observations:           fit.rows,
		InputIdentityHash:      stationary.InputIdentityHash,
		IndependentRoots:       stationary.IndependentRoots,
		IndependentDays:        stationary.IndependentDays,
		MinDurationS:           stationary.MinDurationS,
		MaxDurationS:           stationary.MaxDurationS,
		MaximalAnchors:         stationary.MaximalAnchors,
		HistoricalPriorMeanLog: stationary.HistoricalPriorMeanLog,
		HistoricalPriorSDLog:   stationary.HistoricalPriorSDLog,
		HistoricalPriorAgeDays: stationary.HistoricalPriorAgeDays,
		JointHRRefit:           stationary.JointHRRefit,
	}
}

// evolvedStampCapabilityState publishes the state block on the speed report:
// trend with clamp disclosure, bounded day effects (largest magnitude first,
// deterministic ties), window span and the prior prediction channel.
func evolvedStampCapabilityState(out *EvolvedSpeedReport, fit evolvedFit, sol evolvedSolution, historical *HistoricalCapabilityPrior, histMean, histSD *float64) {
	if fit.state == nil || sol.dayShift == nil {
		return
	}
	stamp := EvolvedCapabilityStateStamp{
		Method:        evolvedStateMethodFit,
		TrendPerDay:   sol.trend,
		TrendClamped:  math.Abs(sol.trend) >= evolvedCapabilityTrendClamp-1e-9,
		DistinctDays:  len(fit.state.days),
		WeightPolicy:  "flat_within_window_age_staleness_divided_out",
	}
	if len(fit.state.days) > 0 {
		stamp.FirstDay = fit.state.days[0]
		stamp.LastDay = fit.state.days[len(fit.state.days)-1]
	}
	effects := make([]EvolvedDayEffectStamp, 0, len(sol.dayShift))
	for d, v := range sol.dayShift {
		effects = append(effects, EvolvedDayEffectStamp{Day: d, ShiftLog: v})
	}
	sort.Slice(effects, func(i, j int) bool {
		if math.Abs(effects[i].ShiftLog) != math.Abs(effects[j].ShiftLog) {
			return math.Abs(effects[i].ShiftLog) > math.Abs(effects[j].ShiftLog)
		}
		return effects[i].Day < effects[j].Day
	})
	if len(effects) > evolvedStateDayEffectsCap {
		effects = effects[:evolvedStateDayEffectsCap]
	}
	stamp.DayEffects = effects
	if stamp.TrendClamped {
		out.Limitations = append(out.Limitations, evolvedStateTrendClampedLimitation)
	}
	if len(fit.state.days) >= 2 {
		stamp.Reasons = append(stamp.Reasons, evolvedStateDayEffectSeparationReason)
	}
	if historical != nil && historical.valid() && histMean != nil && histSD != nil {
		trend := math.Max(-evolvedCapabilityTrendClamp, math.Min(evolvedCapabilityTrendClamp, historical.TrendPerDay))
		prediction := &EvolvedCapabilityPriorPrediction{
			CenterLog:              *histMean,
			SDLog:                  *histSD,
			AgeDays:                historical.AgeDays,
			TrendPerDayUsed:        trend,
			SourceInputFingerprint: historical.InputFingerprint,
		}
		if !historical.AsOfDate.IsZero() {
			prediction.SourceAsOfDay = historical.AsOfDate.Format("2006-01-02")
		}
		stamp.PriorPrediction = prediction
	}
	out.CapabilityState = &stamp
}
