package calibration_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"math"
	"testing"
	"time"
)

func TestReplayIndependentReferenceAuditRejectsUnauditedHRAndSeparatesRetrospective(t *testing.T) {
	m := replayFixture(t)
	addHistoricalMaximalEvidence(&m)
	cutoff := m.Cases[0].PredictionAsOf
	a := m.Activities[0]
	a.ID = "target"
	a.RootActivityID = "heldout"
	a.Split = "final_holdout"
	a.InputEvidence = nil
	a.EventTime = cutoff.Add(time.Hour)
	a.Activity.ActivityDate = cutoff
	a.Activity.LabelID = "target"
	a.ContentSHA256 = calibration.ReplayContentHash(a.Activity)
	at := a.EventTime.Add(time.Hour)
	a.AvailableAt = &at
	a.Reference = &calibration.ReplayReference{Real: true, Kind: "race_prediction", EffortSupport: "probable_maximal", MeasurementQuality: "high", EvidenceRef: "independent-timing-audit", Protocol: "race_timing_v1", AvailableAt: &at, DistanceM: 10000, DurationS: 2400, HRGrade: "lab_lthr", HRBpm: floatPointer(170)}
	m.Activities = append(m.Activities, a)
	m.Cases[0].Mode = "event_date_retrospective"
	m.Cases[0].TargetRootActivityID = "heldout"
	r, err := calibration.Replay(m, "test")
	if err != nil {
		t.Fatal(err)
	}
	find := func(family, mode string) calibration.ReplayCohortEvaluation {
		for _, c := range r.Cohorts {
			if c.Split == "final_holdout" && c.Family == family && c.Mode == mode {
				return c
			}
		}
		t.Fatalf("missing cohort %s/%s", family, mode)
		return calibration.ReplayCohortEvaluation{}
	}
	race := find("race_prediction", "event_date_retrospective")
	if race.EligibleActivities != 1 || race.EligibleUsers != 1 || find("race_prediction", "strict").EligibleActivities != 0 {
		t.Fatal("retro pooled into strict or probable discarded")
	}
	if find("lab_lthr", "event_date_retrospective").EligibleActivities != 0 {
		t.Fatal("unaudited lab admitted")
	}
	if r.ReleaseReady {
		t.Fatal("one retrospective target released")
	}
}

func TestReplayRejectsConflictingPredictionCutoffsAndMissingTargets(t *testing.T) {
	m := replayFixture(t)
	m.Cases[0].TargetRootActivityID = "absent"
	if _, err := calibration.Replay(m, "test"); err == nil {
		t.Fatal("missing target accepted")
	}
	m.Cases[0].TargetRootActivityID = "train"
	if _, err := calibration.Replay(m, "test"); err == nil {
		t.Fatal("training target accepted")
	}
}

func TestReplaySidecarPreservesBaseAndFitProvenance(t *testing.T) {
	m := replayFixture(t)
	baseline, err := calibration.Replay(m, "fixed-code")
	if err != nil {
		t.Fatal(err)
	}
	at := m.AsOf.Add(-time.Hour)
	sidecar := calibration.ReplayEvaluationSidecar{SchemaVersion: 1, BaseManifestSHA256: calibration.ReplayContentHash(m), AvailableAt: at, EvidenceRef: "immutable-audit", RuleVersion: "frozen-audit-v1", RequiredStrata: []string{"device:previously_declared"}, Engineering: &calibration.ReplayEngineeringEvidence{CodeVersion: "fixed-code", DeterministicPassed: true, LegacyPaceDeltaSPerKM: .01, E2EPassed: true, ReviewPassed: true, DeterministicEvidenceRef: "sha256:deterministic", E2EEvidenceRef: "sha256:e2e", ReviewEvidenceRef: "sha256:review"}}
	got, err := calibration.ReplayWithEvaluationSidecar(m, "fixed-code", sidecar)
	if err != nil {
		t.Fatal(err)
	}
	if got.ManifestSHA256 != baseline.ManifestSHA256 || got.Cases[0].InputSHA256 != baseline.Cases[0].InputSHA256 || got.SidecarSHA256 == "" || got.EngineeringStatus != "unavailable_external_acceptance_evidence_required" || got.ReleaseReady {
		t.Fatalf("bad sidecar isolation: %+v", got)
	}
	sidecar.BaseManifestSHA256 = "tampered"
	if _, err := calibration.ReplayWithEvaluationSidecar(m, "fixed-code", sidecar); err == nil {
		t.Fatal("unbound sidecar admitted")
	}
}

func TestReplayOutcomesCountsPredictionStatesOnOneSharedDenominator(t *testing.T) {
	m := replayFixture(t)
	m.Cases = nil
	cutoff := m.AsOf.Add(-24 * time.Hour)
	at := cutoff.Add(2 * time.Hour)
	var results []calibration.ReplayCaseResult
	speed, k := 4.0, .06
	for i, id := range []string{"one", "two", "three", "four"} {
		a := m.Activities[0]
		a.ID = id
		a.User = "athlete-a"
		a.RootActivityID = id
		a.Split = "final_holdout"
		a.InputEvidence = nil
		a.EventTime = cutoff.Add(time.Hour)
		a.AvailableAt = &at
		a.Activity.ActivityDate = cutoff
		a.Activity.LabelID = id
		a.ContentSHA256 = calibration.ReplayContentHash(a.Activity)
		a.Reference = &calibration.ReplayReference{Kind: "race_prediction", Real: true, EffortSupport: "confirmed_maximal", MeasurementQuality: "high", EvidenceRef: "independent-test", Protocol: "race_timing_v1", AvailableAt: &at, DurationS: 3600, DistanceM: 14400}
		if i == 2 {
			a.Reference.DistanceM = 100000
		}
		m.Activities = append(m.Activities, a)
		c := calibration.ReplayCase{ID: id, User: a.User, Mode: "strict", PredictionAsOf: cutoff, TargetRootActivityID: id}
		m.Cases = append(m.Cases, c)
		r := calibration.ReplayCaseResult{ID: id, User: a.User, Mode: c.Mode, PredictionAsOf: cutoff, TargetRootActivityID: id}
		for _, s := range []calibration.Strategy{calibration.StrategyCandidate, calibration.StrategyV3, calibration.StrategySegmentsOnly} {
			v, estimateErr := calibration.EstimateOffline(s, nil, cutoff, nil)
			if estimateErr != nil {
				t.Fatal(estimateErr)
			}
			v.Snapshot = calibration.Snapshot{ThresholdSpeedMps: &speed, RiegelK: &k}
			if s == calibration.StrategyCandidate && i == 1 {
				v.Snapshot.RiegelK = nil
			}
			if s == calibration.StrategyCandidate && i == 3 {
				bad := math.NaN()
				v.Snapshot.ThresholdSpeedMps = &bad
			}
			r.Versions = append(r.Versions, v)
		}
		results = append(results, r)
	}
	cohorts, _, err := calibration.EvaluateReplayOutcomes(m, results)
	if err != nil {
		t.Fatal(err)
	}
	var found calibration.ReplayCohortEvaluation
	for _, c := range cohorts {
		if c.Family == "race_prediction" && c.Split == "final_holdout" && c.Mode == "strict" {
			found = c
		}
	}
	if found.EligibleActivities != 4 || found.PairedActivities != 1 {
		t.Fatalf("counts %+v", found)
	}
	if _, err := calibration.ReportReplayOutcomes(m, "", results); err == nil {
		t.Fatal("sealed report lacks required code provenance")
	}
	sealedReport, sealedErr := calibration.ReportReplayOutcomes(m, "fixed-code", results)
	if sealedErr != nil {
		t.Fatal(sealedErr)
	}
	if _, marshalErr := json.Marshal(sealedReport); marshalErr != nil {
		t.Fatalf("nonfinite raw sealed version escaped complete report: %v", marshalErr)
	}
	if !math.IsNaN(*results[3].Versions[0].Snapshot.ThresholdSpeedMps) {
		t.Fatal("caller sealed results mutated")
	}
	candidate := found.Versions[2]
	if candidate.Available != 1 || candidate.MissingCenter != 1 || candidate.Unsupported != 1 || candidate.ComputationFailures != 1 || candidate.Coverage != .25 || candidate.FailureRate != .25 || candidate.Missing != 3 {
		t.Fatalf("hidden unavailable outputs: %+v", candidate)
	}
	if candidate.MedianAbsoluteError == nil || math.Abs(*candidate.MedianAbsoluteError) > 1e-12 {
		t.Fatal("unpaired outputs changed shared error")
	}
	badCenter := results[3].Versions[0].Snapshot.ThresholdSpeedMps
	results[3].Versions[0].Snapshot.ThresholdSpeedMps = &speed
	m.Activities[4].Reference.DurationS = math.SmallestNonzeroFloat64
	extreme, _, extremeErr := calibration.EvaluateReplayOutcomes(m, results)
	if extremeErr != nil {
		t.Fatal(extremeErr)
	}
	if _, jsonErr := json.Marshal(extreme); jsonErr != nil {
		t.Fatalf("nonfinite reference-derived error escaped to report: %v", jsonErr)
	}
	m.Activities[4].Reference.DurationS = 3600
	results[3].Versions[0].Snapshot.ThresholdSpeedMps = badCenter
	originalVersions := results[0].Versions
	results[0].Versions = nil
	results[0].Failures = map[calibration.Strategy]string{calibration.StrategyV3: "isolated", calibration.StrategySegmentsOnly: "isolated", calibration.StrategyCandidate: "isolated"}
	tolerated, _, failureErr := calibration.EvaluateReplayOutcomes(m, results)
	if failureErr != nil {
		t.Fatal(failureErr)
	}
	for _, c := range tolerated {
		if c.Family == "race_prediction" && c.Mode == "strict" && c.Split == "final_holdout" && !c.ImplementationsValid {
			t.Fatal("isolated calculation failure invalidated implemented strategy")
		}
	}
	results[0].Versions = originalVersions
	results[0].Failures = nil
	alias := m.Activities[1]
	alias.ID = "conflicting-alias"
	alias.Activity.LabelID = "alias-source"
	alias.Activity.DistanceM = floatPointer(100)
	alias.ContentSHA256 = calibration.ReplayContentHash(alias.Activity)
	m.Activities = append(m.Activities, alias)
	if _, _, err := calibration.EvaluateReplayOutcomes(m, results); err == nil {
		t.Fatal("ambiguous same-root target payload accepted")
	}
	m.Activities = m.Activities[:len(m.Activities)-1]
	late := m.AsOf.Add(time.Nanosecond)
	m.Activities[1].Reference.Kind = "constraint_only"
	m.Activities[1].Reference.AvailableAt = &late
	m.Activities[1].Reference.MeasurementRelativeError = floatPointer(0)
	_, quality, qualityErr := calibration.EvaluateReplayOutcomes(m, results)
	if qualityErr != nil {
		t.Fatal(qualityErr)
	}
	for _, q := range quality {
		if q.CaseID == results[0].ID && len(q.Strategies) > 0 {
			t.Fatal("future constraint reference scored")
		}
	}
	results[0].Versions = append(results[0].Versions, results[0].Versions[0])
	if _, _, err := calibration.EvaluateReplayOutcomes(m, results); err == nil {
		t.Fatal("duplicate strategy silently overwritten")
	}
}

func TestReplayUserEqualWeightsPreventOneAthleteDominatingQuantiles(t *testing.T) {
	m := replayFixture(t)
	m.Activities = nil
	m.Cases = nil
	cutoff := m.AsOf.Add(-24 * time.Hour)
	at := cutoff.Add(2 * time.Hour)
	var results []calibration.ReplayCaseResult
	for user := 0; user < 10; user++ {
		n := 1
		if user == 0 {
			n = 100
		}
		for i := 0; i < n; i++ {
			id := fmt.Sprintf("u%d-r%d", user, i)
			u := fmt.Sprintf("u%d", user)
			a := calibration.ReplayActivity{ID: id, User: u, RootActivityID: id, Split: "final_holdout", EventTime: cutoff.Add(time.Hour), AvailableAt: &at, Device: "synthetic", Scenarios: []string{"continuous"}, Activity: calibration.Activity{LabelID: id, ActivityDate: cutoff, Sport: "run"}, Reference: &calibration.ReplayReference{Kind: "direct_60min", Real: true, EffortSupport: "confirmed_maximal", MeasurementQuality: "high", EvidenceRef: "independent", Protocol: "continuous_60min_v1", AvailableAt: &at, DurationS: 3600, DistanceM: 14400}}
			a.ContentSHA256 = calibration.ReplayContentHash(a.Activity)
			m.Activities = append(m.Activities, a)
			c := calibration.ReplayCase{ID: id, User: u, Mode: "strict", PredictionAsOf: cutoff, TargetRootActivityID: id}
			m.Cases = append(m.Cases, c)
			r := calibration.ReplayCaseResult{ID: id, User: u, Mode: c.Mode, PredictionAsOf: cutoff, TargetRootActivityID: id}
			speed := 4.0
			if user == 0 {
				speed = 1000.0 / 350
			}
			for _, s := range []calibration.Strategy{calibration.StrategyV3, calibration.StrategySegmentsOnly, calibration.StrategyCandidate} {
				r.Versions = append(r.Versions, calibration.OfflineResult{Strategy: s, Implementation: "implemented", ParameterVersion: "fixed", Snapshot: calibration.Snapshot{ThresholdSpeedMps: &speed}})
			}
			results = append(results, r)
		}
	}
	cohorts, _, err := calibration.EvaluateReplayOutcomes(m, results)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cohorts {
		if c.Family == "direct_60min" && c.Split == "final_holdout" && c.Mode == "strict" {
			if c.MaxUserWeight != .1 || c.PairedUsers != 10 || c.PairedActivities != 109 {
				t.Fatal(c)
			}
			metric := c.Versions[2]
			if metric.MedianAbsoluteError == nil || *metric.MedianAbsoluteError != 0 || *metric.P90AbsoluteError != 0 || math.Abs(*metric.SignedBias-10) > 1e-9 {
				t.Fatalf("pooled or floating quantile regression: %+v", metric)
			}
			if c.Uncertainty != nil {
				t.Fatal("synthetic source produced real accuracy bootstrap")
			}
		}
	}
	extremeManifest := m
	extremeManifest.Activities = nil
	extremeManifest.Cases = nil
	var extremeResults []calibration.ReplayCaseResult
	uniqueUsers := map[string]bool{}
	for i, r := range results {
		if uniqueUsers[r.User] {
			continue
		}
		uniqueUsers[r.User] = true
		a := m.Activities[i]
		ref := *a.Reference
		ref.DistanceM = 3600000 / math.MaxFloat64
		a.Reference = &ref
		extremeManifest.Activities = append(extremeManifest.Activities, a)
		extremeManifest.Cases = append(extremeManifest.Cases, m.Cases[i])
		extremeResults = append(extremeResults, r)
	}
	a := extremeManifest.Activities[0]
	a.ID = "eleventh"
	a.User = "eleventh"
	a.RootActivityID = "eleventh"
	a.Activity.LabelID = "eleventh"
	a.ContentSHA256 = calibration.ReplayContentHash(a.Activity)
	c := extremeManifest.Cases[0]
	c.ID = "eleventh"
	c.User = "eleventh"
	c.TargetRootActivityID = "eleventh"
	r := extremeResults[0]
	r.ID = c.ID
	r.User = c.User
	r.TargetRootActivityID = c.TargetRootActivityID
	extremeManifest.Activities = append(extremeManifest.Activities, a)
	extremeManifest.Cases = append(extremeManifest.Cases, c)
	extremeResults = append(extremeResults, r)

	extreme, _, extremeErr := calibration.EvaluateReplayOutcomes(extremeManifest, extremeResults)
	if extremeErr != nil {
		t.Fatal(extremeErr)
	}
	if _, marshalErr := json.Marshal(extreme); marshalErr != nil {
		t.Fatalf("finite per-case errors overflowed weighted statistics: %v", marshalErr)
	}

}

func TestReplayFieldReferenceUsesFrozenQualityRulesAndFixedLast20Minutes(t *testing.T) {
	m := replayFixture(t)
	cutoff := m.Cases[0].PredictionAsOf
	at := cutoff.Add(2 * time.Hour)
	a := m.Activities[0]
	a.ID = "field"
	a.RootActivityID = "field"
	a.Split = "final_holdout"
	a.InputEvidence = nil
	a.EventTime = cutoff.Add(time.Hour)
	a.AvailableAt = &at
	a.Activity = evidenceActivity("field", cutoff, 1800, 4)
	// Deliberate 30bpm drift exceeds candidate research filters; this is not a
	// new reference gate. Independent artifact review verifies the measurement.
	for i := range a.Activity.Samples {
		sample := &a.Activity.Samples[i]
		hr := 150 + *sample.ElapsedS/60
		sample.HeartRateBpm = &hr
	}
	a.ContentSHA256 = calibration.ReplayContentHash(a.Activity)
	continuous := true
	start, end, coverage, gap := 0.0, 1800.0, .95, 5.0
	audit := &calibration.ReplayHRAudit{Sensor: "chest_strap", ProtocolStartS: &start, ProtocolEndS: &end, ContinuousVerified: &continuous, ProtocolCoverage: &coverage, ProtocolMaxGapS: &gap, Last20Coverage: &coverage, Last20MaxGapS: &gap, ArtifactReviewRef: "audited-independent-artifacts", ArtifactReviewResult: "clear", EnvironmentRef: "audited-environment"}
	a.Reference = &calibration.ReplayReference{Kind: "constraint_only", Real: true, EffortSupport: "probable_maximal", MeasurementQuality: "high", EvidenceRef: "independent-field-test", Protocol: "field_30min_last20_v1", AvailableAt: &at, DurationS: 1800, DistanceM: 7200, HRGrade: "field_hr_proxy", HRBpm: floatPointer(170), HRAudit: audit}
	m.Activities = append(m.Activities, a)
	m.Cases[0].TargetRootActivityID = "field"
	eligible := func() int {
		r, err := calibration.Replay(m, "test")
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range r.Cohorts {
			if c.Family == "field_hr_proxy" && c.Mode == "strict" && c.Split == "final_holdout" {
				return c.EligibleActivities
			}
		}
		t.Fatal("missing field cohort")
		return -1
	}
	if eligible() != 1 {
		t.Fatal("frozen reference incorrectly inherits candidate drift/range filters")
	}
	coverage = .95 - 1e-12
	if eligible() != 0 {
		t.Fatal("coverage under 95% accepted")
	}
	coverage = .95
	gap = 5 + 1e-12
	if eligible() != 0 {
		t.Fatal("gap over 5s accepted")
	}
	gap = 5
	audit.ArtifactReviewResult = "unknown"
	if eligible() != 0 {
		t.Fatal("unknown artifacts accepted")
	}
	audit.ArtifactReviewResult = "clear"
	audit.Sensor = "wrist_optical"
	if eligible() != 0 {
		t.Fatal("wrist reference admitted as chest strap")
	}
	audit.Sensor = "chest_strap"
	a.Reference.HRBpm = floatPointer(165)
	m.Activities[1].Reference = a.Reference
	if eligible() != 0 {
		t.Fatal("full 30min mean substituted for fixed last20")
	}
}

func TestReplayEngineeringReceiptHashesAreRequiredAndVerified(t *testing.T) {
	m := replayFixture(t)
	at := m.AsOf.Add(-time.Hour)
	delta := .01
	e := &calibration.ReplayEngineeringEvidence{CodeVersion: "fixed-code", DeterministicPassed: true, E2EPassed: true, ReviewPassed: true, LegacyPaceDeltaSPerKM: delta, DeterministicEvidenceRef: "deterministic.json", E2EEvidenceRef: "e2e.json", ReviewEvidenceRef: "review.json"}
	artifacts := map[string][]byte{}
	for _, kind := range []string{"deterministic", "e2e", "review"} {
		receipt := calibration.ReplayEngineeringReceipt{Kind: kind, CodeVersion: "fixed-code", Status: "passed", ArtifactRef: "actual-local-evidence-log"}
		if kind == "deterministic" {
			receipt.LegacyPaceDeltaSPerKM = &delta
		}
		raw, err := json.Marshal(receipt)
		if err != nil {
			t.Fatal(err)
		}
		artifacts[kind+".json"] = raw
		sum := sha256.Sum256(raw)
		hash := hex.EncodeToString(sum[:])
		switch kind {
		case "deterministic":
			e.DeterministicEvidenceSHA256 = hash
		case "e2e":
			e.E2EEvidenceSHA256 = hash
		case "review":
			e.ReviewEvidenceSHA256 = hash
		}
	}
	sidecar := calibration.ReplayEvaluationSidecar{SchemaVersion: 1, BaseManifestSHA256: calibration.ReplayContentHash(m), AvailableAt: at, EvidenceRef: "audit", RuleVersion: "engineering-receipt-v1", Engineering: e}
	report, err := calibration.ReplayWithEvaluationEvidence(m, "fixed-code", sidecar, artifacts)
	if err != nil {
		t.Fatal(err)
	}
	if report.EngineeringStatus != "passed" || report.ReleaseReady {
		t.Fatal("receipt not verified or synthetic accuracy released")
	}
	e.ReviewPassed = false
	failedRaw, marshalErr := json.Marshal(calibration.ReplayEngineeringReceipt{Kind: "review", CodeVersion: "fixed-code", Status: "failed", ArtifactRef: "known-failed-review"})
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	artifacts["review.json"] = failedRaw
	failedHash := sha256.Sum256(failedRaw)
	e.ReviewEvidenceSHA256 = hex.EncodeToString(failedHash[:])
	failedReport, failedErr := calibration.ReplayWithEvaluationEvidence(m, "fixed-code", sidecar, artifacts)
	if failedErr != nil {
		t.Fatal(failedErr)
	}
	if failedReport.EngineeringStatus != "failed" || failedReport.Status != "failed" || failedReport.AccuracyStatus != "insufficient" {
		t.Fatal("known engineering failure hidden as missing evidence")
	}
	artifacts["e2e.json"] = []byte("tampered")
	if _, err := calibration.ReplayWithEvaluationEvidence(m, "fixed-code", sidecar, artifacts); err == nil {
		t.Fatal("tampered engineering accepted")
	}
}
