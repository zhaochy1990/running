package calibration

import (
	"math"
	"sort"
	"time"
)

const hourImplementation = "hour_capability_v1"
const hourParameterVersion = "hour-v1-conservative-research"

// HourCapabilityReport describes a supported speed, never a probability interval.
// Original-duration observations remain in CandidateEvidenceReport even if no
// reliable one-hour inference is identifiable.
type HourCapabilityReport struct {
	ParameterVersion   string                 `json:"parameter_version"`
	Method             string                 `json:"method"`
	CenterMps          *float64               `json:"center_mps,omitempty"`
	RangeLowMps        *float64               `json:"range_low_mps,omitempty"`
	RangeHighMps       *float64               `json:"range_high_mps,omitempty"`
	RangeMeaning       string                 `json:"range_meaning"`
	Confidence         Confidence             `json:"confidence"`
	ModelKUsed         *float64               `json:"model_k_used,omitempty"`
	KSupport           string                 `json:"k_support"`
	RiegelK            *float64               `json:"riegel_k,omitempty"`
	AnchorActivities   int                    `json:"anchor_activities"`
	AnchorDays         int                    `json:"anchor_days"`
	AnchorContribution float64                `json:"anchor_contribution"`
	Observations       []HourModelObservation `json:"observations"`
	Reasons            []string               `json:"reasons"`
	Limitations        []string               `json:"limitations"`
}

type HourModelObservation struct {
	ActivityID     string   `json:"activity_id"`
	RootActivityID string   `json:"root_activity_id"`
	DurationS      float64  `json:"duration_s"`
	ModelDurationS float64  `json:"model_duration_s,omitempty"`
	Role           string   `json:"role"`
	Weight         float64  `json:"weight"`
	LogError       float64  `json:"log_error"`
	Residual       *float64 `json:"standardized_residual,omitempty"`
}

// FitHourCapability is the pure offline pace-model seam. It consumes admitted
// measurements/effort evidence only, never held-out references or HR estimates.
// Model: log Vmax(t) = a - k log(t/3600), with the existing k bounds.
// Near-maximal anchors use Huber loss; other observations use its positive hinge
// after measurement tolerance at THEIR ORIGINAL duration. No easy observation
// supplies an upper bound. See docs/calibration/hour-capability-v1.md.
func FitHourCapability(evidence []CandidateEvidence, asOf time.Time) HourCapabilityReport {
	out := HourCapabilityReport{ParameterVersion: hourParameterVersion, Method: "constraints_only", Confidence: ConfidenceNone, RangeMeaning: "evidence_support_sensitivity_not_probability_interval", Reasons: []string{}, Limitations: []string{"research_parameters_not_independently_calibrated", "environment_not_corrected", "power_law_valid_only_180_to_7200s", "range_is_sensitivity_not_95_percent_ci", "long_duration_uses_monotone_envelope_not_precise_extrapolation"}}
	// Stable identity ordering also makes the pure seam insensitive to input order.
	ordered := append([]CandidateEvidence(nil), evidence...)
	sort.Slice(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if a.RootActivityID != b.RootActivityID {
			return a.RootActivityID < b.RootActivityID
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
	anchors, bounds := []hourPoint{}, []hourPoint{}
	seen := map[string]map[float64]bool{}
	for _, e := range ordered {
		root := e.RootActivityID
		if root == "" {
			root = e.ActivityID
		}
		age := float64(dayDiff(asOf, e.ActivityDate))
		obs := HourModelObservation{ActivityID: e.ActivityID, RootActivityID: root, DurationS: e.DurationS, Role: "not_selected"}
		switch {
		case !e.Selected:
		case !e.Continuous:
			obs.Role = "noncontinuous_observation_only"
		case root == "" || e.ActivityDate.IsZero() || age < 0 || age > 180:
			obs.Role = "identity_or_date_not_admitted"
		case e.DurationS < 180 || math.IsInf(e.DurationS, 0) || math.IsNaN(e.DurationS):
			obs.Role = "outside_model_domain_original_duration_only"
		case !(e.AvgSpeedMps > 0 && e.AvgSpeedMps <= 8.5) || math.IsNaN(e.AvgSpeedMps):
			obs.Role = "invalid_measurement"
		case candidateConfidenceRank(e.MeasurementQuality) == 0:
			obs.Role = "measurement_quality_missing"
		default:
			if seen[root] == nil {
				seen[root] = map[float64]bool{}
			}
			if seen[root][e.DurationS] {
				obs.Role = "duplicate_root_duration"
				break
			}
			seen[root][e.DurationS] = true
			sigma := map[Confidence]float64{ConfidenceHigh: .02, ConfidenceMedium: .05, ConfidenceLow: .10}[e.MeasurementQuality]
			// Measurement error is distinct from effort and ageing uncertainty.
			sigma = math.Hypot(sigma, math.Min(.15, age*.001))
			if e.DurationS > 3600 {
				sigma = math.Hypot(sigma, .06*math.Log(math.Min(e.DurationS, 7200)/3600)/math.Log(2))
			}
			// Beyond two hours use only the permissive nonincreasing envelope:
			// V(t) <= V(7200), with extra log uncertainty. This is a soft
			// necessary model constraint at original t, never a precise long-race
			// conversion or an observed one-hour lower bound.
			longDomain := e.DurationS > 7200
			if longDomain {
				sigma = math.Hypot(sigma, .15)
			}
			maximal := !longDomain && (e.EffortSupport == EffortConfirmedMaximal || e.EffortSupport == EffortProbableMaximal)
			if e.EffortSupport == EffortProbableMaximal {
				sigma = math.Hypot(sigma, .06)
			}
			p := hourPoint{x: math.Log(math.Min(e.DurationS, 7200) / 3600), y: math.Log(e.AvgSpeedMps), sigma: sigma, w: math.Exp2(-age / 90), root: root, day: e.ActivityDate.Format("2006-01-02"), duration: e.DurationS, age: age, confirmed: e.EffortSupport == EffortConfirmedMaximal, index: len(out.Observations), quality: e.MeasurementQuality}
			if maximal {
				obs.Role = "maximal_anchor"
				p.w *= hourEffortWeight(e.EffortSupport)
				anchors = append(anchors, p)
			} else if e.ObservedLowerBoundMps > 0 {
				obs.Role = "original_duration_soft_lower_constraint"
				if longDomain {
					obs.Role = "long_duration_monotone_model_constraint"
				}
				bounds = append(bounds, p)
			} else {
				obs.Role = "original_duration_observation_without_bound"
			}
			obs.ModelDurationS = math.Min(e.DurationS, 7200)
			obs.LogError = sigma
		}
		out.Observations = append(out.Observations, obs)
	}
	// Rebudget actual anchors separately: easy windows/roots never dilute them.
	rawAnchors := append([]hourPoint(nil), anchors...)
	hourBudget(anchors)

	roots, days := map[string]bool{}, map[string]bool{}
	recentRoots := map[string]bool{}
	recentDays := map[string]bool{}
	direct := false
	nearHour := false
	minD, maxD := math.Inf(1), 0.0
	for _, p := range anchors {
		roots[p.root] = true
		days[p.day] = true
		out.AnchorContribution += p.w
		if p.age <= recentMaxAgeDays {
			recentRoots[p.root] = true
			recentDays[p.day] = true
		}
		if p.duration == 3600 && p.confirmed && p.age <= recentMaxAgeDays {
			direct = true
		}
		if p.duration >= 1200 && p.age <= recentMaxAgeDays {
			nearHour = true
		}
		minD = math.Min(minD, p.duration)
		maxD = math.Max(maxD, p.duration)
	}
	out.AnchorActivities = len(roots)
	out.AnchorDays = len(days)
	for _, p := range anchors {
		out.Observations[p.index].Weight = p.w
	}
	if len(anchors) == 0 {
		out.Reasons = append(out.Reasons, "no_independent_maximal_anchors")
		return out
	}
	identifiedK := len(roots) >= 2 && len(days) >= 2 && maxD/minD >= 1.5
	if !direct && !(identifiedK && nearHour && len(recentRoots) >= 2 && len(recentDays) >= 2) {
		out.Method = "insufficient_maximal_support"
		out.Reasons = append(out.Reasons, "hour_extrapolation_not_identified_by_independent_recent_anchors")
		return out
	}
	a, k, _ := hourOptimize(anchors, nil, math.Inf(-1))
	out.KSupport = "independent_duration_fit"
	if !identifiedK {
		k = (riegelKMin + riegelKMax) / 2
		a = hourIntercept(anchors, nil, k, math.Inf(-1))
		out.KSupport = "unidentified_research_midpoint"
		out.Reasons = append(out.Reasons, "endurance_exponent_unidentified_research_midpoint")
	}
	out.ModelKUsed = &k
	originalA := a
	// Nonbinding one-sided data have exactly zero effect, including confidence and
	// support ranges. A binding constraint can only increase the hour center.
	activeBounds := []hourPoint{}
	for _, p := range bounds {
		if p.y-p.sigma-(a-k*p.x) > 1e-12 {
			activeBounds = append(activeBounds, p)
		}
	}
	binding := len(activeBounds) > 0
	if binding {
		joint := append(append([]hourPoint(nil), rawAnchors...), activeBounds...)
		hourBudget(joint)
		anchors, activeBounds = joint[:len(rawAnchors)], joint[len(rawAnchors):]
		out.AnchorContribution = 0
		for _, p := range anchors {
			out.AnchorContribution += p.w
		}
		for _, p := range joint {
			out.Observations[p.index].Weight = p.w
		}
		// Unknown effort cannot train the endurance exponent. At fixed k, increasing
		// a cannot violate a previously nonbinding constraint at any duration.
		a = hourIntercept(anchors, activeBounds, k, originalA)
		out.Reasons = append(out.Reasons, "binding_original_duration_constraints_model_inference")
	}
	center := math.Exp(a)
	out.CenterMps = &center
	out.Method = "speed_duration_inference"
	allAtHour := true
	for _, p := range anchors {
		allAtHour = allAtHour && p.duration == 3600
	}
	if direct && allAtHour && !binding {
		out.Method = "direct_60min_maximal"
	}
	if identifiedK {
		out.RiegelK = &k
	}
	out.Confidence = ConfidenceLow
	qualityRoots := map[string]bool{}
	qualityDays := map[string]bool{}
	highQualityRoots := map[string]bool{}
	highQualityDays := map[string]bool{}
	allConfirmed := true
	conflict := false
	totalError := 0.0
	for _, p := range anchors {
		residual := (p.y - (a - k*p.x)) / p.sigma
		out.Observations[p.index].Residual = &residual
		if math.Abs(residual) > 3 {
			conflict = true
		}
		if math.Abs(residual) <= 3 && p.age <= recentMaxAgeDays {
			if candidateConfidenceRank(p.quality) >= candidateConfidenceRank(ConfidenceMedium) {
				qualityRoots[p.root] = true
				qualityDays[p.day] = true
			}
			if p.quality == ConfidenceHigh {
				highQualityRoots[p.root] = true
				highQualityDays[p.day] = true
			}
		}
		allConfirmed = allConfirmed && p.confirmed
		totalError += p.w * p.sigma
	}
	for _, p := range bounds {
		residual := math.Max(0, (p.y-p.sigma-(a-k*p.x))/p.sigma)
		out.Observations[p.index].Residual = &residual
		if residual > 3 {
			conflict = true
		}
	}
	if len(qualityRoots) >= 2 && len(qualityDays) >= 2 && !conflict {
		out.Confidence = ConfidenceMedium
	}
	if allConfirmed && len(highQualityRoots) >= 3 && len(highQualityDays) >= 3 && direct && !conflict {
		out.Confidence = ConfidenceHigh
	}
	if conflict {
		out.Reasons = append(out.Reasons, "conflicting_evidence_robust_fit_low_support")
	}
	// Sensitivity envelope: existing k bounds plus measurement/effort/age/model
	// error. This is deliberately NOT a calibrated frequentist/Bayesian interval.
	lowerA, upperA := math.Min(a, originalA), math.Max(a, originalA)
	if identifiedK || binding || !allAtHour {
		for _, edgeK := range []float64{riegelKMin, riegelKMax} {
			edgeA := hourIntercept(anchors, nil, edgeK, math.Inf(-1))
			if binding {
				edgeA = hourIntercept(anchors, activeBounds, edgeK, edgeA)
			}
			lowerA = math.Min(lowerA, edgeA)
			upperA = math.Max(upperA, edgeA)
		}
	}
	width := 2*totalError/math.Max(out.AnchorContribution, 1e-12) + .04
	if conflict {
		width += .10
	}
	low, high := math.Exp(lowerA-width), math.Exp(upperA+width)
	out.RangeLowMps = &low
	out.RangeHighMps = &high
	return out
}

type hourPoint struct {
	x, y, sigma, w float64
	root, day      string
	duration, age  float64
	confirmed      bool
	quality        Confidence
	index          int
}

func hourEffortWeight(e EffortSupport) float64 {
	switch e {
	case EffortConfirmedMaximal:
		return 1
	case EffortProbableMaximal:
		return .7
	}
	return 0
}
func hourBudget(points []hourPoint) {
	rootCounts := map[string]int{}
	rootDay := map[string]string{}
	for _, p := range points {
		rootCounts[p.root]++
		if d, ok := rootDay[p.root]; !ok || p.day < d {
			rootDay[p.root] = p.day
		}
	}
	dayCounts := map[string]int{}
	for _, d := range rootDay {
		dayCounts[d]++
	}
	for i := range points {
		points[i].w /= float64(rootCounts[points[i].root] * dayCounts[rootDay[points[i].root]])
	}
}

// Huber delta 1.5 bounds influence from isolated GPS/effort outliers.
func hourHuber(r float64) float64 {
	r = math.Abs(r)
	if r <= 1.5 {
		return .5 * r * r
	}
	return 1.5 * (r - .75)
}
func hourPsi(r float64) float64 { return math.Max(-1.5, math.Min(1.5, r)) }
func hourIntercept(anchors, bounds []hourPoint, k, floor float64) float64 {
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, p := range anchors {
		v := p.y + k*p.x
		lo = math.Min(lo, v)
		hi = math.Max(hi, v)
	}
	for _, p := range bounds {
		hi = math.Max(hi, p.y+k*p.x)
	}
	lo = math.Max(lo, floor)
	hi = math.Max(hi, lo)
	for n := 0; n < 70; n++ {
		a := (lo + hi) / 2
		derivative := 0.0
		for _, p := range anchors {
			derivative += p.w * hourPsi((a-k*p.x-p.y)/p.sigma) / p.sigma
		}
		for _, p := range bounds {
			r := (a - k*p.x - p.y + p.sigma) / p.sigma
			if r < 0 {
				derivative += p.w * hourPsi(r) / p.sigma
			}
		}
		if derivative < 0 {
			lo = a
		} else {
			hi = a
		}
	}
	return (lo + hi) / 2
}
func hourOptimize(anchors, bounds []hourPoint, floor float64) (float64, float64, float64) {
	bestA, bestK, bestLoss := 0.0, riegelKMin, math.Inf(1)
	// Deterministic bounded search, resolution .0002 in the existing k domain.
	for step := 0; step <= 400; step++ {
		k := riegelKMin + (riegelKMax-riegelKMin)*float64(step)/400
		a := hourIntercept(anchors, bounds, k, floor)
		loss := 0.0
		for _, p := range anchors {
			loss += p.w * hourHuber((a-k*p.x-p.y)/p.sigma)
		}
		for _, p := range bounds {
			loss += p.w * hourHuber(math.Max(0, (p.y-p.sigma-a+k*p.x)/p.sigma))
		}
		if loss < bestLoss {
			bestA, bestK, bestLoss = a, k, loss
		}
	}
	return bestA, bestK, bestLoss
}
