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
