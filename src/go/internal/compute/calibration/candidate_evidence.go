package calibration

// OfflineSegmentEvidence is deliberately smaller than CandidateSegment: raw
// activity/timeseries/laps never fan out into replay reports or public diagnostics.
type OfflineSegmentEvidence struct {
	ActivityID  string         `json:"activity_id"`
	DurationS   float64        `json:"duration_s"`
	AvgSpeedMps float64        `json:"avg_speed_mps"`
	Source      string         `json:"source"`
	StartS      *float64       `json:"start_s,omitempty"`
	EndS        *float64       `json:"end_s,omitempty"`
	Confidence  Confidence     `json:"measurement_confidence"`
	Quality     SegmentQuality `json:"quality"`
}
type OfflineSegmentReport struct {
	Candidates  []OfflineSegmentEvidence      `json:"candidates"`
	Diagnostics []CandidateActivityDiagnostic `json:"diagnostics"`
}

func projectCandidateSegments(measurements CandidateSegments) *OfflineSegmentReport {
	report := &OfflineSegmentReport{Diagnostics: measurements.Diagnostics}
	for _, m := range measurements.Candidates {
		report.Candidates = append(report.Candidates, OfflineSegmentEvidence{ActivityID: m.Activity.LabelID, DurationS: m.DurationS, AvgSpeedMps: m.AvgSpeedMps, Source: m.Source, StartS: m.StartS, EndS: m.EndS, Confidence: m.Confidence, Quality: m.Quality})
	}
	return report
}
