package calibration_test

import (
	"encoding/json"
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
	// research_uncalibrated marker.
	mutated := p
	mutated.LogV60.Mean += 0.01
	if mutated.IdentityHash() == p.IdentityHash() {
		t.Fatal("prior identity hash must change with the prior values")
	}
	if p.Calibration != "research_uncalibrated" {
		t.Fatalf("calibration marker=%q", p.Calibration)
	}
	if p.LogV60.Unit != "log_mps" || p.EnduranceK.Low != 0.02 || p.EnduranceK.High != 0.10 {
		t.Fatal("speed-domain prior units/bounds drifted from the frozen v3 k domain")
	}
	// The HR bridge pin at v60 must exist, be finite and inside (0,1).
	bridge := p.HRBridgeAtV60()
	if bridge == nil || bridge.HRFractionMean <= 0 || bridge.HRFractionMean >= 1 || bridge.HRFractionSD <= 0 {
		t.Fatalf("bridge knot %+v", bridge)
	}
	// Optical HR is down-weighted, never excluded.
	if p.OpticalHRWeight <= 0 || p.OpticalHRWeight >= 1 {
		t.Fatalf("optical weight=%v", p.OpticalHRWeight)
	}
	invalid := p
	invalid.EnduranceK.Mean = 0.5 // outside its own truncation bounds
	if err := invalid.Validate(); err == nil {
		t.Fatal("out-of-bounds prior mean accepted")
	}
	invalid = p
	invalid.HRShape[2].HRFractionMean = invalid.HRShape[0].HRFractionMean
	if err := invalid.Validate(); err == nil {
		t.Fatal("non-monotone HR shape accepted")
	}
}

func TestHistoricalCapabilityPriorSpread(t *testing.T) {
	p := calibration.DefaultEvolvedPriors()
	sd0 := p.HistoricalCapabilitySD(0)
	sd100 := p.HistoricalCapabilitySD(100)
	if !(sd0 >= 0.15-1e-12) {
		t.Fatalf("sd floor missing: %v", sd0)
	}
	if !(sd100 > sd0) {
		t.Fatalf("prior sd must widen with age: %v vs %v", sd100, sd0)
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
	// The T1 entry point exists, is explicit and honest: the estimator lands
	// in #996-#998, so today it must refuse rather than fabricate numbers.
	if _, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, nil); err == nil {
		t.Fatal("evolved candidate estimator must be explicit about pending T2-T4 implementation")
	} else if !strings.Contains(err.Error(), "996") {
		t.Fatalf("error must point at the implementing ticket: %v", err)
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
