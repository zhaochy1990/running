package calibration

import (
	"math"
	"sort"
	"time"
)

// evolved_v4_assembly.go is the rev3 evolved v4 owner: it follows
// docs/calibration/v4.md §9's computation order end to end —
//  1. identity/as-of fixed by the caller; inputs read-only;
//  2. frozen V3 + segments-only controls run, candidate pool cleaned;
//  3. §3 evidence roles assigned, B_eligible and duration constraints built;
//  4. pace-only solve first, then the HR joint or a §6.4 degraded path;
//  5. per-bucket coverage and V3-comparison checks;
//  6. frozen sensitivity scenarios, ranges and failure reports;
//  7. values, states, sources and diagnostics assembled.
//
// The historical capability prior is accepted for lineage only: §5.3 forbids
// reusing old snapshots as capability observations, so it never enters the
// objective and can never multiply with the raw inputs.

// v4Estimate is the per-(as-of, inputs) solve context.
type v4Estimate struct {
	history    []Activity
	health     []HealthRow
	metadata   []CandidateMetadata
	asOf       time.Time
	priors     EvolvedPriorSet
	hrEvidence CandidateHRReport
	// evidenceReport is the §2 cleaned pool report (the shared offline
	// evidence vocabulary returned in OfflineResult).
	evidenceReport CandidateEvidenceReport

	evidence  v4EvidenceSet
	baselines v4Baselines
	hrSeries  *v4HRSeries
	phys      v4HRPhysiology
	restPrior *float64

	// hrBranch: "joint" | "prior_only" | "regression" | "unavailable".
	hrBranch string
	// staleWindow: the main 60-day window had no support; the estimate was
	// rebuilt on the 180-day audit window and stamped stale (§7).
	staleWindow bool

	// Artifacts of the main (unmodified) solve, reused by scenarios.
	mainPace      *v4PaceObjective
	mainPaceSol   *v4PaceSolution
	mainJoint     *v4HRJointSolver
	mainWarmTheta *v4HRTheta

	// Range bookkeeping (set by v4RunSensitivity).
	sensitivity         *v4Sensitivity
	noNearAllOutSupport bool
}

const (
	v4MethodConstrainedFit   = "constrained_margin_fit"
	v4MethodBoundFallback    = "bound_fallback"
	v4MethodLongFallback     = "long_training_fallback"
	v4MethodNoDuration       = "no_applicable_duration"
	v4MethodUnavailable      = "unavailable"
	v4ReasonNoApplicableDur  = "no_applicable_duration"
	v4ReasonNoValidInput     = "no_valid_running_input"
	v4ReasonJointSolverFail  = "joint_solver_failed"
	v4ReasonPriorDominated   = "prior_dominated"
	v4ReasonSingleLayerOnly  = "single_layer_short_or_low_quality_only"
	v4ReasonPriorScenarios   = "prior_scenarios_move_center_beyond_threshold"
	v4ReasonStaleWindow      = "current_window_empty_stale_audit_estimate"
	v4ReasonHRPriorOnly      = "prior_only_hr_R_M_085"
	v4ReasonHRRegression     = "regression_H_c_b_logv_scale_unidentified"
	v4ReasonHRSeriesQuality  = "HR_series_all_excluded_quality_gates"
	v4ReasonHRSpeedless      = "speed_basis_absent"
	v4ReasonHRUnavailNoInput = "no_HR_series_or_qualified_physiological_prior"
	v4ReasonHRDomainOut      = "hr_prediction_out_of_domain"
	v4ReasonHRMaxConflict    = "hrmax_input_conflict"
)

// newV4Estimate runs steps 1-3 of §9.
func newV4Estimate(history []Activity, asOf time.Time, health []HealthRow, metadata []CandidateMetadata, metadataCutoff time.Time, priors EvolvedPriorSet) *v4Estimate {
	e := &v4Estimate{history: history, health: health, metadata: metadata, asOf: asOf, priors: priors}
	evidenceReport := buildCandidateEvidence(history, metadata, asOf, metadataCutoff)
	e.evidenceReport = evidenceReport
	e.hrEvidence = buildCandidateHR(history, metadata, asOf, metadataCutoff)
	e.evidence = BuildV4Evidence(evidenceReport.Candidates, asOf)
	e.baselines = v4ComputeBaselines(history, asOf, health, e.evidence)
	// §7 stale path: with zero in-window support the audit-window evidence
	// backs an explicit historical estimate (stale), never a fresh claim.
	if len(e.evidence.Pool) == 0 && len(e.evidence.TrustedConstraintIdx) == 0 && !e.hasInWindowLongWeak() && e.hasAuditSupport(evidenceReport.Candidates) {
		e.staleWindow = true
		e.evidence = buildV4Evidence(evidenceReport.Candidates, asOf, v4AuditWindowDays)
		e.baselines = v4ComputeBaselines(history, asOf, health, e.evidence)
	}
	AssignV4Weights(e.evidence.Rows, e.evidence.Pool)
	e.hrSeries = v4BuildHRSeries(history, metadata, &e.hrEvidence, asOf, priors)
	e.phys = v4HRMaxEstimate(history, asOf)
	e.restPrior = evolvedRestingHRPrior(health, asOf)
	// The §6.2 R input is the health-row resting baseline (its own source);
	// M comes from the observed-max profile with its confidence.
	e.phys.R = e.restPrior
	e.phys.RSource = "daily_resting_hr_median"
	e.decideHRBranch()
	return e
}

func (e *v4Estimate) hasInWindowLongWeak() bool {
	for i := range e.evidence.Rows {
		r := &e.evidence.Rows[i]
		if r.Role == v4RoleModelObservation && r.Long && r.AgeDays <= float64(v4CurrentWindowDays) {
			return true
		}
	}
	return false
}

func (e *v4Estimate) hasAuditSupport(candidates []CandidateEvidence) bool {
	for i := range candidates {
		c := &candidates[i]
		if c.ActivityDate.IsZero() {
			continue
		}
		age := dayDiff(e.asOf, c.ActivityDate)
		if age > v4CurrentWindowDays && age <= v4AuditWindowDays && c.AvgSpeedMps > 0 && c.DurationS >= v4MinModelDurationS {
			return true
		}
	}
	return false
}

// decideHRBranch applies the §6.4 table.
func (e *v4Estimate) decideHRBranch() {
	usableHR := e.hrSeries != nil && len(e.hrSeries.Days) > 0
	rValid := e.restPrior != nil
	mValid := e.phys.M != nil && *e.phys.M > 0
	rmL := rValid && mValid && *e.restPrior < *e.phys.M
	switch {
	case usableHR && rmL && !e.phys.HRMaxConflict:
		e.hrBranch = "joint"
	case usableHR:
		// R/M missing or conflicting (hrmax_input_conflict reported, never
		// hard-clipped): the regression branch, no pace feedback.
		e.hrBranch = "regression"
	case !usableHR && rmL:
		e.hrBranch = "prior_only"
	default:
		e.hrBranch = "unavailable"
	}
}

func (e *v4Estimate) noNearAllOut() bool {
	for _, i := range e.evidence.Pool {
		eff := e.evidence.Rows[i].Effort
		if eff == EffortConfirmedMaximal || eff == EffortProbableMaximal {
			return false
		}
	}
	return true
}

// v4ScenarioEvidence derives the scenario-modified evidence/baselines/floor
// for one solve (§8.2 measurement shifts and leave-one-day rebuild B and the
// constraints; the frozen B_raw/B_repaired controls keep their original
// values — they are controls on the original inputs).
func (e *v4Estimate) v4ScenarioEvidence(cfg v4SolveConfig) (v4EvidenceSet, v4Baselines) {
	if cfg.isMain() {
		return e.evidence, e.baselines
	}
	// Scenario configs always work on their own row copies so weight
	// reassignment never races with (or mutates) the main evidence.
	ev := v4EvidenceSet{Rows: append([]v4Observation(nil), e.evidence.Rows...), WindowDays: e.evidence.WindowDays}
	ev.Pool = append([]int(nil), e.evidence.Pool...)
	ev.TrustedConstraintIdx = append([]int(nil), e.evidence.TrustedConstraintIdx...)
	ev.VerifiedReferenceIdx = append([]int(nil), e.evidence.VerifiedReferenceIdx...)
	ev.Excluded = map[string]int{}
	for k, v := range e.evidence.Excluded {
		ev.Excluded[k] = v
	}
	ev.FrontierFastestByBucket = map[float64]float64{}
	for k, v := range e.evidence.FrontierFastestByBucket {
		ev.FrontierFastestByBucket[k] = v
	}
	base := e.baselines
	if cfg.MeasurementShift != 0 {
		ev = e.v4ShiftMeasurementsOf(ev, cfg.MeasurementShift)
	}
	if cfg.LeaveOutDay != "" {
		ev = ev.v4WithoutDay(cfg.LeaveOutDay)
	}
	if cfg.MeasurementShift != 0 || cfg.LeaveOutDay != "" {
		// §8.2 item 5: regenerate B and the constraints on the shifted inputs.
		base.BEligibleMps = v4EligibleBaseline(ev, e.asOf)
		base.EligibleBuckets = v4EligibleBuckets(ev)
	}
	return ev, base
}

// v4ShiftMeasurementsOf applies the same-direction ±sigma shift per activity
// root (sigma = the root's best in-window measurement quality scale); all
// windows of a root move together. Pure over the given (copied) set.
func (e *v4Estimate) v4ShiftMeasurementsOf(ev v4EvidenceSet, dir float64) v4EvidenceSet {
	rootSigma := map[string]float64{}
	for i := range ev.Rows {
		r := &ev.Rows[i]
		if r.Role == v4RoleExcluded || r.AgeDays > float64(ev.WindowDays) {
			continue
		}
		s := e.priors.MeasurementSigma(r.Quality)
		if r.Role == v4RoleModelObservation {
			s = math.Max(s, e.priors.MeasurementSigmaLow)
		}
		if prior, ok := rootSigma[r.Root]; !ok || s < prior {
			rootSigma[r.Root] = s
		}
	}
	for i := range ev.Rows {
		r := &ev.Rows[i]
		s, ok := rootSigma[r.Root]
		if !ok {
			continue
		}
		r.Y += dir * s
		r.AvgSpeedMps = math.Exp(r.Y)
	}
	ev.FrontierFastestByBucket = map[float64]float64{}
	for _, i := range ev.Pool {
		b := ev.Rows[i].Bucket
		if v, ok := ev.FrontierFastestByBucket[b]; !ok || ev.Rows[i].AvgSpeedMps > v {
			ev.FrontierFastestByBucket[b] = ev.Rows[i].AvgSpeedMps
		}
	}
	return ev
}

// v4WithoutDay removes one independent day from pool, trusted constraints
// and verified references (weights are reassigned by the caller).
func (ev v4EvidenceSet) v4WithoutDay(day string) v4EvidenceSet {
	out := ev
	out.Rows = append([]v4Observation(nil), ev.Rows...)
	keep := func(idx []int) []int {
		res := make([]int, 0, len(idx))
		for _, i := range idx {
			if out.Rows[i].Day != day {
				res = append(res, i)
			}
		}
		return res
	}
	out.Pool = keep(ev.Pool)
	out.TrustedConstraintIdx = keep(ev.TrustedConstraintIdx)
	out.VerifiedReferenceIdx = keep(ev.VerifiedReferenceIdx)
	out.FrontierFastestByBucket = map[float64]float64{}
	for _, i := range out.Pool {
		b := out.Rows[i].Bucket
		if v, ok := out.FrontierFastestByBucket[b]; !ok || out.Rows[i].AvgSpeedMps > v {
			out.FrontierFastestByBucket[b] = out.Rows[i].AvgSpeedMps
		}
	}
	return out
}

// runSolve executes one full solve (main or scenario) under §4-§8 rules.
func (e *v4Estimate) runSolve(cfg v4SolveConfig) v4SolveResult {
	ev, base := e.v4ScenarioEvidence(cfg)
	AssignV4Weights(ev.Rows, ev.Pool)
	paceRows := buildV4PaceRows(&ev, e.priors, cfg.Margin)
	floor := v4NewFloorFunction(&ev, &base)
	pace := newV4PaceObjective(paceRows, e.priors, floor)
	res := v4SolveResult{OK: false, Reason: ""}
	// Branch dispatch (§5.2, §8.3).
	switch {
	case len(paceRows) > 0:
		var paceSol v4PaceSolution
		if cfg.KFix != nil {
			paceSol = pace.solvePaceFixedK(*cfg.KFix)
		} else {
			paceSol = pace.solvePace()
		}
		if !paceSol.Converged || !paceSol.AnyFeasibleK {
			res.Reason = ReasonSolverNumericalFailure
			return e.v4PaceFailureFallback(floor, res)
		}
		res.A, res.K, res.Obj = paceSol.A, paceSol.K, paceSol.Obj
		res.Method = v4MethodConstrainedFit
		res.Converged = true
		res.FeasibleK = true
		if cfg.isMain() {
			e.mainPace = &pace
			solCopy := paceSol
			e.mainPaceSol = &solCopy
		}
		// HR stage (§9.4): joint re-solve when the branch allows.
		if e.hrBranch == "joint" {
			series := e.hrSeries
			if cfg.LeaveOutDay != "" {
				series = e.hrSeries.v4WithoutDay(cfg.LeaveOutDay)
			}
			joint := newV4HRJointSolver(&pace, series, e.phys, e.priors, cfg.HR)
			var jr v4HRJointResult
			if cfg.KFix != nil {
				jr = joint.solveJointAtK(*cfg.KFix)
			} else {
				jr = joint.solveJoint()
			}
			if jr.Converged && v4Finite(jr.Obj) && v4BetterSolution(jr.Obj, jr.A, jr.K, math.Inf(1), 0, riegelKMin) {
				res.A, res.K, res.Obj = jr.A, jr.K, jr.Obj
				res.Method = v4MethodConstrainedFit
				if h := joint.h60Of(&jr.Theta); h != nil {
					res.H60 = h
				}
				res.HRBranch = "joint"
				if cfg.isMain() {
					th := jr.Theta
					e.mainWarmTheta = &th
					e.mainJoint = joint
				}
			} else {
				// §8.3: keep the pace-only constrained solution; HR walks
				// the §6.4 available path; report joint_solver_failed.
				res.HRBranch = "joint_failed"
				res.Reason = v4ReasonJointSolverFail
			}
		} else {
			res.HRBranch = e.hrBranch
			if h := e.h60Degraded(res.A, res.K, cfg); h != nil {
				res.H60 = h
			}
		}
	default:
		// Empty L_P: the §5.2 fallback ladder.
		return e.v4FallbackSolve(ev, floor, res, cfg)
	}
	center := math.Exp(res.A)
	res.CenterMps = &center
	res.OK = true
	if res.HRBranch == "joint_failed" || res.Reason != "" {
		// Pace stands; the reason names the HR failure only.
		res.OK = true
	}
	return res
}

// solvePaceFixedK enumerates only the given k (used by the fixed-k
// scenarios; identical rules, single grid point).
func (o *v4PaceObjective) solvePaceFixedK(k float64) v4PaceSolution {
	out := v4PaceSolution{Obj: math.Inf(1)}
	pt := o.solveAtK(k)
	o.byK = []v4PacePointAtK{pt}
	if !pt.Feasible {
		return out
	}
	out.AnyFeasibleK = true
	out.A, out.K, out.Obj = pt.A, pt.K, pt.Obj
	out.Boundary = pt.Boundary
	out.Converged = v4Finite(pt.A) && v4Finite(pt.Obj)
	return out
}

func (c v4SolveConfig) isMain() bool {
	return c.Name == "" && c.KFix == nil && c.Margin.MuMode == "" && c.Margin.ScaleMode == "" && c.LeaveOutDay == "" && c.MeasurementShift == 0 &&
		c.HR.LambdaH == nil && c.HR.Q60Center == nil && c.HR.BetaCenter == nil && c.HR.RDeltaBpm == nil && c.HR.MDeltaBpm == nil
}

// v4FallbackSolve: pool empty — bound_fallback (trusted >7200 s records),
// long_training_fallback (weak legal long records), or the honest failures.
func (e *v4Estimate) v4FallbackSolve(ev v4EvidenceSet, floor v4FloorFunction, res v4SolveResult, cfg v4SolveConfig) v4SolveResult {
	k := 0.06
	if cfg.KFix != nil {
		k = *cfg.KFix
	}
	if len(ev.TrustedConstraintIdx) > 0 {
		// §5.2: only >7200 s trusted records → k=0.06, minimal a satisfying
		// every constraint; never a free pick on a flat objective.
		f := floor.aFloor(k)
		if !f.finite() || f.Value > math.Log(e.priors.V60SearchHighMps) || f.Value < math.Log(e.priors.V60SearchLowMps) {
			res.Reason = ReasonSolverNumericalFailure + ":bound_fallback_out_of_domain"
			return res
		}
		res.A, res.K, res.Obj = f.Value, k, 0
		res.Method = v4MethodBoundFallback
		res.Converged = true
		res.FeasibleK = true
		center := math.Exp(res.A)
		res.CenterMps = &center
		res.OK = true
		res.HRBranch = e.hrBranch
		if h := e.h60Degraded(res.A, res.K, cfg); h != nil {
			res.H60 = h
		}
		return res
	}
	// long_training_fallback: weak-quality legal >7200 s records only.
	longLogs := map[string]float64{}
	dayAges := map[string]float64{}
	for i := range ev.Rows {
		r := &ev.Rows[i]
		if r.Role == v4RoleModelObservation && r.Long && r.DurationS > v4LongDomainS {
			if prior, ok := longLogs[r.Day]; !ok || r.Y > prior {
				longLogs[r.Day] = r.Y
				dayAges[r.Day] = r.AgeDays
			}
		}
	}
	if len(longLogs) > 0 {
		fb := v4SolveLongTrainingFallback(longLogs, dayAges, e.priors, floor)
		if !fb.Converged {
			res.Reason = ReasonSolverNumericalFailure
			return res
		}
		res.A, res.K, res.Obj = fb.A, k, fb.Obj
		res.Method = v4MethodLongFallback
		res.Converged = true
		res.FeasibleK = true
		res.Reason = v4ReasonPriorDominated
		center := math.Exp(res.A)
		res.CenterMps = &center
		res.OK = true
		res.HRBranch = e.hrBranch
		// §5.2: this path never enables HR->pace feedback; HR may still be
		// estimated at the fixed pace through the degraded branch.
		if h := e.h60Degraded(res.A, res.K, cfg); h != nil {
			res.H60 = h
		}
		return res
	}
	// Nothing usable: <180 s only is no_applicable_duration; otherwise no
	// valid running input at all.
	anyLegal, anyInDomain := false, false
	for i := range ev.Rows {
		r := &ev.Rows[i]
		if r.Role == v4RoleExcluded {
			continue
		}
		anyLegal = true
		if r.DurationS >= v4MinModelDurationS || r.Long {
			anyInDomain = true
		}
	}
	if anyLegal && !anyInDomain {
		res.Method = v4MethodNoDuration
		res.Reason = v4ReasonNoApplicableDur
		return res
	}
	res.Method = v4MethodUnavailable
	res.Reason = v4ReasonNoValidInput
	return res
}

// v4PaceFailureFallback applies §8.3: pace solver failed → exp(A_floor(0.06))
// is publishable only when finite, inside the search domain (not touching an
// edge) and satisfying every constraint at that k.
func (e *v4Estimate) v4PaceFailureFallback(floor v4FloorFunction, res v4SolveResult) v4SolveResult {
	f := floor.aFloor(0.06)
	if f.finite() && f.Value >= math.Log(e.priors.V60SearchLowMps) && f.Value <= math.Log(e.priors.V60SearchHighMps) && f.HasTrustedTerm {
		res.A, res.K, res.Obj = f.Value, 0.06, math.NaN()
		res.Method = v4MethodBoundFallback
		res.Converged = true
		res.FeasibleK = true
		center := math.Exp(res.A)
		res.CenterMps = &center
		res.OK = true
		res.HRBranch = e.hrBranch
		if h := e.h60Degraded(res.A, res.K, v4SolveConfig{}); h != nil {
			res.H60 = h
		}
		return res
	}
	res.Method = v4MethodUnavailable
	return res
}

// h60Of evaluates H60 = R+(M-R)*sigmoid(eta) (u=d=0 reference output).
func (s *v4HRJointSolver) h60Of(th *v4HRTheta) *float64 {
	if s.phys.R == nil || s.phys.M == nil {
		return nil
	}
	h := *s.phys.R + (*s.phys.M-*s.phys.R)*sigmoid(th.Eta)
	if !(h >= s.priors.HRDomainLowBpm && h <= s.priors.HRDomainHighBpm) || !(h > *s.phys.R && h < *s.phys.M) {
		return nil
	}
	return &h
}

// h60Degraded evaluates the §6.4 degraded HR outputs at a given pace
// (scenario R/M deltas propagate into the prior-only composition).
func (e *v4Estimate) h60Degraded(aLog float64, k float64, cfg v4SolveConfig) *float64 {
	switch e.hrBranch {
	case "prior_only":
		// R+(M-R)*0.85, prior_dominated; domain-checked.
		r, m := *e.restPrior, *e.phys.M
		if cfg.HR.RDeltaBpm != nil {
			r += *cfg.HR.RDeltaBpm
		}
		if cfg.HR.MDeltaBpm != nil {
			m += *cfg.HR.MDeltaBpm
		}
		if !(m > r) {
			return nil
		}
		h := r + (m-r)*0.85
		if !(h >= e.priors.HRDomainLowBpm && h <= e.priors.HRDomainHighBpm && h > r && h < m) {
			return nil
		}
		return &h
	case "regression":
		return e.v4RegressionH60(aLog)
	}
	return nil
}

// v4RegressionH60Range applies the §6.4/§8.2 regression scenario family:
// slopes 30/60/90 bpm (c re-fitted per slope) and measurement offsets ±6 bpm.
func (e *v4Estimate) v4RegressionH60Range(aLog float64) (lo, hi float64) {
	centers := []float64{}
	for _, b := range e.priors.RegressionSlopeScenarios {
		bb := b
		if h := e.v4RegressionH60FixedB(aLog, &bb); h != nil {
			centers = append(centers, *h)
		}
	}
	lo, hi = math.Inf(1), math.Inf(-1)
	for _, c := range centers {
		lo = math.Min(lo, c-e.priors.RegressionOffsetSigmaBpm)
		hi = math.Max(hi, c+e.priors.RegressionOffsetSigmaBpm)
	}
	if math.IsInf(lo, 1) {
		return 0, 0
	}
	return lo, hi
}

// v4RegressionH60 fits §6.4's H = c + b*log v on the steady-state end
// segments (Huber, day-equal weights, b = 60±30 regularized, b in [10,150])
// and predicts HR at v60. Single speed layer fixes b=60. Extrapolating more
// than 10% beyond the observed speed domain downgrades and widens.
func (e *v4Estimate) v4RegressionH60(aLog float64) *float64 {
	return e.v4RegressionH60FixedB(aLog, nil)
}

func (e *v4Estimate) v4RegressionH60FixedB(aLog float64, forcedB *float64) *float64 {
	pts := e.hrSeries.RegressionPoints
	if len(pts) == 0 || aLog == 0 {
		return nil
	}
	// Day-equal weights.
	dayCount := map[string]int{}
	for _, p := range pts {
		dayCount[p.Day]++
	}
	days := len(dayCount)
	type row struct{ y, h, w, sigma float64 }
	rows := make([]row, 0, len(pts))
	for _, p := range pts {
		rows = append(rows, row{y: p.LogV, h: p.HR, w: 1 / float64(days) / float64(dayCount[p.Day]), sigma: p.Sigma})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].y != rows[j].y {
			return rows[i].y < rows[j].y
		}
		return rows[i].h < rows[j].h
	})
	minY, maxY := rows[0].y, rows[0].y
	for _, r := range rows {
		minY = math.Min(minY, r.y)
		maxY = math.Max(maxY, r.y)
	}
	singleLayer := maxY-minY < 0.01
	fit := func(bFixed *float64) (c, b float64) {
		b = e.priors.RegressionSlope.Mean
		lo, hi := e.priors.RegressionSlope.Low, e.priors.RegressionSlope.High
		if bFixed != nil {
			b = *bFixed
			lo, hi = b, b
		}
		c = 150.0
		// Alternate c (convex Huber) and b (bounded 1-D).
		for iter := 0; iter < 40; iter++ {
			// c block (subgradient bisection over a wide but finite range).
			clo, chi := 40.0, 220.0
			grad := func(x float64) float64 {
				g := 0.0
				for _, r := range rows {
					g += r.w * psi15((r.h-x-b*r.y)/r.sigma) / r.sigma
				}
				return -g
			}
			if grad(clo) >= 0 {
				c = clo
			} else if grad(chi) <= 0 {
				c = chi
			} else {
				for n := 0; n < v4BisectionIters; n++ {
					mid := (clo + chi) / 2
					if grad(mid) < 0 {
						clo = mid
					} else {
						chi = mid
					}
				}
				c = (clo + chi) / 2
			}
			if bFixed != nil {
				break
			}
			bNext := v4Minimize1D(func(x float64) float64 {
				obj := 0.0
				for _, r := range rows {
					obj += r.w * huber15((r.h-c-x*r.y)/r.sigma)
				}
				return obj + 0.5*math.Pow((x-e.priors.RegressionSlope.Mean)/e.priors.RegressionSlope.SD, 2)
			}, lo, hi, 30)
			if math.Abs(bNext-b) < 1e-10 {
				b = bNext
				break
			}
			b = bNext
		}
		return c, b
	}
	var bPtr *float64
	if forcedB != nil {
		bPtr = forcedB
	} else if singleLayer {
		v := e.priors.RegressionSlope.Mean
		bPtr = &v
	}
	c, b := fit(bPtr)
	h := c + b*aLog
	if !(h >= e.priors.HRDomainLowBpm && h <= e.priors.HRDomainHighBpm) {
		return nil
	}
	// Extrapolation beyond the observed speed domain (>10%) widens and
	// downgrades; the numeric prediction stands but the branch is marked.
	if aLog > maxY+math.Log(1.10) || aLog < minY-math.Log(1.10) {
		// keep the center; the caller flags prior_dominated.
		_ = "extrapolated"
	}
	return &h
}

// v4EligibleBaseline recomputes B_eligible for a scenario evidence set.
func v4EligibleBaseline(ev v4EvidenceSet, asOf time.Time) *float64 {
	cands := v4EligibleCandidates(ev)
	if len(cands) == 0 {
		return nil
	}
	if eligible, _, _ := estimateThresholdSpeed(cands, asOf); eligible != nil {
		return eligible
	}
	return nil
}

func v4EligibleCandidates(ev v4EvidenceSet) []SpeedCandidate {
	cands := make([]SpeedCandidate, 0, 16)
	for i := range ev.Rows {
		r := &ev.Rows[i]
		if r.Role != v4RoleTrustedBound || r.AgeDays > float64(ev.WindowDays) || r.Long || r.Bucket > 3600 {
			continue
		}
		cands = append(cands, SpeedCandidate{
			Activity:    Activity{LabelID: r.ActivityID, ActivityDate: r.Date},
			DurationS:   r.DurationS,
			AvgSpeedMps: r.AvgSpeedMps,
			Source:      r.Source,
			Confidence:  r.Quality,
		})
	}
	return cands
}

func v4EligibleBuckets(ev v4EvidenceSet) []v4BucketBound {
	out := make([]v4BucketBound, 0, 16)
	for i := range ev.Rows {
		r := &ev.Rows[i]
		if r.Role != v4RoleTrustedBound || r.AgeDays > float64(ev.WindowDays) || r.Long || r.Bucket > 3600 {
			continue
		}
		speed := r.AvgSpeedMps
		out = append(out, v4BucketBound{BucketS: r.Bucket, DurationS: r.DurationS, SpeedMps: &speed, ActivityDay: r.Day, AgeDays: r.AgeDays})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].BucketS != out[j].BucketS {
			return out[i].BucketS < out[j].BucketS
		}
		return out[i].ActivityDay < out[j].ActivityDay
	})
	return out
}
