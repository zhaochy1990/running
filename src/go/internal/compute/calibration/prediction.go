package calibration

import (
	"math"
	"sort"
	"time"
)

// SpeedDurationModel mirrors prediction.SpeedDurationModel.
type SpeedDurationModel struct {
	CriticalSpeedMps *float64
	DPrimeM          *float64
	RiegelK          *float64
	EnduranceIndex   *float64
	SpeedIndex       *float64
	Confidence       Confidence
}

const (
	riegelKMin = 0.02
	riegelKMax = 0.10

	csModelMinDurationS = 2 * 60
	csModelMaxDurationS = 20 * 60
	kFitMinDurationS    = 3 * 60
	kFitMaxDurationS    = 60 * 60

	minBucketsForK          = 3
	minBucketsForCS         = 2
	highConfidenceBuckets   = 4
	highConfidenceSpanRatio = 3.0
	recentMaxAgeDays        = 60
	durableLongDurationS    = 45 * 60
	monotoneMinGain         = 0.005
	dPrimeIndexRefM         = 350.0
)

// wpoint is a (duration, speed, weight) triple.
type wpoint struct{ d, v, w float64 }

// fitSpeedDurationModel mirrors prediction.fit_speed_duration_model with prior
// == None (the only path core uses). best is keyed by duration bucket.
func fitSpeedDurationModel(best map[float64]SpeedCandidate, asOf time.Time) SpeedDurationModel {
	points := monotoneEnvelope(weightedPoints(best, asOf))
	distinct := distinctDurations(points)
	if len(points) < 2 || len(distinct) < 2 {
		return emptyModel()
	}
	surviving := map[float64]bool{}
	for _, d := range distinct {
		surviving[d] = true
	}

	enoughActivities := countDistinctKFitActivities(best, surviving) >= 2

	hasRecentLongAnchor := false
	for d, cand := range best {
		if surviving[d] && d >= durableLongDurationS && dayDiff(asOf, cand.Activity.ActivityDate) <= recentMaxAgeDays {
			hasRecentLongAnchor = true
			break
		}
	}

	fastest := points[0].v
	for _, p := range points {
		if p.v > fastest {
			fastest = p.v
		}
	}

	riegelK := fitRiegelK(points)
	cs, dPrime := fitCSDPrime(points)

	riegelK = clampK(riegelK)
	if cs != nil {
		m := math.Min(*cs, fastest)
		if m <= 0 {
			cs = nil
		} else {
			cs = &m
		}
	}
	if dPrime != nil {
		m := math.Max(0.0, *dPrime)
		dPrime = &m
	}

	confidence := modelConfidence(distinct, riegelK, false, enoughActivities, hasRecentLongAnchor)
	return SpeedDurationModel{
		CriticalSpeedMps: roundN(cs, 3),
		DPrimeM:          roundN(dPrime, 3),
		RiegelK:          roundN(riegelK, 4),
		EnduranceIndex:   enduranceIndex(riegelK),
		SpeedIndex:       speedIndex(dPrime),
		Confidence:       confidence,
	}
}

func emptyModel() SpeedDurationModel {
	return SpeedDurationModel{Confidence: ConfidenceNone}
}

// weightedPoints iterates best in a deterministic (sorted-by-duration) order so
// the OLS summation is reproducible; Python preserves insertion order but the
// rounded outputs are robust to summation order.
func weightedPoints(best map[float64]SpeedCandidate, asOf time.Time) []wpoint {
	durations := make([]float64, 0, len(best))
	for d := range best {
		durations = append(durations, d)
	}
	sort.Float64s(durations)
	var points []wpoint
	for _, d := range durations {
		cand := best[d]
		w := candidateWeight(cand, asOf)
		v := cand.AvgSpeedMps
		if w <= 0 || v <= 0 || math.IsInf(v, 0) || math.IsNaN(v) {
			continue
		}
		points = append(points, wpoint{d, v, w})
	}
	return points
}

func monotoneEnvelope(points []wpoint) []wpoint {
	ordered := append([]wpoint(nil), points...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].d > ordered[j].d })
	var kept []wpoint
	bestLonger := 0.0
	for _, p := range ordered {
		if p.v > bestLonger*(1.0+monotoneMinGain) {
			kept = append(kept, p)
			bestLonger = p.v
		}
	}
	return kept
}

func distinctDurations(points []wpoint) []float64 {
	set := map[float64]bool{}
	for _, p := range points {
		set[p.d] = true
	}
	out := make([]float64, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sort.Float64s(out)
	return out
}

func countDistinctKFitActivities(best map[float64]SpeedCandidate, surviving map[float64]bool) int {
	set := map[string]bool{}
	for d, cand := range best {
		if surviving[d] && kFitMinDurationS <= d && d <= kFitMaxDurationS {
			set[cand.Activity.LabelID] = true
		}
	}
	return len(set)
}

func fitRiegelK(points []wpoint) *float64 {
	var domain []wpoint
	set := map[float64]bool{}
	for _, p := range points {
		if kFitMinDurationS <= p.d && p.d <= kFitMaxDurationS {
			domain = append(domain, p)
			set[p.d] = true
		}
	}
	if len(set) < minBucketsForK {
		return nil
	}
	total := 0.0
	for _, p := range domain {
		total += p.w
	}
	if total <= 0 {
		return nil
	}
	xBar, yBar := 0.0, 0.0
	for _, p := range domain {
		xBar += p.w * math.Log(p.d)
		yBar += p.w * math.Log(p.v)
	}
	xBar /= total
	yBar /= total
	sxx, sxy := 0.0, 0.0
	for _, p := range domain {
		x := math.Log(p.d)
		y := math.Log(p.v)
		sxx += p.w * (x - xBar) * (x - xBar)
		sxy += p.w * (x - xBar) * (y - yBar)
	}
	if sxx <= 0 {
		return nil
	}
	slope := sxy / sxx
	if math.IsInf(slope, 0) || math.IsNaN(slope) {
		return nil
	}
	k := -slope
	return &k
}

func fitCSDPrime(points []wpoint) (*float64, *float64) {
	var domain []wpoint
	set := map[float64]bool{}
	for _, p := range points {
		if csModelMinDurationS <= p.d && p.d <= csModelMaxDurationS {
			domain = append(domain, p)
			set[p.d] = true
		}
	}
	if len(set) < minBucketsForCS {
		return nil, nil
	}
	total := 0.0
	for _, p := range domain {
		total += p.w
	}
	if total <= 0 {
		return nil, nil
	}
	tBar, dBar := 0.0, 0.0
	for _, p := range domain {
		tBar += p.w * p.d
		dBar += p.w * (p.v * p.d)
	}
	tBar /= total
	dBar /= total
	stt, std := 0.0, 0.0
	for _, p := range domain {
		dd := p.v * p.d
		stt += p.w * (p.d - tBar) * (p.d - tBar)
		std += p.w * (p.d - tBar) * (dd - dBar)
	}
	if stt <= 0 {
		return nil, nil
	}
	cs := std / stt
	if math.IsInf(cs, 0) || math.IsNaN(cs) || cs <= 0 {
		return nil, nil
	}
	dPrime := dBar - cs*tBar
	return &cs, &dPrime
}

func clampK(k *float64) *float64 {
	if k == nil || math.IsInf(*k, 0) || math.IsNaN(*k) {
		return nil
	}
	v := math.Min(math.Max(*k, riegelKMin), riegelKMax)
	return &v
}

func enduranceIndex(k *float64) *float64 {
	if k == nil {
		return nil
	}
	span := riegelKMax - riegelKMin
	v := math.Max(0.0, math.Min(1.0, (riegelKMax-*k)/span))
	return &v
}

func speedIndex(dPrime *float64) *float64 {
	if dPrime == nil {
		return nil
	}
	v := math.Max(0.0, math.Min(1.0, *dPrime/dPrimeIndexRefM))
	return &v
}

func modelConfidence(distinct []float64, riegelK *float64, reliedOnPrior, enoughActivities, hasRecentLongAnchor bool) Confidence {
	if riegelK == nil {
		if len(distinct) >= 2 {
			return ConfidenceLow
		}
		return ConfidenceNone
	}
	var kBuckets []float64
	for _, d := range distinct {
		if kFitMinDurationS <= d && d <= kFitMaxDurationS {
			kBuckets = append(kBuckets, d)
		}
	}
	sort.Float64s(kBuckets)
	spanRatio := 1.0
	if len(kBuckets) >= 2 {
		spanRatio = kBuckets[len(kBuckets)-1] / kBuckets[0]
	}
	if reliedOnPrior || !enoughActivities {
		return ConfidenceLow
	}
	if len(kBuckets) >= highConfidenceBuckets && spanRatio >= highConfidenceSpanRatio && hasRecentLongAnchor {
		return ConfidenceHigh
	}
	if len(kBuckets) >= minBucketsForK {
		return ConfidenceMedium
	}
	return ConfidenceLow
}

// roundN mirrors prediction._round: round(x, n) or nil.
func roundN(v *float64, n int) *float64 {
	if v == nil {
		return nil
	}
	p := math.Pow(10, float64(n))
	r := math.Round(*v*p) / p
	return &r
}
