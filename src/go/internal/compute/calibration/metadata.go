package calibration

import "encoding/json"

// CandidateVersion is the explicit offline implementation identity. ModelVersion
// remains the frozen production default; changing policy is a separate operation.
const CandidateVersion = candidateAlgorithmVersion

// SourceSummary is the bounded explanation persisted with a snapshot. It never
// contains observations, raw samples, notes, coordinates or complete activities.
type SourceSummary struct {
	SchemaVersion         int           `json:"schema_version"`
	State                 string        `json:"state"`
	Strategy              string        `json:"strategy,omitempty"`
	Implementation        string        `json:"implementation,omitempty"`
	ParameterVersion      string        `json:"parameter_version,omitempty"`
	DataCutoffDay         string        `json:"data_cutoff_day,omitempty"`
	AvailabilitySemantics string        `json:"availability_semantics,omitempty"`
	Fingerprint           string        `json:"fingerprint,omitempty"`
	Speed                 *MetricSource `json:"speed,omitempty"`
	HR                    *MetricSource `json:"hr,omitempty"`
}
type MetricSource struct {
	Method                string            `json:"method"`
	TargetType            string            `json:"target_type"`
	MeasurementQuality    string            `json:"measurement_quality"`
	EffortSupport         string            `json:"effort_support"`
	Support               string            `json:"support"`
	RangeLow              *float64          `json:"range_low,omitempty"`
	RangeHigh             *float64          `json:"range_high,omitempty"`
	RangeMeaning          string            `json:"range_meaning"`
	EvidenceDate          string            `json:"evidence_date,omitempty"`
	IndependentActivities int               `json:"independent_activities"`
	IndependentDays       int               `json:"independent_days"`
	LabMethod             string            `json:"lab_method,omitempty"`
	Reasons               []string          `json:"reasons"`
	Limitations           []string          `json:"limitations"`
	Evidence              []EvidenceSummary `json:"evidence,omitempty"`
	EvidenceCount         int               `json:"evidence_count"`
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
	return out
}

// SummarizeSource retains only actual model contributors. New ordinary training
// cannot refresh the evidence day of an older maximal anchor.
func SummarizeSource(result OfflineResult) SourceSummary {
	out := SourceSummary{SchemaVersion: 1, State: "available", Strategy: string(result.Strategy), Implementation: result.Implementation, ParameterVersion: result.ParameterVersion, DataCutoffDay: result.Snapshot.AsOfDate.Format("2006-01-02"), AvailabilitySemantics: "event_date_retrospective"}
	legacy := func(target, support string) *MetricSource {
		return &MetricSource{Method: "legacy_v3_training_estimate", TargetType: target, MeasurementQuality: "unknown", EffortSupport: "unknown", Support: support, RangeMeaning: "unavailable", Reasons: []string{"legacy_estimate_not_independent_detection"}, Limitations: []string{"event_date_only_not_strict_as_known"}}
	}
	out.Speed = legacy("legacy_training_speed_estimate", string(result.Snapshot.ThresholdSpeedConfidence))
	out.HR = legacy("legacy_training_estimate_not_independent_LTHR", string(result.Snapshot.ThresholdHRConfidence))
	if result.Evidence == nil {
		return out
	}
	report := result.Evidence
	if h := report.Hour; h != nil {
		m := &MetricSource{Method: h.Method, TargetType: "one_hour_running_capability", MeasurementQuality: "unknown", EffortSupport: "unknown", Support: string(h.Confidence), RangeLow: h.RangeLowMps, RangeHigh: h.RangeHighMps, RangeMeaning: h.RangeMeaning, IndependentActivities: h.AnchorActivities, IndependentDays: h.AnchorDays, Reasons: h.Reasons, Limitations: h.Limitations}
		contributors := map[string]bool{}
		for _, o := range h.Observations {
			if o.Weight > 0 {
				contributors[o.ActivityID] = true
			}
		}
		for _, e := range report.Candidates {
			if !e.Selected || !contributors[e.ActivityID] {
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
		out.HR = m
	}
	return out
}
