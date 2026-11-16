package calibration

import (
	"time"
)

// evolved_estimator.go assembles the #996 evolved v4 offline result: the
// speed-domain latent effort-margin fit of evolved_speed.go, the contract
// adjudication five states, the honest HR seam left for #997 and the frozen
// identity triple (evolved_joint_v2 / rev2-research-2026-11 /
// v4-rev2-2026-11). It is reachable only through the offline seam
// (EstimateOffline* / EstimateEvolvedOffline); production wiring never
// selects it.

// EvolvedHRReport is the #997 seam. T2 stamps the contract adjudication state
// and refuses to fabricate a center: the joint Hsteady/tau/drift fit (with the
// F(1.0)=0.92 reserve bridge and the v60 range propagated into the HR range)
// lands with #997 and will populate this report. Optical-HR series will be
// down-weighted, never excluded.
type EvolvedHRReport struct {
	State       EstimationState `json:"state"`
	Reasons     []string        `json:"reasons"`
	Limitations []string        `json:"limitations"`
}

// EvolvedReport is the evolved candidate's own explanation block: contract
// and prior identity hashes (lineage anchors), the speed fit and the HR seam.
type EvolvedReport struct {
	ContractVersion      string              `json:"contract_version"`
	ContractIdentityHash string              `json:"contract_identity_hash"`
	PriorsIdentityHash   string              `json:"priors_identity_hash"`
	Speed                *EvolvedSpeedReport `json:"speed,omitempty"`
	HR                   *EvolvedHRReport    `json:"hr,omitempty"`
	Limitations          []string            `json:"limitations"`
}

const evolvedHRSeamMethod = "evolved_joint_hr_pending_997"

func evolvedHRSeam() *EvolvedHRReport {
	return &EvolvedHRReport{
		State:       StateUnavailable,
		Reasons:     []string{ReasonSolverPendingT2},
		Limitations: []string{"joint_HR_fit_lands_with_997", "optical_HR_will_be_downweighted_not_excluded"},
	}
}

// EstimateEvolvedOffline runs the evolved v4 speed-domain fit with an explicit
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
	// so both candidates share one measurement vocabulary.
	evidence := buildCandidateEvidence(history, metadata, asOf, metadataCutoff)
	speed := FitEvolvedSpeed(evidence.Candidates, asOf, priors, prior)

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
	// No HR center until the #997 joint fit exists; never a v3 backfill
	// dressed up as the evolved model.
	snapshot.ThresholdHR = nil
	snapshot.ThresholdHRConfidence = ConfidenceNone

	contract := EstimationContractDocumentSnapshot()
	evolved := &EvolvedReport{
		ContractVersion:      contract.ContractVersion,
		ContractIdentityHash: contract.IdentityHash(),
		PriorsIdentityHash:   priors.IdentityHash(),
		Speed:                &speed,
		HR:                   evolvedHRSeam(),
		Limitations:          evolvedSpeedLimitations(),
	}
	return snapshot, evidence, evolved
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
