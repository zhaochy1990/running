package storage

import (
	"context"
	"testing"
)

// TestCalibrationZoneTableNames locks in that pace and heart-rate zones map to
// two separate tables (not one mixed running_calibration_zone). Pure unit test,
// no DB.
func TestCalibrationZoneTableNames(t *testing.T) {
	if got := (RunningCalibrationPaceZone{}).TableName(); got != "running_calibration_pace_zone" {
		t.Errorf("pace zone TableName = %q, want running_calibration_pace_zone", got)
	}
	if got := (RunningCalibrationHRZone{}).TableName(); got != "running_calibration_hr_zone" {
		t.Errorf("hr zone TableName = %q, want running_calibration_hr_zone", got)
	}
}

// TestReplaceCalibrationZones_RoundTrip is gated on a live MySQL
// (STRIDE_WORKER_TEST_MYSQL_DSN). It writes pace + HR zones for one snapshot into
// the two split tables, then verifies ReconcileZoneRows re-projects them into the
// shared as_of|zone_kind|name comparison shape (so the diff still lines up
// against the Python single-table store), and that a re-replace is idempotent.
func TestReplaceCalibrationZones_RoundTrip(t *testing.T) {
	st := openTestStore(t) // skips without the env var
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}

	const uid = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
	const asOf = "2026-05-09"

	snapID, err := st.UpsertRunningCalibrationSnapshot(ctx, &RunningCalibrationSnapshot{
		UserID:                   uid,
		AsOfDate:                 asOf,
		AlgorithmVersion:         3,
		ThresholdHRConfidence:    "high",
		ThresholdSpeedConfidence: "high",
	})
	if err != nil {
		t.Fatalf("upsert snapshot: %v", err)
	}

	pace := []RunningCalibrationPaceZone{{
		Name: "easy", MinPaceSPerKm: fptr(300), MaxPaceSPerKm: fptr(360),
		MinSpeedMps: fptr(2.78), MaxSpeedMps: fptr(3.33), Confidence: "high",
	}}
	hr := []RunningCalibrationHRZone{{
		Name: "easy", MinBpm: fptr(130), MaxBpm: fptr(145), Confidence: "high",
	}}
	if err := st.ReplaceCalibrationZones(ctx, uid, snapID, pace, hr); err != nil {
		t.Fatalf("replace zones: %v", err)
	}
	// Re-replace must not duplicate (delete-then-insert on both tables).
	if err := st.ReplaceCalibrationZones(ctx, uid, snapID, pace, hr); err != nil {
		t.Fatalf("re-replace zones: %v", err)
	}

	rows, err := st.ReconcileZoneRows(ctx, uid)
	if err != nil {
		t.Fatalf("reconcile zone rows: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("reconcile rows = %d, want 2 (one pace, one hr)", len(rows))
	}

	p, ok := rows[asOf+"|pace|easy"]
	if !ok {
		t.Fatalf("missing pace row, got keys %v", keysOf(rows))
	}
	if p["min_value"] != 300.0 || p["max_value"] != 360.0 {
		t.Errorf("pace min/max = %v/%v, want 300/360", p["min_value"], p["max_value"])
	}
	if p["min_speed_mps"] == nil || p["max_speed_mps"] == nil {
		t.Errorf("pace speed cols should be populated, got %v/%v", p["min_speed_mps"], p["max_speed_mps"])
	}

	h, ok := rows[asOf+"|heart_rate|easy"]
	if !ok {
		t.Fatalf("missing hr row, got keys %v", keysOf(rows))
	}
	if h["min_value"] != 130.0 || h["max_value"] != 145.0 {
		t.Errorf("hr min/max = %v/%v, want 130/145", h["min_value"], h["max_value"])
	}
	if h["min_speed_mps"] != nil || h["max_speed_mps"] != nil {
		t.Errorf("hr speed cols must be nil, got %v/%v", h["min_speed_mps"], h["max_speed_mps"])
	}
}

func keysOf(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
