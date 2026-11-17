package calibration

import (
	"math"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// evolved_v4_hr.go implements docs/calibration/v4.md §6 for rev3: the
// Hsteady sigmoid model with first-order lag, per-day offsets and slow drift;
// the joint objective L_P + L_k + lambda_H*L_H + HR priors under the hard
// a >= A_floor(k) domain constraint; the §8.1 deterministic joint solve
// (per k, three a starts = pace-only solution and its 1.03x/1.08x lifts, HR
// parameters initialized from the §6.2 table, bounded deterministic
// optimization capped at 500 iterations, convergence = relative objective
// change < 1e-8 and max constraint violation < 1e-8, best converged start
// wins, ties prefer smaller a then k closer to 0.06); and the §6.4 degraded
// paths (prior-only composition, log-speed regression, unavailable).

const (
	// evolvedV4HRBinS: fixed aggregation bin of the raw HR/speed series.
	// Implementation discretization: samples are time-weighted into 60 s
	// bins; the >10 s gap re-segmentation rule acts at bin boundaries.
	evolvedV4HRBinS = 60.0
	// evolvedV4HRMinBinCoverage: a bin needs this fraction of covered HR
	// time to be usable.
	evolvedV4HRMinBinCoverage = 0.5
	// evolvedV4HRMaxBinsPerActivity: deterministic cost guard per series.
	evolvedV4HRMaxBinsPerActivity = 400
)

// v4HRBin is one aggregated sample of a day's series.
type v4HRBin struct {
	T     float64 // bin end time on the activity clock
	Dt    float64 // residual time weight (bin width)
	LogV  float64
	HR    float64
	Sigma float64
	S     float64 // hours since the segment start
	Seg   int     // segment id within the series
	Init  bool    // first bin of its segment: initializes the filter, no residual
}

// v4HRSeriesBins is one admitted continuous HR series (one activity root).
type v4HRSeriesBins struct {
	Root    string
	Sensor  string
	Bins    []v4HRBin
	Role    string
	Reasons []string
}

// v4HRDay is one independent HR day (u_j/d_j unit).
type v4HRDay struct {
	Day     string
	AgeDays float64
	Series  []*v4HRSeriesBins
	Weight  float64 // §6.3 normalized age weight (assigned after admission)
}

// v4HRSeries is the admitted §6.1 input.
type v4HRSeries struct {
	Days []*v4HRDay
	// RegressionPoints: §6.4 steady-state end-segment points (day-keyed).
	RegressionPoints []v4RegressionPoint
	// Digest fields for the input identity hash.
	InputDigest interface{}
}

// v4RegressionPoint is one §6.4 steady-state regression observation.
type v4RegressionPoint struct {
	Day   string
	LogV  float64
	HR    float64
	Sigma float64
}

// v4Minimize1D is a deterministic bounded 1-D minimizer: fixed 9-point scan
// over the box, then golden-section refinement inside the winning bracket
// under the evaluation budget. The best of EVERY evaluated point (including
// both box ends) wins, so boundary minima are returned exactly.
func v4Minimize1D(f func(float64) float64, lo, hi float64, evals int) float64 {
	if !(hi > lo) {
		if hi < lo {
			lo, hi = hi, lo
		} else {
			return lo
		}
	}
	track := func(x, fx float64, bestX, bestF *float64) {
		if fx < *bestF {
			*bestX, *bestF = x, fx
		}
	}
	loF := f(lo)
	hiF := f(hi)
	bestX, bestF := lo, loF
	track(hi, hiF, &bestX, &bestF)
	used := 2
	const scan = 9
	scanBestX, scanBestF := bestX, bestF
	prevX, prevF := lo, loF
	bracketLo, bracketHi := lo, hi
	for i := 1; i <= scan && used < evals; i++ {
		x := lo + (hi-lo)*float64(i)/float64(scan)
		fx := f(x)
		used++
		if fx < scanBestF {
			if i == 1 {
				bracketLo, bracketHi = lo, hi
			} else {
				bracketLo, bracketHi = prevX, hi
			}
			if i == scan {
				bracketHi = x
			}
			scanBestX, scanBestF = x, fx
		} else if prevF < fx && scanBestX == prevX {
			bracketHi = x
		}
		track(x, fx, &bestX, &bestF)
		prevX, prevF = x, fx
	}
	if used+2 >= evals {
		return bestX
	}
	gl, gh := bracketLo, bracketHi
	if !(gl < scanBestX && scanBestX < gh) || gh-gl <= 0 {
		gl, gh = lo, hi
	}
	phi := (math.Sqrt(5) - 1) / 2
	x1 := gh - phi*(gh-gl)
	x2 := gl + phi*(gh-gl)
	f1, f2 := f(x1), f(x2)
	track(x1, f1, &bestX, &bestF)
	track(x2, f2, &bestX, &bestF)
	used += 2
	for used < evals && (gh-gl) > 1e-12*(1+math.Abs(gl)+math.Abs(gh)) {
		if f1 < f2 {
			gh, x2, f2 = x2, x1, f1
			x1 = gh - phi*(gh-gl)
			f1 = f(x1)
		} else {
			gl, x1, f1 = x1, x2, f2
			x2 = gl + phi*(gh-gl)
			f2 = f(x2)
		}
		used++
		track(x1, f1, &bestX, &bestF)
		track(x2, f2, &bestX, &bestF)
	}
	return bestX
}

// v4HRTheta is the HR parameter block.
type v4HRTheta struct {
	Eta     float64
	LogBeta float64
	LogTau  float64
	U       map[string]float64
	D       map[string]float64
}

func v4Clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// v4HRPhysiology carries the §6.2 R/M inputs with their sources.
type v4HRPhysiology struct {
	R *float64
	M *float64
	// HRMaxConflict: M is below a quality-verified recent observed HR
	// (§6.2 hrmax_input_conflict). The normalized model is suspended.
	HRMaxConflict            bool
	HRMaxConflictObservedBpm float64
	RSource, MSource         string
}

// v4HRMaxEstimate computes M from the existing profile (180-day recent
// window) and checks the §6.2 conflict rule against quality-verified recent
// (60-day) observations. Missing M keeps nil.
func v4HRMaxEstimate(history []Activity, asOf time.Time) v4HRPhysiology {
	out := v4HRPhysiology{}
	recent := make([]Activity, 0, len(history))
	windowStart := asOf.AddDate(0, 0, -v4AuditWindowDays)
	for _, a := range history {
		if inClosedRange(a.ActivityDate, windowStart, asOf) {
			recent = append(recent, a)
		}
	}
	profile := EstimateHRMaxProfile(recent)
	if profile.EstimatedHRMax != nil {
		m := *profile.EstimatedHRMax
		if m > 0 {
			out.M = &m
			out.MSource = "observed_max_" + string(profile.Confidence)
		}
	}
	// Quality-verified recent HR: supported timeseries values plus supported
	// activity maxima inside the 60-day current window.
	verified := 0.0
	currentStart := asOf.AddDate(0, 0, -v4CurrentWindowDays)
	for _, a := range recent {
		if !inClosedRange(a.ActivityDate, currentStart, asOf) {
			continue
		}
		supported := supportedTimeseriesHRValues(a)
		for _, v := range supported {
			if v > verified {
				verified = v
			}
		}
		if activityMaxHRSupported(a, supported) && a.MaxHR != nil && *a.MaxHR > verified {
			verified = *a.MaxHR
		}
	}
	if out.M != nil && verified > *out.M {
		out.HRMaxConflict = true
		out.HRMaxConflictObservedBpm = verified
	}
	return out
}

// evolvedRestingHRPrior qualifies the physiological prior from daily resting
// HR rows inside the evidence window (§6.2 R with a real measurement source).
// Kept behavior-identical to the rev2 gate (protocol v2 eligibility reads it).
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

// v4BuildHRSeries admits the §6.1 usable segments: continuous >= 8 minute
// spans with usable speed and comparable conditions, speed variation kept,
// gaps > 10 s re-segmenting, no fabricated per-second HR. One raw time slice
// per activity root; root-day conflicts drop the whole root.
func v4BuildHRSeries(history []Activity, metadata []CandidateMetadata, hrEvidence *CandidateHRReport, asOf time.Time, priors EvolvedPriorSet) *v4HRSeries {
	out := &v4HRSeries{}
	meta, _ := admittedCandidateMetadata(metadata, asOf)
	// Inherit the shared v1 observation verdicts (cadence lock, broken
	// clock) by activity id.
	verdicts := map[string]*CandidateHRObservation{}
	if hrEvidence != nil {
		for i := range hrEvidence.Observations {
			verdicts[hrEvidence.Observations[i].ActivityID] = &hrEvidence.Observations[i]
		}
	}
	activities := append([]Activity(nil), history...)
	sort.Slice(activities, func(i, j int) bool {
		if activities[i].LabelID != activities[j].LabelID {
			return activities[i].LabelID < activities[j].LabelID
		}
		return ReplayContentHash(activities[i]) < ReplayContentHash(activities[j])
	})
	rootDay := map[string]string{}
	rootSeries := map[string]*v4HRSeriesBins{}
	rootOrder := []string{}
	for i := range activities {
		a := &activities[i]
		if a.LabelID == "" || a.ActivityDate.IsZero() || !isRunning(*a) {
			continue
		}
		age := dayDiff(asOf, a.ActivityDate)
		if age < 0 || age > v4AuditWindowDays {
			continue
		}
		m, hasMeta := meta[a.LabelID]
		if !hasMeta {
			m = CandidateMetadata{ActivityID: a.LabelID, SourceVersion: "unavailable"}
		}
		root := m.RootActivityID
		if root == "" {
			root = a.LabelID
		}
		day := a.ActivityDate.Format("2006-01-02")
		if prior, ok := rootDay[root]; ok && prior != day {
			// Contradictory root days keep audit rows but drop support.
			if s, seen := rootSeries[root]; seen {
				s.Role = "root_activity_day_conflict"
				s.Bins = nil
			}
			continue
		}
		rootDay[root] = day
		sensor := "unknown"
		if m.HR != nil && m.HR.Sensor != "" {
			sensor = m.HR.Sensor
		}
		if v, ok := verdicts[a.LabelID]; ok && v.Sensor != "" && v.Sensor != "unknown" {
			sensor = v.Sensor
		}
		sigma := priors.HRSigmaOpticalBpm
		if sensor == "chest_strap" {
			sigma = priors.HRSigmaStrapBpm
		}
		series := &v4HRSeriesBins{Root: root, Sensor: sensor, Role: "model_series"}
		excluded := false
		if !v4ConditionsComparable(m.Terrain, m.Device) {
			// §6.1: prefer segments that are continuous >= 8 min with usable
			// speed AND comparable conditions — known assist/bias terrain
			// never feeds the reference-condition HR model.
			series.Role = "conditions_not_comparable"
			excluded = true
		}
		if m.Interrupted {
			series.Role = "interruption_mapping_unverified"
			excluded = true
		}
		if v, ok := verdicts[a.LabelID]; ok {
			for _, q := range v.Quality.Reasons {
				if q == "suspected_HR_cadence_lock" || q == "non_increasing_or_missing_HR_clock" {
					series.Role = "quality_excluded_" + q
					excluded = true
				}
			}
		}
		if !excluded {
			bins := v4HRActivityBins(*a, sigma, priors)
			if len(bins) > 0 {
				series.Bins = bins
			} else {
				series.Role = "no_usable_bins"
				excluded = true
			}
		}
		if _, seen := rootSeries[root]; !seen {
			rootOrder = append(rootOrder, root)
		} else if rootSeries[root].Role == "model_series" {
			// One raw time slice per root: the first (deterministic) alias
			// wins; later aliases never add overlapping support.
			series.Role = "duplicate_root_alias"
			series.Bins = nil
		}
		rootSeries[root] = series
	}
	// Group by day; drop conflicts.
	dayMap := map[string]*v4HRDay{}
	dayOrder := []string{}
	for _, root := range rootOrder {
		s := rootSeries[root]
		if s.Role != "model_series" || len(s.Bins) == 0 {
			continue
		}
		day := rootDay[root]
		if dayMap[day] == nil {
			dayMap[day] = &v4HRDay{Day: day}
			dayOrder = append(dayOrder, day)
		}
		dayMap[day].Series = append(dayMap[day].Series, s)
	}
	sort.Strings(dayOrder)
	for _, day := range dayOrder {
		d := dayMap[day]
		parsed, err := time.ParseInLocation("2006-01-02", day, time.UTC)
		if err == nil {
			d.AgeDays = float64(dayDiff(asOf, parsed))
		}
		out.Days = append(out.Days, d)
	}
	// §6.3 weights: HR-selected independent days normalized per §5.2
	// (30-day half-life), independent of the pace pool.
	if len(out.Days) > 0 {
		total := 0.0
		for _, d := range out.Days {
			total += math.Exp2(-d.AgeDays / 30)
		}
		D := float64(len(out.Days))
		for _, d := range out.Days {
			d.Weight = D * math.Exp2(-d.AgeDays/30) / total
		}
	}
	// §6.4 regression points from the admitted series' end segments.
	out.RegressionPoints = v4RegressionPoints(out, priors)
	out.InputDigest = v4HRSeriesDigest(out)
	return out
}

// v4HRActivityBins aggregates one activity into fixed bins, splits segments
// on > 10 s gaps and invalid speed, and keeps segments with at least 8
// continuous minutes.
func v4HRActivityBins(a Activity, sigma float64, priors EvolvedPriorSet) []v4HRBin {
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
	nBins := int(math.Floor((end - start) / evolvedV4HRBinS))
	if nBins < 1 {
		return nil
	}
	if nBins > evolvedV4HRMaxBinsPerActivity {
		nBins = evolvedV4HRMaxBinsPerActivity
	}
	hrSum := make([]float64, nBins)
	hrCover := make([]float64, nBins)
	spSum := make([]float64, nBins)
	spCover := make([]float64, nBins)
	for i := 1; i < len(pairs); i++ {
		x, y := pairs[i-1], pairs[i]
		dt := y.t - x.t
		if dt <= 0 || dt > 10 {
			continue
		}
		b0 := int(math.Floor((x.t - start) / evolvedV4HRBinS))
		if b0 < 0 {
			b0 = 0
		}
		for b := b0; b < nBins; b++ {
			bl := start + float64(b)*evolvedV4HRBinS
			br := bl + evolvedV4HRBinS
			left, right := math.Max(x.t, bl), math.Min(y.t, br)
			if right <= left {
				if br > y.t {
					break
				}
				continue
			}
			if x.hr != nil && y.hr != nil {
				hl := *x.hr + (*y.hr-*x.hr)*(left-x.t)/dt
				hrr := *x.hr + (*y.hr-*x.hr)*(right-x.t)/dt
				hrSum[b] += (hl + hrr) / 2 * (right - left)
				hrCover[b] += right - left
			}
			if x.speed != nil && y.speed != nil {
				sl := *x.speed + (*y.speed-*x.speed)*(left-x.t)/dt
				sr := *x.speed + (*y.speed-*x.speed)*(right-x.t)/dt
				if sl >= 0 && sr >= 0 {
					spSum[b] += (sl + sr) / 2 * (right - left)
					spCover[b] += right - left
				}
			}
			if br > y.t {
				break
			}
		}
	}
	bins := make([]v4HRBin, 0, nBins)
	type segAccum struct {
		bins []v4HRBin
	}
	var segs []segAccum
	cur := segAccum{}
	for b := 0; b < nBins; b++ {
		usable := hrCover[b] >= evolvedV4HRMinBinCoverage*evolvedV4HRBinS &&
			spCover[b] >= evolvedV4HRMinBinCoverage*evolvedV4HRBinS*0.5
		if !usable {
			if len(cur.bins) > 0 {
				segs = append(segs, cur)
				cur = segAccum{}
			}
			continue
		}
		hr := hrSum[b] / hrCover[b]
		speed := spSum[b] / spCover[b]
		// Non-positive or out-of-running-domain speed: no log v; segment
		// boundary (never filled with a tiny positive number).
		if !(speed > 0 && speed <= v4MaxPlausibleSpeedMps) {
			if len(cur.bins) > 0 {
				segs = append(segs, cur)
				cur = segAccum{}
			}
			continue
		}
		if !(hr >= contractHRValidLowBpm && hr <= contractHRValidHighBpm) {
			if len(cur.bins) > 0 {
				segs = append(segs, cur)
				cur = segAccum{}
			}
			continue
		}
		cur.bins = append(cur.bins, v4HRBin{
			T: start + float64(b+1)*evolvedV4HRBinS, Dt: evolvedV4HRBinS,
			LogV: math.Log(speed), HR: hr, Sigma: sigma,
		})
	}
	if len(cur.bins) > 0 {
		segs = append(segs, cur)
	}
	segCounter := 0
	for si := range segs {
		// Gap > 10 s already splits (missing bins break the accumulation);
		// keep only >= 8 minute segments (§6.1).
		if float64(len(segs[si].bins))*evolvedV4HRBinS < priors.HRMinSegmentS {
			continue
		}
		segStartT := segs[si].bins[0].T - evolvedV4HRBinS
		for bi := range segs[si].bins {
			bin := &segs[si].bins[bi]
			bin.Seg = segCounter
			bin.S = (bin.T - evolvedV4HRBinS - segStartT) / 3600
			bin.Init = bi == 0
			bins = append(bins, *bin)
		}
		segCounter++
	}
	return bins
}

// v4HRSeriesDigest is the bounded deterministic digest of the admitted
// series (activity roots/days only — never raw samples).
func v4HRSeriesDigest(s *v4HRSeries) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(s.Days))
	for _, d := range s.Days {
		roots := make([]string, 0, len(d.Series))
		bins := 0
		for _, ser := range d.Series {
			roots = append(roots, ser.Root)
			bins += len(ser.Bins)
		}
		sort.Strings(roots)
		out = append(out, map[string]interface{}{"day": d.Day, "roots": roots, "bins": bins})
	}
	return out
}

// v4RegressionPoints extracts the §6.4 steady-state end segments: the last 5
// minutes of each admitted continuous segment with speed CV <= 0.12, HR
// first/last 1-minute means within 5 bpm and >= 95% HR coverage. Full
// time-weighted means; never the highest HR.
func v4RegressionPoints(s *v4HRSeries, priors EvolvedPriorSet) []v4RegressionPoint {
	points := []v4RegressionPoint{}
	for _, d := range s.Days {
		for _, ser := range d.Series {
			// Split bins into segments.
			segs := [][]v4HRBin{}
			cur := []v4HRBin{}
			for _, b := range ser.Bins {
				if len(cur) == 0 || cur[len(cur)-1].Seg == b.Seg {
					cur = append(cur, b)
				} else {
					segs = append(segs, cur)
					cur = []v4HRBin{b}
				}
			}
			if len(cur) > 0 {
				segs = append(segs, cur)
			}
			for _, seg := range segs {
				n := len(seg)
				// Last 5 minutes.
				m := int(300 / evolvedV4HRBinS)
				if n < m {
					continue
				}
				win := seg[n-m:]
				// >= 95% HR coverage in window: bins were admitted at >= 50%
				// each; require no more than 5% of window length missing.
				missing := 0
				for i := 1; i < len(win); i++ {
					if win[i].T-win[i-1].T > evolvedV4HRBinS+1e-9 {
						missing++
					}
				}
				if float64(missing)/float64(len(win)) > 0.05 {
					continue
				}
				// Speed CV (full time-weighted moments in the speed domain —
				// not a log-domain approximation).
				var sumV, sumV2, wsum float64
				for _, b := range win {
					v := math.Exp(b.LogV)
					sumV += v * b.Dt
					sumV2 += v * v * b.Dt
					wsum += b.Dt
				}
				meanV := sumV / wsum
				varV := math.Max(0, sumV2/wsum-meanV*meanV)
				if meanV > 0 && math.Sqrt(varV)/meanV > 0.12 {
					continue
				}
				// HR first/last 1-minute means.
				firstN := int(60 / evolvedV4HRBinS)
				if firstN < 1 {
					firstN = 1
				}
				var f, l float64
				for i := 0; i < firstN && i < len(win); i++ {
					f += win[i].HR
				}
				f /= float64(min(firstN, len(win)))
				for i := 0; i < firstN; i++ {
					l += win[len(win)-1-i].HR
				}
				l /= float64(min(firstN, len(win)))
				if math.Abs(f-l) > 5 {
					continue
				}
				var hr float64
				for _, b := range win {
					hr += b.HR * b.Dt
				}
				hr /= wsum
				points = append(points, v4RegressionPoint{Day: d.Day, LogV: math.Log(meanV), HR: hr, Sigma: win[0].Sigma})
			}
		}
	}
	sort.Slice(points, func(i, j int) bool {
		if points[i].Day != points[j].Day {
			return points[i].Day < points[j].Day
		}
		return points[i].LogV < points[j].LogV
	})
	return points
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ---------------------------------------------------------------------------
// Joint objective and solver (§6.3, §8.1)
// ---------------------------------------------------------------------------

// v4HRJointSolver holds the immutable inputs of one joint solve.
type v4HRJointSolver struct {
	pace   *v4PaceObjective
	series *v4HRSeries
	phys   v4HRPhysiology
	priors EvolvedPriorSet
	// lambdaH (scenario-modified), q60/beta prior centers (scenario-modified).
	lambdaH    float64
	etaCenter  float64
	betaCenter float64
	// Eta domain (q60 box ∩ H60 in [80,230]).
	etaLo, etaHi float64
	days         []*v4HRDay
	dayWeights   []float64 // effective-duration weights for sum(w_j u_j)=0
	constraintW  []float64
}

// v4HRJointConfig mutates priors for §8.2 scenarios.
type v4HRJointConfig struct {
	LambdaH    *float64
	Q60Center  *float64
	BetaCenter *float64
	RDeltaBpm  *float64
	MDeltaBpm  *float64
}

func newV4HRJointSolver(pace *v4PaceObjective, series *v4HRSeries, phys v4HRPhysiology, priors EvolvedPriorSet, cfg v4HRJointConfig) *v4HRJointSolver {
	s := &v4HRJointSolver{pace: pace, series: series, phys: phys, priors: priors, lambdaH: priors.LambdaH}
	s.etaCenter = priors.HR.Eta.Mean
	s.betaCenter = priors.HR.LogBeta.Mean
	if cfg.LambdaH != nil {
		s.lambdaH = *cfg.LambdaH
	}
	r := phys.R
	m := phys.M
	if cfg.RDeltaBpm != nil && r != nil {
		v := *r + *cfg.RDeltaBpm
		r = &v
	}
	if cfg.MDeltaBpm != nil && m != nil {
		v := *m + *cfg.MDeltaBpm
		m = &v
	}
	s.phys.R, s.phys.M = r, m
	if cfg.Q60Center != nil {
		s.etaCenter = math.Log(*cfg.Q60Center / (1 - *cfg.Q60Center))
	}
	if cfg.BetaCenter != nil {
		s.betaCenter = math.Log(*cfg.BetaCenter)
	}
	s.days = series.Days
	s.dayWeights = make([]float64, len(s.days))
	s.constraintW = make([]float64, len(s.days))
	for i, d := range s.days {
		s.dayWeights[i] = d.Weight
		total := 0.0
		for _, ser := range d.Series {
			for _, b := range ser.Bins {
				total += b.Dt
			}
		}
		s.constraintW[i] = total
	}
	// Eta domain: q60 in [0.65, 0.98] ∩ H60 = R+(M-R) sigmoid(eta) in [80,230].
	lo, hi := priors.HR.Eta.Low, priors.HR.Eta.High
	if r != nil && m != nil && *m > *r {
		span := *m - *r
		qLo := (priors.HRDomainLowBpm - *r) / span
		qHi := (priors.HRDomainHighBpm - *r) / span
		qLo = v4Clamp(qLo, 1e-6, 1-1e-6)
		qHi = v4Clamp(qHi, 1e-6, 1-1e-6)
		if cl := math.Log(qLo / (1 - qLo)); cl > lo {
			lo = cl
		}
		if ch := math.Log(qHi / (1 - qHi)); ch < hi {
			hi = ch
		}
	}
	s.etaLo, s.etaHi = lo, hi
	return s
}

// dayLoss computes one day's time-mean Huber loss given (a, theta).
func (s *v4HRJointSolver) dayLoss(d *v4HRDay, a float64, th *v4HRTheta) float64 {
	if s.phys.R == nil || s.phys.M == nil {
		return 0
	}
	R, M := *s.phys.R, *s.phys.M
	beta := math.Exp(th.LogBeta)
	tau := math.Exp(th.LogTau)
	u := th.U[d.Day]
	dd := th.D[d.Day]
	decay := math.Exp(-evolvedV4HRBinS / tau)
	var loss, wsum float64
	for _, ser := range d.Series {
		var hhat float64
		var prev v4HRBin
		hasPrev := false
		for i := range ser.Bins {
			b := &ser.Bins[i]
			if b.Init || !hasPrev {
				// First valid HR of the segment initializes the filter; the
				// point itself carries no residual (§6.2).
				hhat = b.HR
				prev = *b
				hasPrev = true
				continue
			}
			// Left-endpoint speed and drift (§6.2), step decay with bin dt.
			hs := R + (M-R)*sigmoid(th.Eta+beta*(prev.LogV-a)+u+dd*prev.S)
			step := decay
			if math.Abs(b.T-prev.T-evolvedV4HRBinS) > 1e-9 {
				step = math.Exp(-(b.T - prev.T) / tau)
			}
			hhat = hs + (hhat-hs)*step
			z := (b.HR - hhat) / b.Sigma
			loss += b.Dt * huber15(z)
			wsum += b.Dt
			prev = *b
		}
	}
	if wsum <= 0 {
		return 0
	}
	return loss / wsum
}

func sigmoid(z float64) float64 { return 1 / (1 + math.Exp(-z)) }

// hrLossTotal is the raw §6.3 HR loss L_H = Σ_j W_j·TimeMean ρ1.5(...) at
// (a, theta) — the per-side loss total the diagnostics must output.
func (s *v4HRJointSolver) hrLossTotal(a float64, th *v4HRTheta) float64 {
	if len(s.days) == 0 {
		return 0
	}
	lh := 0.0
	for _, d := range s.days {
		lh += d.Weight * s.dayLoss(d, a, th)
	}
	return lh
}

// v4WithoutDay returns a copy of the series without one independent day
// (§8.2 leave-one-day), with the §6.3 day weights renormalized over the
// remaining days.
func (s *v4HRSeries) v4WithoutDay(day string) *v4HRSeries {
	out := &v4HRSeries{}
	for _, d := range s.Days {
		if d.Day == day {
			continue
		}
		// Deep-copy the day: the renormalized weight must never leak back
		// into the shared series (scenario solves run concurrently).
		cp := *d
		cp.Series = append([]*v4HRSeriesBins(nil), d.Series...)
		out.Days = append(out.Days, &cp)
	}
	if len(out.Days) > 0 {
		total := 0.0
		for _, d := range out.Days {
			total += math.Exp2(-d.AgeDays / 30)
		}
		D := float64(len(out.Days))
		for _, d := range out.Days {
			d.Weight = D * math.Exp2(-d.AgeDays/30) / total
		}
	}
	out.RegressionPoints = s.RegressionPoints
	out.InputDigest = s.InputDigest
	return out
}

// lhAndPriors evaluates lambda_H*L_H + HR priors at (a, theta).
func (s *v4HRJointSolver) lhAndPriors(a float64, th *v4HRTheta) float64 {
	if len(s.days) == 0 || s.phys.R == nil || s.phys.M == nil {
		return s.hrPriors(th)
	}
	lh := 0.0
	for _, d := range s.days {
		lh += d.Weight * s.dayLoss(d, a, th)
	}
	return s.lambdaH*lh + s.hrPriors(th)
}

func (s *v4HRJointSolver) hrPriors(th *v4HRTheta) float64 {
	p := s.priors.HR
	j := 0.5 * math.Pow((th.Eta-s.etaCenter)/p.Eta.SD, 2)
	j += 0.5 * math.Pow((th.LogBeta-s.betaCenter)/p.LogBeta.SD, 2)
	j += 0.5 * math.Pow((th.LogTau-p.LogTauS.Mean)/p.LogTauS.SD, 2)
	if len(s.days) > 0 {
		// u/d regularizers averaged over days (§6.2).
		uj, dj := 0.0, 0.0
		for _, d := range s.days {
			uj += 0.5 * math.Pow(th.U[d.Day]/p.DayEffectU.SD, 2)
			dj += 0.5 * math.Pow(th.D[d.Day]/p.DriftDPerHour.SD, 2)
		}
		j += (uj + dj) / float64(len(s.days))
	}
	return j
}

// fullObjective is J(a,k,theta) = L_P + L_k + lambda_H L_H + HR priors.
func (s *v4HRJointSolver) fullObjective(a, k float64, th *v4HRTheta) float64 {
	lp, _ := s.pace.evaluate(a, k)
	return s.pace.objectivePlus(lp, k) + s.lhAndPriors(a, th)
}

// projectDayEffects enforces sum(w_j u_j) = 0 (weighted by effective
// duration) inside the u box: u_j = clamp(v_j − λ) with λ found by bisection
// on the monotone weighted sum — exact to machine scale in a fixed, sorted
// day order (deterministic; no shift-then-clamp stall).
func (s *v4HRJointSolver) projectDayEffects(th *v4HRTheta) {
	if len(s.days) == 0 {
		return
	}
	box := s.priors.HR.DayEffectU
	target := func(lambda float64) float64 {
		sum := 0.0
		for i, d := range s.days {
			u := th.U[d.Day] - lambda
			if u < box.Low {
				u = box.Low
			} else if u > box.High {
				u = box.High
			}
			sum += s.constraintW[i] * u
		}
		return sum
	}
	lo, hi := -2.0, 2.0 // lambda range comfortably beyond the u box
	if target(lo) <= 0 {
		// Every day pinned low: minimum-violation state keeps the box.
		for _, d := range s.days {
			th.U[d.Day] = v4Clamp(th.U[d.Day]-lo, box.Low, box.High)
		}
		return
	}
	if target(hi) >= 0 {
		for _, d := range s.days {
			th.U[d.Day] = v4Clamp(th.U[d.Day]-hi, box.Low, box.High)
		}
		return
	}
	for n := 0; n < 80; n++ {
		mid := (lo + hi) / 2
		if target(mid) > 0 {
			lo = mid
		} else {
			hi = mid
		}
	}
	for _, d := range s.days {
		u := th.U[d.Day] - (lo+hi)/2
		if u < box.Low {
			u = box.Low
		} else if u > box.High {
			u = box.High
		}
		th.U[d.Day] = u
	}
}

// v4HRJointResult is one start's converged state.
type v4HRJointResult struct {
	A, K, Obj float64
	Theta     v4HRTheta
	Converged bool
	Rounds    int
}

// solveFrom runs the bounded deterministic coordinate descent from one
// (k, a0) start. Iteration cap 500 rounds; convergence requires relative
// objective change < 1e-8 and max constraint violation < 1e-8.
func (s *v4HRJointSolver) solveFrom(k, a0 float64) v4HRJointResult {
	res := v4HRJointResult{K: k, Obj: math.Inf(1)}
	lo, hi, ok := s.pace.boundsAtK(k)
	if !ok {
		return res
	}
	p := s.priors.HR
	th := v4HRTheta{
		Eta:     v4Clamp(s.priors.HR.Eta.Mean, s.etaLo, s.etaHi),
		LogBeta: p.LogBeta.Mean,
		LogTau:  p.LogTauS.Mean,
		U:       map[string]float64{},
		D:       map[string]float64{},
	}
	for _, d := range s.days {
		th.U[d.Day] = 0
		th.D[d.Day] = 0
	}
	a := v4Clamp(a0, lo, hi)
	const evals = 24
	// Best-state tracking: the per-day coordinate passes plus the weighted
	// zero projection can cycle without improving the objective; the solve
	// converges when a full round no longer improves the best objective
	// (§8.1: relative objective change < 1e-8), returning the best state.
	bestA, bestJ := a, s.fullObjective(a, k, &th)
	bestTh := v4CopyTheta(&th)
	for round := 1; round <= 500; round++ {
		// a block.
		a = v4Minimize1D(func(x float64) float64 { return s.fullObjective(x, k, &th) }, lo, hi, evals)
		// eta block (theta mutated in place, restored around each probe).
		th.Eta = v4Minimize1D(func(x float64) float64 {
			saved := th.Eta
			th.Eta = x
			j := s.fullObjective(a, k, &th)
			th.Eta = saved
			return j
		}, s.etaLo, s.etaHi, evals)
		// log beta block.
		th.LogBeta = v4Minimize1D(func(x float64) float64 {
			saved := th.LogBeta
			th.LogBeta = x
			j := s.fullObjective(a, k, &th)
			th.LogBeta = saved
			return j
		}, p.LogBeta.Low, p.LogBeta.High, evals)
		// log tau block.
		th.LogTau = v4Minimize1D(func(x float64) float64 {
			saved := th.LogTau
			th.LogTau = x
			j := s.fullObjective(a, k, &th)
			th.LogTau = saved
			return j
		}, p.LogTauS.Low, p.LogTauS.High, evals)
		// per-day u (sorted day order), then the weighted zero projection.
		for _, d := range s.days {
			th.U[d.Day] = v4Minimize1D(func(x float64) float64 {
				saved := th.U[d.Day]
				th.U[d.Day] = x
				j := s.lhOnly(d, a, &th)
				th.U[d.Day] = saved
				return j
			}, p.DayEffectU.Low, p.DayEffectU.High, evals)
		}
		s.projectDayEffects(&th)
		// per-day drift.
		for _, d := range s.days {
			th.D[d.Day] = v4Minimize1D(func(x float64) float64 {
				saved := th.D[d.Day]
				th.D[d.Day] = x
				j := s.lhOnly(d, a, &th)
				th.D[d.Day] = saved
				return j
			}, p.DriftDPerHour.Low, p.DriftDPerHour.High, evals)
		}
		j := s.fullObjective(a, k, &th)
		res.Rounds = round
		if j < bestJ-v4TieTolerance*math.Max(1, math.Abs(bestJ)) {
			bestA, bestJ, bestTh = a, j, v4CopyTheta(&th)
			continue
		}
		if j < bestJ {
			bestA, bestJ, bestTh = a, j, v4CopyTheta(&th)
		}
		// No material improvement this round: converged on the best state.
		if s.constraintViolation(bestA, k, &bestTh) < v4TieTolerance {
			res.Converged = true
			break
		}
	}
	res.A, res.Obj, res.Theta = bestA, bestJ, bestTh
	return res
}

func v4CopyTheta(th *v4HRTheta) v4HRTheta {
	out := v4HRTheta{Eta: th.Eta, LogBeta: th.LogBeta, LogTau: th.LogTau, U: make(map[string]float64, len(th.U)), D: make(map[string]float64, len(th.D))}
	keys := make([]string, 0, len(th.U))
	for k := range th.U {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out.U[k] = th.U[k]
	}
	keys = keys[:0]
	for k := range th.D {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out.D[k] = th.D[k]
	}
	return out
}

// lhOnly evaluates one day's contribution to the joint objective — its
// lambda_H-weighted day loss plus its per-day prior share — for the u/d
// coordinate updates. The lambda factor is part of the SAME objective: with
// lambda_H = 0 the day effects stay at their prior centers.
func (s *v4HRJointSolver) lhOnly(d *v4HRDay, a float64, th *v4HRTheta) float64 {
	return s.lambdaH*d.Weight*s.dayLoss(d, a, th) + (0.5*math.Pow(th.U[d.Day]/s.priors.HR.DayEffectU.SD, 2)+0.5*math.Pow(th.D[d.Day]/s.priors.HR.DriftDPerHour.SD, 2))/math.Max(1, float64(len(s.days)))
}

func (s *v4HRJointSolver) constraintViolation(a, k float64, th *v4HRTheta) float64 {
	v := math.Max(0, s.pace.floor.aFloor(k).Value-a)
	sum, total := 0.0, 0.0
	for i, d := range s.days {
		sum += s.constraintW[i] * th.U[d.Day]
		total += s.constraintW[i]
	}
	if total > 0 {
		v = math.Max(v, math.Abs(sum)/total)
	}
	return v
}

// solveJoint runs the full §8.1 HR-branch enumeration: every k on the grid,
// three deterministic a starts each (pace-only solution, 1.03x, 1.08x), HR
// parameters initialized from the table; the best converged start wins; ties
// prefer the smaller a, then the k closer to 0.06. The per-(k, start) solves
// are independent; they run concurrently but the reduction below walks the
// fixed (k, lift) order, so the reported winner is scheduling-independent.
func (s *v4HRJointSolver) solveJoint() v4HRJointResult {
	jobs := make([]v4HRStartJob, 0, 3*len(s.pace.byK))
	for _, pt := range s.pace.byK {
		if !pt.Feasible {
			continue
		}
		for _, lift := range []float64{0, math.Log(1.03), math.Log(1.08)} {
			jobs = append(jobs, v4HRStartJob{k: pt.K, a0: pt.A + lift})
		}
	}
	results := s.solveJobs(jobs)
	best := v4HRJointResult{Obj: math.Inf(1)}
	for _, r := range results {
		if !r.Converged || !v4Finite(r.Obj) {
			continue
		}
		if v4BetterSolution(r.Obj, r.A, r.K, best.Obj, best.A, best.K) {
			best = r
		}
	}
	return best
}

// solveJobs runs the independent starts on a bounded worker pool. Every job
// touches only its own theta copy; the shared solver state is read-only.
type v4HRStartJob struct {
	k, a0 float64
}

func (s *v4HRJointSolver) solveJobs(jobs []v4HRStartJob) []v4HRJointResult {
	results := make([]v4HRJointResult, len(jobs))
	workers := runtime.GOMAXPROCS(0)
	if workers > 8 {
		workers = 8
	}
	if workers < 2 || len(jobs) < 8 {
		for i, j := range jobs {
			results[i] = s.solveFrom(j.k, j.a0)
		}
		return results
	}
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
				results[i] = s.solveFrom(jobs[i].k, jobs[i].a0)
			}
		}()
	}
	wg.Wait()
	return results
}

// solveJointAtK runs the same three-start procedure at one fixed k (§8.2
// fixed-k scenarios).
func (s *v4HRJointSolver) solveJointAtK(k float64) v4HRJointResult {
	best := v4HRJointResult{Obj: math.Inf(1)}
	for _, pt := range s.pace.byK {
		if !pt.Feasible || math.Abs(pt.K-k) > 1e-12 {
			continue
		}
		for _, lift := range []float64{0, math.Log(1.03), math.Log(1.08)} {
			r := s.solveFrom(pt.K, pt.A+lift)
			if !r.Converged || !v4Finite(r.Obj) {
				continue
			}
			if v4BetterSolution(r.Obj, r.A, r.K, best.Obj, best.A, best.K) {
				best = r
			}
		}
		break
	}
	return best
}

// solveThetaAtA minimizes the HR block (lambda_H*L_H + priors) over theta at
// a fixed a — the §8.2 profile's "re-optimize the remaining parameters". It
// is a deterministic warm-started continuation across grid points.
func (s *v4HRJointSolver) solveThetaAtA(a float64, warm *v4HRTheta, maxRounds int) (v4HRTheta, float64) {
	p := s.priors.HR
	th := v4HRTheta{Eta: p.Eta.Mean, LogBeta: p.LogBeta.Mean, LogTau: p.LogTauS.Mean, U: map[string]float64{}, D: map[string]float64{}}
	if warm != nil {
		th.Eta, th.LogBeta, th.LogTau = warm.Eta, warm.LogBeta, warm.LogTau
		for d, v := range warm.U {
			th.U[d] = v
		}
		for d, v := range warm.D {
			th.D[d] = v
		}
	}
	for _, d := range s.days {
		if _, ok := th.U[d.Day]; !ok {
			th.U[d.Day] = 0
		}
		if _, ok := th.D[d.Day]; !ok {
			th.D[d.Day] = 0
		}
	}
	th.Eta = v4Clamp(th.Eta, s.etaLo, s.etaHi)
	const evals = 24
	best := math.Inf(1)
	var bestTh v4HRTheta
	for round := 1; round <= maxRounds; round++ {
		th.Eta = v4Minimize1D(func(x float64) float64 {
			saved := th.Eta
			th.Eta = x
			j := s.lhAndPriors(a, &th)
			th.Eta = saved
			return j
		}, s.etaLo, s.etaHi, evals)
		th.LogBeta = v4Minimize1D(func(x float64) float64 {
			saved := th.LogBeta
			th.LogBeta = x
			j := s.lhAndPriors(a, &th)
			th.LogBeta = saved
			return j
		}, p.LogBeta.Low, p.LogBeta.High, evals)
		th.LogTau = v4Minimize1D(func(x float64) float64 {
			saved := th.LogTau
			th.LogTau = x
			j := s.lhAndPriors(a, &th)
			th.LogTau = saved
			return j
		}, p.LogTauS.Low, p.LogTauS.High, evals)
		for _, d := range s.days {
			th.U[d.Day] = v4Minimize1D(func(x float64) float64 {
				saved := th.U[d.Day]
				th.U[d.Day] = x
				j := s.lhOnly(d, a, &th)
				th.U[d.Day] = saved
				return j
			}, p.DayEffectU.Low, p.DayEffectU.High, evals)
		}
		s.projectDayEffects(&th)
		for _, d := range s.days {
			th.D[d.Day] = v4Minimize1D(func(x float64) float64 {
				saved := th.D[d.Day]
				th.D[d.Day] = x
				j := s.lhOnly(d, a, &th)
				th.D[d.Day] = saved
				return j
			}, p.DriftDPerHour.Low, p.DriftDPerHour.High, evals)
		}
		j := s.lhAndPriors(a, &th)
		if j < best-v4TieTolerance*math.Max(1, math.Abs(best)) {
			best, bestTh = j, v4CopyTheta(&th)
			continue
		}
		if j < best {
			best, bestTh = j, v4CopyTheta(&th)
		}
		return bestTh, best
	}
	return th, s.lhAndPriors(a, &th)
}

// solveAtH60 runs the §8.2 H60 constrained profile at one H60 grid value:
// eta is pinned by H60 = R+(M-R)*sigmoid(eta) and a/k/beta/tau/u/d are
// re-optimized (k as a bounded coordinate), warm-started by continuation.
func (s *v4HRJointSolver) solveAtH60(h60 float64, warm *v4HRJointResult, maxRounds int) (v4HRJointResult, bool) {
	if s.phys.R == nil || s.phys.M == nil || *s.phys.M <= *s.phys.R {
		return v4HRJointResult{}, false
	}
	q := (h60 - *s.phys.R) / (*s.phys.M - *s.phys.R)
	if !(q > 1e-6 && q < 1-1e-6) {
		return v4HRJointResult{}, false
	}
	eta := math.Log(q / (1 - q))
	if eta < s.etaLo || eta > s.etaHi {
		return v4HRJointResult{}, false
	}
	p := s.priors.HR
	th := v4HRTheta{Eta: eta, LogBeta: p.LogBeta.Mean, LogTau: p.LogTauS.Mean, U: map[string]float64{}, D: map[string]float64{}}
	a, k := math.Log(3.4), 0.06
	if warm != nil {
		th.LogBeta, th.LogTau = warm.Theta.LogBeta, warm.Theta.LogTau
		for d, v := range warm.Theta.U {
			th.U[d] = v
		}
		for d, v := range warm.Theta.D {
			th.D[d] = v
		}
		a, k = warm.A, warm.K
	}
	for _, d := range s.days {
		if _, ok := th.U[d.Day]; !ok {
			th.U[d.Day] = 0
		}
		if _, ok := th.D[d.Day]; !ok {
			th.D[d.Day] = 0
		}
	}
	const evals = 24
	best := math.Inf(1)
	var bestState v4HRJointResult
	for round := 1; round <= maxRounds; round++ {
		loK, hiK := riegelKMin, riegelKMax
		// k coordinate, subject to a >= A_floor(k): feasible k range first.
		k = v4Minimize1D(func(x float64) float64 {
			alo, _, ok := s.pace.boundsAtK(x)
			if !ok {
				return math.Inf(1)
			}
			aa := v4Clamp(a, alo, s.pace.aHi)
			return s.fullObjective(aa, x, &th)
		}, loK, hiK, evals)
		lo, hi, ok := s.pace.boundsAtK(k)
		if !ok {
			return v4HRJointResult{}, false
		}
		a = v4Minimize1D(func(x float64) float64 { return s.fullObjective(x, k, &th) }, lo, hi, evals)
		th.LogBeta = v4Minimize1D(func(x float64) float64 {
			saved := th.LogBeta
			th.LogBeta = x
			j := s.fullObjective(a, k, &th)
			th.LogBeta = saved
			return j
		}, p.LogBeta.Low, p.LogBeta.High, evals)
		th.LogTau = v4Minimize1D(func(x float64) float64 {
			saved := th.LogTau
			th.LogTau = x
			j := s.fullObjective(a, k, &th)
			th.LogTau = saved
			return j
		}, p.LogTauS.Low, p.LogTauS.High, evals)
		for _, d := range s.days {
			th.U[d.Day] = v4Minimize1D(func(x float64) float64 {
				saved := th.U[d.Day]
				th.U[d.Day] = x
				j := s.lhOnly(d, a, &th)
				th.U[d.Day] = saved
				return j
			}, p.DayEffectU.Low, p.DayEffectU.High, evals)
		}
		s.projectDayEffects(&th)
		for _, d := range s.days {
			th.D[d.Day] = v4Minimize1D(func(x float64) float64 {
				saved := th.D[d.Day]
				th.D[d.Day] = x
				j := s.lhOnly(d, a, &th)
				th.D[d.Day] = saved
				return j
			}, p.DriftDPerHour.Low, p.DriftDPerHour.High, evals)
		}
		j := s.fullObjective(a, k, &th)
		if s.constraintViolation(a, k, &th) > 1e-6 {
			return v4HRJointResult{}, false
		}
		if j < best-v4TieTolerance*math.Max(1, math.Abs(best)) {
			best = j
			bestState = v4HRJointResult{A: a, K: k, Obj: j, Theta: v4CopyTheta(&th), Converged: true, Rounds: round}
			continue
		}
		if j < best {
			best = j
			bestState = v4HRJointResult{A: a, K: k, Obj: j, Theta: v4CopyTheta(&th), Converged: true, Rounds: round}
		}
		return bestState, true
	}
	if math.IsInf(best, 1) {
		return v4HRJointResult{A: a, K: k, Obj: s.fullObjective(a, k, &th), Theta: th, Converged: false}, true
	}
	return bestState, true
}
