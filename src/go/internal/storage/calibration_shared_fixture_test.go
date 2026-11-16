package storage

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestCalibrationSharedFixture is the Go-owned bridge for a real read-only TS
// adapter test. It writes only the explicitly configured disposable test DB.
func TestCalibrationSharedFixture(t *testing.T) {
	path := os.Getenv("STRIDE_989_FIXTURE_OUTPUT")
	if path == "" {
		t.Skip("explicit shared fixture output required")
	}
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatal(err)
	}
	var old []RunningCalibrationPolicy
	if err := st.db.Find(&old).Error; err != nil {
		t.Fatal(err)
	}
	st.db.Where("policy_key = ?", calibrationPolicyKey).Delete(&RunningCalibrationPolicy{})
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	t.Cleanup(func() {
		for _, uid := range ids {
			for _, m := range []any{&RunningCalibrationPaceZone{}, &RunningCalibrationHRZone{}, &RunningCalibrationSnapshot{}, &RunningCalibrationUserOverride{}} {
				st.db.Where("user_id = ?", uid).Delete(m)
			}
		}
		st.db.Where("policy_key = ?", calibrationPolicyKey).Delete(&RunningCalibrationPolicy{})
		if len(old) > 0 {
			st.db.Create(&old)
		}
	})
	source := calibration.SourceSummary{SchemaVersion: 1, State: "available", Strategy: "candidate", Implementation: "hour_capability_v1+independent_hr_v1", ParameterVersion: "test-only", DataCutoffDay: "2026-11-02", AvailabilitySemantics: "event_date_retrospective", Speed: &calibration.MetricSource{Method: "constraints_only", TargetType: "one_hour_running_capability", MeasurementQuality: "unknown", EffortSupport: "unknown", Support: "none", RangeMeaning: "evidence_support_sensitivity_not_probability_interval", Reasons: []string{"insufficient_maximal_support"}, Limitations: []string{}}}
	raw, _ := json.Marshal(source)
	text := string(raw)
	bad := "{"
	for _, seed := range []struct {
		user    string
		version int
		day     string
		speed   *float64
		source  *string
	}{{ids[0], 3, "2026-11-01", fptr(4), nil}, {ids[0], 4, "2026-11-02", nil, &text}, {ids[0], 4, "2026-12-01", fptr(5), &text}, {ids[1], 3, "2026-11-01", fptr(3), nil}, {ids[2], 3, "2026-11-01", fptr(3.5), &bad}} {
		var p []RunningCalibrationPaceZone
		var h []RunningCalibrationHRZone
		if seed.speed != nil {
			p = []RunningCalibrationPaceZone{{Name: "easy", MinSpeedMps: seed.speed, Confidence: "low"}}
			h = []RunningCalibrationHRZone{{Name: "easy", MinBpm: fptr(130), Confidence: "low"}}
		}
		if _, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: seed.user, AsOfDate: seed.day, AlgorithmVersion: seed.version, ThresholdSpeedMps: seed.speed, SourceJSON: seed.source}, p, h); err != nil {
			t.Fatal(err)
		}
	}
	phase := os.Getenv("STRIDE_989_FIXTURE_PHASE")
	if phase == "active4" || phase == "rollback3" {
		p := DefaultCalibrationPolicy()
		p.ActiveVersion = 4
		p, err := st.ReplaceCalibrationPolicy(ctx, 0, p)
		if err != nil {
			t.Fatal(err)
		}
		if phase == "rollback3" {
			p.ActiveVersion = 3
			if _, err = st.ReplaceCalibrationPolicy(ctx, p.Revision, p); err != nil {
				t.Fatal(err)
			}
		}
	}
	// #999 per-user override cases: ids[4] holds an active override pinning the
	// evolved v4 revision (with both v4 identities plus a v3 row seeded),
	// ids[5] holds a revoked override. Global policy stays untouched, so the
	// pre-existing cases keep their expected selections.
	overrideSource := calibration.SourceSummary{SchemaVersion: 1, State: "available", Strategy: "evolved_candidate", Implementation: "evolved_joint_v2", ParameterVersion: "rev2-research-2026-11", AlgorithmRevision: calibration.EvolvedCandidateAlgorithmRevision, DataCutoffDay: "2026-11-16", AvailabilitySemantics: "event_date_retrospective", Speed: &calibration.MetricSource{Method: "evolved_joint_v2", TargetType: "model_one_hour_capability_v60", State: "model_estimated", MeasurementQuality: "low", EffortSupport: "submaximal", Support: "medium", RangeMeaning: "model_sensitivity", Reasons: []string{}, Limitations: []string{}}, HR: &calibration.MetricSource{Method: "evolved_joint_v2", TargetType: "threshold_hr_at_v60_reference", State: "prior_dominated", MeasurementQuality: "unknown", EffortSupport: "unknown", Support: "low", RangeMeaning: "model_sensitivity", Reasons: []string{}, Limitations: []string{}}}
	overrideRaw, err := json.Marshal(overrideSource)
	if err != nil {
		t.Fatal(err)
	}
	overrideText := string(overrideRaw)
	for _, seed := range []struct {
		user     string
		day      string
		version  int
		revision string
		speed    *float64
		source   *string
	}{
		{ids[4], "2026-11-01", 3, "", fptr(4), nil},
		{ids[4], "2026-11-16", 4, calibration.EvolvedCandidateAlgorithmRevision, fptr(3.5), &overrideText},
		{ids[4], "2026-11-16", 4, "", fptr(5), nil},
		{ids[5], "2026-11-01", 3, "", fptr(4.4), nil},
		{ids[5], "2026-11-16", 4, calibration.EvolvedCandidateAlgorithmRevision, fptr(3.4), &overrideText},
	} {
		if _, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: seed.user, AsOfDate: seed.day, AlgorithmVersion: seed.version, AlgorithmRevision: seed.revision, ThresholdSpeedMps: seed.speed, SourceJSON: seed.source}, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.ReplaceUserCalibrationOverride(ctx, 0, RunningCalibrationUserOverride{UserID: ids[4], AlgorithmVersion: 4, AlgorithmRevision: calibration.EvolvedCandidateAlgorithmRevision, Actor: "fixture"}); err != nil {
		t.Fatal(err)
	}
	revoked, err := st.ReplaceUserCalibrationOverride(ctx, 0, RunningCalibrationUserOverride{UserID: ids[5], AlgorithmVersion: 4, AlgorithmRevision: calibration.EvolvedCandidateAlgorithmRevision, Actor: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.RevokeUserCalibrationOverride(ctx, ids[5], revoked.Revision, "fixture", "trial ended"); err != nil {
		t.Fatal(err)
	}
	type testCase struct {
		Name   string            `json:"name"`
		UserID string            `json:"user_id"`
		Cutoff string            `json:"cutoff"`
		Mode   CalibrationMode   `json:"mode"`
		Bundle CalibrationBundle `json:"bundle"`
	}
	var cases []testCase
	for _, x := range []struct {
		name string
		user int
		day  string
		mode CalibrationMode
	}{{"active-v3", 0, "2026-11-03", CalibrationActive}, {"constraints-only", 0, "2026-11-03", CalibrationCandidate}, {"preferred-missing", 0, "2026-11-01", CalibrationCandidate}, {"no-history", 0, "2026-10-01", CalibrationActive}, {"cross-user", 1, "2026-11-03", CalibrationActive}, {"invalid-source", 2, "2026-11-03", CalibrationActive}, {"no-snapshot", 3, "2026-11-03", CalibrationActive}, {"override-selected", 4, "2026-11-16", CalibrationActive}, {"override-historical-fallback", 4, "2026-11-02", CalibrationActive}, {"override-revoked", 5, "2026-11-16", CalibrationActive}} {
		b, err := st.ReadEffectiveRunningCalibration(ctx, ids[x.user], x.day, x.mode)
		if err != nil {
			t.Fatal(err)
		}
		cases = append(cases, testCase{x.name, ids[x.user], x.day, x.mode, b})
	}
	payload, _ := json.Marshal(struct {
		Cases []testCase `json:"cases"`
	}{cases})
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, payload, 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("shared fixture ready; awaiting explicit reader completion marker")
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path + ".done"); err == nil {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatal("shared fixture consumer timed out")
}
