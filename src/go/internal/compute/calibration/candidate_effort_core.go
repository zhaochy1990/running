package calibration

import "time"

// The pace model evolves only in the candidate path. Unrelated baselines and
// the explicitly named segments_only comparison retain frozen v3 mathematics.
func estimateEvidenceCandidate(history []Activity, asOf time.Time, health []HealthRow, metadata []CandidateMetadata, metadataCutoff time.Time) (Snapshot, CandidateEvidenceReport) {
	snapshot := estimateRunningCalibrationV3(history, asOf, health)
	report := buildCandidateEvidence(history, metadata, asOf, metadataCutoff)
	hour := FitHourCapability(report.Candidates, asOf)
	report.Hour = &hour
	speed, confidence := hour.CenterMps, hour.Confidence
	snapshot.ThresholdSpeedMps = round4(speed)
	snapshot.ThresholdSpeedConfidence = confidence
	snapshot.CriticalSpeedMps = nil
	snapshot.DPrimeM = nil
	snapshot.RiegelK = roundN(hour.RiegelK, 4)
	snapshot.EnduranceIndex = enduranceIndex(hour.RiegelK)
	snapshot.SpeedIndex = nil
	snapshot.SpeedDurationConfidence = confidence
	if hour.RiegelK == nil {
		snapshot.SpeedDurationConfidence = ConfidenceNone
	}
	hr := buildCandidateHR(history, metadata, asOf, metadataCutoff)
	report.HR = &hr
	snapshot.ThresholdHR = round4(hr.ValueBpm)
	snapshot.ThresholdHRConfidence = hr.Confidence
	snapshot.AlgorithmVersion = candidateAlgorithmVersion
	return snapshot, report
}
