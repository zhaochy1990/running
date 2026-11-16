package api

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/storage"
)

// Evolved-v4 (#993/#996/#997) client display vectors: synthetic inputs run
// through the real evolved estimator and SummarizeSource, then compared
// deep-equal against the shared cross-platform fixture. These are engineering
// display vectors only: no accuracy label, no production read.
func evolvedClientScenario(t *testing.T, name string) calibration.OfflineResult {
	t.Helper()
	cutoff := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	run := func(id string, day time.Time, seconds int, speedMps float64, withHR bool) calibration.Activity {
		duration, distance := float64(seconds), float64(seconds)*speedMps
		a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run", DurationS: &duration, DistanceM: &distance}
		for second := 0; second <= seconds; second += 5 {
			elapsed, d := float64(second), float64(second)*speedMps
			s := calibration.Sample{ElapsedS: fptr(elapsed), DistanceM: fptr(d), SpeedMps: fptr(speedMps)}
			if withHR {
				hr := 150.0
				if second >= 600 {
					hr = 162.0
				}
				s.HeartRateBpm = fptr(hr)
			}
			a.Samples = append(a.Samples, s)
		}
		return a
	}
	switch name {
	case "evolved-low-evidence":
		// Two ordinary training runs on two days, duration ratio 2x, wrist
		// HR only: speed+HR both model_estimated, optical down-weighted.
		short := run("synthetic-evolved-ordinary-short", cutoff.AddDate(0, 0, -20), 1800, 3.6, true)
		long := run("synthetic-evolved-ordinary-long", cutoff.AddDate(0, 0, -10), 3600, 3.3, true)
		r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, []calibration.Activity{short, long}, cutoff, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return r
	case "evolved-prior-only":
		// One easy run without HR samples plus a real resting-HR row: speed
		// prior_dominated (single root, no duration diversity), HR
		// prior_dominated from the physiological prior only.
		easy := run("synthetic-evolved-easy-solo", cutoff.AddDate(0, 0, -15), 2400, 3.0, false)
		rhr := 55.0
		health := []calibration.HealthRow{{Date: cutoff.AddDate(0, 0, -14), RHR: &rhr}}
		r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, []calibration.Activity{easy}, cutoff, health, nil)
		if err != nil {
			t.Fatal(err)
		}
		return r
	case "evolved-measured-reference":
		// Probable-maximal hour anchor plus a verified fresh field protocol:
		// speed measured_reference, HR measured-reference median.
		hour := run("synthetic-evolved-probable-hour", cutoff.AddDate(0, 0, -1), 3600, 4.5, true)
		field := run("synthetic-evolved-field-protocol", cutoff.AddDate(0, 0, -1), 1800, 4.0, true)
		metadata := []calibration.CandidateMetadata{
			{ActivityID: hour.LabelID, SourceVersion: "synthetic-engineering-v3", EvidenceRef: "synthetic-race-evidence", RaceIdentity: true, AthleteReportedMaximal: true, SustainedEffortCorroborated: true},
			{ActivityID: field.LabelID, SourceVersion: "synthetic-engineering-v3", EvidenceRef: "synthetic-hr-evidence", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 1800, StartS: fptr(0), EndS: fptr(1800), HR: &calibration.CandidateHRMetadata{Protocol: "field_30min_last20_v1", Verified: true, Sensor: "chest_strap"}},
		}
		r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, []calibration.Activity{hour, field}, cutoff, nil, metadata)
		if err != nil {
			t.Fatal(err)
		}
		return r
	case "evolved-unavailable":
		// No running input and no qualified physiological prior: both
		// channels unavailable with categorical reasons.
		r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, nil, cutoff, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	t.Fatalf("unknown evolved scenario %q", name)
	return calibration.OfflineResult{}
}

func evolvedClientVector(t *testing.T, name string) (calibration.Snapshot, calibration.SourceSummary) {
	t.Helper()
	result := evolvedClientScenario(t, name)
	source := calibration.SummarizeSource(result)
	return result.Snapshot, source
}

// TestCalibrationEvolvedClientVectors pins the scenario states first (the
// display contract depends on them) and then locks the shared fixture to the
// real producer output.
func TestCalibrationEvolvedClientVectors(t *testing.T) {
	expectations := map[string]struct {
		speedState, hrState string
		speedMethod, hrReas string
	}{
		"evolved-low-evidence":       {speedState: "model_estimated", hrState: "model_estimated"},
		"evolved-prior-only":         {speedState: "prior_dominated", hrState: "prior_dominated", hrReas: "prior_only_HR_estimate"},
		"evolved-measured-reference": {speedState: "measured_reference", hrState: "measured_reference"},
		"evolved-unavailable":        {speedState: "unavailable", hrState: "unavailable", hrReas: "no_HR_series_or_qualified_physiological_prior"},
	}
	var exports []map[string]any
	for _, name := range []string{"evolved-low-evidence", "evolved-prior-only", "evolved-measured-reference", "evolved-unavailable"} {
		snapshot, source := evolvedClientVector(t, name)
		exp := expectations[name]
		if source.Speed == nil || source.Speed.State != exp.speedState {
			t.Fatalf("%s speed state = %+v, want %s", name, source.Speed, exp.speedState)
		}
		if source.HR == nil || source.HR.State != exp.hrState {
			t.Fatalf("%s HR state = %+v, want %s", name, source.HR, exp.hrState)
		}
		if exp.hrReas != "" {
			found := false
			for _, r := range source.HR.Reasons {
				if r == exp.hrReas {
					found = true
				}
			}
			if !found {
				t.Fatalf("%s missing HR reason %s: %+v", name, exp.hrReas, source.HR.Reasons)
			}
		}
		if source.AlgorithmRevision != calibration.EvolvedCandidateAlgorithmRevision {
			t.Fatalf("%s revision = %q", name, source.AlgorithmRevision)
		}
		var pace, hr any
		if snapshot.ThresholdSpeedMps != nil {
			sec := apifmt.PacePerKmSec(snapshot.ThresholdSpeedMps)
			pace = *sec
		}
		if snapshot.ThresholdHR != nil {
			hr = *snapshot.ThresholdHR
		}
		var speedRange map[string]any
		if s := source.Speed; s != nil {
			fast, slow := finitePace(s.RangeHigh), finitePace(s.RangeLow)
			kind := "unavailable"
			switch {
			case fast != nil && slow != nil:
				kind = "two_sided"
			case slow != nil:
				kind = "speed_lower_bound"
			case fast != nil:
				kind = "speed_upper_bound"
			}
			speedRange = map[string]any{"fast": anyOrNil(fast), "slow": anyOrNil(slow), "bound_kind": kind, "meaning": s.RangeMeaning}
		}
		exports = append(exports, map[string]any{"name": name, "source": source, "hr_bpm": hr, "pace_per_km_sec": pace, "speed_range": speedRange, "speed_mps": snapshot.ThresholdSpeedMps, "speed_confidence": snapshot.ThresholdSpeedConfidence, "hr_confidence": snapshot.ThresholdHRConfidence, "as_of_date": snapshot.AsOfDate.Format("2006-01-02")})
	}
	if output := os.Getenv("STRIDE_993_EVOLVED_OUTPUT"); output != "" {
		raw, err := json.MarshalIndent(exports, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(output, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile("../../../../docs/calibration/fixtures/client-display-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name     string              `json:"name"`
			Response strideZonesResponse `json:"response"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	byName := map[string]int{}
	for i, c := range fixture.Cases {
		byName[c.Name] = i
	}
	for _, name := range []string{"evolved-low-evidence", "evolved-prior-only", "evolved-measured-reference", "evolved-unavailable", "historical-v4", "override-selected", "override-fallback"} {
		idx, ok := byName[name]
		if !ok {
			t.Fatalf("missing shared evolved fixture case: %s", name)
		}
		if fixture.Cases[idx].Response.Threshold == nil {
			t.Fatalf("%s has no threshold", name)
		}
	}
	for _, name := range []string{"evolved-low-evidence", "evolved-prior-only", "evolved-measured-reference", "evolved-unavailable"} {
		snapshot, source := evolvedClientVector(t, name)
		idx := byName[name]
		th := fixture.Cases[idx].Response.Threshold
		if !reflect.DeepEqual(th.Source, &source) {
			t.Fatalf("%s shared vector differs from real producer:\nfixture=%+v\nproducer=%+v", name, th.Source, source)
		}
		wantPace, wantHR := 0, 0.0
		if snapshot.ThresholdSpeedMps != nil {
			wantPace = *apifmt.PacePerKmSec(snapshot.ThresholdSpeedMps)
		}
		if snapshot.ThresholdHR != nil {
			wantHR = *snapshot.ThresholdHR
		}
		if (th.PacePerKmSec == nil) != (snapshot.ThresholdSpeedMps == nil) || (th.PacePerKmSec != nil && *th.PacePerKmSec != wantPace) {
			t.Fatalf("%s pace mismatch: fixture=%v producer=%d", name, th.PacePerKmSec, wantPace)
		}
		if (th.HRBpm == nil) != (snapshot.ThresholdHR == nil) || (th.HRBpm != nil && *th.HRBpm != wantHR) {
			t.Fatalf("%s HR mismatch: fixture=%v producer=%v", name, th.HRBpm, wantHR)
		}
	}
}

// TestCalibrationOverrideSelectionWireShape guards the two constructed
// selection disclosures (override pin and override_snapshot_missing fallback)
// against the storage serializer so the shared fixture never drifts from the
// real resolver output shape.
func TestCalibrationOverrideSelectionWireShape(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/calibration/fixtures/client-display-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name     string         `json:"name"`
			Response map[string]any `json:"response"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	find := func(name string) map[string]any {
		for _, c := range fixture.Cases {
			if c.Name == name {
				th, _ := c.Response["threshold"].(map[string]any)
				return th
			}
		}
		return nil
	}
	pinned := storage.CalibrationSelection{Mode: "active", PolicyRevision: 3, RequestedVersion: vptr(4), EffectiveVersion: vptr(4), State: "selected", Override: &storage.CalibrationOverrideSelection{Revision: 2, AlgorithmVersion: 4, AlgorithmRevision: calibration.EvolvedCandidateAlgorithmRevision}}
	fallback := storage.CalibrationSelection{Mode: "active", PolicyRevision: 3, RequestedVersion: vptr(4), EffectiveVersion: vptr(3), State: "fallback", Reason: "override_snapshot_missing", Override: &storage.CalibrationOverrideSelection{Revision: 2, AlgorithmVersion: 4, AlgorithmRevision: calibration.EvolvedCandidateAlgorithmRevision}}
	for name, want := range map[string]storage.CalibrationSelection{"override-selected": pinned, "override-fallback": fallback} {
		th := find(name)
		if th == nil {
			t.Fatalf("missing %s fixture case", name)
		}
		encoded, err := json.Marshal(want)
		if err != nil {
			t.Fatal(err)
		}
		var asMap map[string]any
		if err = json.Unmarshal(encoded, &asMap); err != nil {
			t.Fatal(err)
		}
		got, _ := th["selection"].(map[string]any)
		if !reflect.DeepEqual(got, asMap) {
			t.Fatalf("%s selection differs from storage serializer:\nfixture=%v\nstorage=%v", name, got, asMap)
		}
		// The DTO must round-trip the disclosure without losing fields.
		decoded, err := json.Marshal(th)
		if err != nil {
			t.Fatal(err)
		}
		var dto struct {
			Selection *storage.CalibrationSelection `json:"selection"`
		}
		if err = json.Unmarshal(decoded, &dto); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(*dto.Selection, want) {
			t.Fatalf("%s DTO round-trip lost the override disclosure: %+v", name, dto.Selection)
		}
	}
}

// TestCalibrationHistoricalV4CaseStaysReadable guards the historical v4 row
// shape (no algorithm_revision, no per-metric state) against regression in the
// shared fixture: an old row must keep decoding with empty optional fields.
func TestCalibrationHistoricalV4CaseStaysReadable(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/calibration/fixtures/client-display-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name         string              `json:"name"`
			Response     strideZonesResponse `json:"response"`
			ServerExpect json.RawMessage     `json:"server_expected"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		if c.Name != "historical-v4" {
			continue
		}
		th := c.Response.Threshold
		if th == nil || th.Source == nil || th.Source.Speed == nil || th.Source.AlgorithmRevision != "" || th.Source.Speed.State != "" {
			t.Fatalf("historical-v4 case lost its empty-optional shape: %+v", th)
		}
		return
	}
	t.Fatal("missing historical-v4 fixture case")
}

func vptr(v int) *int { return &v }

func anyOrNil(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}
