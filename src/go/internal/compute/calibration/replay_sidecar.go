package calibration

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

// Evaluation annotations cannot contain train inputs, effort upgrades, measured
// outcomes or model parameters. Existing base/split artifacts remain immutable.
type ReplayEvaluationSidecar struct {
	SchemaVersion      int                         `json:"schema_version"`
	BaseManifestSHA256 string                      `json:"base_manifest_sha256"`
	AvailableAt        time.Time                   `json:"available_at"`
	EvidenceRef        string                      `json:"evidence_ref"`
	RuleVersion        string                      `json:"rule_version"`
	RequiredStrata     []string                    `json:"required_strata,omitempty"`
	Annotations        []ReplayReferenceAnnotation `json:"annotations,omitempty"`
	Engineering        *ReplayEngineeringEvidence  `json:"engineering,omitempty"`
}
type ReplayReferenceAnnotation struct {
	User           string         `json:"user"`
	RootActivityID string         `json:"root_activity_id"`
	HRAudit        *ReplayHRAudit `json:"hr_audit,omitempty"`
	Device         string         `json:"device,omitempty"`
	Scenarios      []string       `json:"scenarios,omitempty"`
}
type ReplayEngineeringEvidence struct {
	CodeVersion                 string  `json:"code_version"`
	DeterministicPassed         bool    `json:"deterministic_passed"`
	LegacyPaceDeltaSPerKM       float64 `json:"legacy_pace_delta_s_per_km"`
	E2EPassed                   bool    `json:"e2e_passed"`
	ReviewPassed                bool    `json:"review_passed"`
	DeterministicEvidenceRef    string  `json:"deterministic_evidence_ref"`
	E2EEvidenceRef              string  `json:"e2e_evidence_ref"`
	ReviewEvidenceRef           string  `json:"review_evidence_ref"`
	DeterministicEvidenceSHA256 string  `json:"deterministic_evidence_sha256"`
	E2EEvidenceSHA256           string  `json:"e2e_evidence_sha256"`
	ReviewEvidenceSHA256        string  `json:"review_evidence_sha256"`
	verified                    bool
}

func ReplayWithEvaluationSidecar(m ReplayManifest, code string, sidecar ReplayEvaluationSidecar) (ReplayReport, error) {
	return replay(m, code, &sidecar)
}

func applyReplaySidecar(m ReplayManifest, code string, sidecar *ReplayEvaluationSidecar) (ReplayManifest, error) {
	if sidecar == nil {
		return m, nil
	}
	if sidecar.SchemaVersion != 1 || sidecar.BaseManifestSHA256 != ReplayContentHash(m) || sidecar.AvailableAt.IsZero() || sidecar.AvailableAt.After(m.AsOf) || sidecar.EvidenceRef == "" || sidecar.RuleVersion == "" {
		return ReplayManifest{}, fmt.Errorf("evaluation sidecar identity, availability or base manifest hash invalid")
	}
	if e := sidecar.Engineering; e != nil && e.CodeVersion != code {
		return ReplayManifest{}, fmt.Errorf("engineering evidence code version mismatch")
	}
	out := m
	out.Activities = append([]ReplayActivity(nil), m.Activities...)
	out.RequiredStrata = append(append([]string(nil), m.RequiredStrata...), sidecar.RequiredStrata...)
	seen := map[string]bool{}
	for _, annotation := range sidecar.Annotations {
		key := annotation.User + "/" + annotation.RootActivityID
		if annotation.User == "" || annotation.RootActivityID == "" || seen[key] {
			return ReplayManifest{}, fmt.Errorf("invalid or duplicate reference annotation")
		}
		seen[key] = true
		found := false
		for i, a := range out.Activities {
			if a.User != annotation.User || a.RootActivityID != annotation.RootActivityID {
				continue
			}
			if a.Split == "train" || a.Reference == nil {
				return ReplayManifest{}, fmt.Errorf("evaluation annotation requires heldout reference, never train")
			}
			found = true
			if annotation.HRAudit != nil {
				r := *a.Reference
				r.HRAudit = annotation.HRAudit
				out.Activities[i].Reference = &r
			}
			if annotation.Device != "" {
				out.Activities[i].Device = annotation.Device
			}
			if len(annotation.Scenarios) > 0 {
				out.Activities[i].Scenarios = append([]string(nil), annotation.Scenarios...)
			}
		}
		if !found {
			return ReplayManifest{}, fmt.Errorf("evaluation annotation target missing")
		}
	}
	return out, nil
}

func replayEngineering(sidecar *ReplayEvaluationSidecar) (string, ReplayGate) {
	g := ReplayGate{ID: "deterministic", Status: "insufficient", Threshold: "all deterministic regressions passed; legacy pace delta <=0.01", Unit: "s/km", Reason: "external_deterministic_evidence_required"}
	if sidecar == nil || sidecar.Engineering == nil || !sidecar.Engineering.verified {
		return "unavailable_external_acceptance_evidence_required", g
	}
	e := sidecar.Engineering
	if e.DeterministicEvidenceRef != "" {
		g.Status = "fail"
		g.Reason = "deterministic_regression_failed"
		g.Observed = e.LegacyPaceDeltaSPerKM
		if finiteScalar(e.LegacyPaceDeltaSPerKM) && e.LegacyPaceDeltaSPerKM >= 0 && e.LegacyPaceDeltaSPerKM <= .01 && e.DeterministicPassed {
			g.Status = "pass"
			g.Reason = ""
		}
	}
	if g.Status == "fail" || !e.E2EPassed || !e.ReviewPassed {
		return "failed", g
	}
	if g.Status == "pass" && e.E2EPassed && e.ReviewPassed && e.E2EEvidenceRef != "" && e.ReviewEvidenceRef != "" {
		return "passed", g
	}
	return "insufficient_external_acceptance_evidence", g
}

// ReplayEngineeringReceipt is a small local evidence index, not a release
// authorization. Artifact references point to the actual test/review records.
type ReplayEngineeringReceipt struct {
	Kind                  string   `json:"kind"`
	CodeVersion           string   `json:"code_version"`
	Status                string   `json:"status"`
	ArtifactRef           string   `json:"artifact_ref"`
	LegacyPaceDeltaSPerKM *float64 `json:"legacy_pace_delta_s_per_km,omitempty"`
}

// ReplayWithEvaluationEvidence verifies explicit local receipt bytes against
// the sidecar's content hashes. No filesystem, database or network access occurs.
func ReplayWithEvaluationEvidence(m ReplayManifest, code string, sidecar ReplayEvaluationSidecar, artifacts map[string][]byte) (ReplayReport, error) {
	if sidecar.Engineering != nil {
		e := *sidecar.Engineering
		specs := []struct {
			kind, ref, hash string
			status          bool
		}{{"deterministic", e.DeterministicEvidenceRef, e.DeterministicEvidenceSHA256, e.DeterministicPassed}, {"e2e", e.E2EEvidenceRef, e.E2EEvidenceSHA256, e.E2EPassed}, {"review", e.ReviewEvidenceRef, e.ReviewEvidenceSHA256, e.ReviewPassed}}
		for _, spec := range specs {
			raw, ok := artifacts[spec.ref]
			if !ok || len(spec.hash) != 64 || hashBytes(raw) != spec.hash {
				return ReplayReport{}, fmt.Errorf("engineering %s receipt missing or hash mismatch", spec.kind)
			}
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			var receipt ReplayEngineeringReceipt
			if err := decoder.Decode(&receipt); err != nil {
				return ReplayReport{}, fmt.Errorf("engineering %s receipt invalid: %w", spec.kind, err)
			}
			var extra any
			if err := decoder.Decode(&extra); err != io.EOF {
				return ReplayReport{}, fmt.Errorf("engineering receipt must contain one JSON value")
			}
			if receipt.CodeVersion != code || receipt.Kind != spec.kind || receipt.ArtifactRef == "" || receipt.Status != "passed" && receipt.Status != "failed" || (receipt.Status == "passed") != spec.status {
				return ReplayReport{}, fmt.Errorf("engineering %s receipt identity/status mismatch", spec.kind)
			}
			if spec.kind == "deterministic" && (receipt.LegacyPaceDeltaSPerKM == nil || !candidateFinite(receipt.LegacyPaceDeltaSPerKM) || *receipt.LegacyPaceDeltaSPerKM != e.LegacyPaceDeltaSPerKM) {
				return ReplayReport{}, fmt.Errorf("engineering deterministic pace evidence mismatch")
			}
		}
		e.verified = true
		sidecar.Engineering = &e
	}
	return replay(m, code, &sidecar)
}
