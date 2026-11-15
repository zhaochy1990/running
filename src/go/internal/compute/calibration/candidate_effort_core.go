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
	// T5 owns independent HR support. Keep the legacy HR calculation explicit,
	// never promote it above low merely because the new pace fit is supported.
	ceiling := ConfidenceLow
	if speed == nil {
		ceiling = ConfidenceNone
	}
	snapshot.ThresholdHR = nil
	snapshot.ThresholdHRConfidence = ConfidenceNone
	if speed != nil {
		recent := []Activity{}
		for _, a := range history {
			if inClosedRange(a.ActivityDate, asOf.AddDate(0, 0, -180), asOf) {
				recent = append(recent, a)
			}
		}
		hrmax := EstimateHRMaxProfile(recent)
		hr, conf := estimateThresholdHR(StableThresholdHrCandidates(recent, *speed), hrmax.EstimatedHRMax, hrmax.Confidence)
		if candidateConfidenceRank(conf) > candidateConfidenceRank(ceiling) {
			conf = ceiling
		}
		snapshot.ThresholdHR = round4(hr)
		snapshot.ThresholdHRConfidence = conf
	}
	snapshot.AlgorithmVersion = candidateAlgorithmVersion
	return snapshot, report
}
