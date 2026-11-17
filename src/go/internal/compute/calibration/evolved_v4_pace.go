package calibration

import (
	"math"
	"sort"
)

// evolved_v4_pace.go implements docs/calibration/v4.md §5 (margin model over
// the proven lower bounds) and the §8.1 deterministic solve conventions for
// the pace-only branch: k enumerated on the fixed 0.0005 grid over [0.02,
// 0.10]; at each k the convex Huber objective is solved as a bounded 1-D
// problem over a with the hard domain constraint a >= A_floor(k) (never a
// finite penalty); the v60 numerical search domain is 0.5-12 m/s; boundary
// hits are reported, never silently clamped into success; ties within 1e-8
// take the smallest a and then the k closest to 0.06 — including the flat
// constraint-only case.

const (
	// v4KGridStep: §8.1 fixed k enumeration step.
	v4KGridStep = 0.0005
	// v4TieTolerance: §8.1 objective tie tolerance.
	v4TieTolerance = 1e-8
	// v4BisectionIters: exactness of the convex 1-D subgradient bisection.
	v4BisectionIters = 80
)

// v4PaceRow is one frontier-pool row projected into the §5.1 loss.
type v4PaceRow struct {
	X, Y, Mu, S, W float64
	RowIdx         int
	Class          EffortSupport
}

// v4MarginScenario mutates the §5.1 margin table inputs for the §8.2
// sensitivity scenarios. MuMode: "initial" (table values), "zero" (all mu=0)
// or "double_nonallout" (non-all-out class means ×2). ScaleMode: "1x"/"2x".
type v4MarginScenario struct {
	Name      string
	MuMode    string
	ScaleMode string
}

// v4PaceObjective is the pace-side objective L_P + L_k with the floor
// constraint, shared by the pace-only solve, the HR joint solve and the §8.2
// profiles.
type v4PaceObjective struct {
	rows   []v4PaceRow
	priors EvolvedPriorSet
	floor  v4FloorFunction
	aLo    float64 // max(numerical domain low, …) computed per-k with the floor
	aHi    float64
	// Precomputed k grid (§8.1).
	kGrid []float64
	// byK: per-k bounded solutions of the last full solve (the §8.1 HR-branch
	// a starts: the pace-only solution at each k and its 1.03x/1.08x lifts).
	byK []v4PacePointAtK
}

func newV4PaceObjective(rows []v4PaceRow, priors EvolvedPriorSet, floor v4FloorFunction) v4PaceObjective {
	kGrid := make([]float64, 0, int((riegelKMax-riegelKMin)/v4KGridStep)+2)
	for k := riegelKMin; k <= riegelKMax+1e-12; k += v4KGridStep {
		kGrid = append(kGrid, math.Min(k, riegelKMax))
	}
	if len(kGrid) == 0 || kGrid[len(kGrid)-1] < riegelKMax-1e-12 {
		kGrid = append(kGrid, riegelKMax)
	}
	return v4PaceObjective{
		rows: rows, priors: priors, floor: floor,
		aLo: math.Log(priors.V60SearchLowMps), aHi: math.Log(priors.V60SearchHighMps),
		kGrid: kGrid,
	}
}

// buildV4PaceRows projects the frontier pool into §5.1 loss rows under a
// margin scenario. Trusted rows use their quality measurement scale;
// model_observation rows use at least the low scale (§3.3).
func buildV4PaceRows(ev *v4EvidenceSet, priors EvolvedPriorSet, scenario v4MarginScenario) []v4PaceRow {
	rows := make([]v4PaceRow, 0, len(ev.Pool))
	for _, i := range ev.Pool {
		r := &ev.Rows[i]
		prior := priors.MarginPriorFor(r.Effort)
		mu, sigma := prior.Mean, prior.SD
		switch scenario.MuMode {
		case "zero":
			mu = 0
		case "double_nonallout":
			if r.Effort != EffortConfirmedMaximal && r.Effort != EffortProbableMaximal {
				mu *= 2
			}
		}
		if scenario.ScaleMode == "2x" {
			sigma *= 2
		}
		sigmaMeas := priors.MeasurementSigma(r.Quality)
		if r.Role == v4RoleModelObservation {
			sigmaMeas = math.Max(sigmaMeas, priors.MeasurementSigmaLow)
		}
		rows = append(rows, v4PaceRow{
			X: r.X, Y: r.Y, Mu: mu, S: math.Hypot(sigma, sigmaMeas),
			W: r.Weight, RowIdx: i, Class: r.Effort,
		})
	}
	return rows
}

// evaluate returns L_P(a,k); grad is the exact subgradient in a (Danskin).
func (o *v4PaceObjective) evaluate(a, k float64) (obj, grad float64) {
	for i := range o.rows {
		r := &o.rows[i]
		z := (a - k*r.X - r.Y - r.Mu) / r.S
		obj += r.W * huber15(z)
		grad += r.W * psi15(z) / r.S
	}
	return obj, grad
}

// objectivePlus adds L_k to a evaluated L_P.
func (o *v4PaceObjective) objectivePlus(lp, k float64) float64 {
	return lp + o.priors.EndurancePenalty(k)
}

func huber15(z float64) float64 {
	az := math.Abs(z)
	if az <= 1.5 {
		return 0.5 * z * z
	}
	return 1.5 * (az - 0.75)
}

func psi15(z float64) float64 {
	if z > 1.5 {
		return 1.5
	}
	if z < -1.5 {
		return -1.5
	}
	return z
}

// boundsAtK returns the feasible a interval at k: [max(A_floor(k), log 0.5),
// log 12]. ok=false when the floor itself exceeds the numerical domain (the
// scenario's inputs make the trusted constraints infeasible — reported, never
// clamped).
func (o *v4PaceObjective) boundsAtK(k float64) (lo, hi float64, ok bool) {
	hi = o.aHi
	lo = o.floor.aFloor(k).Value
	if lo < o.aLo {
		lo = o.aLo
	}
	if lo > hi {
		return lo, hi, false
	}
	return lo, hi, true
}

// v4PacePointAtK is one k's bounded convex solution.
type v4PacePointAtK struct {
	K        float64
	A        float64
	LP       float64
	Obj      float64 // L_P + L_k
	Feasible bool
	Boundary string // "", "fast" (hit log 12) or "slow" (hit log 0.5)
	FloorHit bool
}

// solveAtK: fixed k, bounded 1-D convex solve over a with the A_floor(k)
// domain constraint (§8.1). Exact via the monotone subgradient.
func (o *v4PaceObjective) solveAtK(k float64) v4PacePointAtK {
	out := v4PacePointAtK{K: k}
	lo, hi, ok := o.boundsAtK(k)
	if !ok {
		out.Feasible = false
		return out
	}
	out.Feasible = true
	grad := func(a float64) float64 {
		_, g := o.evaluate(a, k)
		return g
	}
	if grad(lo) >= 0 {
		out.A = lo
		out.FloorHit = lo > o.aLo || o.floor.aFloor(k).Value >= o.aLo
	} else if grad(hi) <= 0 {
		out.A = hi
		out.Boundary = "fast"
	} else {
		for n := 0; n < v4BisectionIters; n++ {
			mid := (lo + hi) / 2
			if grad(mid) < 0 {
				lo = mid
			} else {
				hi = mid
			}
		}
		out.A = (lo + hi) / 2
		if math.Abs(out.A-o.aHi) < 1e-9 {
			out.Boundary = "fast"
		}
	}
	if math.Abs(out.A-o.aLo) < 1e-9 && o.floor.aFloor(k).Value <= o.aLo {
		out.Boundary = "slow"
	}
	out.LP, _ = o.evaluate(out.A, k)
	out.Obj = o.objectivePlus(out.LP, k)
	return out
}

// v4BetterSolution applies the §8.1 tie rules: strictly better objective
// wins; within 1e-8 ties prefer the smaller a, then the k closer to 0.06.
func v4BetterSolution(obj, a, k, bestObj, bestA, bestK float64) bool {
	if math.IsInf(bestObj, 1) {
		return true
	}
	if obj < bestObj-v4TieTolerance {
		return true
	}
	if obj <= bestObj+v4TieTolerance {
		if a < bestA-v4TieTolerance {
			return true
		}
		if a <= bestA+v4TieTolerance {
			return math.Abs(k-0.06) < math.Abs(bestK-0.06)-1e-12
		}
	}
	return false
}

// v4PaceSolution is the pace-only §5.2 solve result.
type v4PaceSolution struct {
	A, K, Obj    float64
	Converged    bool
	Boundary     string
	AnyFeasibleK bool
}

// solvePace enumerates the full k grid (§8.1) and applies the tie rules.
func (o *v4PaceObjective) solvePace() v4PaceSolution {
	out := v4PaceSolution{Obj: math.Inf(1)}
	o.byK = make([]v4PacePointAtK, 0, len(o.kGrid))
	best := math.Inf(1)
	bestA, bestK := 0.0, riegelKMin
	for _, k := range o.kGrid {
		pt := o.solveAtK(k)
		o.byK = append(o.byK, pt)
		if !pt.Feasible {
			continue
		}
		out.AnyFeasibleK = true
		if pt.Boundary != "" {
			out.Boundary = pt.Boundary
		}
		if v4BetterSolution(pt.Obj, pt.A, k, best, bestA, bestK) {
			best, bestA, bestK = pt.Obj, pt.A, k
		}
	}
	if !out.AnyFeasibleK {
		return out
	}
	out.A, out.K, out.Obj = bestA, bestK, best
	out.Converged = v4Finite(out.A) && v4Finite(out.Obj)
	return out
}

func v4Finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// v4LongTrainingFallback is §5.2's degraded path: only weak-quality legal
// >7200 s records, no in-domain observations and no trusted bounds. k fixed
// at 0.06; per independent day the best full-activity average speed forms a
// wide position prior; minimize sum_j W_j*Huber((a - log v_j)/0.15) under the
// same domain constraints. Marked prior_dominated; never relabels the
// activities as measured hour efforts; no HR->pace feedback.
type v4LongTrainingFallback struct {
	A, Obj    float64
	Days      int
	Converged bool
}

func v4SolveLongTrainingFallback(longLogs map[string]float64 /*day->log v*/, dayAges map[string]float64, priors EvolvedPriorSet, floor v4FloorFunction) v4LongTrainingFallback {
	out := v4LongTrainingFallback{}
	days := make([]string, 0, len(longLogs))
	for d := range longLogs {
		days = append(days, d)
	}
	sort.Strings(days)
	out.Days = len(days)
	if len(days) == 0 {
		return out
	}
	// §5.2 day weights over these independent days.
	total := 0.0
	for _, d := range days {
		total += math.Exp2(-dayAges[d] / 30)
	}
	D := float64(len(days))
	type fbRow struct {
		y, w float64
	}
	rows := make([]fbRow, 0, len(days))
	for _, d := range days {
		w := D * math.Exp2(-dayAges[d]/30) / total
		rows = append(rows, fbRow{y: longLogs[d], w: w})
	}
	sigma := 0.15
	lo := floor.aFloor(0.06).Value
	if lo < math.Log(priors.V60SearchLowMps) {
		lo = math.Log(priors.V60SearchLowMps)
	}
	hi := math.Log(priors.V60SearchHighMps)
	if lo > hi {
		return out
	}
	obj := func(a float64) float64 {
		s := 0.0
		for _, r := range rows {
			s += r.w * huber15((a-r.y)/sigma)
		}
		return s
	}
	grad := func(a float64) float64 {
		s := 0.0
		for _, r := range rows {
			s += r.w * psi15((a-r.y)/sigma) / sigma
		}
		return s
	}
	if grad(lo) >= 0 {
		out.A = lo
	} else if grad(hi) <= 0 {
		out.A = hi
	} else {
		for n := 0; n < v4BisectionIters; n++ {
			mid := (lo + hi) / 2
			if grad(mid) < 0 {
				lo = mid
			} else {
				hi = mid
			}
		}
		out.A = (lo + hi) / 2
	}
	out.Obj = obj(out.A)
	out.Converged = v4Finite(out.A) && v4Finite(out.Obj)
	return out
}
