package calibration

import (
	"math"
	"sort"
	"time"
)

// evolved_v4_baseline.go implements docs/calibration/v4.md §4 for rev3: the
// three comparison values (B_raw frozen V3, B_repaired segments-only,
// B_eligible = §3-admitted trusted standard 7 buckets through the frozen V3
// pace aggregation rule), the hard floor A_floor(k) as a solve-domain
// constraint (never a finite penalty), and the §4.3 enumerated slowdown
// reasons whenever V4 is slower than the frozen V3 output.

// v4Baselines carries the §4.1 comparison chain. Every value is computed (or
// recorded) at the same as-of and input manifest.
type v4Baselines struct {
	// BRawMps: frozen original V3 threshold speed (estimateRunningCalibrationV3).
	BRawMps *float64
	// BRepairedMps: existing segments_only output (its own comparison rules).
	BRepairedMps *float64
	// BEligibleMps: trusted standard 7 buckets through the frozen V3 pace
	// aggregation rule; a compatibility baseline, not a claimed V3 output and
	// not a directly measured hour bound (it may itself be a model projection).
	BEligibleMps *float64
	// EligibleBuckets: the bucket speeds actually fed to the aggregator.
	EligibleBuckets []v4BucketBound
	// SlowerReasons: §4.3 enumerated reason codes when v60 < B_raw.
	SlowerReasons []string
	// V3Support: the frozen V3 run's per-bucket support (for §4.3 attribution).
	V3Support []v4BucketBound
}

// v4BucketBound is one bucket-level provenance row (§9 diagnostics).
type v4BucketBound struct {
	BucketS     float64  `json:"bucket_s"`
	DurationS   float64  `json:"duration_s"`
	SpeedMps    *float64 `json:"speed_mps,omitempty"`
	ActivityDay string   `json:"activity_day,omitempty"`
	AgeDays     float64  `json:"age_days,omitempty"`
}

// v4Slowdown reason codes (§4.3, verbatim vocabulary).
const (
	v4ReasonMeasurementCorrected    = "measurement_corrected"
	v4ReasonEvidenceExpired         = "evidence_expired"
	v4ReasonConditionsNotComparable = "conditions_not_comparable"
	v4ReasonCapabilityEpochChanged  = "capability_epoch_changed"
	v4ReasonV3ProjectionConflict    = "v3_projection_conflict"
	// v4ReasonUnexplainedSlowdown marks a V4<B_raw step with no enumerated
	// evidence change: per §4.3 an unexplained slowdown means the
	// design/implementation does not conform to the spec — it is reported,
	// never swallowed.
	v4ReasonUnexplainedSlowdown = "unexplained_v3_slowdown_nonconforming"
)

// v4ComputeBaselines builds the §4.1 chain. history/health/asOf are the raw
// offline inputs; evidence is the §3 role-assigned set.
func v4ComputeBaselines(history []Activity, asOf time.Time, health []HealthRow, evidence v4EvidenceSet) v4Baselines {
	out := v4Baselines{}
	// 1. B_raw: the frozen V3, untouched.
	v3Snap := estimateRunningCalibrationV3(history, asOf, health)
	out.BRawMps = v3Snap.ThresholdSpeedMps
	// 2. B_repaired: the segments-only control, its own rules.
	repaired, _ := estimateSegmentsOnly(history, asOf, health)
	out.BRepairedMps = repaired.ThresholdSpeedMps
	// 3. B_eligible: trusted standard-7-bucket rows through the frozen V3
	// pace aggregation rule (nearestBucket → per-bucket fastest → the frozen
	// estimateThresholdSpeed order, including its 60-minute direct branch —
	// for a trusted measured hour that IS a valid bound).
	recent := make([]Activity, 0, len(history))
	windowStart := asOf.AddDate(0, 0, -v4AuditWindowDays)
	for _, a := range history {
		if inClosedRange(a.ActivityDate, windowStart, asOf) {
			recent = append(recent, a)
		}
	}
	// V3 support attribution set: the buckets the frozen V3 actually used.
	out.V3Support = v3BucketSupport(recent, asOf)
	candidates := v4EligibleCandidates(evidence)
	out.EligibleBuckets = v4EligibleBuckets(evidence)
	if len(candidates) > 0 {
		if eligible, _, _ := estimateThresholdSpeed(candidates, asOf); eligible != nil {
			out.BEligibleMps = eligible
		}
	}
	return out
}

// v3BucketSupport reconstructs the frozen V3's own bucket support (the
// best-per-bucket map of its candidate selection) for §4.3 attribution.
func v3BucketSupport(recent []Activity, asOf time.Time) []v4BucketBound {
	speedCandidates := BestSpeedCandidates(recent, BestEffortDurationsS)
	best := buildBestByDuration(speedCandidates)
	buckets := make([]float64, 0, len(best))
	for d := range best {
		buckets = append(buckets, d)
	}
	sort.Float64s(buckets)
	out := make([]v4BucketBound, 0, len(buckets))
	for _, d := range buckets {
		c := best[d]
		speed := c.AvgSpeedMps
		age := 0.0
		day := ""
		if !c.Activity.ActivityDate.IsZero() {
			age = float64(dayDiff(asOf, c.Activity.ActivityDate))
			day = c.Activity.ActivityDate.Format("2006-01-02")
		}
		out = append(out, v4BucketBound{BucketS: d, DurationS: c.DurationS, SpeedMps: &speed, ActivityDay: day, AgeDays: age})
	}
	return out
}

// v4AFloor is §4.2's hard floor for a given k:
//
//	A_floor(k) = max( log B_eligible, max_{i in trusted} y_i + k*log(min(t_i,7200)/3600) )
//
// Missing terms are skipped; nothing invents a zero-speed floor. This value
// enters the solve as a domain constraint — no finite penalty weight may
// replace it.
type v4AFloor struct {
	Value float64
	// HasTrustedTerm: at least one trusted performance term exists.
	HasTrustedTerm bool
	// TrustedOnly: the floor without the B_eligible compatibility term (the
	// nominal proven lower bound under original inputs, §8.2).
	TrustedOnly float64
	// BindingIdx: index of the trusted row achieving TrustedOnly at this k.
	BindingIdx int
}

func (f v4AFloor) finite() bool { return !math.IsNaN(f.Value) && !math.IsInf(f.Value, 0) }

// v4FloorFunction precomputes the trusted terms (y_i, log(min(t_i,7200)/3600))
// once; AFloor(k) is then an O(n) max.
type v4FloorFunction struct {
	terms       []v4FloorTerm
	baselineLog *float64 // log B_eligible when present
	rows        []v4Observation
}

type v4FloorTerm struct {
	y, xlog float64
	rowIdx  int
}

func v4NewFloorFunction(evidence *v4EvidenceSet, baseline *v4Baselines) v4FloorFunction {
	f := v4FloorFunction{rows: evidence.Rows}
	for _, i := range evidence.TrustedConstraintIdx {
		r := &evidence.Rows[i]
		if r.Long || r.DurationS >= v4MinModelDurationS {
			f.terms = append(f.terms, v4FloorTerm{y: r.Y, xlog: r.X, rowIdx: i})
		}
	}
	sort.Slice(f.terms, func(i, j int) bool {
		if f.terms[i].rowIdx != f.terms[j].rowIdx {
			return f.terms[i].rowIdx < f.terms[j].rowIdx
		}
		return false
	})
	if baseline != nil && baseline.BEligibleMps != nil && *baseline.BEligibleMps > 0 {
		v := math.Log(*baseline.BEligibleMps)
		f.baselineLog = &v
	}
	return f
}

func (f v4FloorFunction) aFloor(k float64) v4AFloor {
	out := v4AFloor{BindingIdx: -1, Value: math.Inf(-1), TrustedOnly: math.Inf(-1)}
	if f.baselineLog != nil {
		out.Value = *f.baselineLog
	}
	for _, t := range f.terms {
		v := t.y + k*t.xlog
		if !out.HasTrustedTerm || v > out.TrustedOnly {
			out.TrustedOnly = v
			out.BindingIdx = t.rowIdx
		}
		out.HasTrustedTerm = true
		if v > out.Value {
			out.Value = v
		}
	}
	return out
}

// v4ExplainSlowdown applies §4.3: V4 slower than the frozen V3 may only be
// explained by concrete evidence changes. The enumerated codes are checked in
// a fixed order; an unexplained slowdown is reported as non-conforming.
func v4ExplainSlowdown(v60 *float64, base v4Baselines, evidence v4EvidenceSet) []string {
	if v60 == nil || base.BRawMps == nil || *base.BRawMps <= 0 {
		return nil
	}
	if *v60 >= *base.BRawMps {
		return nil
	}
	reasons := []string{}
	// evidence_expired: the activities supporting the old value left the
	// current 60-day window.
	expired := false
	for _, s := range base.V3Support {
		if s.AgeDays > float64(v4CurrentWindowDays) {
			expired = true
			break
		}
	}
	if expired {
		reasons = append(reasons, v4ReasonEvidenceExpired)
	}
	// measurement_corrected: repairing measurements (the segments_only
	// control on the same inputs) changed the outcome. The doc names no
	// tolerance; a visible repair difference in the round4 controls counts
	// (the epsilon only absorbs float noise, not a semantic threshold).
	if base.BRepairedMps != nil && *base.BRepairedMps > 0 && math.Abs(*base.BRepairedMps-*base.BRawMps) > 1e-9 {
		reasons = append(reasons, v4ReasonMeasurementCorrected)
	}
	// conditions_not_comparable: explicit terrain/device counter-evidence on
	// the rows that supported the old value (demoted or excluded rows carry
	// the marker in their role notes).
	for i := range evidence.Rows {
		marked := false
		for _, why := range evidence.Rows[i].ExclusionReasons {
			if why == "conditions_not_comparable" {
				marked = true
				break
			}
		}
		if marked {
			reasons = append(reasons, v4ReasonConditionsNotComparable)
			break
		}
	}
	// capability_epoch_changed: only a user-confirmed epoch could set this;
	// rev3 has no epoch input channel, so the code can never fire here.
	// v3_projection_conflict: a retained verified all-out reference whose
	// model-projected hour bound (its §4.2 constraint term at k=0.06, the
	// declared prior center) exceeds the frozen V3 output — the reference
	// contradicts V3's extrapolation. No invented tolerance: any strict
	// excess is a conflict. Reported only; it never auto-releases the
	// compatibility floor.
	for _, i := range evidence.VerifiedReferenceIdx {
		r := &evidence.Rows[i]
		projected := math.Exp(r.Y + thresholdSpeedRiegelExponent*math.Log(math.Min(r.DurationS, v4LongDomainS)/3600))
		if projected > *base.BRawMps {
			reasons = append(reasons, v4ReasonV3ProjectionConflict)
			break
		}
	}
	if len(reasons) == 0 {
		reasons = append(reasons, v4ReasonUnexplainedSlowdown)
	}
	return reasons
}
