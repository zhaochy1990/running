package storage

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"os"
	"testing"
)

func TestCalibrationBundlePolicyAndHistory(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatal(err)
	}
	uid := uuid.NewString()
	t.Cleanup(func() {
		for _, m := range []any{&RunningCalibrationPaceZone{}, &RunningCalibrationHRZone{}, &RunningCalibrationSnapshot{}} {
			st.db.Where("user_id = ?", uid).Delete(m)
		}
		st.db.Where("policy_key = ?", calibrationPolicyKey).Delete(&RunningCalibrationPolicy{})
	})
	p, err := st.CalibrationPolicy(ctx)
	if err != nil || p.ActiveVersion != 3 || p.Revision != 0 {
		t.Fatalf("default: %+v %v", p, err)
	}
	for _, x := range []struct {
		v     int
		day   string
		speed *float64
	}{{3, "2026-11-01", fptr(4)}, {4, "2026-11-02", nil}, {4, "2026-12-01", fptr(5)}} {
		_, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: uid, AsOfDate: x.day, AlgorithmVersion: x.v, ThresholdSpeedMps: x.speed}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	active, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-03", CalibrationActive)
	if err != nil || active.Snapshot.AlgorithmVersion != 3 {
		t.Fatalf("active: %+v %v", active, err)
	}
	candidate, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-03", CalibrationCandidate)
	if err != nil || candidate.Snapshot.AlgorithmVersion != 4 || candidate.Snapshot.ThresholdSpeedMps != nil || candidate.Selection.State != "selected" {
		t.Fatalf("candidate: %+v %v", candidate, err)
	}
	fallback, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-01", CalibrationCandidate)
	if err != nil || fallback.Selection.State != "fallback" || *fallback.Selection.EffectiveVersion != 3 {
		t.Fatalf("fallback: %+v %v", fallback, err)
	}
	empty, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-10-01", CalibrationActive)
	if err != nil || empty.Snapshot != nil || empty.Selection.State != "unavailable" {
		t.Fatalf("history: %+v %v", empty, err)
	}
	p.ActiveVersion = 4
	p, err = st.ReplaceCalibrationPolicy(ctx, 0, p)
	if err != nil || p.Revision != 1 {
		t.Fatalf("CAS %+v %v", p, err)
	}
	if _, err = st.ReplaceCalibrationPolicy(ctx, 0, p); !errors.Is(err, ErrCalibrationPolicyConflict) {
		t.Fatalf("CAS conflict %v", err)
	}
	switched, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-03", CalibrationActive)
	if err != nil || switched.Snapshot.AlgorithmVersion != 4 {
		t.Fatal("switch", err)
	}
	p.ActiveVersion = 3
	if _, err = st.ReplaceCalibrationPolicy(ctx, 1, p); err != nil {
		t.Fatal(err)
	}
	again, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-03", CalibrationActive)
	if err != nil || again.Snapshot.ID != active.Snapshot.ID {
		t.Fatal("rollback", err)
	}
}

func TestCalibrationPublishRollbackAndRetry(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatal(err)
	}
	uid := uuid.NewString()
	t.Cleanup(func() {
		for _, m := range []any{&RunningCalibrationPaceZone{}, &RunningCalibrationHRZone{}, &RunningCalibrationSnapshot{}} {
			st.db.Where("user_id = ?", uid).Delete(m)
		}
	})
	s := &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-01", AlgorithmVersion: 3, ThresholdSpeedMps: fptr(4)}
	id, err := st.PublishRunningCalibration(ctx, s, []RunningCalibrationPaceZone{{Name: "easy", MinSpeedMps: fptr(3)}}, []RunningCalibrationHRZone{{Name: "easy", MinBpm: fptr(130)}})
	if err != nil {
		t.Fatal(err)
	}
	s.ThresholdSpeedMps = fptr(5)
	_, err = st.PublishRunningCalibration(ctx, s, []RunningCalibrationPaceZone{{Name: "easy", MinSpeedMps: fptr(4)}}, []RunningCalibrationHRZone{{Name: "duplicate"}, {Name: "duplicate"}})
	if err == nil {
		t.Fatal("expected real HR unique constraint failure")
	}
	b, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-01", CalibrationActive)
	if err != nil || b.Snapshot.ID != id || *b.Snapshot.ThresholdSpeedMps != 4 || *b.PaceZones[0].MinSpeedMps != 3 || *b.HRZones[0].MinBpm != 130 {
		t.Fatalf("partial publish %+v %v", b, err)
	}
	for range 2 {
		got, err := st.PublishRunningCalibration(ctx, s, []RunningCalibrationPaceZone{{Name: "easy", MinSpeedMps: fptr(4)}}, nil)
		if err != nil || got != id {
			t.Fatalf("retry %d %v", got, err)
		}
	}
}

func TestCalibrationFrozenProvenanceDetectsLegacyWriter(t *testing.T) {
	row := ActivityTrainingLoad{UserID: uuid.NewString(), LabelID: "synthetic", TrainingDose: fptr(42)}
	input := CalibrationInput{SnapshotID: 1, AsOfDate: "2026-11-01", AlgorithmVersion: 3, ValuesUsed: CalibrationValues{ThresholdSpeedMps: fptr(4)}}
	if err := FreezeCalibrationProvenance(&row, []CalibrationInput{input}, nil); err != nil {
		t.Fatal(err)
	}
	if p, state := ReadCalibrationProvenance(row); state != "available" || *p.Inputs[0].ValuesUsed.ThresholdSpeedMps != 4 {
		t.Fatalf("frozen %+v %s", p, state)
	}
	input.ValuesUsed.ThresholdSpeedMps = fptr(5)
	if p, _ := ReadCalibrationProvenance(row); *p.Inputs[0].ValuesUsed.ThresholdSpeedMps != 4 {
		t.Fatal("source drift")
	}
	row.TrainingDose = fptr(43)
	if _, state := ReadCalibrationProvenance(row); state != "legacy_or_stale_provenance" {
		t.Fatal("old writer not detected", state)
	}
}

func TestCalibrationSharedPolicyContract(t *testing.T) {
	raw, err := os.ReadFile("../../../coach_agent_worker/src/data/calibrationPolicyContract.json")
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		Active    int   `json:"active_version"`
		Candidate int   `json:"candidate_version"`
		Fallback  int   `json:"fallback_version"`
		Supported []int `json:"supported_versions"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	d := DefaultCalibrationPolicy()
	if p.Active != d.ActiveVersion || p.Candidate != *d.CandidateVersion || p.Fallback != d.FallbackVersion || len(p.Supported) != 2 {
		t.Fatal("shared policy drift")
	}
	for _, v := range p.Supported {
		if !validCalibrationVersion(v) {
			t.Fatal("unsupported shared version")
		}
	}
}
