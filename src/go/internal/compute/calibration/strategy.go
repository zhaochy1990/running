package calibration

import (
	"fmt"
	"time"
)

// Strategy is an offline-only migration strategy, never a production setting.
type Strategy string

const (
	StrategyV3               Strategy = "v3"
	StrategySegmentsOnly     Strategy = "segments_only"
	StrategyCandidate        Strategy = "candidate"
	StrategyEvolvedCandidate Strategy = "evolved_candidate"
)

// OfflineResult separates requested strategy from the actually implemented code.
// Snapshot.AlgorithmVersion identifies the offline implementation, never active policy.
// AlgorithmRevision distinguishes the in-place evolved v4 outputs
// (EvolvedCandidateAlgorithmRevision) from historical v4 rows (empty), per the
// 2026-11-16 no-v5 decision; legacy strategies leave it empty so replay
// hashes and persisted JSON stay byte-identical. Evolved carries the evolved
// candidate's own explanation block (#996); it stays nil for every legacy
// strategy.
type OfflineResult struct {
	Strategy          Strategy                 `json:"strategy"`
	Implementation    string                   `json:"implementation"`
	ParameterVersion  string                   `json:"parameter_version"`
	AlgorithmRevision string                   `json:"algorithm_revision,omitempty"`
	Snapshot          Snapshot                 `json:"snapshot"`
	Segments          *OfflineSegmentReport    `json:"segments,omitempty"`
	Evidence          *CandidateEvidenceReport `json:"evidence,omitempty"`
	Evolved           *EvolvedReport           `json:"evolved,omitempty"`
}

// EstimateRunningCalibration is the production entry point. It deliberately has
// no environment flag or candidate selection. T6 owns any production cutover.
func EstimateRunningCalibration(history []Activity, asOf time.Time, health []HealthRow) Snapshot {
	return estimateRunningCalibrationV3(history, asOf, health)
}

// EstimateOffline runs an explicit strategy without persistence. T2-T5 must add
// candidate-specific code in this domain; never change the frozen v3 files to
// implement a candidate. See docs/calibration/evaluation-protocol-v1.md.
func EstimateOffline(strategy Strategy, history []Activity, asOf time.Time, health []HealthRow) (OfflineResult, error) {
	return EstimateOfflineWithEvidence(strategy, history, asOf, health, nil)
}

// EstimateOfflineWithEvidence admits explicit activity-bound evidence only for candidate.
// The legacy/v3 strategies ignore it and remain identical comparison controls.
func EstimateOfflineWithEvidence(strategy Strategy, history []Activity, asOf time.Time, health []HealthRow, metadata []CandidateMetadata) (OfflineResult, error) {
	return estimateOfflineWithEvidenceAt(strategy, history, asOf, health, metadata, asOf)
}

func estimateOfflineWithEvidenceAt(strategy Strategy, history []Activity, asOf time.Time, health []HealthRow, metadata []CandidateMetadata, metadataCutoff time.Time) (OfflineResult, error) {
	implementation := "v3"
	parameterVersion := "v3-frozen"
	algorithmRevision := ""
	var snapshot Snapshot
	var segments *OfflineSegmentReport
	var evidence *CandidateEvidenceReport
	var evolved *EvolvedReport
	switch strategy {
	case StrategyV3:
		snapshot = estimateRunningCalibrationV3(history, asOf, health)
	case StrategySegmentsOnly:
		implementation = segmentsImplementation
		parameterVersion = segmentsParameterVersion
		var measurements CandidateSegments
		snapshot, measurements = estimateSegmentsOnly(history, asOf, health)
		segments = projectCandidateSegments(measurements)
	case StrategyCandidate:
		implementation = hourImplementation + "+independent_hr_v1"
		parameterVersion = hourParameterVersion + "+" + hrParameterVersion
		var report CandidateEvidenceReport
		snapshot, report = estimateEvidenceCandidate(history, asOf, health, metadata, metadataCutoff)
		evidence = &report
	case StrategyEvolvedCandidate:
		// The evolved v4 stays one offline-only strategy entry (production
		// wiring never selects it). #996 assembles the speed-domain fitter
		// here; the HR joint fit is the explicit #997 seam and stays
		// unavailable rather than fabricated.
		implementation, parameterVersion, algorithmRevision = EvolvedCandidateIdentity()
		var report CandidateEvidenceReport
		snapshot, report, evolved = estimateEvolvedCandidate(history, asOf, health, metadata, metadataCutoff, nil)
		evidence = &report
	default:
		return OfflineResult{}, fmt.Errorf("unknown calibration strategy %q", strategy)
	}
	return OfflineResult{Strategy: strategy, Implementation: implementation, ParameterVersion: parameterVersion, AlgorithmRevision: algorithmRevision, Snapshot: snapshot, Segments: segments, Evidence: evidence, Evolved: evolved}, nil
}
