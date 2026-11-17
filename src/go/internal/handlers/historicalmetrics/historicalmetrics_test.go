// historicalmetrics_test.go holds the no-database unit tests: the default-off
// gate and the fingerprint/output-fingerprint stability. The behavioral suite
// (AC6) lives in historicalmetrics_mysql_test.go.
package historicalmetrics

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

func TestFlagOffFailsPermanently(t *testing.T) {
	h := New(Config{Enabled: false})
	j := &job.Job{ID: uuid.NewString(), UserID: uuid.NewString(), Type: JobType}
	_, err := h(context.Background(), j, nil)
	if err == nil {
		t.Fatal("flag-off handler must fail")
	}
	var perm *job.PermanentError
	if !errors.As(err, &perm) {
		t.Fatalf("error must be permanent, got %v", err)
	}
	if perm.Code != "historical_metrics_disabled" {
		t.Fatalf("code = %q, want historical_metrics_disabled", perm.Code)
	}
}

func TestBadWiringFailsPermanently(t *testing.T) {
	// Order mirrors T07: flag → wiring → partition, so a bad partition only
	// surfaces with live wiring (exercised by the MySQL suite's harness).
	h := New(Config{Enabled: true})
	j := &job.Job{ID: uuid.NewString(), UserID: uuid.NewString(), Type: JobType}
	_, err := h(context.Background(), j, nil)
	var perm *job.PermanentError
	if !errors.As(err, &perm) || perm.Code != "bad_wiring" {
		t.Fatalf("want bad_wiring permanent error, got %v", err)
	}
}

// The output fingerprint must be order-insensitive over the staged ledger and
// content-sensitive: reordering rows keeps it, changing one payload moves it.
func TestOutputFingerprintStability(t *testing.T) {
	rows := []*storage.HistoricalMetricsStaged{
		{RunID: "r", Kind: storage.HistoricalMetricsKindActivityLoad, ItemKey: "b", Payload: `{"x":1}`},
		{RunID: "r", Kind: storage.HistoricalMetricsKindActivityLoad, ItemKey: "a", Payload: `{"x":2}`},
		{RunID: "r", Kind: storage.HistoricalMetricsKindDailyLoad, ItemKey: "2026-01-01", Payload: `{"d":1}`},
	}
	shuffled := []*storage.HistoricalMetricsStaged{rows[2], rows[1], rows[0]}
	if storage.HistoricalMetricsOutputFingerprint(rows) != storage.HistoricalMetricsOutputFingerprint(shuffled) {
		t.Fatal("fingerprint must be independent of staged row order")
	}
	mutated := append([]*storage.HistoricalMetricsStaged(nil), rows...)
	mutated[0] = &storage.HistoricalMetricsStaged{RunID: "r", Kind: storage.HistoricalMetricsKindActivityLoad, ItemKey: "b", Payload: `{"x":3}`}
	if storage.HistoricalMetricsOutputFingerprint(rows) == storage.HistoricalMetricsOutputFingerprint(mutated) {
		t.Fatal("fingerprint must change when a payload changes")
	}
}

// The input fingerprint must move when the consumed calibration bundle moves,
// even with identical data/policy/binding inputs (the vintage marker).
func TestFingerprintPinsCalibrationBundle(t *testing.T) {
	policy := storage.DefaultCalibrationPolicy()
	d := storage.OnboardingAnalysisDigest{ActivityCount: 3}
	cal := storage.HistoricalCalibrationDigest{RowCount: 12}
	calMoved := storage.HistoricalCalibrationDigest{RowCount: 13}
	a := storage.HistoricalMetricsFingerprint("2026-11-17", "2025-11-18", "2026-11-17", 1, policy, d, cal, "run-a", "fp-a")
	b := storage.HistoricalMetricsFingerprint("2026-11-17", "2025-11-18", "2026-11-17", 1, policy, d, cal, "run-a", "fp-b")
	if a == b {
		t.Fatal("a different consumed bundle fingerprint must move the input fingerprint")
	}
	if a == storage.HistoricalMetricsFingerprint("2026-11-17", "2025-11-18", "2026-11-17", 1, policy, d, calMoved, "run-a", "fp-a") {
		t.Fatal("a rewritten calibration window must move the input fingerprint")
	}
	same := storage.HistoricalMetricsFingerprint("2026-11-17", "2025-11-18", "2026-11-17", 1, policy, d, cal, "run-a", "fp-a")
	if a != same {
		t.Fatal("identical inputs must fingerprint identically")
	}
}
