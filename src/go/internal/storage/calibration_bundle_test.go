package storage

import (
	"context"
	"errors"
	"github.com/google/uuid"
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
