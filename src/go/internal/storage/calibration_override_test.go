package storage

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
)

// #999 R4: a per-user override wins over the global policy for that user only.
// User A with an active override selecting the evolved v4 reads its pinned
// (version, revision) row; user B without an override keeps the global active
// v3; the global policy row itself never changes. Deleting (revoking) the
// override restores A's previous selection.
func TestCalibrationUserOverrideSelectionPrecedence(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatal(err)
	}
	userA, userB := uuid.NewString(), uuid.NewString()
	t.Cleanup(func() {
		for _, uid := range []string{userA, userB} {
			for _, m := range []any{&RunningCalibrationPaceZone{}, &RunningCalibrationHRZone{}, &RunningCalibrationSnapshot{}, &RunningCalibrationUserOverride{}} {
				st.db.Where("user_id = ?", uid).Delete(m)
			}
		}
	})
	seed := func(user string, day string, version int, revision string, speed float64) {
		t.Helper()
		if _, err := st.PublishRunningCalibration(ctx, &RunningCalibrationSnapshot{UserID: user, AsOfDate: day, AlgorithmVersion: version, AlgorithmRevision: revision, ThresholdSpeedMps: fptr(speed)}, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	seed(userA, "2026-11-01", 3, "", 4.0)
	seed(userB, "2026-11-01", 3, "", 4.2)
	// Both v4 identities exist on the same day for A: the historical v4 row is
	// written second (higher id), so the unpinned tiebreak would pick it — the
	// override must read the pinned revision instead.
	seed(userA, "2026-11-16", 4, "v4-rev2-2026-11", 3.5)
	seed(userA, "2026-11-16", 4, "", 5.0)

	// Baseline: no override anywhere — A and B both read the global active v3.
	a, err := st.ReadEffectiveRunningCalibration(ctx, userA, "2026-11-16", CalibrationActive)
	if err != nil || a.Snapshot == nil || a.Snapshot.AlgorithmVersion != 3 || *a.Snapshot.ThresholdSpeedMps != 4.0 {
		t.Fatalf("baseline A: %+v %v", a, err)
	}
	if a.Selection.Override != nil {
		t.Fatalf("baseline A must not report an override: %+v", a.Selection)
	}

	// Set A's override to the evolved v4 revision.
	policyBefore, err := st.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	override, err := st.ReplaceUserCalibrationOverride(ctx, 0, RunningCalibrationUserOverride{UserID: userA, AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", Actor: "operator", Note: "single-user trial"})
	if err != nil || override.Revision != 1 || override.Status != OverrideStatusActive {
		t.Fatalf("replace override: %+v %v", override, err)
	}

	// A now reads the pinned evolved v4 row — not the newer-id historical v4 row.
	a, err = st.ReadEffectiveRunningCalibration(ctx, userA, "2026-11-16", CalibrationActive)
	if err != nil || a.Snapshot == nil || a.Snapshot.AlgorithmVersion != 4 || a.Snapshot.AlgorithmRevision != "v4-rev2-2026-11" || *a.Snapshot.ThresholdSpeedMps != 3.5 {
		t.Fatalf("override A: %+v %v", a, err)
	}
	if a.Selection.State != "selected" || a.Selection.Override == nil || a.Selection.Override.AlgorithmRevision != "v4-rev2-2026-11" {
		t.Fatalf("override selection: %+v", a.Selection)
	}

	// B is untouched by A's override, and the global policy row is unchanged.
	b, err := st.ReadEffectiveRunningCalibration(ctx, userB, "2026-11-16", CalibrationActive)
	if err != nil || b.Snapshot == nil || b.Snapshot.AlgorithmVersion != 3 || *b.Snapshot.ThresholdSpeedMps != 4.2 || b.Selection.Override != nil {
		t.Fatalf("user B must keep global v3: %+v %v", b, err)
	}
	policyAfter, err := st.CalibrationPolicy(ctx)
	if err != nil || policyAfter.Revision != policyBefore.Revision || policyAfter.ActiveVersion != policyBefore.ActiveVersion {
		t.Fatalf("global policy must not change: %+v -> %+v %v", policyBefore, policyAfter, err)
	}

	// Historical as-of: the pinned v4-rev2 row did not exist on 2026-11-02, so
	// the read must fall back to the global v3 row with an explicit reason —
	// today's new threshold never backfills history.
	a, err = st.ReadEffectiveRunningCalibration(ctx, userA, "2026-11-02", CalibrationActive)
	if err != nil || a.Snapshot == nil || a.Snapshot.AlgorithmVersion != 3 || *a.Snapshot.ThresholdSpeedMps != 4.0 {
		t.Fatalf("historical A: %+v %v", a, err)
	}
	if a.Selection.State != "fallback" || a.Selection.Reason != "override_snapshot_missing" || a.Selection.Override == nil {
		t.Fatalf("historical selection must explain the miss: %+v", a.Selection)
	}

	// Revoking the override restores A's previous (global v3) selection.
	if err := st.RevokeUserCalibrationOverride(ctx, userA, override.Revision, "operator", "trial ended"); err != nil {
		t.Fatal(err)
	}
	a, err = st.ReadEffectiveRunningCalibration(ctx, userA, "2026-11-16", CalibrationActive)
	if err != nil || a.Snapshot == nil || a.Snapshot.AlgorithmVersion != 3 || *a.Snapshot.ThresholdSpeedMps != 4.0 || a.Selection.Override != nil {
		t.Fatalf("revoked override must restore global v3: %+v %v", a, err)
	}
	// A revoked row is invisible to the reader but retains its audit trail.
	revoked, err := st.UserCalibrationOverride(ctx, userA)
	if err != nil || revoked != nil {
		t.Fatalf("revoked override must read as absent: %+v %v", revoked, err)
	}
	var audit RunningCalibrationUserOverride
	if err := st.db.Where("user_id = ?", userA).Take(&audit).Error; err != nil || audit.Status != OverrideStatusRevoked || audit.Revision != 2 || audit.Actor != "operator" {
		t.Fatalf("revoked audit row must survive: %+v %v", audit, err)
	}
}

// The override row is CAS-guarded like the global policy, and the single-user
// publish boundary is one transaction: snapshot + zones + override commit
// together, a failed zone write rolls the override back, and a retried
// publish with the same identity is idempotent (no revision bump, no extra
// snapshot row).
func TestCalibrationUserOverridePublishBoundaryAndCAS(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatal(err)
	}
	uid := uuid.NewString()
	t.Cleanup(func() {
		for _, m := range []any{&RunningCalibrationPaceZone{}, &RunningCalibrationHRZone{}, &RunningCalibrationSnapshot{}, &RunningCalibrationUserOverride{}} {
			st.db.Where("user_id = ?", uid).Delete(m)
		}
	})
	// CAS: stale revisions conflict; a second create conflicts.
	first, err := st.ReplaceUserCalibrationOverride(ctx, 0, RunningCalibrationUserOverride{UserID: uid, AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", Actor: "a"})
	if err != nil || first.Revision != 1 {
		t.Fatalf("create: %+v %v", first, err)
	}
	if _, err := st.ReplaceUserCalibrationOverride(ctx, 0, RunningCalibrationUserOverride{UserID: uid, AlgorithmVersion: 3, AlgorithmRevision: "", Actor: "b"}); err == nil {
		t.Fatal("second create must conflict")
	}
	if _, err := st.ReplaceUserCalibrationOverride(ctx, 7, RunningCalibrationUserOverride{UserID: uid, AlgorithmVersion: 3, AlgorithmRevision: "", Actor: "b"}); err == nil {
		t.Fatal("stale revision must conflict")
	}
	if err := st.RevokeUserCalibrationOverride(ctx, uid, 1, "a", "done"); err != nil {
		t.Fatal(err)
	}
	if err := st.RevokeUserCalibrationOverride(ctx, uid, 1, "a", "again"); err == nil {
		t.Fatal("double revoke must conflict")
	}
	// Re-activating after revoke bumps from the stored revision.
	again, err := st.ReplaceUserCalibrationOverride(ctx, 2, RunningCalibrationUserOverride{UserID: uid, AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", Actor: "a"})
	if err != nil || again.Revision != 3 || again.Status != OverrideStatusActive {
		t.Fatalf("re-activate: %+v %v", again, err)
	}

	// Atomic publish: snapshot + zones + override commit together.
	snap := &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-16", AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", ThresholdSpeedMps: fptr(3.5)}
	pace := []RunningCalibrationPaceZone{{Name: "easy", MinSpeedMps: fptr(3)}}
	hr := []RunningCalibrationHRZone{{Name: "easy", MinBpm: fptr(130)}}
	id, err := st.PublishUserCalibrationOverride(ctx, snap, pace, hr, RunningCalibrationUserOverride{UserID: uid, AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", Actor: "publish"})
	if err != nil {
		t.Fatal(err)
	}
	// Idempotent retry with identical identity: same snapshot row, same
	// override revision — no audit churn, no duplicate rows.
	id2, err := st.PublishUserCalibrationOverride(ctx, snap, pace, hr, RunningCalibrationUserOverride{UserID: uid, AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", Actor: "publish-retry"})
	if err != nil || id2 != id {
		t.Fatalf("idempotent publish: %d %d %v", id, id2, err)
	}
	var stored RunningCalibrationUserOverride
	if err := st.db.Where("user_id = ?", uid).Take(&stored).Error; err != nil || stored.Revision != 3 || stored.Actor != "a" {
		t.Fatalf("identical-identity publish/retry must keep the original override audit: %+v %v", stored, err)
	}
	var count int64
	st.db.Model(&RunningCalibrationSnapshot{}).Where("user_id = ?", uid).Count(&count)
	if count != 1 {
		t.Fatalf("retry must not add snapshot rows: %d", count)
	}

	// A failing zone write rolls the whole publish back: a changed identity
	// must not become effective without its snapshot, and the old values stay.
	snap2 := &RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-17", AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", ThresholdSpeedMps: fptr(3.6)}
	if _, err := st.PublishUserCalibrationOverride(ctx, snap2, pace, []RunningCalibrationHRZone{{Name: "dup"}, {Name: "dup"}}, RunningCalibrationUserOverride{UserID: uid, AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", Actor: "bad"}); err == nil {
		t.Fatal("expected zone uniqueness failure")
	}
	b, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-17", CalibrationActive)
	if err != nil || b.Snapshot == nil || b.Snapshot.ID != id || *b.Snapshot.ThresholdSpeedMps != 3.5 {
		t.Fatalf("failed publish must not change effective bundle: %+v %v", b, err)
	}
	if err := st.db.Where("user_id = ?", uid).Take(&stored).Error; err != nil || stored.Revision != 3 {
		t.Fatalf("failed publish must not touch the override: %+v %v", stored, err)
	}
}

// Concurrent publishes for one user serialize safely: same-identity racers
// converge on one snapshot row and one active override (identical identity is
// a no-op), while concurrent readers only ever see a complete bundle.
func TestCalibrationUserOverrideConcurrentPublish(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatal(err)
	}
	uid := uuid.NewString()
	t.Cleanup(func() {
		for _, m := range []any{&RunningCalibrationPaceZone{}, &RunningCalibrationHRZone{}, &RunningCalibrationSnapshot{}, &RunningCalibrationUserOverride{}} {
			st.db.Where("user_id = ?", uid).Delete(m)
		}
	})
	publish := func(speed float64) error {
		_, err := st.PublishUserCalibrationOverride(ctx,
			&RunningCalibrationSnapshot{UserID: uid, AsOfDate: "2026-11-16", AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", ThresholdSpeedMps: fptr(speed)},
			[]RunningCalibrationPaceZone{{Name: "easy", MinSpeedMps: fptr(speed)}},
			[]RunningCalibrationHRZone{{Name: "easy", MinBpm: fptr(speed * 40)}},
			RunningCalibrationUserOverride{UserID: uid, AlgorithmVersion: 4, AlgorithmRevision: "v4-rev2-2026-11", Actor: "concurrent"})
		return err
	}
	errs := make(chan error, 5)
	for worker := 0; worker < 4; worker++ {
		go func(worker int) {
			speed := 3.5 + float64(worker%2)*0.01
			if err := publish(speed); err != nil {
				errs <- err
				return
			}
			errs <- nil
		}(worker)
	}
	go func() {
		for range 40 {
			b, err := st.ReadEffectiveRunningCalibration(ctx, uid, "2026-11-16", CalibrationActive)
			if err != nil {
				errs <- err
				return
			}
			if b.Snapshot != nil {
				if b.Selection.Override == nil || len(b.PaceZones) != 1 || *b.Snapshot.ThresholdSpeedMps != *b.PaceZones[0].MinSpeedMps || *b.HRZones[0].MinBpm != *b.Snapshot.ThresholdSpeedMps*40 {
					errs <- fmt.Errorf("inconsistent concurrent bundle: %+v", b)
					return
				}
			}
		}
		errs <- nil
	}()
	for range 5 {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	var snaps int64
	st.db.Model(&RunningCalibrationSnapshot{}).Where("user_id = ? AND algorithm_revision = ?", uid, "v4-rev2-2026-11").Count(&snaps)
	if snaps != 1 {
		t.Fatalf("concurrent same-identity publishes must converge on one row: %d", snaps)
	}
	var overrides int64
	st.db.Model(&RunningCalibrationUserOverride{}).Where("user_id = ? AND status = ?", uid, OverrideStatusActive).Count(&overrides)
	if overrides != 1 {
		t.Fatalf("exactly one active override may exist: %d", overrides)
	}
}
