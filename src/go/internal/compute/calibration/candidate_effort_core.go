package calibration

import "time"

// T3 changes the input pool and confidence ceiling, not the legacy model's
// equations. T4 owns cross-duration inference and replacement of the shortcut.
func estimateEvidenceCandidate(history []Activity, asOf time.Time, health []HealthRow, metadata []CandidateMetadata, metadataCutoff time.Time) (Snapshot, CandidateEvidenceReport) {
	snapshot := estimateRunningCalibrationV3(history, asOf, health)
	report := buildCandidateEvidence(history, metadata, asOf, metadataCutoff)
	candidates := []SpeedCandidate{}
	ceiling := ConfidenceHigh
	for _, e := range report.Candidates {
		// Long/full-duration observations are available to T4 but must not be folded
		// into the legacy nearest-60min bucket by its limited-duration estimator.
		if !e.Selected || e.DurationS > 3600 || e.AvgSpeedMps < 1.5 {
			continue
		}
		c := SpeedCandidate{Activity: Activity{LabelID: e.ActivityID, ActivityDate: e.ActivityDate, Sport: "run"}, DurationS: e.DurationS, AvgSpeedMps: e.AvgSpeedMps, Source: e.Source, StartS: e.StartS, EndS: e.EndS, Confidence: e.MeasurementQuality}
		candidates = append(candidates, c)
		cap := ConfidenceLow
		if e.EffortSupport == EffortConfirmedMaximal {
			cap = ConfidenceHigh
		} else if e.EffortSupport == EffortProbableMaximal {
			cap = ConfidenceMedium
		}
		if candidateConfidenceRank(e.MeasurementQuality) < candidateConfidenceRank(cap) {
			cap = e.MeasurementQuality
		}
		if candidateConfidenceRank(cap) < candidateConfidenceRank(ceiling) {
			ceiling = cap
		}
	}
	if len(candidates) == 0 {
		ceiling = ConfidenceNone
	}
	speed, confidence, model := estimateThresholdSpeed(candidates, asOf)
	if candidateConfidenceRank(confidence) > candidateConfidenceRank(ceiling) {
		confidence = ceiling
	}
	snapshot.ThresholdSpeedMps = round4(speed)
	snapshot.ThresholdSpeedConfidence = confidence
	snapshot.CriticalSpeedMps = model.CriticalSpeedMps
	snapshot.DPrimeM = model.DPrimeM
	snapshot.RiegelK = model.RiegelK
	snapshot.EnduranceIndex = model.EnduranceIndex
	snapshot.SpeedIndex = model.SpeedIndex
	snapshot.SpeedDurationConfidence = model.Confidence
	if candidateConfidenceRank(snapshot.SpeedDurationConfidence) > candidateConfidenceRank(ceiling) {
		snapshot.SpeedDurationConfidence = ceiling
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
