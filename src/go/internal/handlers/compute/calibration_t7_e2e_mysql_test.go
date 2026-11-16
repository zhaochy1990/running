package compute

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// TestT7IsolatedStackFullChainMySQL is the #1001 phase-A engineering E2E on
// the real isolated stack (13383/13384): data -> fit -> per-user override ->
// atomic bundle -> derived load/zones/PMC/ability -> effective reads for both
// a target and a control user, then the revoke -> recompute recovery drill.
// The global policy must be byte-identical across every phase.
func TestT7IsolatedStackFullChainMySQL(t *testing.T) {
	ctx, st := openCalibrationReviewMySQL(t)
	userA := uuid.NewString()
	userB := uuid.NewString()
	seedUserOrdinaryTraining(t, st, userA, 23, 3.6)
	labelsB := seedUserOrdinaryTraining(t, st, userB, 23, 3.9)
	for _, uid := range []string{userA, userB} {
		t.Cleanup(func() {
			if err := st.DeleteUserData(ctx, uid); err != nil {
				t.Error(err)
			}
		})
	}
	today := timefmt.ShanghaiToday()
	day := today.Format("2006-01-02")
	run := func(h job.Handler, user, input string) (string, error) {
		t.Helper()
		return h(ctx, &job.Job{UserID: user, InputJSON: input}, func(string, int) error { return nil })
	}
	handler := NewUserCalibration(st)

	policyBefore, err := st.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	policySame := func(phase string) {
		t.Helper()
		now, err := st.CalibrationPolicy(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(now, policyBefore) {
			t.Fatalf("global policy changed during %s: %+v -> %+v", phase, policyBefore, now)
		}
		t.Logf("[drill] %s: global policy unchanged (active=%d)", phase, now.ActiveVersion)
	}

	// Phase 0: both users on global v3 (the target gets the realistic daily
	// four-day row history so historical activity days resolve a same-day
	// snapshot during the derived recompute).
	for i := 3; i >= 0; i-- {
		if _, _, err := runCalibrationVersion(ctx, st, userA, today.AddDate(0, 0, -i), 3); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := runCalibrationVersion(ctx, st, userB, today, 3); err != nil {
		t.Fatal(err)
	}
	bundleB0, err := st.ReadEffectiveRunningCalibration(ctx, userB, day, storage.CalibrationActive)
	if err != nil || bundleB0.Snapshot == nil || bundleB0.Snapshot.AlgorithmVersion != 3 {
		t.Fatalf("control baseline: %+v %v", bundleB0, err)
	}
	policySame("baseline")

	// Phase 1: publish the evolved override for the target user only.
	first, err := run(handler, userA, `{"action":"publish","actor":"t7-e2e","note":"phase-A drill"}`)
	if err != nil {
		t.Fatal(err)
	}
	var published struct {
		CalibrationRowID uint64 `json:"calibration_snapshot_id"`
		Fingerprint      string `json:"fingerprint"`
		SpeedState       string `json:"speed_state"`
		HRState          string `json:"hr_state"`
	}
	if err := json.Unmarshal([]byte(first), &published); err != nil {
		t.Fatal(err)
	}
	if published.SpeedState == "" || published.Fingerprint == "" {
		t.Fatalf("publish result: %s", first)
	}
	// Atomic bundle: the effective read immediately resolves the pinned
	// identity with pace+HR zones attached (no torn state).
	bundleA, err := st.ReadEffectiveRunningCalibration(ctx, userA, day, storage.CalibrationActive)
	if err != nil || bundleA.Snapshot == nil || bundleA.Snapshot.AlgorithmVersion != 4 || bundleA.Snapshot.AlgorithmRevision != calibration.EvolvedCandidateAlgorithmRevision {
		t.Fatalf("target effective after publish: %+v %v", bundleA, err)
	}
	if len(bundleA.PaceZones) == 0 || len(bundleA.HRZones) == 0 {
		t.Fatalf("atomic bundle must carry both zone sets: %+v", bundleA)
	}
	if bundleA.Snapshot.ThresholdSpeedMps == nil || bundleA.Snapshot.ThresholdHR == nil {
		t.Fatalf("evolved bundle must carry finite pace and HR centers: %+v", bundleA.Snapshot)
	}
	t.Logf("[drill] publish: snapshot=%d fingerprint=%s speed_state=%s hr_state=%s v60=%.2f m/s hr=%.1f bpm",
		published.CalibrationRowID, published.Fingerprint, published.SpeedState, published.HRState,
		*bundleA.Snapshot.ThresholdSpeedMps, *bundleA.Snapshot.ThresholdHR)
	// Control user and global policy untouched.
	bundleB1, err := st.ReadEffectiveRunningCalibration(ctx, userB, day, storage.CalibrationActive)
	if err != nil || bundleB1.Snapshot.ID != bundleB0.Snapshot.ID {
		t.Fatalf("control user's effective row changed: %+v %v", bundleB1, err)
	}
	policySame("after-publish")
	// Write scope: the control user has no override row at all.
	if o, err := st.UserCalibrationOverride(ctx, userB); err != nil || o != nil {
		t.Fatalf("control user must not get an override row: %+v %v", o, err)
	}

	// Phase 2: derived recompute under the override — load/zones, daily PMC
	// and ability snapshots must appear for the target user only.
	if _, err := run(handler, userA, `{"action":"recompute","days":30,"actor":"t7-e2e"}`); err != nil {
		t.Fatal(err)
	}
	labelsA := labelsForUser(t, st, userA)
	v4Today := 0
	for _, label := range labelsA {
		a, err := st.ActivityTrainingLoad(ctx, userA, label)
		if err != nil || a == nil {
			t.Fatalf("missing derived load for %s: %v", label, err)
		}
		prov, state := storage.ReadCalibrationProvenance(*a)
		if state != "available" {
			t.Fatalf("provenance unavailable for %s: %s", label, state)
		}
		if a.ActivityDate == day && prov.Inputs[0].AlgorithmVersion == 4 {
			v4Today++
		}
	}
	if v4Today == 0 {
		t.Fatal("no same-day derived row carries the overridden v4 lineage")
	}
	pmc, err := st.DailyTrainingLoadSeries(ctx, userA, 30)
	if err != nil || len(pmc) == 0 {
		t.Fatalf("daily PMC series missing for target: %+v %v", pmc, err)
	}
	abilityToday, err := st.AbilitySnapshotForDate(ctx, userA, day)
	if err != nil || len(abilityToday) == 0 {
		t.Fatalf("ability snapshot missing for target: %+v %v", abilityToday, err)
	}
	abilityLabels, err := st.ActivityAbilityLabelIDs(ctx, userA)
	if err != nil || len(abilityLabels) == 0 {
		t.Fatalf("per-activity ability rows missing for target: %+v %v", abilityLabels, err)
	}
	t.Logf("[drill] recompute: load=%d rows (v4 today=%d) pmc_days=%d ability_dims=%d activity_ability=%d",
		len(labelsA), v4Today, len(pmc), len(abilityToday), len(abilityLabels))
	// Control user untouched by the target's recompute.
	for _, label := range labelsB {
		if a, err := st.ActivityTrainingLoad(ctx, userB, label); err != nil || a != nil {
			t.Fatalf("control derived rows must stay untouched: %+v %v", a, err)
		}
	}
	if abilityB, err := st.AbilitySnapshotForDate(ctx, userB, day); err != nil || len(abilityB) != 0 {
		t.Fatalf("control ability rows must stay untouched: %+v %v", abilityB, err)
	}
	policySame("after-recompute")

	// Phase 3: revoke -> effective selection returns to global v3; the
	// explicit recompute then rebuilds the derived rows with v3 lineage.
	out, err := run(handler, userA, `{"action":"revoke","actor":"t7-e2e","note":"drill end"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"restored"`) {
		t.Fatalf("revoke result: %s", out)
	}
	bundleA2, err := st.ReadEffectiveRunningCalibration(ctx, userA, day, storage.CalibrationActive)
	if err != nil || bundleA2.Snapshot == nil || bundleA2.Snapshot.AlgorithmVersion != 3 || bundleA2.Selection.Override != nil {
		t.Fatalf("revoke must restore the global v3 selection: %+v %v", bundleA2, err)
	}
	t.Logf("[drill] revoke: effective back to v3 (snapshot as_of=%s)", bundleA2.Snapshot.AsOfDate)
	policySame("after-revoke")
	if _, err := run(handler, userA, `{"action":"recompute","days":30,"actor":"t7-e2e"}`); err != nil {
		t.Fatal(err)
	}
	recoveredV3 := 0
	for _, label := range labelsA {
		a, err := st.ActivityTrainingLoad(ctx, userA, label)
		if err != nil || a == nil {
			t.Fatalf("missing recovered load: %v", err)
		}
		prov, state := storage.ReadCalibrationProvenance(*a)
		if state != "available" {
			t.Fatalf("recovered provenance unavailable: %s", state)
		}
		if prov.Inputs[0].AlgorithmVersion == 3 && prov.Inputs[0].Selection.Override == nil {
			recoveredV3++
		}
	}
	if recoveredV3 != len(labelsA) {
		t.Fatalf("recovery rebuilt %d/%d rows with clean v3 lineage", recoveredV3, len(labelsA))
	}
	// The evolved snapshot history stays immutable through the drill.
	rows := userCalibrationSnapshots(t, st, userA)
	if countRevisions(t, rows, calibration.EvolvedCandidateAlgorithmRevision) != 1 {
		t.Fatalf("evolved history must survive revoke unchanged: %+v", rows)
	}
	policySame("after-recovery")
	// Control user's final state: same v3 row id as the very first read.
	bundleBEnd, err := st.ReadEffectiveRunningCalibration(ctx, userB, day, storage.CalibrationActive)
	if err != nil || bundleBEnd.Snapshot.ID != bundleB0.Snapshot.ID {
		t.Fatalf("control user final effective row drifted: %+v %v", bundleBEnd, err)
	}
	t.Logf("[drill] complete: target recovered to v3 lineage; control unchanged (snapshot=%d)", bundleB0.Snapshot.ID)
}
