package calibration

import (
	"time"
)

// evolved_estimator.go assembles the evolved v4 offline result: the joint
// speed (#996, evolved_speed.go) + individual HR dynamic (#997, evolved_hr.go)
// fit under one objective, the contract adjudication five states and the
// frozen identity triple (evolved_joint_v2 / rev2-research-2026-11 /
// v4-rev2-2026-11). It is reachable only through the offline seam
// (EstimateOffline* / EstimateEvolvedOffline); production wiring never
// selects it.

// EvolvedReport is the evolved candidate's own explanation block: contract
// and prior identity hashes (lineage anchors), the speed fit and the joint HR
// report.
type EvolvedReport struct {
	ContractVersion      string              `json:"contract_version"`
	ContractIdentityHash string              `json:"contract_identity_hash"`
	PriorsIdentityHash   string              `json:"priors_identity_hash"`
	Speed                *EvolvedSpeedReport `json:"speed,omitempty"`
	HR                   *EvolvedHRReport    `json:"hr,omitempty"`
	Limitations          []string            `json:"limitations"`
}

// EstimateEvolvedOffline runs the evolved v4 joint fit with an explicit
// weak historical capability prior (aged, variance-floored, never a speed
// cap). The prior enters the objective exactly once, so a same-source old
// snapshot can never be multiplied with the raw inputs as a second
// independent evidence vote.
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
	// Reuse the existing cleaning/pause/recovery pipeline: selection,
	// continuity verdicts and full-activity elapsed handling all stay upstream
	// so both candidates share one measurement vocabulary. The HR observation
	// report is the shared v1 vocabulary for series quality, sensors and
	// verified reference tiers.
	evidence := buildCandidateEvidence(history, metadata, asOf, metadataCutoff)
	hrEvidence := buildCandidateHR(history, metadata, asOf, metadataCutoff)
	speed, hr := FitEvolvedJoint(evidence.Candidates, history, metadata, &hrEvidence, health, asOf, priors, prior)

	// Unrelated baselines keep their frozen v3 calculation during this
	// migration; only the pace-side fields move to the evolved fit.
	snapshot := estimateRunningCalibrationV3(history, asOf, health)
	snapshot.AlgorithmVersion = CandidateVersion
	snapshot.ThresholdSpeedMps = round4(speed.CenterMps)
	snapshot.ThresholdSpeedConfidence = evolvedConfidence(speed)
	snapshot.CriticalSpeedMps = nil
	snapshot.DPrimeM = nil
	snapshot.RiegelK = roundN(speed.RiegelK, 4)
	snapshot.EnduranceIndex = enduranceIndex(speed.RiegelK)
	snapshot.SpeedIndex = nil
	snapshot.SpeedDurationConfidence = evolvedConfidence(speed)
	if speed.RiegelK == nil {
		snapshot.SpeedDurationConfidence = ConfidenceNone
	}
	snapshot.ThresholdHR = round4(hr.CenterBpm)
	snapshot.ThresholdHRConfidence = evolvedHRConfidence(hr)

	contract := EstimationContractDocumentSnapshot()
	limitations := evolvedSpeedLimitations()
	limitations = append(limitations, hr.Limitations...)
	evolved := &EvolvedReport{
		ContractVersion:      contract.ContractVersion,
		ContractIdentityHash: contract.IdentityHash(),
		PriorsIdentityHash:   priors.IdentityHash(),
		Speed:                &speed,
		HR:                   &hr,
		Limitations:          limitations,
	}
	return snapshot, evidence, evolved
}

// evolvedHRConfidence maps the HR five-state onto the legacy confidence
// vocabulary. Following the v1 principle that no HR estimate reaches high
// without independent calibration, a verified reference or an identified
// model fit both cap at medium.
func evolvedHRConfidence(hr EvolvedHRReport) Confidence {
	switch hr.State {
	case StateMeasuredReference, StateModelEstimated:
		return ConfidenceMedium
	case StatePriorDominated, StateStale:
		return ConfidenceLow
	default:
		return ConfidenceNone
	}
}

// evolvedConfidence maps the five contract states onto the legacy confidence
// vocabulary used by snapshots and zones. A missing all-out label can never
// reach high: only a measured_reference state (a real confirmed/probable
// anchor) may, and a non-converged solver caps at low.
func evolvedConfidence(speed EvolvedSpeedReport) Confidence {
	var c Confidence
	switch speed.State {
	case StateMeasuredReference:
		c = ConfidenceHigh
	case StateModelEstimated:
		c = ConfidenceMedium
	case StatePriorDominated, StateStale:
		c = ConfidenceLow
	default:
		c = ConfidenceNone
	}
	if !speed.SolverConverged && speed.CenterMps != nil && c == ConfidenceHigh {
		c = ConfidenceLow
	}
	return c
}
