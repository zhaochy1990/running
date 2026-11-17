package calibration

import (
	"math"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
)

// evolved_v4_range.go implements docs/calibration/v4.md §8.2 for rev3: the
// frozen sensitivity scenario list (k fixed at 0.02/0.06/0.10; margin means
// zero / initial / non-all-out ×2 with scales 1×/2×; HR weight 0/0.5/1, q60
// center 0.80/0.85/0.90, beta center 2/3/5; R ±3 bpm and M ±5 bpm; per-root
// same-direction ±sigma measurement shifts with B and constraints rebuilt;
// leave-one-independent-day recomputes), the Delta L=2 objective profiles on
// log(v60) (0.002 grid, 0.0001 boundary refinement) and on H60 (1 bpm grid,
// 0.1 bpm refinement), and the union envelope with nominal-bound versus
// sensitivity-range separation. Failed scenarios are reported as failures —
// never dropped to fake a tight two-sided range.

// v4SolveConfig is one scenario's modifications of the main solve.
type v4SolveConfig struct {
	Name        string
	KFix        *float64
	Margin      v4MarginScenario
	HR          v4HRJointConfig
	LeaveOutDay string
	// MeasurementShift ∈ {0, +1, −1}: shift every root's in-window log speeds
	// by its quality measurement sigma (same direction for all windows of a
	// root) and regenerate B_eligible and the constraints.
	MeasurementShift float64
	// Kind: "prior" (prior/scenario-family change, feeds the §8.3 dominance
	// rule) or "data" (measurement/leave-one-day robustness).
	Kind string
}

// v4ScenarioList is the pre-fixed §8.2 combination list: every single-item
// change plus the two joint endpoints ("bigger margins / stronger HR" and
// "zero margins / no HR"). Frozen before any run; its hash is reported.
func v4ScenarioList(priors EvolvedPriorSet) []v4SolveConfig {
	f := func(v float64) *float64 { return &v }
	scenarios := []v4SolveConfig{
		// 1. Fixed k edges and center, compared against the free-k result.
		{Name: "k_fixed_0.02", KFix: f(0.02), Kind: "prior"},
		{Name: "k_fixed_0.06", KFix: f(0.06), Kind: "prior"},
		{Name: "k_fixed_0.10", KFix: f(0.10), Kind: "prior"},
		// 2. Margin means all zero / initial is the main solve / non-all-out
		// means ×2; scales 1× and 2×.
		{Name: "margin_zero", Margin: v4MarginScenario{MuMode: "zero"}, Kind: "prior"},
		{Name: "margin_double_nonallout", Margin: v4MarginScenario{MuMode: "double_nonallout"}, Kind: "prior"},
		{Name: "margin_scale_2x", Margin: v4MarginScenario{ScaleMode: "2x"}, Kind: "prior"},
		// 3. HR feedback weight 0 / 0.5 (main) / 1; q60 center 0.80/0.90;
		// beta center 2/5 (0.85 and 3 are the main priors).
		{Name: "hr_lambda_0", HR: v4HRJointConfig{LambdaH: f(0)}, Kind: "prior"},
		{Name: "hr_lambda_1", HR: v4HRJointConfig{LambdaH: f(1)}, Kind: "prior"},
		{Name: "hr_q60_0.80", HR: v4HRJointConfig{Q60Center: f(0.80)}, Kind: "prior"},
		{Name: "hr_q60_0.90", HR: v4HRJointConfig{Q60Center: f(0.90)}, Kind: "prior"},
		{Name: "hr_beta_2", HR: v4HRJointConfig{BetaCenter: f(2)}, Kind: "prior"},
		{Name: "hr_beta_5", HR: v4HRJointConfig{BetaCenter: f(5)}, Kind: "prior"},
		// 4. R ±3 bpm, M ±5 bpm research scenarios (no calibrated ranges).
		{Name: "r_minus_3", HR: v4HRJointConfig{RDeltaBpm: f(-3)}, Kind: "prior"},
		{Name: "r_plus_3", HR: v4HRJointConfig{RDeltaBpm: f(3)}, Kind: "prior"},
		{Name: "m_minus_5", HR: v4HRJointConfig{MDeltaBpm: f(-5)}, Kind: "prior"},
		{Name: "m_plus_5", HR: v4HRJointConfig{MDeltaBpm: f(5)}, Kind: "prior"},
		// Joint endpoints.
		{Name: "endpoint_bigger_margin_stronger_hr", Margin: v4MarginScenario{MuMode: "double_nonallout", ScaleMode: "2x"}, HR: v4HRJointConfig{LambdaH: f(1)}, Kind: "prior"},
		{Name: "endpoint_zero_margin_no_hr", Margin: v4MarginScenario{MuMode: "zero"}, HR: v4HRJointConfig{LambdaH: f(0)}, Kind: "prior"},
		// 5. Same-direction ±sigma measurement shifts per root; B and the
		// constraints are regenerated on the shifted inputs.
		{Name: "measurement_shift_plus_sigma", MeasurementShift: 1, Kind: "data"},
		{Name: "measurement_shift_minus_sigma", MeasurementShift: -1, Kind: "data"},
	}
	return scenarios
}

// v4SolveResult is one solve's published numbers (main or scenario).
type v4SolveResult struct {
	A, K, Obj float64
	Method    string
	Converged bool
	CenterMps *float64
	H60       *float64
	HRBranch  string
	OK        bool
	Reason    string
	// FeasibleK: at least one feasible k existed.
	FeasibleK bool
}

// v4ScenarioOutcome publishes one scenario row of the §9 diagnostics.
type v4ScenarioOutcome struct {
	Name       string   `json:"name"`
	Kind       string   `json:"kind"`
	CenterMps  *float64 `json:"center_mps,omitempty"`
	H60Bpm     *float64 `json:"h60_bpm,omitempty"`
	OK         bool     `json:"ok"`
	FailReason string   `json:"fail_reason,omitempty"`
}

// v4Sensitivity is the assembled §8.2 output.
type v4Sensitivity struct {
	Scenarios    []v4ScenarioOutcome
	ScenarioHash string
	FailedCount  int
	// PaceRangeLog: [lo, hi] envelope in log speed (nil when unavailable).
	PaceRangeLog   [2]float64
	ProfileLowLog  *float64
	ProfileHighLog *float64
	// HRRangeBpm: [lo, hi] for the normalized branch (nil otherwise).
	HRRangeBpm    [2]float64
	HRProfileLow  *float64
	HRProfileHigh *float64
	// FastSidePriorLimited: fast side not data-identified (§8.2).
	FastSidePriorLimited bool
	SlowSideLimited      bool
	// LeaveOneDaySpread: max |center − main| over leave-one-day recomputes.
	LeaveOneDaySpread *float64
	LeaveOneDayCount  int
}

// v4PaceProfileAt evaluates the §8.2 pace profile at a fixed a: re-optimize
// the remaining parameters (k on the §8.1 grid; the HR block at its profile
// optimum when the joint branch is active) under the constraint that the
// chosen k keeps a >= A_floor(k). The HR block is k-independent, so its
// profile solve runs once per a.
func (e *v4Estimate) v4PaceProfileAt(a float64, pace *v4PaceObjective, joint *v4HRJointSolver, warm *v4HRTheta) (float64, *v4HRTheta) {
	g := 0.0
	var th *v4HRTheta
	if joint != nil {
		t, gj := joint.solveThetaAtA(a, warm, 12)
		th = &t
		g = gj
	}
	best := math.Inf(1)
	for _, k := range pace.kGrid {
		if pace.floor.aFloor(k).Value > a {
			continue
		}
		lp, _ := pace.evaluate(a, k)
		if j := pace.objectivePlus(lp, k) + g; j < best {
			best = j
		}
	}
	return best, th
}

// v4PaceProfile sweeps the 0.002 log(v60) grid outward from the main center
// until L > L_min + DeltaL on both sides (or the numerical domain edge),
// refining kept-set boundaries to 0.0001.
func (e *v4Estimate) v4PaceProfile(main v4SolveResult, pace *v4PaceObjective, joint *v4HRJointSolver, deltaL float64) (lo, hi *float64) {
	if !main.OK {
		return nil, nil
	}
	lMin := main.Obj
	warm := e.mainWarmTheta
	inSet := func(a float64) bool {
		j, w := e.v4PaceProfileAt(a, pace, joint, warm)
		if w != nil {
			warm = w
		}
		return j <= lMin+deltaL
	}
	grid, refine := 0.002, 0.0001
	loBound, hiBound := pace.aLo, pace.aHi
	if !inSet(main.A) {
		v := main.A
		return &v, &v
	}
	// Expand downward.
	down, hitSlow := main.A, false
	for {
		cand := down - grid
		if cand < loBound {
			if inSet(loBound) {
				hitSlow = true
			}
			break
		}
		if !inSet(cand) {
			loOut, loIn := cand, down
			for loIn-loOut > refine {
				mid := (loIn + loOut) / 2
				if inSet(mid) {
					loIn = mid
				} else {
					loOut = mid
				}
			}
			down = loIn
			break
		}
		down = cand
	}
	// Expand upward.
	up, hitFast := main.A, false
	for {
		cand := up + grid
		if cand > hiBound {
			if inSet(hiBound) {
				hitFast = true
			}
			break
		}
		if !inSet(cand) {
			hiIn, hiOut := up, cand
			for hiOut-hiIn > refine {
				mid := (hiIn + hiOut) / 2
				if inSet(mid) {
					hiIn = mid
				} else {
					hiOut = mid
				}
			}
			up = hiOut
			break
		}
		up = cand
	}
	if hitSlow {
		e.sensitivity.SlowSideLimited = true
	}
	if hitFast {
		// The kept set reaches the numerical domain edge: that side is not
		// identified; the search cap is not a real capability limit.
		e.sensitivity.FastSidePriorLimited = true
	}
	return &down, &up
}

// v4HRProfile sweeps the §8.2 H60 constrained profile on the 1 bpm grid with
// 0.1 bpm boundary refinement (normalized branch only).
func (e *v4Estimate) v4HRProfile(main v4SolveResult, joint *v4HRJointSolver, deltaL float64) (lo, hi *float64) {
	if joint == nil || !main.OK || main.H60 == nil || joint.phys.R == nil || joint.phys.M == nil {
		return nil, nil
	}
	lMin := main.Obj
	loDomain := math.Max(joint.priors.HRDomainLowBpm, *joint.phys.R+1)
	hiDomain := math.Min(joint.priors.HRDomainHighBpm, *joint.phys.M-1)
	if loDomain >= hiDomain {
		return nil, nil
	}
	var warm *v4HRJointResult
	solveAt := func(h float64) (float64, bool) {
		res, ok := joint.solveAtH60(h, warm, 40)
		if ok {
			w := res
			warm = &w
		}
		return res.Obj, ok && res.Obj <= lMin+deltaL
	}
	if _, ok := solveAt(math.Round(*main.H60)); !ok {
		// Fall back to the nearest in-profile point of the main center.
		v := *main.H60
		return &v, &v
	}
	expand := func(start float64, step float64, bound float64) float64 {
		last := start
		for {
			cand := last + step
			if cand < loDomain || cand > hiDomain {
				return last
			}
			_, in := solveAt(cand)
			if !in {
				// refine to 0.1 bpm between cand (out) and last (in)
				out, inPt := cand, last
				for math.Abs(out-inPt) > 0.1 {
					mid := math.Round((out+inPt)/2*10) / 10
					if mid <= inPt || mid >= out {
						break
					}
					if _, inside := solveAt(mid); inside {
						inPt = mid
					} else {
						out = mid
					}
				}
				return inPt
			}
			last = cand
		}
	}
	down := expand(math.Round(*main.H60), -1, loDomain)
	up := expand(math.Round(*main.H60), 1, hiDomain)
	return &down, &up
}

// v4RunSensitivity executes the frozen scenario list and the profiles, then
// assembles the union envelope. The main center is always contained (§8.3).
func v4RunSensitivity(e *v4Estimate, main v4SolveResult, pace *v4PaceObjective, joint *v4HRJointSolver, priors EvolvedPriorSet, leaveOutDays []string) *v4Sensitivity {
	s := &v4Sensitivity{}
	e.sensitivity = s
	e.noNearAllOutSupport = e.noNearAllOut()
	s.ScenarioHash = ReplayContentHash(struct {
		Scenarios []string
		LeaveOut  []string
	}{v4ScenarioNames(v4ScenarioList(priors)), leaveOutDays})
	s.FastSidePriorLimited = e.noNearAllOutSupport
	mainCenter := math.Exp(main.A)
	lo, hi := main.A, main.A
	hrLo, hrHi := math.Inf(1), math.Inf(-1)
	if main.H60 != nil {
		hrLo, hrHi = *main.H60, *main.H60
	}
	// The frozen scenario list runs first; every scenario is an independent
	// recompute on its own evidence copies, so they execute concurrently and
	// reduce in the fixed list order (scheduling-independent results).
	type scenarioJob struct {
		cfg  v4SolveConfig
		kind string
	}
	jobs := make([]scenarioJob, 0, 32)
	for _, cfg := range v4ScenarioList(priors) {
		jobs = append(jobs, scenarioJob{cfg: cfg, kind: cfg.Kind})
	}
	for _, day := range leaveOutDays {
		jobs = append(jobs, scenarioJob{cfg: v4SolveConfig{Name: "leave_one_day_" + day, LeaveOutDay: day}, kind: "data"})
	}
	results := make([]v4SolveResult, len(jobs))
	workers := runtime.GOMAXPROCS(0)
	if workers > 6 {
		workers = 6
	}
	if workers < 2 || len(jobs) < 4 {
		for i, j := range jobs {
			results[i] = e.runSolve(j.cfg)
		}
	} else {
		var next int64
		var wg sync.WaitGroup
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					i := int(atomic.AddInt64(&next, 1)) - 1
					if i >= len(jobs) {
						return
					}
					results[i] = e.runSolve(jobs[i].cfg)
				}
			}()
		}
		wg.Wait()
	}
	for idx, j := range jobs {
		res := results[idx]
		out := v4ScenarioOutcome{Name: j.cfg.Name, Kind: j.kind, OK: res.OK, FailReason: res.Reason, CenterMps: res.CenterMps, H60Bpm: res.H60}
		if res.OK && res.CenterMps != nil {
			lo = math.Min(lo, math.Log(*res.CenterMps))
			hi = math.Max(hi, math.Log(*res.CenterMps))
		}
		if res.OK && res.H60 != nil {
			hrLo = math.Min(hrLo, *res.H60)
			hrHi = math.Max(hrHi, *res.H60)
		}
		if j.kind == "data" && res.OK && res.CenterMps != nil {
			spread := math.Abs(*res.CenterMps-mainCenter) / mainCenter
			if s.LeaveOneDaySpread == nil || spread > *s.LeaveOneDaySpread {
				v := spread
				s.LeaveOneDaySpread = &v
			}
			s.LeaveOneDayCount++
		}
		if !res.OK {
			s.FailedCount++
		}
		s.Scenarios = append(s.Scenarios, out)
	}
	// Pace objective profile (ΔL=2) joins the envelope.
	pLo, pHi := e.v4PaceProfile(main, pace, joint, priors.ProfileDeltaL)
	if pLo != nil && pHi != nil {
		lo = math.Min(lo, *pLo)
		hi = math.Max(hi, *pHi)
		s.ProfileLowLog, s.ProfileHighLog = pLo, pHi
	}
	s.PaceRangeLog = [2]float64{lo, hi}
	// HR profile (normalized branch) merges with the HR scenario centers.
	if joint != nil {
		hLo, hHi := e.v4HRProfile(main, joint, priors.ProfileDeltaL)
		if hLo != nil && hHi != nil {
			hrLo = math.Min(hrLo, *hLo)
			hrHi = math.Max(hrHi, *hHi)
			s.HRProfileLow, s.HRProfileHigh = hLo, hHi
		}
	}
	if v4Finite(hrLo) && v4Finite(hrHi) {
		s.HRRangeBpm = [2]float64{hrLo, hrHi}
	}
	return s
}

func v4ScenarioNames(list []v4SolveConfig) []string {
	out := make([]string, 0, len(list))
	for _, s := range list {
		out = append(out, s.Name)
	}
	sort.Strings(out)
	return out
}
