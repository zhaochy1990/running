package calibration

import (
	"math"
	"sort"
	"time"
)

const hrParameterVersion = "hr-v1-conservative-research"

// CandidateCadenceSample is optional auxiliary input in the samples' chosen
// timestamp/elapsed clock; cadence is whole steps per minute, never strides.
type CandidateCadenceSample struct {
	TimeS          float64 `json:"time_s"`
	StepsPerMinute float64 `json:"steps_per_minute"`
}

// CandidateHRMetadata is historical admitted input, never a replay outcome.
// Protocol verification and effort verification are separate assertions.
type CandidateHRMetadata struct {
	LabHRBpm             *float64                 `json:"lab_hr_bpm,omitempty"`
	LabMethod            string                   `json:"lab_method,omitempty"`
	LabInstrument        string                   `json:"lab_instrument,omitempty"`
	LabReportDate        time.Time                `json:"lab_report_date,omitempty"`
	Cadence              []CandidateCadenceSample `json:"cadence,omitempty"`
	SuspectedCadenceLock bool                     `json:"suspected_cadence_lock,omitempty"`
	Protocol             string                   `json:"protocol"`
	Verified             bool                     `json:"verified"`
	Sensor               string                   `json:"sensor"`
}
type CandidateHRQuality struct {
	Coverage float64  `json:"coverage"`
	MaxGapS  float64  `json:"max_gap_s"`
	DriftBpm *float64 `json:"drift_bpm,omitempty"`
	Reasons  []string `json:"reasons"`
}
type CandidateHRObservation struct {
	MeasurementKind  string             `json:"measurement_kind"`
	LabInstrument    string             `json:"lab_instrument,omitempty"`
	ProtocolCoverage *float64           `json:"protocol_coverage,omitempty"`
	ProtocolMaxGapS  *float64           `json:"protocol_max_gap_s,omitempty"`
	LabMethod        string             `json:"lab_method,omitempty"`
	ActivityID       string             `json:"activity_id"`
	RootActivityID   string             `json:"root_activity_id"`
	ActivityDate     time.Time          `json:"activity_date"`
	SourceVersion    string             `json:"source_version"`
	EvidenceRef      string             `json:"evidence_ref,omitempty"`
	ReferenceTier    string             `json:"reference_tier"`
	Protocol         string             `json:"protocol"`
	Sensor           string             `json:"sensor"`
	StartS           float64            `json:"start_s"`
	EndS             float64            `json:"end_s"`
	ValueBpm         *float64           `json:"value_bpm"`
	Quality          CandidateHRQuality `json:"quality"`
	EffortSupport    EffortSupport      `json:"effort_support"`
	Selected         bool               `json:"selected"`
	Reasons          []string           `json:"reasons"`
}
type CandidateHRReport struct {
	TargetType            string                   `json:"target_type"`
	Protocol              string                   `json:"protocol"`
	DataCutoff            time.Time                `json:"data_cutoff"`
	EvidenceDate          *time.Time               `json:"evidence_date,omitempty"`
	LabMethod             string                   `json:"lab_method,omitempty"`
	ParameterVersion      string                   `json:"parameter_version"`
	ValueBpm              *float64                 `json:"value_bpm"`
	ReferenceTier         string                   `json:"reference_tier"`
	Confidence            Confidence               `json:"confidence"`
	DependsOnPace         bool                     `json:"depends_on_pace"`
	IndependentActivities int                      `json:"independent_activities"`
	IndependentDays       int                      `json:"independent_days"`
	Observations          []CandidateHRObservation `json:"observations"`
	Reasons               []string                 `json:"reasons"`
	Limitations           []string                 `json:"limitations"`
}

// No speed, pace estimate, RHR or HRmax is used to manufacture threshold support.
func buildCandidateHR(history []Activity, metadata []CandidateMetadata, asOf, cutoff time.Time) CandidateHRReport {
	out := CandidateHRReport{TargetType: "unavailable", Protocol: "none", DataCutoff: cutoff, ParameterVersion: hrParameterVersion, ReferenceTier: "training_hr", Confidence: ConfidenceNone, Reasons: []string{"no_independent_HR_protocol_support"}, Limitations: []string{"HR_research_quality_parameters_uncalibrated", "field_proxy_is_not_physiological_LTHR", "missing_cadence_cannot_exclude_cadence_lock"}}
	meta, _ := admittedCandidateMetadata(metadata, cutoff)
	activities := append([]Activity(nil), history...)
	sort.Slice(activities, func(i, j int) bool {
		if activities[i].LabelID != activities[j].LabelID {
			return activities[i].LabelID < activities[j].LabelID
		}
		return ReplayContentHash(activities[i]) < ReplayContentHash(activities[j])
	})
	seen := map[string]bool{}
	for _, a := range activities {
		if a.LabelID == "" || a.ActivityDate.IsZero() || !isRunning(a) || !inClosedRange(a.ActivityDate, asOf.AddDate(0, 0, -180), asOf) || seen[a.LabelID] {
			continue
		}
		seen[a.LabelID] = true
		m, ok := meta[a.LabelID]
		if !ok {
			m = CandidateMetadata{ActivityID: a.LabelID, SourceVersion: "unavailable"}
		}
		root := m.RootActivityID
		if root == "" {
			root = a.LabelID
		}
		o := CandidateHRObservation{MeasurementKind: "observed_HR_timeseries", ActivityID: a.LabelID, RootActivityID: root, ActivityDate: a.ActivityDate, SourceVersion: m.SourceVersion, EvidenceRef: m.EvidenceRef, ReferenceTier: "training_hr", Protocol: "none", Sensor: "unknown", EffortSupport: EffortUnknown, Reasons: []string{}}
		points, badClock := candidateHRPoints(a)
		if len(points) >= 2 {
			o.StartS = points[0].t
			o.EndS = points[len(points)-1].t
		}
		field := m.HR != nil && m.HR.Protocol == "field_30min_last20_v1"
		if m.HR != nil {
			o.Protocol = m.HR.Protocol
			o.Sensor = m.HR.Sensor
		}
		if field && candidateFinite(m.StartS) && candidateFinite(m.EndS) {
			o.StartS = *m.EndS - 1200
			o.EndS = *m.EndS
		}
		o.ValueBpm, o.Quality = measureCandidateHR(points, o.StartS, o.EndS)
		if m.HR != nil && (m.HR.SuspectedCadenceLock || candidateHRCadenceLock(points, m.HR.Cadence, o.StartS, o.EndS)) {
			o.Quality.Reasons = appendReason(o.Quality.Reasons, "suspected_HR_cadence_lock")
		}
		if badClock {
			o.Quality.Reasons = appendReason(o.Quality.Reasons, "non_increasing_or_missing_HR_clock")
		}
		if m.Interrupted {
			o.Reasons = append(o.Reasons, "activity_interruption_window_mapping_unverified")
		}
		interrupted := m.Interrupted
		if field && candidateFinite(m.StartS) && candidateFinite(m.EndS) {
			diag := CandidateActivityDiagnostic{}
			prepareCandidateSeries(a.Samples, &diag)
			for _, b := range diag.Breaks {
				if b.StartS < *m.EndS && b.EndS > *m.StartS {
					interrupted = true
					o.Reasons = appendReason(o.Reasons, "measured_protocol_continuity_break")
					break
				}
			}
		}
		e := CandidateEvidence{Continuous: !badClock && !interrupted, StartS: m.StartS, EndS: m.EndS, DurationS: m.DurationS}
		classifyCandidateEffort(&e, m)
		o.EffortSupport = e.EffortSupport
		valid := field && m.HR.Verified && m.HR.Sensor == "chest_strap" && m.EvidenceRef != "" && m.SourceVersion != "unavailable" && candidateFinite(m.StartS) && candidateFinite(m.EndS) && m.DurationS == 1800 && math.Abs(*m.EndS-*m.StartS-1800) < 1e-6 && o.EffortSupport == EffortConfirmedMaximal
		if valid {
			_, full := measureCandidateHR(points, *m.StartS, *m.EndS)
			o.ProtocolCoverage = &full.Coverage
			o.ProtocolMaxGapS = &full.MaxGapS
			// Coverage and clock must hold over the entire protocol, including its
			// initial HR-lag period. Stability applies only to the final 20min.
			if full.Coverage < .95 || full.MaxGapS > 5 {
				o.Reasons = append(o.Reasons, "full_protocol_HR_coverage_or_gap_failed")
				valid = false
			}
		}
		if !valid {
			o.Reasons = append(o.Reasons, "independent_field_protocol_not_verified")
		}
		if valid && len(o.Quality.Reasons) == 0 && o.ValueBpm != nil && !interrupted && dayDiff(asOf, a.ActivityDate) <= 60 {
			o.ReferenceTier = "field_hr_proxy"
			o.Selected = true
		}
		if m.HR != nil && m.HR.Protocol == "lab_lthr_report_v1" {
			o.Protocol = m.HR.Protocol
			o.LabMethod = m.HR.LabMethod
			o.LabInstrument = m.HR.LabInstrument
			o.MeasurementKind = "audited_lab_report"
			o.Selected = false
			validLab := m.HR.Verified && m.EvidenceRef != "" && m.SourceVersion != "unavailable" && m.HR.LabMethod != "" && m.HR.LabInstrument != "" && m.HR.LabReportDate.Equal(a.ActivityDate) && candidateFinite(m.HR.LabHRBpm) && *m.HR.LabHRBpm >= 80 && *m.HR.LabHRBpm <= 230
			if validLab {
				o.ValueBpm = m.HR.LabHRBpm
				o.ReferenceTier = "lab_lthr"
				o.Quality = CandidateHRQuality{Reasons: []string{}}
				o.Reasons = []string{}
				o.Selected = dayDiff(asOf, a.ActivityDate) <= 60
			} else {
				o.ValueBpm = nil
				o.Reasons = append(o.Reasons, "lab_report_method_instrument_date_or_value_unverified")
			}
		}
		if dayDiff(asOf, a.ActivityDate) > 60 {
			o.Reasons = append(o.Reasons, "stale_HR_support")
		}
		out.Observations = append(out.Observations, o)
	}
	selectCandidateHR(&out)
	return out
}

type candidateHRPoint struct {
	t  float64
	hr *float64
}

func candidateHRPoints(a Activity) ([]candidateHRPoint, bool) {
	useTimestamp := 0
	for _, s := range a.Samples {
		if candidateFinite(s.TimestampS) {
			useTimestamp++
		}
	}
	points := []candidateHRPoint{}
	bad := false
	for _, s := range a.Samples {
		clock := s.ElapsedS
		if useTimestamp >= 2 {
			clock = s.TimestampS
		}
		if !candidateFinite(clock) {
			bad = true
			continue
		}
		if len(points) > 0 && *clock <= points[len(points)-1].t {
			bad = true
			continue
		}
		var hr *float64
		if candidateFinite(s.HeartRateBpm) && *s.HeartRateBpm >= 80 && *s.HeartRateBpm <= 230 {
			hr = s.HeartRateBpm
		}
		points = append(points, candidateHRPoint{*clock, hr})
	}
	return points, bad
}
func measureCandidateHR(points []candidateHRPoint, start, end float64) (*float64, CandidateHRQuality) {
	q := CandidateHRQuality{Reasons: []string{}}
	if end <= start || math.IsNaN(start) || math.IsInf(start, 0) || math.IsNaN(end) || math.IsInf(end, 0) {
		q.Reasons = append(q.Reasons, "HR_duration_missing")
		return nil, q
	}
	sum, valid, lastCovered := 0.0, 0.0, start
	lo, hi := math.Inf(1), math.Inf(-1)
	for i := 1; i < len(points); i++ {
		a, b := points[i-1], points[i]
		left, right := math.Max(start, a.t), math.Min(end, b.t)
		if right <= left || b.t <= a.t {
			continue
		}
		if b.t-a.t > 5 || a.hr == nil || b.hr == nil {
			continue
		}
		q.MaxGapS = math.Max(q.MaxGapS, left-lastCovered)
		dt := b.t - a.t
		hl := *a.hr + (*b.hr-*a.hr)*(left-a.t)/dt
		hr := *a.hr + (*b.hr-*a.hr)*(right-a.t)/dt
		sum += (hl + hr) / 2 * (right - left)
		valid += right - left
		lastCovered = right
		lo = math.Min(lo, math.Min(hl, hr))
		hi = math.Max(hi, math.Max(hl, hr))
		if math.Abs(hr-hl) > 15 {
			q.Reasons = appendReason(q.Reasons, "HR_abrupt_spike_or_recovery")
		}
	}
	q.MaxGapS = math.Max(q.MaxGapS, end-lastCovered)
	q.Coverage = valid / (end - start)
	if q.Coverage < .95 {
		q.Reasons = appendReason(q.Reasons, "HR_coverage_below_95_percent")
	}
	if q.MaxGapS > 5 {
		q.Reasons = appendReason(q.Reasons, "HR_gap_over_5_seconds")
	}
	if end-start >= 1200 {
		first, fw := candidateHRMean(points, start, start+300)
		last, lw := candidateHRMean(points, end-300, end)
		if fw >= 285 && lw >= 285 {
			d := last - first
			q.DriftBpm = &d
			if math.Abs(d) > 8 {
				q.Reasons = appendReason(q.Reasons, "HR_drift_over_research_limit")
			}
		}
		peak := math.Inf(-1)
		for t := start; t+30 <= end; t += 30 {
			mean, coverage := candidateHRMean(points, t, t+30)
			if coverage < 28.5 {
				continue
			}
			if peak-mean > 10 {
				q.Reasons = appendReason(q.Reasons, "HR_sustained_recovery_drop_over_10_bpm")
				break
			}
			peak = math.Max(peak, mean)
		}
		if hi-lo > 20 {
			q.Reasons = appendReason(q.Reasons, "HR_range_suggests_recovery_or_artifact")
		}
	} else {
		q.Reasons = appendReason(q.Reasons, "HR_sustained_duration_below_20min")
	}
	if valid <= 0 {
		return nil, q
	}
	v := sum / valid
	return &v, q
}
func candidateHRMean(points []candidateHRPoint, start, end float64) (float64, float64) {
	sum, weight := 0.0, 0.0
	for i := 1; i < len(points); i++ {
		a, b := points[i-1], points[i]
		left, right := math.Max(start, a.t), math.Min(end, b.t)
		if right <= left || b.t-a.t > 5 || a.hr == nil || b.hr == nil {
			continue
		}
		dt := b.t - a.t
		hl := *a.hr + (*b.hr-*a.hr)*(left-a.t)/dt
		hr := *a.hr + (*b.hr-*a.hr)*(right-a.t)/dt
		sum += (hl + hr) / 2 * (right - left)
		weight += right - left
	}
	if weight == 0 {
		return 0, 0
	}
	return sum / weight, weight
}

// Auxiliary cadence uses the exact same clock and whole-step/minute units.
// Missing or conflicting cadence never proves the absence of lock.
func candidateHRCadenceLock(points []candidateHRPoint, cadence []CandidateCadenceSample, start, end float64) bool {
	values := map[float64]float64{}
	conflicts := map[float64]bool{}
	for _, c := range cadence {
		if math.IsNaN(c.TimeS) || math.IsInf(c.TimeS, 0) || math.IsNaN(c.StepsPerMinute) || math.IsInf(c.StepsPerMinute, 0) || c.StepsPerMinute < 80 || c.StepsPerMinute > 230 {
			continue
		}
		if v, ok := values[c.TimeS]; ok && v != c.StepsPerMinute {
			conflicts[c.TimeS] = true
		}
		values[c.TimeS] = c.StepsPerMinute
	}
	covered, locked := 0.0, 0.0
	for i := 1; i < len(points); i++ {
		a, b := points[i-1], points[i]
		dt := math.Min(end, b.t) - math.Max(start, a.t)
		if dt <= 0 || b.t-a.t > 5 || a.hr == nil || b.hr == nil {
			continue
		}
		ca, oka := values[a.t]
		cb, okb := values[b.t]
		if !oka || !okb || conflicts[a.t] || conflicts[b.t] {
			continue
		}
		covered += dt
		if math.Abs(*a.hr-ca) <= 3 && math.Abs(*b.hr-cb) <= 3 {
			locked += dt
		}
	}
	return covered >= 300 && locked/covered >= .8
}

func selectCandidateHR(out *CandidateHRReport) {
	// Root aliases are subject to the same civil-day invariant as speed evidence.
	evidence := make([]CandidateEvidence, 0, len(out.Observations))
	for _, o := range out.Observations {
		evidence = append(evidence, CandidateEvidence{RootActivityID: o.RootActivityID, ActivityDate: o.ActivityDate})
	}
	conflicts := conflictingCandidateRootDays(evidence)
	for i := range out.Observations {
		o := &out.Observations[i]
		if conflicts[o.RootActivityID] {
			o.Selected = false
			o.Reasons = appendReason(o.Reasons, "root_activity_day_conflict")
		}
	}
	tier := "field_hr_proxy"
	method := ""
	var latest time.Time
	for _, o := range out.Observations {
		if o.Selected && o.ReferenceTier == "lab_lthr" && (latest.IsZero() || o.ActivityDate.After(latest)) {
			tier = "lab_lthr"
			method = o.LabMethod
			latest = o.ActivityDate
		}
	}
	// A civil-day tie cannot establish which interpretation is latest.
	// Preserve every method as a separate observation rather than choosing by ID.
	methods := map[string]bool{}
	for _, o := range out.Observations {
		if o.Selected && o.ReferenceTier == "lab_lthr" && o.ActivityDate.Equal(latest) {
			methods[o.LabMethod] = true
		}
	}
	if len(methods) > 1 {
		out.Reasons = []string{"latest_lab_method_ambiguous"}
		for i := range out.Observations {
			o := &out.Observations[i]
			if o.Selected {
				o.Selected = false
				o.Reasons = appendReason(o.Reasons, "latest_lab_method_ambiguous")
			}
		}
		return
	}
	roots, days := map[string]bool{}, map[string]bool{}
	values := []float64{}
	dayValues := map[string][]float64{}
	for i := range out.Observations {
		o := &out.Observations[i]
		if !o.Selected {
			continue
		}
		if o.ReferenceTier != tier || o.LabMethod != method {
			o.Selected = false
			o.Reasons = append(o.Reasons, "different_HR_reference_tier_or_lab_method")
			continue
		}
		if roots[o.RootActivityID] {
			o.Selected = false
			o.Reasons = append(o.Reasons, "duplicate_HR_root")
			continue
		}
		roots[o.RootActivityID] = true
		days[o.ActivityDate.Format("2006-01-02")] = true
		values = append(values, *o.ValueBpm)
		day := o.ActivityDate.Format("2006-01-02")
		dayValues[day] = append(dayValues[day], *o.ValueBpm)
	}
	if len(values) > 0 {
		daily := []float64{}
		keys := []string{}
		for day := range dayValues {
			keys = append(keys, day)
		}
		sort.Strings(keys)
		for _, day := range keys {
			daily = append(daily, medianFloat(dayValues[day]))
		}
		v := medianFloat(daily)
		out.ValueBpm = &v
		out.ReferenceTier = tier
		out.LabMethod = method
		out.TargetType = "field_HR_proxy_not_physiological_LTHR"
		out.Protocol = "field_30min_last20_v1"
		if tier == "lab_lthr" {
			out.TargetType = "lab_method_specific_LTHR"
			out.Protocol = "lab_lthr_report_v1"
		}
		for _, o := range out.Observations {
			if o.Selected && (out.EvidenceDate == nil || o.ActivityDate.After(*out.EvidenceDate)) {
				date := o.ActivityDate
				out.EvidenceDate = &date
			}
		}
		out.Confidence = ConfidenceLow
		out.Reasons = []string{"independent_HR_protocol_support"}
		sort.Float64s(values)
		if len(roots) >= 2 && len(days) >= 2 {
			out.Confidence = ConfidenceMedium
		}
		if values[len(values)-1]-values[0] > 6 {
			out.Confidence = ConfidenceLow
			out.Reasons = append(out.Reasons, "independent_HR_protocols_disagree_over_6_bpm")
		}
		// Protocol repeatability is support, not validated physiological accuracy.
		// Until independent calibration, v1 never promotes HR to high.
	}
	out.IndependentActivities = len(roots)
	out.IndependentDays = len(days)
}
