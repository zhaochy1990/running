package calibration

import (
	"encoding/json"
	"math"
)

// CandidateVersion is the explicit offline implementation identity. ModelVersion
// remains the frozen production default; changing policy is a separate operation.
const CandidateVersion = candidateAlgorithmVersion

// SourceSummary is the bounded explanation persisted with a snapshot. It never
// contains observations, raw samples, notes, coordinates or complete activities.
type SourceSummary struct {
	SchemaVersion    int    `json:"schema_version"`
	State            string `json:"state"`
	Strategy         string `json:"strategy,omitempty"`
	Implementation   string `json:"implementation,omitempty"`
	ParameterVersion string `json:"parameter_version,omitempty"`
	// AlgorithmRevision distinguishes in-place evolved v4 outputs from
	// historical v4 rows (#995; empty on all legacy summaries).
	AlgorithmRevision     string        `json:"algorithm_revision,omitempty"`
	DataCutoffDay         string        `json:"data_cutoff_day,omitempty"`
	AvailabilitySemantics string        `json:"availability_semantics,omitempty"`
	Fingerprint           string        `json:"fingerprint,omitempty"`
	Speed                 *MetricSource `json:"speed,omitempty"`
	HR                    *MetricSource `json:"hr,omitempty"`
}
type MetricSource struct {
	Method     string `json:"method"`
	TargetType string `json:"target_type"`
	// State is the five-label estimation state of the evolved v4 contract
	// (#995): measured_reference / model_estimated / prior_dominated / stale /
	// unavailable. Empty on all legacy summaries until T2+ stamps it.
	State                      string            `json:"state,omitempty"`
	MeasurementQuality         string            `json:"measurement_quality"`
	EffortSupport              string            `json:"effort_support"`
	Support                    string            `json:"support"`
	RangeLow                   *float64          `json:"range_low,omitempty"`
	RangeHigh                  *float64          `json:"range_high,omitempty"`
	RangeMeaning               string            `json:"range_meaning"`
	EvidenceDate               string            `json:"evidence_date,omitempty"`
	LatestRejectedEvidenceDate string            `json:"latest_rejected_evidence_date,omitempty"`
	LatestStaleEvidenceDate    string            `json:"latest_stale_evidence_date,omitempty"`
	IndependentActivities      int               `json:"independent_activities"`
	IndependentDays            int               `json:"independent_days"`
	LabMethod                  string            `json:"lab_method,omitempty"`
	Reasons                    []string          `json:"reasons"`
	RejectedReasons            []string          `json:"rejected_reasons,omitempty"`
	Limitations                []string          `json:"limitations"`
	Evidence                   []EvidenceSummary `json:"evidence,omitempty"`
	EvidenceCount              int               `json:"evidence_count"`
}
type EvidenceSummary struct {
	ActivityID         string   `json:"activity_id"`
	RootActivityID     string   `json:"root_activity_id"`
	ActivityDay        string   `json:"activity_day"`
	SourceVersion      string   `json:"source_version"`
	EvidenceRef        string   `json:"evidence_ref,omitempty"`
	DurationS          float64  `json:"duration_s,omitempty"`
	StartS             *float64 `json:"start_s,omitempty"`
	EndS               *float64 `json:"end_s,omitempty"`
	MeasurementQuality string   `json:"measurement_quality"`
	EffortSupport      string   `json:"effort_support"`
}

// ParseSource accepts legacy/invalid rows without fabricating evidence. Unknown
// fields are discarded by typed decoding, including legacy raw observations.
func ParseSource(raw *string) SourceSummary {
	if raw == nil || *raw == "" {
		return SourceSummary{State: "legacy_source_missing"}
	}
	var out SourceSummary
	if json.Unmarshal([]byte(*raw), &out) != nil {
		return SourceSummary{State: "source_unavailable"}
	}
	if out.SchemaVersion != 1 || out.State != "available" || out.Strategy == "" || out.DataCutoffDay == "" {
		return SourceSummary{State: "legacy_source_missing"}
	}
	limitSourceString(&out.Strategy)
	limitSourceString(&out.Implementation)
	limitSourceString(&out.ParameterVersion)
	limitSourceString(&out.AlgorithmRevision)
	limitSourceString(&out.DataCutoffDay)
	limitSourceString(&out.AvailabilitySemantics)
	limitSourceString(&out.Fingerprint)
	boundSourceMetric(out.Speed)
	boundSourceMetric(out.HR)
	return out
}

// SummarizeSource separates actual model contributors from bounded rejected
// protocol history. Ordinary training cannot refresh an older maximal anchor.
func SummarizeSource(result OfflineResult) SourceSummary {
	out := SourceSummary{SchemaVersion: 1, State: "available", Strategy: string(result.Strategy), Implementation: result.Implementation, ParameterVersion: result.ParameterVersion, AlgorithmRevision: result.AlgorithmRevision, DataCutoffDay: result.Snapshot.AsOfDate.Format("2006-01-02"), AvailabilitySemantics: "event_date_retrospective"}
	legacy := func(target, support string) *MetricSource {
		return &MetricSource{Method: "legacy_v3_training_estimate", TargetType: target, MeasurementQuality: "unknown", EffortSupport: "unknown", Support: support, RangeMeaning: "unavailable", Reasons: []string{"legacy_estimate_not_independent_detection"}, Limitations: []string{"event_date_only_not_strict_as_known"}}
	}
	out.Speed = legacy("legacy_training_speed_estimate", string(result.Snapshot.ThresholdSpeedConfidence))
	out.HR = legacy("legacy_training_estimate_not_independent_LTHR", string(result.Snapshot.ThresholdHRConfidence))
	if result.Evolved != nil {
		summarizeEvolvedSource(&out, result.Evolved, result.Snapshot)
		return out
	}
	if result.Evidence == nil {
		return out
	}
	report := result.Evidence
	if h := report.Hour; h != nil {
		m := &MetricSource{Method: h.Method, TargetType: "one_hour_running_capability", MeasurementQuality: "unknown", EffortSupport: "unknown", Support: string(h.Confidence), RangeLow: h.RangeLowMps, RangeHigh: h.RangeHighMps, RangeMeaning: h.RangeMeaning, IndependentActivities: h.AnchorActivities, IndependentDays: h.AnchorDays, Reasons: h.Reasons, Limitations: h.Limitations}
		type contributorKey struct {
			id, root string
			duration float64
		}
		contributors := map[contributorKey]bool{}
		for _, o := range h.Observations {
			if o.Weight > 0 {
				contributors[contributorKey{o.ActivityID, o.RootActivityID, o.DurationS}] = true
			}
		}
		for _, e := range report.Candidates {
			if !e.Selected || (h.CenterMps != nil && !contributors[contributorKey{e.ActivityID, e.RootActivityID, e.DurationS}]) {
				continue
			}
			// With a center, only near-maximal anchors establish freshness. A soft
			// constraint may influence sensitivity but is not a new maximal test.
			if h.CenterMps != nil && e.EffortSupport != EffortConfirmedMaximal && e.EffortSupport != EffortProbableMaximal {
				continue
			}
			day := e.ActivityDate.Format("2006-01-02")
			if day > m.EvidenceDate {
				m.EvidenceDate = day
			}
			m.EvidenceCount++
			if len(m.Evidence) < 16 {
				m.Evidence = append(m.Evidence, EvidenceSummary{ActivityID: e.ActivityID, RootActivityID: e.RootActivityID, ActivityDay: day, SourceVersion: e.SourceVersion, EvidenceRef: e.EvidenceRef, DurationS: e.DurationS, StartS: e.StartS, EndS: e.EndS, MeasurementQuality: string(e.MeasurementQuality), EffortSupport: string(e.EffortSupport)})
			}
			if m.MeasurementQuality == "unknown" {
				m.MeasurementQuality = string(e.MeasurementQuality)
			} else if candidateConfidenceRank(e.MeasurementQuality) < candidateConfidenceRank(Confidence(m.MeasurementQuality)) {
				m.MeasurementQuality = string(e.MeasurementQuality)
			}
			if m.EffortSupport == "unknown" || e.EffortSupport == EffortProbableMaximal {
				m.EffortSupport = string(e.EffortSupport)
			}
		}
		out.Speed = m
	}
	if h := report.HR; h != nil {
		m := &MetricSource{Method: h.Protocol, TargetType: h.TargetType, MeasurementQuality: "unknown", EffortSupport: "unknown", Support: string(h.Confidence), RangeMeaning: "unavailable", IndependentActivities: h.IndependentActivities, IndependentDays: h.IndependentDays, LabMethod: h.LabMethod, Reasons: h.Reasons, Limitations: h.Limitations}
		if h.EvidenceDate != nil {
			m.EvidenceDate = h.EvidenceDate.Format("2006-01-02")
		}
		for _, e := range h.Observations {
			if !e.Selected {
				// Rejected protocols remain historical records, without changing
				// current estimate reasons, contributors, support or freshness.
				if e.Protocol != "" && e.Protocol != "none" {
					day := e.ActivityDate.Format("2006-01-02")
					if day > m.LatestRejectedEvidenceDate {
						m.LatestRejectedEvidenceDate = day
					}
					for _, reason := range append(append([]string(nil), e.Reasons...), e.Quality.Reasons...) {
						if reason == "stale_HR_support" && day > m.LatestStaleEvidenceDate {
							m.LatestStaleEvidenceDate = day
						}
						m.RejectedReasons = appendReason(m.RejectedReasons, reason)
					}
				}
				continue
			}
			m.MeasurementQuality = "protocol_quality_gate_passed"
			m.EffortSupport = string(e.EffortSupport)
			m.EvidenceCount++
			if len(m.Evidence) < 16 {
				start, end := e.StartS, e.EndS
				m.Evidence = append(m.Evidence, EvidenceSummary{ActivityID: e.ActivityID, RootActivityID: e.RootActivityID, ActivityDay: e.ActivityDate.Format("2006-01-02"), SourceVersion: e.SourceVersion, EvidenceRef: e.EvidenceRef, StartS: &start, EndS: &end, MeasurementQuality: m.MeasurementQuality, EffortSupport: string(e.EffortSupport)})
			}
		}
		boundSourceMetric(m)
		out.HR = m
	}
	return out
}

// summarizeEvolvedSource fills the five contract states (#995) for the
// evolved v4 (#996/#997): schema stays 1 so legacy readers keep working, but
// every metric now carries State, range and the recomputable reasons.
// MeasurementQuality/EffortSupport are derived from the contributing
// observations (weakest quality rank, dominant effort class by weight), never
// hardcoded labels (#996 review P2-1).
func summarizeEvolvedSource(out *SourceSummary, evolved *EvolvedReport, snapshot Snapshot) {
	if speed := evolved.Speed; speed != nil {
		m := &MetricSource{
			Method:                speed.Method,
			TargetType:            "model_one_hour_capability_v60",
			State:                 string(speed.State),
			MeasurementQuality:    "unknown",
			EffortSupport:         "unknown",
			Support:               string(snapshot.ThresholdSpeedConfidence),
			RangeLow:              speed.RangeLowMps,
			RangeHigh:             speed.RangeHighMps,
			RangeMeaning:          speed.RangeMeaning,
			IndependentActivities: speed.IndependentRoots,
			IndependentDays:       speed.IndependentDays,
			Reasons:               speed.Reasons,
			Limitations:           speed.Limitations,
		}
		effortWeight := map[string]float64{}
		worstRank := -1
		for i := range speed.Observations {
			o := &speed.Observations[i]
			if o.Weight <= 0 {
				continue
			}
			if o.ActivityDay > m.EvidenceDate {
				m.EvidenceDate = o.ActivityDay
			}
			rank := candidateConfidenceRank(o.MeasurementQuality)
			if worstRank < 0 || (rank > 0 && rank < worstRank) {
				worstRank = rank
			}
			effortWeight[string(o.EffortSupport)] += o.Weight
			m.EvidenceCount++
			if len(m.Evidence) < 16 {
				m.Evidence = append(m.Evidence, EvidenceSummary{ActivityID: o.ActivityID, RootActivityID: o.RootActivityID, ActivityDay: o.ActivityDay, DurationS: o.DurationS, MeasurementQuality: string(o.MeasurementQuality), EffortSupport: string(o.EffortSupport)})
			}
		}
		// Honest summary labels: the weakest contributing quality and the
		// weight-dominant effort class (ties resolved by class order).
		if worstRank > 0 {
			m.MeasurementQuality = map[int]string{3: string(ConfidenceHigh), 2: string(ConfidenceMedium), 1: string(ConfidenceLow)}[worstRank]
		} else if m.EvidenceCount > 0 {
			m.MeasurementQuality = "none"
		}
		if len(effortWeight) > 0 {
			best, bestW := "", math.Inf(-1)
			for _, class := range []string{string(EffortConfirmedMaximal), string(EffortProbableMaximal), string(EffortSubmaximal), string(EffortUnknown)} {
				if w := effortWeight[class]; w > bestW {
					best, bestW = class, w
				}
			}
			m.EffortSupport = best
		}
		boundSourceMetric(m)
		out.Speed = m
	}
	if hr := evolved.HR; hr != nil {
		m := &MetricSource{
			Method:       hr.Method,
			TargetType:   hr.TargetType,
			State:        string(hr.State),
			Support:      string(snapshot.ThresholdHRConfidence),
			RangeMeaning: "unavailable",
			Reasons:      hr.Reasons,
			Limitations:  hr.Limitations,
		}
		if hr.CenterBpm != nil {
			m.RangeLow, m.RangeHigh, m.RangeMeaning = hr.RangeLowBpm, hr.RangeHighBpm, hr.RangeMeaning
		}
		m.IndependentActivities = hr.IndependentRoots
		m.IndependentDays = hr.IndependentDays
		m.EvidenceDate = hr.EvidenceDate
		m.LatestRejectedEvidenceDate = hr.LatestRejectedEvidenceDate
		for i := range hr.Observations {
			o := &hr.Observations[i]
			if o.Role != "model_series" || o.Weight <= 0 {
				continue
			}
			if o.ActivityDay > m.EvidenceDate {
				m.EvidenceDate = o.ActivityDay
			}
			m.EvidenceCount++
			if len(m.Evidence) < 16 {
				m.Evidence = append(m.Evidence, EvidenceSummary{ActivityID: o.ActivityID, RootActivityID: o.RootActivityID, ActivityDay: o.ActivityDay, MeasurementQuality: "sensor_" + o.Sensor, EffortSupport: "unknown"})
			}
		}
		boundSourceMetric(m)
		out.HR = m
	}
}

func boundSourceMetric(m *MetricSource) {
	if m == nil {
		return
	}
	if len(m.Evidence) > 16 {
		m.Evidence = m.Evidence[:16]
	}
	if len(m.RejectedReasons) > 16 {
		m.RejectedReasons = m.RejectedReasons[:16]
	}
	if len(m.Reasons) > 16 {
		m.Reasons = m.Reasons[:16]
	}
	if len(m.Limitations) > 16 {
		m.Limitations = m.Limitations[:16]
	}
	limit := limitSourceString
	for _, p := range []*string{&m.Method, &m.TargetType, &m.State, &m.MeasurementQuality, &m.EffortSupport, &m.Support, &m.RangeMeaning, &m.EvidenceDate, &m.LatestRejectedEvidenceDate, &m.LatestStaleEvidenceDate, &m.LabMethod} {
		limit(p)
	}
	for i := range m.RejectedReasons {
		limit(&m.RejectedReasons[i])
	}
	for i := range m.Reasons {
		limit(&m.Reasons[i])
	}
	for i := range m.Limitations {
		limit(&m.Limitations[i])
	}
	for i := range m.Evidence {
		e := &m.Evidence[i]
		for _, p := range []*string{&e.ActivityID, &e.RootActivityID, &e.ActivityDay, &e.SourceVersion, &e.EvidenceRef, &e.MeasurementQuality, &e.EffortSupport} {
			limit(p)
		}
	}
}

func limitSourceString(p *string) {
	r := []rune(*p)
	if len(r) > 256 {
		*p = string(r[:256])
	}
}
