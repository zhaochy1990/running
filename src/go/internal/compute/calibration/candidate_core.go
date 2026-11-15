package calibration

import "time"

// T2 deliberately reuses the frozen estimator rules, including their known
// one-hour shortcut. T3-T5 evolve only StrategyCandidate; segments_only remains
// this explicit comparison. Neither entry point is a production selector.
const segmentsImplementation = "segments_v1_v3_estimator"
const segmentsParameterVersion = "segments-v1-conservative-research"
const candidateAlgorithmVersion = 4

func estimateSegmentsOnly(history []Activity, asOf time.Time, health []HealthRow) (Snapshot, CandidateSegments) {
	// Unrelated baselines retain their exact v3 calculation during this migration.
	snapshot := estimateRunningCalibrationV3(history, asOf, health)
	recent := make([]Activity, 0, len(history))
	for _, a := range history {
		if inClosedRange(a.ActivityDate, asOf.AddDate(0, 0, -180), asOf) {
			recent = append(recent, a)
		}
	}
	measurements := BuildCandidateSegments(recent, BestEffortDurationsS)
	candidates := make([]SpeedCandidate, 0, len(measurements.Candidates))
	modelQuality := ConfidenceNone
	for _, m := range measurements.Candidates {
		// Measurement retains valid 0/low-speed intervals. The legacy running model
		// still requires a running-speed aggregate; never filter individual points.
		if m.AvgSpeedMps < 1.5 {
			continue
		}
		candidates = append(candidates, m.SpeedCandidate)
	}
	if len(candidates) > 0 {
		modelQuality = ConfidenceHigh
		for _, c := range buildBestByDuration(candidates) {
			if candidateConfidenceRank(c.Confidence) < candidateConfidenceRank(modelQuality) {
				modelQuality = c.Confidence
			}
		}
	}
	speed, confidence, model := estimateThresholdSpeed(candidates, asOf)
	if candidateConfidenceRank(confidence) > candidateConfidenceRank(modelQuality) {
		confidence = modelQuality
	}
	snapshot.ThresholdSpeedMps = round4(speed)
	snapshot.ThresholdSpeedConfidence = confidence
	snapshot.CriticalSpeedMps = model.CriticalSpeedMps
	snapshot.DPrimeM = model.DPrimeM
	snapshot.RiegelK = model.RiegelK
	snapshot.EnduranceIndex = model.EnduranceIndex
	snapshot.SpeedIndex = model.SpeedIndex
	snapshot.SpeedDurationConfidence = model.Confidence
	if candidateConfidenceRank(snapshot.SpeedDurationConfidence) > candidateConfidenceRank(modelQuality) {
		snapshot.SpeedDurationConfidence = modelQuality
	}
	// The legacy pace-conditioned HR rule is deliberately left for T5, with the
	// same explicit measurement confidence ceiling. This is not HR validation.
	snapshot.ThresholdHR = nil
	snapshot.ThresholdHRConfidence = ConfidenceNone
	if speed != nil {
		hrmax := EstimateHRMaxProfile(recent)
		hr, hrConfidence := estimateThresholdHR(StableThresholdHrCandidates(recent, *speed), hrmax.EstimatedHRMax, hrmax.Confidence)
		if candidateConfidenceRank(hrConfidence) > candidateConfidenceRank(modelQuality) {
			hrConfidence = modelQuality
		}
		snapshot.ThresholdHR = round4(hr)
		snapshot.ThresholdHRConfidence = hrConfidence
	}
	snapshot.AlgorithmVersion = candidateAlgorithmVersion
	return snapshot, measurements
}
func candidateConfidenceRank(c Confidence) int {
	switch c {
	case ConfidenceHigh:
		return 3
	case ConfidenceMedium:
		return 2
	case ConfidenceLow:
		return 1
	default:
		return 0
	}
}
