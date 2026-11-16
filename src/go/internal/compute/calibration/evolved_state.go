package calibration

import (
	"fmt"
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

	// Deterministic iteration caps of the joint state solver (IRLS outer
	// rounds of the exact linear conditional vs the margin bisections, plus
	// the halving line search budget per round).
	evolvedStateIRLSIters    = 25
	evolvedStateLineHalvings = 8
	// Bounded day-effect disclosure in the report stamp.
	evolvedStateDayEffectsCap = 16
	// Cost guards at production scale: beyond this many distinct evidence
	// days the day effects resolve at ISO-week granularity and the IRLS
	// rounds tighten (disclosed).
	evolvedStateDayCap         = 60
	evolvedStateIRLSItersLarge = 8

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
	Method       string                  `json:"method"`
	TrendPerDay  float64                 `json:"trend_per_day_log_v60"`
	TrendClamped bool                    `json:"trend_clamped,omitempty"`
	DayEffects   []EvolvedDayEffectStamp `json:"day_effects,omitempty"`
	// DistinctEffects counts the day-effect UNKNOWN SUPPORTS actually
	// fitted: distinct days in day mode, distinct ISO weeks in the coarsened
	// scale-guard mode - the semantics are pinned by EffectResolution, it is
	// never silently "days" in both.
	DistinctEffects int    `json:"distinct_effects"`
	FirstEffect     string `json:"first_effect,omitempty"`
	LastEffect      string `json:"last_effect,omitempty"`
	// EffectResolution discloses the day-effect granularity: "day" or
	// "iso_week_beyond_60_distinct_days" (the deterministic scale cap).
	EffectResolution string `json:"effect_resolution"`
	// WeightPolicy discloses that the state solve drops the stationary
	// admission's per-age staleness factors (weight decay and sigma age
	// inflation): with the explicit trend/day structure those factors would
	// double-count drift and erase the trend signal. Budget semantics stay.
	WeightPolicy    string                            `json:"weight_policy"`
	PriorPrediction *EvolvedCapabilityPriorPrediction `json:"prior_prediction,omitempty"`
	Reasons         []string                          `json:"reasons,omitempty"`
}

// evolvedCapabilityState is the mutable solver block attached to evolvedFit
// (and referenced by the HR term so both domains see the same per-activity
// capability). nil keeps the stationary #996/#997 behavior bit-for-bit.
type evolvedCapabilityState struct {
	trend float64
	// dayShift holds one effect per effect key (day or ISO week at scale).
	dayShift map[string]float64
	days     []string // sorted distinct effect keys
	dayKey   map[string]string
	// weekly marks the coarsened resolution (cost guard, disclosed).
	weekly bool
	// frozen marks a state solved by the standalone speed resolve and then
	// conditioned on by the HR joint: the joint re-optimizes only the anchor
	// a_now (and k, deltas, theta) through the proven #997 machinery, never
	// the time structure itself.
	frozen bool
}

// capabilityAt returns the capability of an observation age days old on day
// d, anchored at aNow. nil state = stationary scalar capability.
func (st *evolvedCapabilityState) capabilityAt(age float64, day string, aNow float64) float64 {
	if st == nil {
		return aNow
	}
	return aNow - st.trend*age + st.dayShift[st.dayKey[day]]
}

// evolvedStateEffectKey maps one civil day to its effect key: the day itself
// up to the cap, its ISO week beyond (deterministic).
func evolvedStateEffectKey(day string, weekly bool) string {
	if !weekly {
		return day
	}
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	year, week := t.ISOWeek()
	return fmt.Sprintf("%04d-W%02d", year, week)
}

// newEvolvedCapabilityState collects the distinct evidence days of the
// admitted model observations and builds the effect keys (per-day up to
// evolvedStateDayCap distinct days, ISO-weekly beyond - the cost guard that
// keeps the linear system small at production scale; disclosed on the
// stamp).
func newEvolvedCapabilityState(fit *evolvedFit) *evolvedCapabilityState {
	daySet := map[string]bool{}
	for i := range fit.obs {
		if !fit.obs[i].constraint {
			daySet[fit.obs[i].day] = true
		}
	}
	weekly := len(daySet) > evolvedStateDayCap
	keys := map[string]bool{}
	dayKey := make(map[string]string, len(daySet))
	for d := range daySet {
		k := evolvedStateEffectKey(d, weekly)
		dayKey[d] = k
		keys[k] = true
	}
	days := make([]string, 0, len(keys))
	for k := range keys {
		days = append(days, k)
	}
	sort.Strings(days)
	shifts := make(map[string]float64, len(days))
	for _, d := range days {
		shifts[d] = 0
	}
	return &evolvedCapabilityState{dayShift: shifts, days: days, dayKey: dayKey, weekly: weekly}
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

// trendOnlyFrozen returns a frozen copy carrying only the slow structure
// (trend): the joint objective conditions per-activity capabilities on
// a_now - trend*age, leaving the day-level offsets to the speed-domain
// solve (they would fight the HR-domain theta.day channel).
func (st *evolvedCapabilityState) trendOnlyFrozen() *evolvedCapabilityState {
	shifts := make(map[string]float64, len(st.dayShift))
	for k := range st.dayShift {
		shifts[k] = 0
	}
	return &evolvedCapabilityState{trend: st.trend, dayShift: shifts, days: st.days, dayKey: st.dayKey, weekly: st.weekly, frozen: true}
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
// ---------------------------------------------------------------------------
// Joint state solver: the exact conditional of (a, trend, day shifts, class
// shifts) given the effort margins, as one linear-Gaussian system at IRLS
// weights. The collinear directions (a_now vs the class shift, trend vs day
// offsets) are resolved inside a single solve instead of a stalling
// alternation.
// ---------------------------------------------------------------------------

// evolvedStateUnknowns fixes the deterministic unknown ordering of the joint
// state system: [a, trend, days sorted, effort classes sorted] (a omitted
// when pinned for profile probes).
type evolvedStateUnknowns struct {
	n          int
	hasA       bool
	iA, iTrend int
	dayIdx     map[string]int
	clsIdx     map[EffortSupport]int
}

func evolvedStateUnknownsOf(fit *evolvedFit, hasA bool) evolvedStateUnknowns {
	u := evolvedStateUnknowns{hasA: hasA, dayIdx: map[string]int{}, clsIdx: map[EffortSupport]int{}}
	if hasA {
		u.iA, u.n = 0, 1
	}
	u.iTrend = u.n
	u.n++
	for _, d := range fit.state.days {
		u.dayIdx[d] = u.n
		u.n++
	}
	classes := make([]EffortSupport, 0, len(fit.classShift))
	for c := range fit.classShift {
		classes = append(classes, c)
	}
	sort.Slice(classes, func(i, j int) bool { return classes[i] < classes[j] })
	for _, c := range classes {
		u.clsIdx[c] = u.n
		u.n++
	}
	return u
}

// evolvedStateAddRow accumulates one weighted linearized residual row
// 0.5*w*(g.x + r)^2 into the normal equations A x = rhs.
func evolvedStateAddRow(A [][]float64, rhs []float64, g map[int]float64, r, w float64) {
	for i, gi := range g {
		rhs[i] -= w * gi * r
		for j, gj := range g {
			if j >= i {
				A[i][j] += w * gi * gj
			}
		}
	}
}

func evolvedStateAddPrior(A [][]float64, rhs []float64, idx int, theta, mean, sd float64) {
	inv := 1 / (sd * sd)
	A[idx][idx] += inv
	rhs[idx] -= (theta - mean) * inv
}

// evolvedStateSolveSystem builds and solves the joint state normal equations
// conditional on the current effort margins: Huber-IRLS rows for the speed
// observations and active long-duration hinges, Gauss-Newton rows for the HR
// term (analytic Jacobians through the shared response-filter chain), the
// hierarchical class-shift coupling (each group's margin prior centers on
// mean_c + s_c) and every state prior. Returns the proposed increment or
// nil on a singular system (caller keeps the current point).
func evolvedStateSolveSystem(fit *evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64, k, aNow float64, u evolvedStateUnknowns) []float64 {
	n := u.n
	A := make([][]float64, n)
	for i := range A {
		A[i] = make([]float64, n)
	}
	rhs := make([]float64, n)
	st := fit.state
	// Per-group margin response factors (Schur): along a state increment the
	// group margin re-solve follows the increment by W_d/(W_d+W_p) (data
	// share) and the class shift by W_p/(W_d+W_p) - the hierarchical coupling
	// enters the linear system through these factors instead of a stalling
	// alternation between a and the class shift.
	keep := make([]float64, len(fit.groups))
	for g := range fit.groups {
		grp := &fit.groups[g]
		var wData float64
		for _, oi := range grp.obsIdx {
			p := &fit.obs[oi]
			r := (p.y - st.capabilityAt(p.age, p.day, aNow) + k*p.x + grp.delta) / p.sigma
			nu := 1.0
			if math.Abs(r) > 1.5 {
				nu = 1.5 / math.Abs(r)
			}
			wData += p.w * nu / (p.sigma * p.sigma)
		}
		wPrior := 1 / (grp.prior.SD * grp.prior.SD)
		keep[g] = wPrior / (wData + wPrior)
	}
	for i := range fit.obs {
		p := &fit.obs[i]
		aEff := st.capabilityAt(p.age, p.day, aNow)
		g := map[int]float64{}
		var r, nu, keepG float64
		if p.constraint {
			v := (p.y - p.sigma - (aEff - k*p.x)) / p.sigma
			if v <= 0 {
				continue
			}
			r, nu, keepG = v, 1, 1
			if math.Abs(v) > 1.5 {
				nu = 1.5 / math.Abs(v)
			}
		} else {
			delta := fit.groups[p.group].delta
			r = (p.y - aEff + k*p.x + delta) / p.sigma
			nu = 1
			if math.Abs(r) > 1.5 {
				nu = 1.5 / math.Abs(r)
			}
			keepG = keep[p.group]
		}
		if u.hasA {
			g[u.iA] = -keepG / p.sigma
		}
		g[u.iTrend] = p.age * keepG / p.sigma
		// The day column is indexed by EFFECT KEY (the day itself up to the
		// cap, its ISO week beyond) - the raw civil day would never match
		// the weekly keys and the day unknowns would lose their data
		// gradient entirely (review P1).
		if di, ok := u.dayIdx[st.dayKey[p.day]]; ok {
			g[di] = -keepG / p.sigma
		}
		if ci, ok := u.clsIdx[fit.groups[p.group].effort]; ok && !p.constraint {
			g[ci] = keepG / p.sigma
		}
		evolvedStateAddRow(A, rhs, g, r, p.w*nu)
	}
	// Class coupling rows: the margin prior term (delta_g - mean_c - s_c) as a
	// linearized row with the same response factors - this is where the
	// class-mean information (and with it the differential/trend signal)
	// enters the system. Along the ridge delta_a = delta_s_c the row is
	// invariant, so the a-vs-s_c split is resolved by their priors alone -
	// exactly the hierarchical marginal.
	for gi := range fit.groups {
		grp := &fit.groups[gi]
		ci, ok := u.clsIdx[grp.effort]
		if !ok {
			continue
		}
		fData := 1 - keep[gi]
		j := map[int]float64{}
		if u.hasA {
			j[u.iA] = fData / grp.prior.SD
		}
		j[u.iTrend] = -fData * grp.age / grp.prior.SD
		if di, ok := u.dayIdx[st.dayKey[grp.day]]; ok {
			j[di] = fData / grp.prior.SD
		}
		j[ci] = (keep[gi] - 1) / grp.prior.SD
		r := (grp.delta - grp.prior.Mean - fit.classShift[grp.effort]) / grp.prior.SD
		evolvedStateAddRow(A, rhs, j, r, 1)
	}
	evolvedStateAddPrior(A, rhs, u.iTrend, st.trend, 0, evolvedCapabilityTrendSDPerDay)
	for _, d := range st.days {
		evolvedStateAddPrior(A, rhs, u.dayIdx[d], st.dayShift[d], 0, evolvedCapabilityDaySDLog)
	}
	for c, idx := range u.clsIdx {
		// The margin-prior coupling itself rides the response factors above;
		// only the class shift's own prior centers it at zero.
		sd := evolvedEffortPrior(priors, c).SD
		evolvedStateAddPrior(A, rhs, idx, fit.classShift[c], 0, sd)
	}
	if u.hasA {
		evolvedStateAddPrior(A, rhs, u.iA, aNow, priors.LogV60.Mean, priors.LogV60.SD)
		if histMean != nil {
			evolvedStateAddPrior(A, rhs, u.iA, aNow, *histMean, *histSD)
		}
	}
	for i := 0; i < n; i++ {
		for j := 0; j < i; j++ {
			A[i][j] = A[j][i]
		}
	}
	x := make([]float64, n)
	b := append([]float64(nil), rhs...)
	for col := 0; col < n; col++ {
		pivot := col
		for r := col + 1; r < n; r++ {
			if math.Abs(A[r][col]) > math.Abs(A[pivot][col]) {
				pivot = r
			}
		}
		if math.Abs(A[pivot][col]) < 1e-12 {
			return nil
		}
		A[col], A[pivot] = A[pivot], A[col]
		b[col], b[pivot] = b[pivot], b[col]
		for r := col + 1; r < n; r++ {
			f := A[r][col] / A[col][col]
			if f == 0 {
				continue
			}
			for c2 := col; c2 < n; c2++ {
				A[r][c2] -= f * A[col][c2]
			}
			b[r] -= f * b[col]
		}
	}
	for i := n - 1; i >= 0; i-- {
		s := b[i]
		for j := i + 1; j < n; j++ {
			s -= A[i][j] * x[j]
		}
		x[i] = s / A[i][i]
		if !evolvedFinite(x[i]) {
			return nil
		}
	}
	return x
}

// evolvedStateApply writes a solved increment into the state, clamped to the
// frozen truncation domains; returns the updated a anchor.
func evolvedStateApply(fit *evolvedFit, u evolvedStateUnknowns, x []float64, aNow, step float64) float64 {
	st := fit.state
	if u.hasA {
		aNow += step * x[u.iA]
	}
	st.trend = math.Max(-evolvedCapabilityTrendClamp, math.Min(evolvedCapabilityTrendClamp, st.trend+step*x[u.iTrend]))
	for d, idx := range u.dayIdx {
		v := st.dayShift[d] + step*x[idx]
		st.dayShift[d] = math.Max(-evolvedCapabilityDayClamp, math.Min(evolvedCapabilityDayClamp, v))
	}
	for c, idx := range u.clsIdx {
		fit.classShift[c] += step * x[idx]
	}
	return aNow
}

// evolvedStateStepSave/restore keep the line search reversible.
type evolvedStateSave struct {
	a          float64
	trend      float64
	dayShift   map[string]float64
	classShift map[EffortSupport]float64
}

func evolvedStateSaveOf(fit *evolvedFit, a float64) evolvedStateSave {
	s := evolvedStateSave{a: a, trend: fit.state.trend, dayShift: make(map[string]float64, len(fit.state.dayShift)), classShift: make(map[EffortSupport]float64, len(fit.classShift))}
	for d, v := range fit.state.dayShift {
		s.dayShift[d] = v
	}
	for c, v := range fit.classShift {
		s.classShift[c] = v
	}
	return s
}

func (fit *evolvedFit) restore(s evolvedStateSave) {
	fit.state.trend = s.trend
	for d, v := range s.dayShift {
		fit.state.dayShift[d] = v
	}
	for c, v := range s.classShift {
		fit.classShift[c] = v
	}
}

// evolvedStateJointSolve iterates the exact conditional blocks of the state
// mode: the joint (a, trend, days, class shifts) linear-Gaussian system at
// IRLS weights against the per-group margin bisections, damped by a halving
// line search on the full profile objective. Every block is an exact
// conditional minimization of the SAME objective; the collinear directions
// are resolved inside the linear solve, so the iteration cannot stall the
// way an alternation of collinear scalar blocks does. Returns the a anchor.
// evolvedStateIRLSItersFor scales the IRLS round cap at production scale
// (deterministic, disclosed via the coarsened effect resolution).
func evolvedStateIRLSItersFor(fit *evolvedFit) int {
	if fit.state.weekly || len(fit.obs) > evolvedLargeObservationThreshold {
		return evolvedStateIRLSItersLarge
	}
	return evolvedStateIRLSIters
}

func evolvedStateJointSolve(fit *evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64, k, aNow float64, withPriors bool, probes *int) float64 {
	u := evolvedStateUnknownsOf(fit, true)
	iters := evolvedStateIRLSItersFor(fit)
	jAt := func(a float64) float64 {
		j, _ := evolvedProfile(fit, priors, histMean, histSD, k, a, withPriors)
		*probes++
		return j
	}
	for iter := 0; iter < iters; iter++ {
		x := evolvedStateSolveSystem(fit, priors, histMean, histSD, k, aNow, u)
		if x == nil {
			break
		}
		j0 := jAt(aNow)
		applied, cand := false, aNow
		step := 1.0
		for hs := 0; hs < evolvedStateLineHalvings; hs++ {
			save := evolvedStateSaveOf(fit, aNow)
			cand = evolvedStateApply(fit, u, x, aNow, step)
			if j1 := jAt(cand); j1 <= j0+1e-12 {
				applied = true
				break
			}
			fit.restore(save)
			step /= 2
		}
		for g := range fit.groups {
			fit.groups[g].delta = evolvedGroupDelta(fit, g, cand, k, withPriors)
		}
		*probes++
		if !applied {
			break
		}
		aNow = cand
		tiny := true
		for _, v := range x {
			if math.Abs(v*step) > 1e-6 {
				tiny = false
				break
			}
		}
		if tiny {
			break
		}
	}
	return aNow
}

// evolvedStateProfileJ evaluates the profile objective at a PINNED anchor
// with the state (trend, days, class shifts) and the margins re-minimized:
// the honest marginalization used by the sensitivity decomposition (the
// solve's own machinery, anchored).
func evolvedStateProfileJ(fit *evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64, k, aPin float64, withPriors bool, probes *int) float64 {
	u := evolvedStateUnknownsOf(fit, false)
	iters := evolvedStateIRLSItersFor(fit)
	jAt := func() float64 {
		j, _ := evolvedProfile(fit, priors, histMean, histSD, k, aPin, withPriors)
		*probes++
		return j
	}
	for iter := 0; iter < iters; iter++ {
		x := evolvedStateSolveSystem(fit, priors, histMean, histSD, k, aPin, u)
		if x == nil {
			break
		}
		j0 := jAt()
		applied := false
		step := 1.0
		for hs := 0; hs < 5; hs++ {
			save := evolvedStateSaveOf(fit, aPin)
			evolvedStateApply(fit, u, x, aPin, step)
			if jAt() <= j0+1e-12 {
				applied = true
				break
			}
			fit.restore(save)
			step /= 2
		}
		for g := range fit.groups {
			fit.groups[g].delta = evolvedGroupDelta(fit, g, aPin, k, withPriors)
		}
		*probes++
		if !applied {
			break
		}
	}
	return jAt()
}

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
// evolvedAttachCapabilityState admits the evidence for a state solve (all
// valid continuous windows - see evolvedAdmitObservationsMode), applies the
// state weight policy and attaches the state when the window can structure
// time. withClassHierarchy attaches the per-effort-class common margin
// s_c: it is the mechanism that keeps easy-only windows from forcing a
// capability downgrade by sheer count, but it is collinear with the shared
// capability anchor for EVERY common-mode signal - including the #997 HR
// bridge feedback - so it is attached ONLY for the speed-only resolve. The
// HR joint path attaches the state without it, preserving the proven #997
// soft-feedback channel.
func evolvedAttachCapabilityState(evidence []CandidateEvidence, asOf time.Time, priors EvolvedPriorSet, withClassHierarchy bool) (evolvedFit, bool) {
	fit := evolvedAdmitObservationsMode(evidence, asOf, priors, true)
	if !evolvedStateEligible(&fit) {
		return fit, false
	}
	evolvedStateReweight(&fit)
	fit.state = newEvolvedCapabilityState(&fit)
	if withClassHierarchy {
		fit.classShift = map[EffortSupport]float64{}
		for g := range fit.groups {
			if _, ok := fit.classShift[fit.groups[g].effort]; !ok {
				fit.classShift[fit.groups[g].effort] = 0
			}
		}
	}
	return fit, true
}

// evolvedSpeedStateResolve re-solves the speed objective with the capability
// state attached (local deterministic k refinement around the stationary
// MAP exponent, same machinery as the joint re-solve). Ineligible windows
// keep the stationary report; a numerical failure falls back to the
// stationary center with an explicit limitation - never a fabricated state.
func evolvedSpeedStateResolve(evidence []CandidateEvidence, asOf time.Time, priors EvolvedPriorSet, historical *HistoricalCapabilityPrior, stationary EvolvedSpeedReport) (EvolvedSpeedReport, *evolvedFit) {
	if stationary.CenterMps == nil {
		return stationary, nil
	}
	fit, ok := evolvedAttachCapabilityState(evidence, asOf, priors, true)
	if !ok {
		return stationary, nil
	}
	histMean, histSD := evolvedHistoricalPriorTerms(priors, historical)
	sol, ok := evolvedSolveJointK(&fit, priors, histMean, histSD, stationary.MapK)
	if !ok {
		stationary.Limitations = append(stationary.Limitations, evolvedStateSolveFallbackLimitation)
		return stationary, nil
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
		return stationary, nil
	}
	return out, &fit
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
		Method:          evolvedStateMethodFit,
		TrendPerDay:     sol.trend,
		TrendClamped:    math.Abs(sol.trend) >= evolvedCapabilityTrendClamp-1e-9,
		DistinctEffects: len(fit.state.days),
		WeightPolicy:    "flat_within_window_age_staleness_divided_out",
	}
	if fit.state.weekly {
		stamp.EffectResolution = "iso_week_beyond_60_distinct_days"
	} else {
		stamp.EffectResolution = "day"
	}
	if len(fit.state.days) > 0 {
		stamp.FirstEffect = fit.state.days[0]
		stamp.LastEffect = fit.state.days[len(fit.state.days)-1]
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
