package storage

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// The (user, day, version) overwrite-upsert conflicted with the 2026-11-16
// decision that the evolved v4 must never overwrite historical v4 rows (#995).
// Contract resolution: algorithm_revision joins the natural key. These tests
// lock the three consequences: cross-revision writes are separate rows,
// same-key republish stays idempotent, and junk revisions never enter the key.
func TestCalibrationRevisionKeySeparatesEvolvedV4FromHistory(t *testing.T) {
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
	// 1. Historical v4 row (pre-993 writers leave algorithm_revision empty).
	historical, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-16", AlgorithmVersion: 4, AlgorithmRevision: "", ThresholdSpeedMps: fptr(4.0)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// 2. Evolved v4 revision on the same (user, day, version): a new row.
	evolved, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-16", AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", ThresholdSpeedMps: fptr(3.55)}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if evolved == historical {
		t.Fatalf("same-day different revision must be a distinct row: %d", evolved)
	}
	var rows []RunningCalibrationSnapshot
	if err := st.db.Where("user_id = ? AND as_of_date = ?", uid, "2026-11-16").Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].AlgorithmRevision != "" || *rows[0].ThresholdSpeedMps != 4.0 || rows[1].AlgorithmRevision != "v4-rev2-2026-11" || *rows[1].ThresholdSpeedMps != 3.55 {
		t.Fatalf("historical v4 row must survive the evolved write: %+v", rows)
	}
	// 3. Same-key republish remains an idempotent overwrite (same-day recompute).
	again, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-16", AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", ThresholdSpeedMps: fptr(3.56)}, nil, nil)
	if err != nil || again != evolved {
		t.Fatalf("same revision republish must reuse the row: %d %d %v", again, evolved, err)
	}
	if err := st.db.Where("user_id = ? AND as_of_date = ?", uid, "2026-11-16").Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("idempotent same-key overwrite must not add rows: %+v", rows)
	}
	// 4. Reads stay deterministic (as_of_date DESC, id DESC) and the bundle
	// carries the winning revision.
	bundle, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-16", CalibrationCandidate)
	if err != nil || bundle.Snapshot == nil || bundle.Snapshot.AlgorithmVersion != 4 {
		t.Fatalf("read: %+v %v", bundle, err)
	}
	if bundle.Snapshot.AlgorithmRevision != "v4-rev2-2026-11" {
		t.Fatalf("read tiebreak must pick the latest-written row, got revision %q", bundle.Snapshot.AlgorithmRevision)
	}
	// 5. Junk revisions never enter the natural key.
	if _, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-17", AlgorithmVersion: 4, AlgorithmRevision: "bad revision; drop table"}, nil, nil); err == nil {
		t.Fatal("invalid revision charset accepted")
	}
	if _, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-17", AlgorithmVersion: 3, AlgorithmRevision: "ok-rev.1_2"}, nil, nil); err != nil {
		t.Fatalf("valid revision charset rejected: %v", err)
	}
}

func TestUpsertRunningCalibrationSnapshotReadsBackPerRevision(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatal(err)
	}
	uid := uuid.NewString()
	t.Cleanup(func() {
		st.db.Where("user_id = ?", uid).Delete(&RunningCalibrationSnapshot{})
	})
	a := &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-16", AlgorithmVersion: 4, AlgorithmRevision: "", ThresholdSpeedMps: fptr(4)}
	idA, err := st.UpsertRunningCalibrationSnapshot(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	b := &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-16", AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", ThresholdSpeedMps: fptr(3.5)}
	idB, err := st.UpsertRunningCalibrationSnapshot(ctx, b)
	if err != nil {
		t.Fatal(err)
	}
	if idA == idB {
		t.Fatal("upsert read-back must distinguish revisions")
	}
	again, err := st.UpsertRunningCalibrationSnapshot(ctx, a)
	if err != nil || again != idA {
		t.Fatalf("same revision re-upsert must reuse id: %d %d %v", again, idA, err)
	}
}
