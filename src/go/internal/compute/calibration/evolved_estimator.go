package calibration

import (
	"time"
)

// evolved_estimator.go assembles the evolved v4 rev3 offline result: the
// v4.md (2026-11-17) constrained margin fit over the proven lower bounds
// with the joint HR feedback, the frozen identity triple
// (evolved_v4md_rev3 / rev3-v4md-2026-11 / v4-rev3-2026-11). It is reachable
// only through the offline seam (EstimateOffline* / EstimateEvolvedOffline);
// production wiring never selects it.

// EvolvedReport is the evolved candidate's own explanation block: contract
// and prior identity hashes (lineage anchors), the constrained pace fit and
// the HR report.
type EvolvedReport struct {
	ContractVersion      string              `json:"contract_version"`
	ContractIdentityHash string              `json:"contract_identity_hash"`
	PriorsIdentityHash   string              `json:"priors_identity_hash"`
	Speed                *EvolvedSpeedReport `json:"speed,omitempty"`
	HR                   *EvolvedHRReport    `json:"hr,omitempty"`
	Limitations          []string            `json:"limitations"`
}

// EstimateEvolvedOffline runs the evolved v4 rev3 fit. The historical
// capability prior is lineage-only: v4.md §5.3 forbids reusing old snapshots
// as capability observations, so it is recorded for audit and never enters
// the objective (batch recompute per explicit as-of; no
// "last value × (1+margin)" loops).
func EstimateEvolvedOffline(history []Activity, asOf time.Time, health []HealthRow, metadata []CandidateMetadata, prior *HistoricalCapabilityPrior) (OfflineResult, error) {
	snapshot, evidence, evolved := estimateEvolvedCandidate(history, asOf, health, metadata, asOf, prior)
	implementation, parameterVersion, revision := EvolvedCandidateIdentity()
	return OfflineResult{
		Strategy:          StrategyEvolvedCandidate,
		Implementation:    implementation,
		ParameterVersion:  parameterVersion,
		AlgorithmRevision: revision,
		Snapshot:          snapshot,
		Evidence:          &evidence,
		Evolved:           evolved,
	}, nil
}

func estimateEvolvedCandidate(history []Activity, asOf time.Time, health []HealthRow, metadata []CandidateMetadata, metadataCutoff time.Time, prior *HistoricalCapabilityPrior) (Snapshot, CandidateEvidenceReport, *EvolvedReport) {
	priors := DefaultEvolvedPriors()
	if err := priors.Validate(); err != nil {
		// A broken prior set is a hard failure of the computation, never an
		// invented number (the contract rejects the whole revision).
		snapshot := estimateRunningCalibrationV3(history, asOf, health)
		snapshot.AlgorithmVersion = CandidateVersion
		snapshot.ThresholdSpeedMps = nil
		snapshot.ThresholdSpeedConfidence = ConfidenceNone
		snapshot.ThresholdHR = nil
		snapshot.ThresholdHRConfidence = ConfidenceNone
		evidence := buildCandidateEvidence(history, metadata, asOf, metadataCutoff)
		contract := EstimationContractDocumentSnapshot()
		evolved := &EvolvedReport{
			ContractVersion:      contract.ContractVersion,
			ContractIdentityHash: contract.IdentityHash(),
			PriorsIdentityHash:   priors.IdentityHash(),
			Speed:                &EvolvedSpeedReport{ParameterVersion: EvolvedPriorSetVersion, Method: v4MethodUnavailable, State: StateUnavailable, RangeMeaning: contractRangeSemantics, Reasons: []string{ReasonSolverNumericalFailure, "prior_set_invalid"}, Limitations: v4SpeedLimitations()},
			HR:                   &EvolvedHRReport{ParameterVersion: EvolvedPriorSetVersion, Method: v4MethodUnavailable, State: StateUnavailable, RangeMeaning: contractRangeSemantics, Reasons: []string{ReasonSolverNumericalFailure, "prior_set_invalid"}, Limitations: v4HRLimitations()},
			Limitations:          []string{"prior_set_invalid"},
		}
		return snapshot, evidence, evolved
	}
	// §9 steps 1-7 live in the assembly; the estimate is one batch over the
	// original evidence at the fixed as-of (§5.3).
	est := newV4Estimate(history, asOf, health, metadata, metadataCutoff, priors)
	speed, hr := buildV4Reports(est, prior)

	// Unrelated baselines keep their frozen v3 calculation during this
	// migration; only the pace/HR/k fields move to the rev3 fit.
	snapshot := estimateRunningCalibrationV3(history, asOf, health)
	snapshot.AlgorithmVersion = CandidateVersion
	snapshot.ThresholdSpeedMps = round4(speed.CenterMps)
	snapshot.ThresholdSpeedConfidence = v4ConfidenceForState(speed.State, speed.SolverConverged)
	snapshot.CriticalSpeedMps = nil
	snapshot.DPrimeM = nil
	snapshot.RiegelK = roundN(speed.RiegelK, 4)
	snapshot.EnduranceIndex = nil
	if speed.RiegelK != nil {
		snapshot.EnduranceIndex = enduranceIndex(speed.RiegelK)
	}
	snapshot.SpeedIndex = nil
	snapshot.SpeedDurationConfidence = snapshot.ThresholdSpeedConfidence
	if speed.RiegelK == nil {
		snapshot.SpeedDurationConfidence = ConfidenceNone
	}
	snapshot.ThresholdHR = round4(hr.CenterBpm)
	snapshot.ThresholdHRConfidence = v4ConfidenceForState(hr.State, hr.SolverConverged)

	contract := EstimationContractDocumentSnapshot()
	limitations := v4SpeedLimitations()
	limitations = append(limitations, hr.Limitations...)
	evolved := &EvolvedReport{
		ContractVersion:      contract.ContractVersion,
		ContractIdentityHash: contract.IdentityHash(),
		PriorsIdentityHash:   priors.IdentityHash(),
		Speed:                &speed,
		HR:                   &hr,
		Limitations:          limitations,
	}
	return snapshot, est.evidenceReport, evolved
}

// v4ConfidenceForState maps the four §8.3 output states onto the legacy
// confidence vocabulary. No estimate without an independent reference ever
// reaches high (v4.md publishes no measured_reference centers); a
// non-converged solver caps at low.
func v4ConfidenceForState(state EstimationState, converged bool) Confidence {
	var c Confidence
	switch state {
	case StateModelEstimated:
		c = ConfidenceMedium
	case StatePriorDominated, StateStale:
		c = ConfidenceLow
	default:
		c = ConfidenceNone
	}
	if !converged && c == ConfidenceMedium {
		c = ConfidenceLow
	}
	return c
}
