package calibration

import (
	"math"
	"sort"
	"time"
)

// evolved_speed.go implements the #996 speed-domain estimator of the evolved
// v4: the latent effort-margin model frozen in estimation-contract-v2 section
// 2.1. log v_i = a - k*log(t_i/3600) - delta_i + eps_i with delta_i >= 0,
// fitted by a deterministic robust MAP (Huber likelihood, truncated quadratic
// priors from contract_priors.go). Near-maximal evidence only tightens the
// delta prior of its effort class; it is never an on/off switch for the
// center. Ordinary training without any all-out label therefore still
// produces a finite center plus a sensitivity range. Windows of one activity
// root and effort class share one effort margin (the delta_root of the
// contract); their weights share a root/day contribution budget. See
// docs/calibration/evolved-speed-rev2.md.

const (
	evolvedSpeedMethodFit       = "robust_map_effort_margin_fit"
	evolvedSpeedMethodPriorOnly = "aged_prior_only"
	evolvedSpeedMethodNone      = "unavailable"
)

const (
	evolvedBisectionIters       = 60
	evolvedKCoarseSteps         = 80 // step 0.001 over the frozen [0.02, 0.10]
	evolvedKFineSteps           = 40 // step ~0.00005 around the coarse best
	evolvedLongDomainExtraSigma = 0.15
	evolvedProfileStepLogA      = 0.01
	evolvedPriorShareDominant   = 0.5
	evolvedPriorShareReason     = "prior_share_at_least_half_effective_curvature"
	// Large-input guard (review P2-4): the solver cost is O(k grid x a
	// bisection x group solves), which reaches seconds at production scale
	// (~250 roots per 180-day window). Above the observation threshold the k
	// grid is coarsened deterministically and the report says so; the exact
	// block solves and all comparisons stay untouched.
	evolvedLargeObservationThreshold = 400
	evolvedKCoarseStepsLarge         = 40 // step 0.002
	evolvedKFineStepsLarge           = 20 // step ~0.0002
	evolvedKGridCoarsenedLimitation  = "k_grid_coarsened_large_input"
)

// EvolvedSpeedObservation is one auditable row of the fit: admitted role,
// budgeted weight, actual contribution share, prior class, fitted effort
// margin and standardized residual.
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
	Delta              *float64      `json:"delta,omitempty"`
	Residual           *float64      `json:"residual,omitempty"`
}

// EvolvedSpeedReport is the speed-domain output of the evolved v4: center,
// sensitivity range (never a probability interval), prior identity and
// recomputable dominance basis, per-observation contributions and solver
// diagnostics. Numerical failure is reported as failure, never disguised as
// insufficient evidence.
type EvolvedSpeedReport struct {
	ParameterVersion    string          `json:"parameter_version"`
	Method              string          `json:"method"`
	State               EstimationState `json:"state"`
	CenterMps           *float64        `json:"center_mps,omitempty"`
	RangeLowMps         *float64        `json:"range_low_mps,omitempty"`
	RangeHighMps        *float64        `json:"range_high_mps,omitempty"`
	RangeMeaning        string          `json:"range_meaning"`
	PaceCenterSPerKm    *float64        `json:"pace_center_s_per_km,omitempty"`
	PaceRangeLowSPerKm  *float64        `json:"pace_range_low_s_per_km,omitempty"`
	PaceRangeHighSPerKm *float64        `json:"pace_range_high_s_per_km,omitempty"`
	// MapK is the MAP endurance exponent used; RiegelK is published only when
	// the admitted durations identify k under the contract criteria.
	MapK    float64  `json:"map_k"`
	RiegelK *float64 `json:"riegel_k,omitempty"`
	// Sensitivity diagnostics: profile posterior sd of log v60 and the
	// recomputable dominance basis. EffectiveCurvature caps how much
	// precision repeated effort-margin priors may contribute (a runner's
	// class margin is one research fact, not one per window), so repeated
	// easy runs cannot manufacture certainty.
	PosteriorSDLogV60   float64 `json:"posterior_sd_log_v60"`
	PriorCurvature      float64 `json:"prior_curvature"`
	DataCurvature       float64 `json:"data_curvature"`
	EffectiveCurvature  float64 `json:"effective_curvature"`
	PriorCurvatureShare float64 `json:"prior_curvature_share"`
	// Prior identity: the contract prior-set hash plus the aged historical
	// prior composition actually applied (a weak prior, never a speed cap).
	PriorsIdentityHash     string   `json:"priors_identity_hash"`
	HistoricalPriorMeanLog *float64 `json:"historical_prior_mean_log_v60,omitempty"`
	HistoricalPriorSDLog   *float64 `json:"historical_prior_sd_log_v60,omitempty"`
	HistoricalPriorAgeDays float64  `json:"historical_prior_age_days,omitempty"`
	// InputIdentityHash hashes the admitted observation tuples so the
	// dominance basis is recomputable from the same inputs.
	InputIdentityHash string `json:"input_identity_hash"`
	// Actual contributions and support structure.
	IndependentRoots int     `json:"independent_roots"`
	IndependentDays  int     `json:"independent_days"`
	MinDurationS     float64 `json:"min_duration_s,omitempty"`
	MaxDurationS     float64 `json:"max_duration_s,omitempty"`
	MaximalAnchors   int     `json:"maximal_anchors"`
	// Solver diagnostics. The profile bisection is exact for the convex
	// objective; SolverRounds counts profile probes for audit.
	SolverRounds          int                       `json:"solver_rounds"`
	SolverConverged       bool                      `json:"solver_converged"`
	SolverObjective       float64                   `json:"solver_objective"`
	SolverKGridResolution float64                   `json:"solver_k_grid_resolution"`
	Observations          []EvolvedSpeedObservation `json:"observations"`
	Reasons               []string                  `json:"reasons"`
	Limitations           []string                  `json:"limitations"`
}

// FitEvolvedSpeed is the pure offline speed-domain seam of the evolved v4.
// It consumes admitted evidence (selection, cleaning and pause handling are
// upstream in buildCandidateEvidence; continuous windows keep their real time
// denominators) and the frozen contract priors. The historical snapshot prior
// enters the objective exactly once, aged with a variance floor, and is never
// a speed cap; it is never multiplied with the same raw inputs as a second
// independent evidence vote.
func FitEvolvedSpeed(evidence []CandidateEvidence, asOf time.Time, priors EvolvedPriorSet, historical *HistoricalCapabilityPrior) EvolvedSpeedReport {
	out := EvolvedSpeedReport{
		ParameterVersion:      EvolvedPriorSetVersion,
		Method:                evolvedSpeedMethodNone,
		State:                 StateUnavailable,
		RangeMeaning:          contractRangeSemantics,
		PriorsIdentityHash:    priors.IdentityHash(),
		SolverKGridResolution: (riegelKMax - riegelKMin) / evolvedKCoarseSteps / (evolvedKFineSteps/2 + 1),
		Reasons:               []string{},
		Limitations:           evolvedSpeedLimitations(),
	}
	if err := priors.Validate(); err != nil {
		out.Reasons = append(out.Reasons, ReasonSolverNumericalFailure)
		out.Limitations = append(out.Limitations, "prior_set_invalid")
		return out
	}
	// Adjudication is the contract-owned state machine; the fitter supplies
	// numbers and diagnostics, never its own state ordering.
	in := DeriveAdjudicationInput(evidence, nil, asOf, historical, false)
	decision := AdjudicateEstimationContract(in)
	out.Reasons = append(out.Reasons, decision.Speed.Reasons...)
	out.MaximalAnchors = in.MaximalAnchorCount
	if decision.Speed.State == StateUnavailable {
		return out
	}

	fit := evolvedAdmitObservations(evidence, asOf, priors)
	out.Observations = fit.rows
	out.InputIdentityHash = ReplayContentHash(evolvedInputDigests(fit.obs))
	out.IndependentRoots, out.IndependentDays = evolvedSupportStructure(fit.obs)
	for _, p := range fit.obs {
		if p.constraint {
			continue
		}
		if out.MinDurationS == 0 || p.duration < out.MinDurationS {
			out.MinDurationS = p.duration
		}
		if p.duration > out.MaxDurationS {
			out.MaxDurationS = p.duration
		}
	}
	histMean, histSD := evolvedHistoricalPriorTerms(priors, historical)
	if historical != nil && historical.valid() {
		out.HistoricalPriorAgeDays = historical.AgeDays
		out.HistoricalPriorMeanLog, out.HistoricalPriorSDLog = histMean, histSD
	}

	if len(fit.obs) == 0 {
		if histMean == nil {
			// Adjudication already excluded no-input-no-prior, so this is a
			// hard failure rather than an invented number.
			out.Reasons = append(out.Reasons, ReasonSolverNumericalFailure)
			return out
		}
		// Aged prior only: center = prior combination, range = prior spread
		// (contract section 6); finite, never a locked v3 value.
		out.Method = evolvedSpeedMethodPriorOnly
		out.State = decision.Speed.State
		out.MapK = priors.EnduranceK.Mean
		out.SolverConverged = true
		a := priors.LogV60.Mean
		curv := 1 / (priors.LogV60.SD * priors.LogV60.SD)
		if histMean != nil {
			wPop, wHist := 1/(priors.LogV60.SD*priors.LogV60.SD), 1/(*histSD**histSD)
			a = (priors.LogV60.Mean*wPop + *histMean*wHist) / (wPop + wHist)
			curv = wPop + wHist
		}
		evolvedStampCenter(&out, priors, a, a, a, math.Sqrt(1/curv))
		out.PriorCurvature, out.DataCurvature, out.EffectiveCurvature, out.PriorCurvatureShare = curv, 0, curv, 1
		return out
	}

	sol, ok := evolvedSolveMAP(fit, priors, histMean, histSD)
	if !ok {
		out.Reasons = append(out.Reasons, ReasonSolverNumericalFailure)
		return out
	}
	out.Method = evolvedSpeedMethodFit
	out.State = decision.Speed.State
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
	evolvedStampSolved(fit, sol)
	// RiegelK is published only when duration diversity actually identifies
	// the exponent (same criteria as the contract's model_estimated rule).
	if out.IndependentRoots >= ContractSpeedModelMinRoots && out.IndependentDays >= ContractSpeedModelMinDays &&
		out.MinDurationS > 0 && out.MaxDurationS/out.MinDurationS >= ContractSpeedDurationRatioMin {
		k := sol.k
		out.RiegelK = &k
	}
	// Sensitivity: second differences of the full profile J*(a) (priors plus
	// data, margins re-optimized) and of the data-only profile D(a). The gap
	// between conditioning and marginalizing the effort margins is exactly
	// what keeps all-easy windows honestly wide.
	curvTotal, curvData, okCurv := evolvedCurvatures(fit, priors, histMean, histSD, sol)
	if !okCurv {
		out.Reasons = append(out.Reasons, ReasonSolverNumericalFailure)
		return out
	}
	priorCurv := 1 / (priors.LogV60.SD * priors.LogV60.SD)
	if histMean != nil {
		priorCurv += 1 / (*histSD * *histSD)
	}
	// Class-correlated prior ceiling: at most one margin prior's precision
	// per effort class present, so repeated windows of one class cannot
	// multiply the prior into certainty. No new numbers: the class prior SDs
	// are contract values.
	classCurv, seenClass := 0.0, map[EffortSupport]bool{}
	for _, g := range fit.groups {
		if !seenClass[g.effort] {
			seenClass[g.effort] = true
			classCurv += 1 / (g.prior.SD * g.prior.SD)
		}
	}
	curvEff := math.Min(curvTotal, curvData+priorCurv+classCurv)
	if !(curvEff > 0) {
		out.Reasons = append(out.Reasons, ReasonSolverNumericalFailure)
		return out
	}
	share := 1 - curvData/curvEff
	if share < 0 {
		share = 0
	}
	if share > 1 {
		share = 1
	}
	out.PriorCurvature, out.DataCurvature, out.EffectiveCurvature, out.PriorCurvatureShare = priorCurv, curvData, curvEff, share
	// k sensitivity envelope: exact re-solve at both frozen k edges.
	loEdge, hiEdge, okEdges := evolvedKEnvelope(fit, priors, histMean, histSD)
	if !okEdges {
		out.Reasons = append(out.Reasons, ReasonSolverNumericalFailure)
		return out
	}
	sd := math.Sqrt(1 / curvEff)
	envLo := math.Min(sol.a, math.Min(loEdge, hiEdge))
	envHi := math.Max(sol.a, math.Max(loEdge, hiEdge))
	evolvedStampCenter(&out, priors, sol.a, envLo, envHi, sd)
	if share >= evolvedPriorShareDominant {
		// Recomputable dominance annotation: priors carry at least half the
		// effective curvature, so identification is prior-limited even when
		// the adjudication state is model_estimated.
		out.Reasons = append(out.Reasons, evolvedPriorShareReason)
	}
	if !sol.converged {
		out.Limitations = append(out.Limitations, "solver_iteration_cap_reached")
	}
	return out
}

func evolvedSpeedLimitations() []string {
	return []string{
		"research_uncalibrated_not_population_calibrated",
		"range_is_sensitivity_not_probability_interval",
		"environment_temperature_not_corrected",
		"terrain_gradient_not_corrected",
		"power_law_valid_only_180_to_7200s",
		"long_duration_uses_monotone_soft_constraint",
	}
}

type evolvedObsPoint struct {
	y, x, sigma, w float64
	root, day      string
	duration       float64
	group          int  // index into evolvedFit.groups; -1 for constraints
	constraint     bool // t > 7200: monotone soft constraint only, no margin
	effort         EffortSupport
	quality        Confidence
	index          int
}

type evolvedGroup struct {
	root, day string
	effort    EffortSupport
	prior     PriorNormal
	delta     float64
	obsIdx    []int
}

type evolvedFit struct {
	obs    []evolvedObsPoint
	groups []evolvedGroup
	rows   []EvolvedSpeedObservation
}

type evolvedInputDigest struct {
	Root        string  `json:"root"`
	Day         string  `json:"day"`
	DurationS   float64 `json:"duration_s"`
	AvgSpeedMps float64 `json:"avg_speed_mps"`
	Weight      float64 `json:"weight"`
	SigmaLog    float64 `json:"sigma_log"`
	Effort      string  `json:"effort"`
	Constraint  bool    `json:"constraint"`
}

func evolvedInputDigests(obs []evolvedObsPoint) []evolvedInputDigest {
	out := make([]evolvedInputDigest, 0, len(obs))
	for i := range obs {
		p := &obs[i]
		out = append(out, evolvedInputDigest{Root: p.root, Day: p.day, DurationS: p.duration, AvgSpeedMps: math.Exp(p.y), Weight: p.w, SigmaLog: p.sigma, Effort: string(p.effort), Constraint: p.constraint})
	}
	return out
}

// evolvedAdmitObservations mirrors the v1 admission rules (selection, root
// consistency, continuity, model domain, plausibility, quality), groups
// same-root same-class windows on one shared effort margin and budgets
// weights per root and day: same-activity windows and same-day overlaps share
// one contribution budget and never accumulate as independent support.
// Repeated root+duration windows are dropped rather than double counted.
func evolvedAdmitObservations(evidence []CandidateEvidence, asOf time.Time, priors EvolvedPriorSet) evolvedFit {
	ordered := append([]CandidateEvidence(nil), evidence...)
	sort.Slice(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if candidateRootID(a) != candidateRootID(b) {
			return candidateRootID(a) < candidateRootID(b)
		}
		if a.DurationS != b.DurationS {
			return a.DurationS < b.DurationS
		}
		if hourEffortWeight(a.EffortSupport) != hourEffortWeight(b.EffortSupport) {
			return hourEffortWeight(a.EffortSupport) > hourEffortWeight(b.EffortSupport)
		}
		if candidateConfidenceRank(a.MeasurementQuality) != candidateConfidenceRank(b.MeasurementQuality) {
			return candidateConfidenceRank(a.MeasurementQuality) > candidateConfidenceRank(b.MeasurementQuality)
		}
		return ReplayContentHash(a) < ReplayContentHash(b)
	})
	dated := make([]CandidateEvidence, 0, len(evidence))
	for _, e := range evidence {
		if age := dayDiff(asOf, e.ActivityDate); !e.ActivityDate.IsZero() && age >= 0 && age <= ContractEvidenceWindowDays {
			dated = append(dated, e)
		}
	}
	conflicts := conflictingCandidateRootDays(dated)
	fit := evolvedFit{rows: make([]EvolvedSpeedObservation, 0, len(ordered)), obs: make([]evolvedObsPoint, 0, len(ordered))}
	seen := map[string]map[float64]bool{}
	rootCounts := map[string]int{}
	rootDay := map[string]string{}
	groupIdx := map[string]int{}
	for i := range ordered {
		e := &ordered[i]
		root := candidateRootID(*e)
		age := float64(dayDiff(asOf, e.ActivityDate))
		day := e.ActivityDate.Format("2006-01-02")
		row := EvolvedSpeedObservation{ActivityID: e.ActivityID, RootActivityID: root, ActivityDay: day, DurationS: e.DurationS, EffortSupport: e.EffortSupport, MeasurementQuality: e.MeasurementQuality, Role: "not_selected"}
		switch {
		case conflicts[root]:
			row.Role = "root_activity_day_conflict"
		case !e.Selected:
		case !e.Continuous:
			row.Role = "noncontinuous_observation_only"
		case root == "" || e.ActivityDate.IsZero() || age < 0 || age > ContractEvidenceWindowDays:
			row.Role = "identity_or_date_not_admitted"
		case e.DurationS < contractMinModelDurationS || math.IsInf(e.DurationS, 0) || math.IsNaN(e.DurationS):
			row.Role = "outside_model_domain_original_duration_only"
		case !(e.AvgSpeedMps > 0 && e.AvgSpeedMps <= contractMaxPlausibleSpeedMps) || math.IsNaN(e.AvgSpeedMps):
			row.Role = "invalid_measurement"
		case candidateConfidenceRank(e.MeasurementQuality) == 0:
			row.Role = "measurement_quality_missing"
		default:
			if seen[root] == nil {
				seen[root] = map[float64]bool{}
			}
			if seen[root][e.DurationS] {
				row.Role = "duplicate_root_duration"
				break
			}
			seen[root][e.DurationS] = true
			// Measurement sigma recipe carried over from hour-capability-v1 so
			// both implementations share one uncertainty vocabulary.
			sigma := map[Confidence]float64{ConfidenceHigh: .02, ConfidenceMedium: .05, ConfidenceLow: .10}[e.MeasurementQuality]
			sigma = math.Hypot(sigma, math.Min(.15, age*.001))
			if e.DurationS > 3600 {
				sigma = math.Hypot(sigma, .06*math.Log(math.Min(e.DurationS, 7200)/3600)/math.Log(2))
			}
			if e.EffortSupport == EffortProbableMaximal {
				sigma = math.Hypot(sigma, .06)
			}
			longDomain := e.DurationS > 7200
			if longDomain {
				sigma = math.Hypot(sigma, evolvedLongDomainExtraSigma)
			}
			p := evolvedObsPoint{
				y:          math.Log(e.AvgSpeedMps),
				x:          math.Log(math.Min(e.DurationS, 7200) / 3600),
				sigma:      sigma,
				w:          math.Exp2(-age / 90),
				root:       root,
				day:        day,
				duration:   e.DurationS,
				group:      -1,
				constraint: longDomain,
				effort:     e.EffortSupport,
				quality:    e.MeasurementQuality,
				index:      len(fit.rows),
			}
			if longDomain {
				row.Role = "long_duration_monotone_soft_constraint"
			} else {
				row.Role = "model_observation"
				key := root + "\x00" + string(e.EffortSupport)
				g, ok := groupIdx[key]
				if !ok {
					prior := evolvedEffortPrior(priors, e.EffortSupport)
					g = len(fit.groups)
					groupIdx[key] = g
					fit.groups = append(fit.groups, evolvedGroup{root: root, day: day, effort: e.EffortSupport, prior: prior, delta: prior.Mean})
				}
				p.group = g
				fit.groups[g].obsIdx = append(fit.groups[g].obsIdx, len(fit.obs))
			}
			row.ModelDurationS = math.Min(e.DurationS, 7200)
			row.SigmaLog = sigma
			rootCounts[root]++
			if d, ok := rootDay[root]; !ok || day < d {
				rootDay[root] = day
			}
			fit.obs = append(fit.obs, p)
		}
		fit.rows = append(fit.rows, row)
	}
	// Contribution budget: within a root the windows share one unit and roots
	// on the same day share that day's unit, so repeated or overlapping
	// content never adds independent support.
	dayCounts := map[string]int{}
	for _, d := range rootDay {
		dayCounts[d]++
	}
	total := 0.0
	for i := range fit.obs {
		fit.obs[i].w /= float64(rootCounts[fit.obs[i].root] * dayCounts[rootDay[fit.obs[i].root]])
		fit.rows[fit.obs[i].index].Weight = fit.obs[i].w
		total += fit.obs[i].w
	}
	if total > 0 {
		for i := range fit.obs {
			fit.rows[fit.obs[i].index].Contribution = fit.obs[i].w / total
		}
	}
	return fit
}

func evolvedEffortPrior(priors EvolvedPriorSet, effort EffortSupport) PriorNormal {
	switch effort {
	case EffortConfirmedMaximal:
		return priors.EffortMargin.ConfirmedMaximal
	case EffortProbableMaximal:
		return priors.EffortMargin.ProbableMaximal
	case EffortSubmaximal:
		return priors.EffortMargin.Submaximal
	default:
		return priors.EffortMargin.Unknown
	}
}

func evolvedHistoricalPriorTerms(priors EvolvedPriorSet, historical *HistoricalCapabilityPrior) (mean, sd *float64) {
	if historical == nil || !historical.valid() {
		return nil, nil
	}
	m, s := math.Log(historical.V60Mps), priors.HistoricalCapabilitySD(historical.AgeDays)
	return &m, &s
}

func evolvedSupportStructure(obs []evolvedObsPoint) (roots, days int) {
	rootSet, daySet := map[string]bool{}, map[string]bool{}
	for i := range obs {
		rootSet[obs[i].root] = true
		daySet[obs[i].day] = true
	}
	return len(rootSet), len(daySet)
}

type evolvedSolution struct {
	a, k      float64
	deltas    []float64 // per group
	probes    int
	converged bool
	objective float64
	// gridResolution is the k grid step actually used; gridCoarsened marks
	// the large-input guard so the report can disclose it.
	gridResolution float64
	gridCoarsened  bool
}

// evolvedGroupDelta minimizes the group's budgeted Huber likelihood plus its
// truncated quadratic prior over the prior support; convex, so bisection on
// the monotone subgradient is exact. withPrior=false yields the data-only
// inner solve used by the sensitivity decomposition.
func evolvedGroupDelta(fit *evolvedFit, g int, a, k float64, withPrior bool) float64 {
	grp := &fit.groups[g]
	deriv := func(d float64) float64 {
		s := 0.0
		for _, i := range grp.obsIdx {
			p := &fit.obs[i]
			r := (p.y - a + k*p.x + d) / p.sigma
			s += p.w * hourPsi(r) / p.sigma
		}
		if withPrior {
			// Derivative of 0.5*((d-m)/s)^2 is (d-m)/s^2, NOT (d-m)/s:
			// dropping the second 1/s factor would apply the margin prior
			// with weight s and desynchronize the inner solves from the
			// joint objective.
			s += (d - grp.prior.Mean) / (grp.prior.SD * grp.prior.SD)
		}
		return s
	}
	lo, hi := grp.prior.Low, grp.prior.High
	if deriv(hi) <= 0 {
		return hi
	}
	if deriv(lo) >= 0 {
		return lo
	}
	for n := 0; n < evolvedBisectionIters; n++ {
		mid := (lo + hi) / 2
		if deriv(mid) < 0 {
			lo = mid
		} else {
			hi = mid
		}
	}
	return (lo + hi) / 2
}

// evolvedProfile evaluates the profile objective J*(a) = min_delta J(a, delta)
// and its Danskin subgradient: every group margin is re-optimized for the
// probe a, so the profile marginalizes the effort margins exactly. This is
// the exact solver (convex partial minimization), replacing the slow
// alternating coordinate updates that stall when a and the margins are
// strongly coupled.
func evolvedProfile(fit *evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64, k, a float64, withPriors bool) (j, grad float64) {
	for g := range fit.groups {
		fit.groups[g].delta = evolvedGroupDelta(fit, g, a, k, withPriors)
	}
	j = 0
	if withPriors {
		j += 0.5 * math.Pow((a-priors.LogV60.Mean)/priors.LogV60.SD, 2)
		if histMean != nil {
			j += 0.5 * math.Pow((a-*histMean) / *histSD, 2)
		}
		// Contract section 5 freezes a truncated quadratic prior on the
		// endurance exponent too (mean 0.06, sd 0.03 inside the frozen
		// [0.02, 0.10] grid domain). Without it a weakly identified duration
		// decline parks the MAP exponent on the domain edge (review P1).
		j += 0.5 * math.Pow((k-priors.EnduranceK.Mean)/priors.EnduranceK.SD, 2)
		// The effort-margin priors are part of the joint objective: without
		// them the k comparison would silently prefer exponents that push
		// margins away from their class means.
		for g := range fit.groups {
			d := fit.groups[g].delta
			j += 0.5 * math.Pow((d-fit.groups[g].prior.Mean)/fit.groups[g].prior.SD, 2)
		}
	}
	for i := range fit.obs {
		p := &fit.obs[i]
		if p.constraint {
			v := (p.y - p.sigma - (a - k*p.x)) / p.sigma
			if v > 0 {
				j += p.w * hourHuber(v)
				if withPriors {
					grad -= p.w * hourPsi(v) / p.sigma
				}
			}
			continue
		}
		delta := fit.groups[p.group].delta
		r := (p.y - a + k*p.x + delta) / p.sigma
		j += p.w * hourHuber(r)
		if withPriors {
			grad -= p.w * hourPsi(r) / p.sigma
		}
	}
	if withPriors {
		grad += (a - priors.LogV60.Mean) / (priors.LogV60.SD * priors.LogV60.SD)
		if histMean != nil {
			grad += (a - *histMean) / (*histSD * *histSD)
		}
	}
	return j, grad
}

// evolvedSolveAtK finds the exact minimizer over a of the convex profile by
// bisection on its monotone subgradient.
func evolvedSolveAtK(fit *evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64, k float64) evolvedSolution {
	probes := 0
	grad := func(a float64) float64 {
		probes++
		_, g := evolvedProfile(fit, priors, histMean, histSD, k, a, true)
		return g
	}
	lo, hi := priors.LogV60.Low, priors.LogV60.High
	if grad(lo) >= 0 {
		hi = lo
	} else if grad(hi) <= 0 {
		lo = hi
	} else {
		for n := 0; n < evolvedBisectionIters; n++ {
			mid := (lo + hi) / 2
			if grad(mid) < 0 {
				lo = mid
			} else {
				hi = mid
			}
		}
	}
	sol := evolvedSolution{a: (lo + hi) / 2, k: k, deltas: make([]float64, len(fit.groups)), probes: probes}
	sol.objective, _ = evolvedProfile(fit, priors, histMean, histSD, k, sol.a, true)
	sol.probes++
	sol.converged = evolvedFinite(sol.a) && evolvedFinite(sol.objective)
	for g := range fit.groups {
		sol.deltas[g] = fit.groups[g].delta
	}
	return sol
}

// evolvedSolveMAP: for each grid k the convex profile is minimized exactly
// over a; k is scanned on a fixed coarse+fine grid with input-order
// independent comparisons.
func evolvedSolveMAP(fit evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64) (evolvedSolution, bool) {
	coarseSteps, fineSteps := evolvedKCoarseSteps, evolvedKFineSteps
	gridCoarsened := len(fit.obs) > evolvedLargeObservationThreshold
	if gridCoarsened {
		coarseSteps, fineSteps = evolvedKCoarseStepsLarge, evolvedKFineStepsLarge
	}
	best := evolvedSolution{k: riegelKMin, objective: math.Inf(1), gridCoarsened: gridCoarsened}
	totalProbes := 0
	evalK := func(k float64) {
		sol := evolvedSolveAtK(&fit, priors, histMean, histSD, k)
		totalProbes += sol.probes
		if sol.objective < best.objective {
			sol.gridCoarsened = gridCoarsened
			best = sol
		}
	}
	coarseStep := (riegelKMax - riegelKMin) / float64(coarseSteps)
	for step := 0; step <= coarseSteps; step++ {
		evalK(math.Min(riegelKMin+coarseStep*float64(step), riegelKMax))
	}
	fineStep := coarseStep / (float64(fineSteps/2) + 1)
	fineLo := math.Max(riegelKMin, best.k-coarseStep)
	for step := 0; step <= fineSteps; step++ {
		k := fineLo + fineStep*float64(step)
		if k < riegelKMin || k > riegelKMax {
			continue
		}
		evalK(k)
	}
	best.probes = totalProbes
	best.gridResolution = fineStep
	if !evolvedFinite(best.a) || !evolvedFinite(best.objective) {
		return evolvedSolution{}, false
	}
	return best, true
}

// evolvedCurvatures returns one-sided second differences of the full profile
// and of the data-only profile at the MAP point (margins re-optimized at each
// probe). The optimum often sits on the delta>=0 kink (an all-out window
// pins the capability from below), so a symmetric second difference would
// average the two sides and understate sensitivity. The reported basis uses
// the SMALLER full-profile side (conservative, wider range) and the LARGER
// data-only side (the side where the data actually speaks).
func evolvedCurvatures(fit evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64, sol evolvedSolution) (total, dataOnly float64, ok bool) {
	secondSided := func(withPriors bool) (lo, hi float64) {
		value := func(a float64) float64 {
			j, _ := evolvedProfile(&fit, priors, histMean, histSD, sol.k, a, withPriors)
			return j
		}
		h := evolvedProfileStepLogA
		mid, up, down := value(sol.a), value(sol.a+h), value(sol.a-h)
		// One-sided second differences: f'' ~ 2*(J(a+h)-J(a))/h^2 and
		// 2*(J(a-h)-J(a))/h^2 for the convex profile.
		lo = 2 * (down - mid) / (h * h)
		hi = 2 * (up - mid) / (h * h)
		if lo < 0 {
			lo = 0
		}
		if hi < 0 {
			hi = 0
		}
		return lo, hi
	}
	loFull, hiFull := secondSided(true)
	loData, hiData := secondSided(false)
	total = math.Min(loFull, hiFull)
	dataOnly = math.Max(loData, hiData)
	if !evolvedFinite(total) || !evolvedFinite(dataOnly) || total <= 0 {
		return 0, 0, false
	}
	return total, dataOnly, true
}

// evolvedKEnvelope re-solves the profile exactly at both frozen k edges.
func evolvedKEnvelope(fit evolvedFit, priors EvolvedPriorSet, histMean, histSD *float64) (lo, hi float64, ok bool) {
	loSol := evolvedSolveAtK(&fit, priors, histMean, histSD, riegelKMin)
	hiSol := evolvedSolveAtK(&fit, priors, histMean, histSD, riegelKMax)
	if !evolvedFinite(loSol.a) || !evolvedFinite(hiSol.a) {
		return 0, 0, false
	}
	return loSol.a, hiSol.a, true
}

// evolvedStampSolved publishes per-observation fitted margins and standardized
// residuals from the MAP solution (constraint rows carry their hinge
// violation).
func evolvedStampSolved(fit evolvedFit, sol evolvedSolution) {
	for i := range fit.obs {
		p := &fit.obs[i]
		var r float64
		if p.constraint {
			r = math.Max(0, (p.y-p.sigma-(sol.a-sol.k*p.x))/p.sigma)
		} else {
			delta := sol.deltas[p.group]
			d := delta
			fit.rows[p.index].Delta = &d
			r = (p.y - sol.a + sol.k*p.x + delta) / p.sigma
		}
		fit.rows[p.index].Residual = &r
	}
}

func evolvedFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// evolvedStampCenter publishes center and sensitivity range in both unit
// contracts (m/s and s/km = 1000/v60), clamped to the declared prior support:
// the historical prior is never a cap, but the plausibility domain still is.
func evolvedStampCenter(out *EvolvedSpeedReport, priors EvolvedPriorSet, a, envLo, envHi, sd float64) {
	// env brackets a which sits inside the prior support, so ordering holds;
	// the swap is a defensive no-op for nonfinite callers.
	lo := math.Max(envLo-sd, priors.LogV60.Low)
	hi := math.Min(envHi+sd, priors.LogV60.High)
	if hi < lo {
		lo, hi = math.Min(lo, hi), math.Max(lo, hi)
	}
	center, low, high := math.Exp(a), math.Exp(lo), math.Exp(hi)
	out.CenterMps = &center
	out.RangeLowMps = &low
	out.RangeHighMps = &high
	out.PosteriorSDLogV60 = sd
	pace, paceLow, paceHigh := 1000/center, 1000/high, 1000/low
	out.PaceCenterSPerKm = &pace
	out.PaceRangeLowSPerKm = &paceLow
	out.PaceRangeHighSPerKm = &paceHigh
}
