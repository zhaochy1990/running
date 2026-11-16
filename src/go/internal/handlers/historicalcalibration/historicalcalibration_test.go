// historicalcalibration_test.go covers the executor's pure logic without a
// database: window derivation, chunk keys, fingerprint sensitivity, and the
// default-off gate.
package historicalcalibration

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

func TestPendingDaysWindow(t *testing.T) {
	run := &storage.HistoricalRecomputeRun{TargetFromDay: "2026-06-28", TargetToDay: "2026-06-30"}
	days, err := pendingDays(run)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"2026-06-28", "2026-06-29", "2026-06-30"}
	if len(days) != 3 || days[0] != want[0] || days[2] != want[2] {
		t.Fatalf("days = %v, want %v", days, want)
	}
	if _, err := pendingDays(&storage.HistoricalRecomputeRun{TargetFromDay: "2026-06-30", TargetToDay: "2026-06-28"}); err == nil {
		t.Fatal("inverted window must be an error")
	}
	if _, err := pendingDays(&storage.HistoricalRecomputeRun{TargetFromDay: "junk", TargetToDay: "2026-06-28"}); err == nil {
		t.Fatal("invalid day must be an error")
	}
}

func TestContinuationKeyStable(t *testing.T) {
	a, b := continuationKey("r1", 3), continuationKey("r1", 3)
	if a != b || a != "histcal:r1:c3" {
		t.Fatalf("key not stable: %q vs %q", a, b)
	}
	if continuationKey("r1", 4) == a {
		t.Fatal("distinct chunk must have a distinct key")
	}
}

func TestHistoricalRecomputeFingerprintSensitivity(t *testing.T) {
	base := storage.HistoricalRecomputeFingerprint("2026-06-30", "2025-07-02", "2026-06-30",
		7, storage.RunningCalibrationPolicy{ActiveVersion: 3, Revision: 2, FallbackVersion: 3},
		storage.OnboardingAnalysisDigest{ActivityCount: 4, HealthDayCount: 9})
	same := storage.HistoricalRecomputeFingerprint("2026-06-30", "2025-07-02", "2026-06-30",
		7, storage.RunningCalibrationPolicy{ActiveVersion: 3, Revision: 2, FallbackVersion: 3},
		storage.OnboardingAnalysisDigest{ActivityCount: 4, HealthDayCount: 9})
	if base != same {
		t.Fatal("identical inputs must fingerprint identically")
	}
	variants := []struct {
		name string
		fp   string
	}{
		{"as_of", storage.HistoricalRecomputeFingerprint("2026-07-01", "2025-07-02", "2026-06-30", 7,
			storage.RunningCalibrationPolicy{ActiveVersion: 3, Revision: 2}, storage.OnboardingAnalysisDigest{ActivityCount: 4})},
		{"binding", storage.HistoricalRecomputeFingerprint("2026-06-30", "2025-07-02", "2026-06-30", 8,
			storage.RunningCalibrationPolicy{ActiveVersion: 3, Revision: 2}, storage.OnboardingAnalysisDigest{ActivityCount: 4})},
		{"policy", storage.HistoricalRecomputeFingerprint("2026-06-30", "2025-07-02", "2026-06-30", 7,
			storage.RunningCalibrationPolicy{ActiveVersion: 3, Revision: 3}, storage.OnboardingAnalysisDigest{ActivityCount: 4})},
		{"data", storage.HistoricalRecomputeFingerprint("2026-06-30", "2025-07-02", "2026-06-30", 7,
			storage.RunningCalibrationPolicy{ActiveVersion: 3, Revision: 2}, storage.OnboardingAnalysisDigest{ActivityCount: 5})},
	}
	for _, v := range variants {
		if v.fp == base {
			t.Fatalf("fingerprint insensitive to %s change", v.name)
		}
	}
}

func TestBundleFingerprintFreezesLedger(t *testing.T) {
	days := []storage.HistoricalRecomputeDay{
		{Day: "2026-06-30", Status: storage.HistoricalRecomputeDayReady, Fingerprint: "aa"},
		{Day: "2026-06-29", Status: storage.HistoricalRecomputeDayUnavailable},
	}
	a := storage.HistoricalRecomputeBundleFingerprint(days)
	// Order-insensitive…
	shuffled := []storage.HistoricalRecomputeDay{days[1], days[0]}
	if storage.HistoricalRecomputeBundleFingerprint(shuffled) != a {
		t.Fatal("bundle fingerprint must not depend on row order")
	}
	// …but outcome-sensitive.
	days[0].Status = storage.HistoricalRecomputeDayPartial
	if storage.HistoricalRecomputeBundleFingerprint(days) == a {
		t.Fatal("bundle fingerprint must change when a day outcome changes")
	}
}

// The default-off gate: a stray job on a disabled worker fails PERMANENTLY —
// the capability must not silently execute (AC1/rollout).
func TestDisabledWorkerRefusesJob(t *testing.T) {
	h := New(Config{Enabled: false})
	_, err := h(context.Background(), &job.Job{UserID: uuid.NewString(), InputJSON: `{}`}, nil)
	perm, ok := job.AsPermanent(err)
	if !ok || perm.Code != "historical_recompute_disabled" {
		t.Fatalf("err = %v, want permanent historical_recompute_disabled", err)
	}
}

func TestResultJSONCarriesAuditFields(t *testing.T) {
	e := &executor{}
	run := &storage.HistoricalRecomputeRun{
		RunID: "r", UserID: "u", AnalysisAsOfDay: "2026-06-30",
		TargetFromDay: "2025-07-02", TargetToDay: "2026-06-30",
		BindingRevision: 3, PolicyVersion: 3, PolicyRevision: 5,
		InputFingerprint: "fp", State: storage.HistoricalRecomputeStateCompletedWithGaps,
		ChunkSeq: 7, DaysTotal: 365, DaysReady: 300, DaysUnavailable: 65,
	}
	cp, fp, reason := "2026-06-30", "bundle", "input_revision_changed"
	run.CheckpointDay, run.BundleFingerprint, run.SupersedeReason = &cp, &fp, &reason
	raw := e.resultJSON(run, run.State)
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"run_id", "as_of_day", "target_from", "target_to",
		"binding_revision", "policy_version", "policy_revision", "input_fingerprint",
		"bundle_fingerprint", "checkpoint_day", "counts"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("result JSON missing %s: %s", k, raw)
		}
	}
}

func TestProgressBounded(t *testing.T) {
	if progress(0, 365) != 0 || progress(365, 365) != 100 || progress(400, 365) != 100 || progress(1, 0) != 100 {
		t.Fatal("progress bounds broken")
	}
}

func TestParseHealthDayFormats(t *testing.T) {
	for _, c := range []struct {
		in   string
		want bool
	}{
		{"20260630", true}, {"2026-06-30", true}, {"2026-06-30T00:00:00Z", true}, {"junk", false},
	} {
		if _, ok := parseHealthDay(c.in); ok != c.want {
			t.Fatalf("parseHealthDay(%q) ok = %v, want %v", c.in, ok, c.want)
		}
	}
	if d, ok := parseHealthDay("2026-06-30"); !ok || d.Format("2006-01-02") != "2026-06-30" {
		t.Fatal("parsed day value wrong")
	}
}
