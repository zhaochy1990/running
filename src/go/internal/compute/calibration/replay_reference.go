package calibration

import (
	"math"
	"strings"
	"time"
)

// Held-out outcome audit is deliberately a different type from fitting metadata.
type ReplayHRAudit struct {
	ReportDate           *time.Time `json:"report_date,omitempty"`
	LabMethod            string     `json:"lab_method,omitempty"`
	LabInstrument        string     `json:"lab_instrument,omitempty"`
	LabProcedureRef      string     `json:"lab_procedure_ref,omitempty"`
	Sensor               string     `json:"sensor,omitempty"`
	ProtocolStartS       *float64   `json:"protocol_start_s,omitempty"`
	ProtocolEndS         *float64   `json:"protocol_end_s,omitempty"`
	ContinuousVerified   *bool      `json:"continuous_verified,omitempty"`
	ProtocolCoverage     *float64   `json:"protocol_coverage,omitempty"`
	ProtocolMaxGapS      *float64   `json:"protocol_max_gap_s,omitempty"`
	Last20Coverage       *float64   `json:"last20_coverage,omitempty"`
	Last20MaxGapS        *float64   `json:"last20_max_gap_s,omitempty"`
	ArtifactReviewRef    string     `json:"artifact_review_ref,omitempty"`
	ArtifactReviewResult string     `json:"artifact_review_result,omitempty"`
	EnvironmentRef       string     `json:"environment_ref,omitempty"`
}

type ReplayQualityCheck struct {
	CaseID     string              `json:"case_id"`
	Family     string              `json:"family"`
	Status     string              `json:"status"`
	Reason     string              `json:"reason"`
	Coverage   *float64            `json:"coverage,omitempty"`
	MaxGapS    *float64            `json:"max_gap_s,omitempty"`
	Strategies map[Strategy]string `json:"strategies,omitempty"`
}

func syntheticReplay(m ReplayManifest) bool {
	return strings.Contains(strings.ToLower(m.SourceVersion), "synthetic")
}

func referenceValue(a ReplayActivity, c ReplayCaseResult, m ReplayManifest, family string) (float64, string) {
	r := a.Reference
	if r == nil {
		return 0, "reference_missing"
	}
	if !r.Real {
		return 0, "non_real_reference"
	}
	if a.Split == "train" || !a.EventTime.After(c.PredictionAsOf) || a.EventTime.After(m.AsOf) || r.AvailableAt == nil || r.AvailableAt.After(m.AsOf) || r.AvailableAt.Before(a.EventTime) {
		return 0, "reference_not_available_at_report_or_not_heldout"
	}
	if r.EvidenceRef == "" || r.Protocol == "" {
		return 0, "measurement_or_independent_audit_missing"
	}
	maximal := r.EffortSupport == "confirmed_maximal" || r.EffortSupport == "probable_maximal"
	switch family {
	case "direct_60min":
		if r.MeasurementQuality != "high" || r.Kind != "direct_60min" || r.EffortSupport != "confirmed_maximal" || r.Protocol != "continuous_60min_v1" || r.DurationS != 3600 || !finiteScalar(r.DistanceM) || r.DistanceM <= 0 {
			return 0, "direct60_protocol_not_verified"
		}
		if r.ContinuousVerified != nil && !*r.ContinuousVerified {
			return 0, "direct60_not_continuous"
		}
		return 3600000 / r.DistanceM, ""
	case "race_prediction":
		if r.Kind != "race_prediction" || !maximal || !finiteScalar(r.DurationS) || r.DurationS <= 0 || !finiteScalar(r.DistanceM) || r.DistanceM <= 0 {
			return 0, "race_near_maximal_independent_timing_not_verified"
		}
		return r.DurationS, ""
	case "lab_lthr":
		h := r.HRAudit
		if r.HRGrade != "lab_lthr" || h == nil || h.ReportDate == nil || h.ReportDate.IsZero() || h.ReportDate.After(m.AsOf) || h.ReportDate.After(*r.AvailableAt) || h.LabMethod == "" || h.LabInstrument == "" || h.LabProcedureRef == "" || r.Protocol != "lab_lthr_report_v1" || !candidateFinite(r.HRBpm) || *r.HRBpm <= 0 {
			return 0, "lab_date_method_instrument_procedure_missing"
		}
		return *r.HRBpm, ""
	case "field_hr_proxy":
		h := r.HRAudit
		if r.HRGrade != "field_hr_proxy" || h == nil || !maximal || r.Protocol != "field_30min_last20_v1" || !candidateFinite(h.ProtocolStartS) || !candidateFinite(h.ProtocolEndS) || *h.ProtocolEndS-*h.ProtocolStartS != 1800 || h.ContinuousVerified == nil || !*h.ContinuousVerified || h.Sensor != "chest_strap" || h.ArtifactReviewRef == "" || h.ArtifactReviewResult != "clear" || h.EnvironmentRef == "" {
			return 0, "field_protocol_sensor_continuity_artifact_or_environment_missing"
		}
		if !coverageQualified(h.ProtocolCoverage, h.ProtocolMaxGapS) || !coverageQualified(h.Last20Coverage, h.Last20MaxGapS) {
			return 0, "field_coverage_or_gap_not_qualified"
		}
		if len(a.Activity.Samples) > 0 {
			points, bad := candidateHRPoints(a.Activity)
			full, quality := measureCandidateHR(points, *h.ProtocolStartS, *h.ProtocolEndS)
			mean, lastQuality := measureCandidateHR(points, *h.ProtocolEndS-1200, *h.ProtocolEndS)
			// Only frozen reference coverage/gap rules apply. Candidate research
			// drift/range/recovery filters are not independent-reference gates.
			if bad || full == nil || mean == nil || quality.Coverage < .95 || quality.MaxGapS > 5 || lastQuality.Coverage < .95 || lastQuality.MaxGapS > 5 {
				return 0, "field_samples_fail_frozen_coverage_or_clock"
			}
			if r.HRBpm != nil && (!candidateFinite(r.HRBpm) || math.Abs(*r.HRBpm-*mean) > 1e-9) {
				return 0, "field_report_disagrees_with_fixed_last20_mean"
			}
			return *mean, ""
		}
		if !candidateFinite(r.HRBpm) || *r.HRBpm <= 0 {
			return 0, "field_HR_value_missing"
		}
		return *r.HRBpm, ""
	}
	return 0, "unsupported_reference_family"
}

func coverageQualified(coverage, gap *float64) bool {
	return candidateFinite(coverage) && *coverage >= .95 && *coverage <= 1 && candidateFinite(gap) && *gap >= 0 && *gap <= 5
}
