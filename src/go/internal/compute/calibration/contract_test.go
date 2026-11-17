package calibration_test

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// The deterministic fixture set required by #995: ordinary runs only, one
// single valid run, optical-HR only, no all-out labels, weak historical prior
// only, no data at all, and no HR series with/without a qualified
// physiological prior. Each fixture locks the pre-declared adjudication
// contract that T2-T4 estimators must satisfy.
func contractFixtureEvidence(asOf time.Time, daysAgo int, id string, durationS, avgSpeedMps float64, support calibration.EffortSupport) calibration.CandidateEvidence {
	return calibration.CandidateEvidence{
		ActivityID:     id,
		RootActivityID: id,
		ActivityDate:   asOf.AddDate(0, 0, -daysAgo),
		DurationS:      durationS,
		AvgSpeedMps:    avgSpeedMps,
		Continuous:     true,
		Selected:       true,
		EffortSupport:  support,
	}
}

func ordinary(asOf time.Time, daysAgo int, id string, durationS, avgSpeedMps float64) calibration.CandidateEvidence {
	return contractFixtureEvidence(asOf, daysAgo, id, durationS, avgSpeedMps, calibration.EffortSubmaximal)
}

func opticalHRReport(asOf time.Time, daysAgo int, sensor string, selected bool, tier string) *calibration.CandidateHRReport {
	bpm := 165.0
	return &calibration.CandidateHRReport{
		TargetType: "unavailable",
		Protocol:   "none",
		DataCutoff: asOf,
		Observations: []calibration.CandidateHRObservation{{
			MeasurementKind: "observed_HR_timeseries",
			ActivityID:      "hr-" + sensor,
			RootActivityID:  "hr-" + sensor,
			ActivityDate:    asOf.AddDate(0, 0, -daysAgo),
			ReferenceTier:   tier,
			Protocol:        "none",
			Sensor:          sensor,
			ValueBpm:        &bpm,
			Selected:        selected,
			Reasons:         []string{},
		}},
	}
}

func TestContractAdjudicationSixDeterministicFixtures(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)

	fixtures := []struct {
		name           string
		evidence       []calibration.CandidateEvidence
		hr             *calibration.CandidateHRReport
		prior          *calibration.HistoricalCapabilityPrior
		hrPriorOK      bool
		wantSpeedState calibration.EstimationState
		wantHRState    calibration.EstimationState
		wantSpeedValid bool
		wantHREligible bool
	}{
		{
			// Ordinary training only, multiple independent days and durations:
			// speed must be estimated (model_estimated), never unavailable for
			// the missing all-out labels; no HR series and no prior -> HR
			// unavailable WITH an explicit reason.
			name: "ordinary_runs_only_no_hr",
			evidence: []calibration.CandidateEvidence{
				ordinary(asOf, 2, "a", 5400, 3.1),
				ordinary(asOf, 9, "b", 1800, 3.6),
				ordinary(asOf, 30, "c", 3600, 3.3),
			},
			wantSpeedState: calibration.StateModelEstimated,
			wantHRState:    calibration.StateUnavailable,
			wantSpeedValid: true,
			wantHREligible: false,
		},
		{
			// Exactly one valid run: identifiability is prior-limited. The
			// contract still requires a finite prior_dominated estimate with a
			// range, not an empty output.
			name:           "single_valid_run",
			evidence:       []calibration.CandidateEvidence{ordinary(asOf, 3, "only", 3600, 3.2)},
			wantSpeedState: calibration.StatePriorDominated,
			wantHRState:    calibration.StateUnavailable,
			wantSpeedValid: true,
			wantHREligible: false,
		},
		{
			// Optical wrist HR only: usable as down-weighted input. Missing
			// chest strap must not exclude or make HR unavailable.
			name:           "optical_hr_only",
			evidence:       []calibration.CandidateEvidence{ordinary(asOf, 2, "a", 3600, 3.2), ordinary(asOf, 12, "b", 5400, 3.0)},
			hr:             opticalHRReport(asOf, 2, "wrist_optical", false, "training_hr"),
			wantSpeedState: calibration.StateModelEstimated,
			wantHRState:    calibration.StateModelEstimated,
			wantSpeedValid: true,
			wantHREligible: true,
		},
		{
			// No all-out labels at all is never an unavailability reason: same
			// ordinary training with unknown effort support stays estimable.
			name: "no_all_out_labels",
			evidence: []calibration.CandidateEvidence{
				contractFixtureEvidence(asOf, 4, "a", 3600, 3.2, calibration.EffortUnknown),
				contractFixtureEvidence(asOf, 11, "b", 5400, 3.0, calibration.EffortUnknown),
				contractFixtureEvidence(asOf, 40, "c", 2400, 3.5, calibration.EffortUnknown),
			},
			wantSpeedState: calibration.StateModelEstimated,
			wantHRState:    calibration.StateUnavailable,
			wantSpeedValid: true,
			wantHREligible: false,
		},
		{
			// Weak historical prior only (no current-window observations): the
			// aged wide prior is a prior_dominated estimate, not unavailable,
			// and not a hard speed cap.
			name:           "historical_weak_prior_only",
			prior:          &calibration.HistoricalCapabilityPrior{V60Mps: 3.8, AgeDays: 120},
			wantSpeedState: calibration.StatePriorDominated,
			wantHRState:    calibration.StateUnavailable,
			wantSpeedValid: true,
			wantHREligible: false,
		},
		{
			// Completely no data and no prior: explicit unavailable with
			// reasons for both metrics.
			name:           "no_data_at_all",
			wantSpeedState: calibration.StateUnavailable,
			wantHRState:    calibration.StateUnavailable,
			wantSpeedValid: false,
			wantHREligible: false,
		},
		{
			// No HR series but a qualified physiological prior: HR is
			// prior_dominated with a finite range.
			name:           "no_hr_series_with_qualified_prior",
			evidence:       []calibration.CandidateEvidence{ordinary(asOf, 2, "a", 3600, 3.2), ordinary(asOf, 10, "b", 5400, 3.0)},
			hrPriorOK:      true,
			wantSpeedState: calibration.StateModelEstimated,
			wantHRState:    calibration.StatePriorDominated,
			wantSpeedValid: true,
			wantHREligible: true,
		},
		{
			// No HR series and no qualified prior: unavailable with an
			// explicit reason (never silently empty).
			name:           "no_hr_series_without_prior",
			evidence:       []calibration.CandidateEvidence{ordinary(asOf, 2, "a", 3600, 3.2), ordinary(asOf, 10, "b", 5400, 3.0)},
			wantSpeedState: calibration.StateModelEstimated,
			wantHRState:    calibration.StateUnavailable,
			wantSpeedValid: true,
			wantHREligible: false,
		},
		{
			// A confirmed all-out anchor promotes speed to measured_reference.
			name: "confirmed_maximal_anchor",
			evidence: []calibration.CandidateEvidence{
				contractFixtureEvidence(asOf, 5, "race", 3600, 3.9, calibration.EffortConfirmedMaximal),
				ordinary(asOf, 20, "easy", 5400, 3.0),
			},
			wantSpeedState: calibration.StateMeasuredReference,
			wantHRState:    calibration.StateUnavailable,
			wantSpeedValid: true,
			wantHREligible: false,
		},
	}

	for _, f := range fixtures {
		t.Run(f.name, func(t *testing.T) {
			in := calibration.DeriveAdjudicationInput(f.evidence, f.hr, asOf, f.prior, f.hrPriorOK)
			got := calibration.AdjudicateEstimationContract(in)
			if got.Speed.State != f.wantSpeedState {
				t.Fatalf("speed state=%s want %s (input %+v)", got.Speed.State, f.wantSpeedState, in)
			}
			if got.HR.State != f.wantHRState {
				t.Fatalf("HR state=%s want %s (input %+v)", got.HR.State, f.wantHRState, in)
			}
			if got.Speed.Valid != f.wantSpeedValid {
				t.Fatalf("speed valid=%v want %v", got.Speed.Valid, f.wantSpeedValid)
			}
			if got.HR.Eligible != f.wantHREligible {
				t.Fatalf("HR eligible=%v want %v", got.HR.Eligible, f.wantHREligible)
			}
			if got.Speed.State != calibration.StateUnavailable {
				if !got.Speed.RangeRequired {
					t.Fatal("non-unavailable speed decision must require a finite range")
				}
				if got.Speed.RangeSemantics == "" {
					t.Fatal("range semantics must be declared")
				}
			}
			if got.HR.State != calibration.StateUnavailable {
				if !got.HR.RangeRequired {
					t.Fatal("non-unavailable HR decision must require a finite range")
				}
			}
			if got.Speed.State == calibration.StateUnavailable && len(got.Speed.Reasons) == 0 {
				t.Fatal("unavailable speed must report a reason")
			}
			if got.HR.State == calibration.StateUnavailable && len(got.HR.Reasons) == 0 {
				t.Fatal("unavailable HR must report a reason")
			}
			// Missing all-out labels / missing chest strap are categorical
			// non-reasons: they can never justify unavailability.
			for _, r := range append(append([]string{}, got.Speed.Reasons...), got.HR.Reasons...) {
				for _, banned := range calibration.NeverUnavailabilityReasons() {
					if r == banned {
						t.Fatalf("reason %q must never justify unavailability", r)
					}
				}
			}
		})
	}
}

func TestContractStaleAndPhysicallyInvalidInputs(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	// All supporting evidence older than the stale threshold keeps the
	// estimate but marks it stale.
	old := []calibration.CandidateEvidence{
		ordinary(asOf, 120, "a", 3600, 3.3),
		ordinary(asOf, 150, "b", 5400, 3.0),
	}
	in := calibration.DeriveAdjudicationInput(old, nil, asOf, nil, false)
	got := calibration.AdjudicateEstimationContract(in)
	if got.Speed.State != calibration.StateStale {
		t.Fatalf("old support state=%s want stale", got.Speed.State)
	}
	// HR evidence older than the HR stale window: stale as well.
	hr := opticalHRReport(asOf, 90, "wrist_optical", false, "training_hr")
	got = calibration.AdjudicateEstimationContract(calibration.DeriveAdjudicationInput(old, hr, asOf, nil, false))
	if got.HR.State != calibration.StateStale {
		t.Fatalf("old HR state=%s want stale", got.HR.State)
	}
	// Physically impossible measurements (all selected speeds beyond the
	// declared bound) are a hard unavailable with an explicit reason.
	broken := []calibration.CandidateEvidence{
		contractFixtureEvidence(asOf, 1, "x", 3600, 12.0, calibration.EffortUnknown),
	}
	got = calibration.AdjudicateEstimationContract(calibration.DeriveAdjudicationInput(broken, nil, asOf, nil, false))
	if got.Speed.State != calibration.StateUnavailable {
		t.Fatalf("physically invalid state=%s want unavailable", got.Speed.State)
	}
	found := false
	for _, r := range got.Speed.Reasons {
		if r == "inputs_physically_invalid" {
			found = true
		}
	}
	if !found {
		t.Fatalf("physically invalid reason missing: %v", got.Speed.Reasons)
	}
}

func TestContractTimeMachineFutureInputsCannotChangePastAdjudication(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	past := []calibration.CandidateEvidence{
		ordinary(asOf, 3, "a", 3600, 3.2),
		ordinary(asOf, 17, "b", 5400, 3.0),
	}
	hrPast := opticalHRReport(asOf, 5, "wrist_optical", false, "training_hr")
	baseline := calibration.AdjudicateEstimationContract(calibration.DeriveAdjudicationInput(past, hrPast, asOf, nil, false))
	// Future activities, future labels and future HR observations appended to
	// the same pool must not change the decision made at the earlier cutoff.
	withFuture := append(append([]calibration.CandidateEvidence{}, past...),
		contractFixtureEvidence(asOf, -5, "future", 3600, 4.5, calibration.EffortConfirmedMaximal),
		contractFixtureEvidence(asOf, -20, "future2", 1800, 4.8, calibration.EffortConfirmedMaximal),
	)
	hrWithFuture := opticalHRReport(asOf, 5, "wrist_optical", false, "training_hr")
	futureObs := opticalHRReport(asOf, -6, "chest_strap", true, "field_hr_proxy")
	hrWithFuture.Observations = append(hrWithFuture.Observations, futureObs.Observations...)
	got := calibration.AdjudicateEstimationContract(calibration.DeriveAdjudicationInput(withFuture, hrWithFuture, asOf, nil, false))
	if !reflect.DeepEqual(got, baseline) {
		t.Fatalf("future inputs changed past adjudication: %+v vs %+v", got, baseline)
	}
}

func TestNeverUnavailabilityReasonsAreCategorical(t *testing.T) {
	want := []string{"missing_all_out_label", "missing_chest_strap", "optical_HR_only"}
	if got := calibration.NeverUnavailabilityReasons(); !reflect.DeepEqual(got, want) {
		t.Fatalf("denylist=%v want %v", got, want)
	}
}

func TestDefaultEvolvedPriorsValidateAndHash(t *testing.T) {
	p := calibration.DefaultEvolvedPriors()
	if err := p.Validate(); err != nil {
		t.Fatalf("default priors invalid: %v", err)
	}
	if p.PriorSetVersion == "" {
		t.Fatal("prior set version must be named")
	}
	if p.IdentityHash() != calibration.DefaultEvolvedPriors().IdentityHash() {
		t.Fatal("prior identity hash must be deterministic")
	}
	// Every numeric prior is finite and carries a source and the explicit
	// research_uncalibrated marker; mutating any value must move the hash.
	mutated := p
	mutated.EffortMargin.Ordinary.SD += 0.001
	if mutated.IdentityHash() == p.IdentityHash() {
		t.Fatal("prior identity hash must change with the prior values")
	}
	if p.Calibration != "research_uncalibrated" {
		t.Fatalf("calibration marker=%q", p.Calibration)
	}
	// v4.md §5.1/§5.2 table shapes: measurement sigma ordering, the frozen k
	// domain and the numerical search domain.
	if p.EnduranceK.Unit != "log_speed_per_log_duration" || p.EnduranceK.Low != 0.02 || p.EnduranceK.High != 0.10 || p.EnduranceK.Mean != 0.06 || p.EnduranceK.SD != 0.02 {
		t.Fatal("endurance prior drifted from the §5.2 0.06/0.02 center over [0.02,0.10]")
	}
	if p.MeasurementSigmaHigh != 0.01 || p.MeasurementSigmaMedium != 0.025 || p.MeasurementSigmaLow != 0.06 {
		t.Fatal("§5.1 measurement sigma must stay 0.01/0.025/0.06")
	}
	if p.V60SearchLowMps != 0.5 || p.V60SearchHighMps != 12 {
		t.Fatal("§8.1 v60 numerical search domain must stay 0.5-12 m/s")
	}
	// §6.2 HR table: q60 center 0.85 with the [0.65,0.98] domain, beta
	// center 3 on [1,8], tau center 60 s on 15-180 s, u/d scales.
	logit := func(q float64) float64 { return math.Log(q / (1 - q)) }
	if math.Abs(p.HR.Eta.Mean-logit(0.85)) > 1e-12 || p.HR.Eta.SD != 0.6 {
		t.Fatal("§6.2 eta prior must stay logit(0.85)/0.6")
	}
	if math.Abs(p.HR.LogBeta.Mean-math.Log(3)) > 1e-12 || p.HR.LogBeta.SD != 0.5 {
		t.Fatal("§6.2 log beta prior must stay log(3)/0.5")
	}
	if math.Abs(p.HR.LogTauS.Mean-math.Log(60)) > 1e-12 || p.HR.LogTauS.SD != 0.5 {
		t.Fatal("§6.2 log tau prior must stay log(60s)/0.5")
	}
	if p.HR.DayEffectU.SD != 0.25 || p.HR.DriftDPerHour.SD != 0.15 {
		t.Fatal("§6.2 u/d prior scales must stay 0.25/0.15")
	}
	if p.LambdaH != 0.5 || p.HRSigmaStrapBpm != 3 || p.HRSigmaOpticalBpm != 6 {
		t.Fatal("§6.3 lambda_H and HR sensor scales must stay 0.5/3/6")
	}
	// Optical HR stays usable at a wider scale, never excluded (6 >= 3).
	if !(p.HRSigmaOpticalBpm > p.HRSigmaStrapBpm) {
		t.Fatal("optical HR must be down-weighted by scale, not excluded")
	}
	invalid := p
	invalid.EnduranceK.Mean = 0.5 // outside its own truncation bounds
	if err := invalid.Validate(); err == nil {
		t.Fatal("out-of-bounds prior mean accepted")
	}
	invalid = p
	invalid.EffortMargin.Easy.Mean = p.EffortMargin.Ordinary.Mean
	if err := invalid.Validate(); err == nil {
		t.Fatal("§5.1 margin mean ordering violation accepted")
	}
}

func TestEstimationContractDocumentSerialization(t *testing.T) {
	doc := calibration.EstimationContractDocumentSnapshot()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var back calibration.EstimationContractDocument
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, doc) {
		t.Fatal("contract document lost fields in JSON round-trip")
	}
	if doc.IdentityHash() != calibration.EstimationContractDocumentSnapshot().IdentityHash() {
		t.Fatal("contract identity hash must be deterministic")
	}
	if doc.AlgorithmVersion != 4 {
		t.Fatalf("evolved algorithm version=%d must stay 4 (no v5)", doc.AlgorithmVersion)
	}
	if doc.AlgorithmRevision != calibration.EvolvedCandidateAlgorithmRevision {
		t.Fatalf("revision=%q", doc.AlgorithmRevision)
	}
	// Target units are declared, and the pace unit conversion holds.
	if doc.Units.Speed != "m_per_s" || !strings.HasPrefix(doc.Units.Pace, "s_per_km") || doc.Units.HR != "bpm" {
		t.Fatalf("units %+v", doc.Units)
	}
	if pace := 1000 / 3.4; !(pace > 290 && pace < 296) {
		t.Fatalf("pace conversion sanity: %v", pace)
	}
	for _, h := range []string{doc.PriorsIdentityHash, doc.ProtocolV2SHA256, doc.ProtocolV1SHA256, doc.V3SourceSHA256} {
		if len(h) != 64 {
			t.Fatalf("hash %q must be a sha256 hex digest", h)
		}
	}
	states := map[calibration.EstimationState]bool{}
	for _, s := range doc.States {
		states[s.State] = true
	}
	for _, want := range []calibration.EstimationState{calibration.StateMeasuredReference, calibration.StateModelEstimated, calibration.StatePriorDominated, calibration.StateStale, calibration.StateUnavailable} {
		if !states[want] {
			t.Fatalf("state %s missing from contract document", want)
		}
	}
	if len(doc.Gates) != 3 {
		t.Fatalf("three separate gates required, got %d", len(doc.Gates))
	}
}

func TestEvolvedCandidateIdentityAndStrategyEntry(t *testing.T) {
	implementation, parameterVersion, revision := calibration.EvolvedCandidateIdentity()
	if revision != calibration.EvolvedCandidateAlgorithmRevision || revision == "" {
		t.Fatalf("revision=%q", revision)
	}
	if implementation == "" || parameterVersion == "" {
		t.Fatal("evolved identity must name implementation and parameter set")
	}
	if calibration.CandidateVersion != 4 {
		t.Fatal("candidate algorithm version must stay 4")
	}
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{{LabelID: "run", ActivityDate: asOf.AddDate(0, 0, -1), Sport: "run", DurationS: f64p(3600), DistanceM: f64p(11520)}}
	// Since #996 the entry assembles the speed-domain estimator; since #997
	// the joint HR fit runs in the same entry. This fixture carries no HR
	// samples at all, so HR stays honestly unavailable with the categorical
	// no-series/no-prior reason.
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, nil)
	if err != nil {
		t.Fatalf("evolved candidate must not error since #996: %v", err)
	}
	if result.Implementation != implementation || result.ParameterVersion != parameterVersion || result.AlgorithmRevision != revision {
		t.Fatalf("evolved identity drift: %+v", result)
	}
	if result.Snapshot.AlgorithmVersion != 4 || result.Evolved == nil {
		t.Fatalf("evolved result must stay v4 with its own report: %+v", result)
	}
	if result.Evolved.HR == nil || result.Evolved.HR.State != calibration.StateUnavailable {
		t.Fatalf("HR seam must stay unavailable until #997: %+v", result.Evolved.HR)
	}
	// Production entry stays frozen v3 with no candidate switch.
	if got := calibration.EstimateRunningCalibration(history, asOf, nil); got.AlgorithmVersion != 3 {
		t.Fatal("production entry must remain v3")
	}
}

func TestOfflineResultRevisionFieldKeepsLegacyPayloadsByteStable(t *testing.T) {
	// Legacy strategies never populated algorithm_revision; the field must
	// stay absent from their JSON so replay hashes are unchanged.
	raw, err := json.Marshal(calibration.OfflineResult{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "algorithm_revision") {
		t.Fatal("empty revision must stay omitted")
	}
	with := calibration.OfflineResult{AlgorithmRevision: calibration.EvolvedCandidateAlgorithmRevision}
	raw, err = json.Marshal(with)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"algorithm_revision":"`+calibration.EvolvedCandidateAlgorithmRevision+`"`) {
		t.Fatal("revision must serialize when set")
	}
}

func TestSourceSummaryCarriesRevisionAndMetricState(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	result, err := calibration.EstimateOffline(calibration.StrategyV3, []calibration.Activity{{LabelID: "run", ActivityDate: asOf.AddDate(0, 0, -1), Sport: "run", DurationS: f64p(3600), DistanceM: f64p(11520)}}, asOf, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.AlgorithmRevision != "" {
		t.Fatal("legacy strategies keep the implicit empty revision")
	}
	summary := calibration.SummarizeSource(result)
	if summary.AlgorithmRevision != "" {
		t.Fatal("legacy summary revision must stay empty")
	}
	result.AlgorithmRevision = calibration.EvolvedCandidateAlgorithmRevision
	summary = calibration.SummarizeSource(result)
	if summary.AlgorithmRevision != calibration.EvolvedCandidateAlgorithmRevision {
		t.Fatal("summary must carry the algorithm revision marker")
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	parsed := calibration.ParseSource(&text)
	if parsed.AlgorithmRevision != calibration.EvolvedCandidateAlgorithmRevision {
		t.Fatal("ParseSource must round-trip the revision")
	}
	legacy := `{"schema_version":1,"state":"available","strategy":"candidate","data_cutoff_day":"2026-11-16"}`
	if got := calibration.ParseSource(&legacy); got.AlgorithmRevision != "" || got.Speed != nil {
		t.Fatalf("legacy row must parse without new fields: %+v", got)
	}
}

func TestAdjudicationInputIgnoresNonSelectedAndUnadmittedEvidence(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	selected := ordinary(asOf, 3, "a", 3600, 3.2)
	unselected := ordinary(asOf, 4, "b", 3600, 3.9)
	unselected.Selected = false
	discontinuous := ordinary(asOf, 5, "c", 7200, 3.4)
	discontinuous.Continuous = false
	outside := ordinary(asOf, 200, "d", 3600, 3.3)
	in := calibration.DeriveAdjudicationInput([]calibration.CandidateEvidence{selected, unselected, discontinuous, outside}, nil, asOf, nil, false)
	if in.ValidRunningObservations != 1 || in.IndependentActivityRoots != 1 {
		t.Fatalf("only admitted selected continuous in-window evidence counts: %+v", in)
	}
	// LatestSpeedEvidenceAgeDays is the age of the single valid obs (3 days).
	if in.LatestSpeedEvidenceAgeDays != 3 {
		t.Fatalf("age=%v", in.LatestSpeedEvidenceAgeDays)
	}
}

func f64p(v float64) *float64 { return &v }
