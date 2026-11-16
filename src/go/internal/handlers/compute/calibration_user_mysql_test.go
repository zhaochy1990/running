package compute

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// Ordinary-training fixture: submaximal runs with HR series and daily health,
// no maximal/protocol labels. The evolved v4 must produce a publishable
// estimate from exactly this shape (SPEC #993 core behavior change).
func seedUserOrdinaryTraining(t *testing.T, st *storage.Store, uid string, days int, speed float64) []string {
	t.Helper()
	ctx := context.Background()
	today := timefmt.ShanghaiToday()
	labels := []string{}
	for i := days - 1; i >= 0; i-- {
		rhr := 48
		if err := st.UpsertDailyHealth(ctx, &storage.DailyHealth{UserID: uid, Provider: "coros", Date: today.AddDate(0, 0, -i).Format("20060102"), RHR: &rhr}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 2; i >= 0; i-- {
		day := today.AddDate(0, 0, -i)
		for _, duration := range []int{3600, 2400} {
			label := strings.Join([]string{"t5-ordinary", uid[:8], day.Format("20060102"), fmt.Sprint(duration)}, "-")
			labels = append(labels, label)
			dur := float64(duration)
			distance := dur * speed
			sport := "run_outdoor"
			maxHR := 176
			row := storage.Activity{UserID: uid, LabelID: label, Provider: "coros", SyncedAt: time.Now().UTC(), Sport: &sport, SportType: 100, Date: day.Add(12 * time.Hour).UTC(), DurationS: &dur, DistanceM: &distance, MaxHR: &maxHR}
			var points []storage.TimeseriesPoint
			for second := 0; second <= duration; second += 5 {
				clock := int64(second * 100)
				d := float64(second) * speed * 100
				hr := 150 + second%300/60
				s := speed - float64(second%600)/6000
				points = append(points, storage.TimeseriesPoint{Timestamp: &clock, Distance: &d, Speed: &s, HeartRate: &hr})
			}
			if err := st.UpsertActivity(ctx, &row, nil, points, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	return labels
}

func userCalibrationSnapshots(t *testing.T, st *storage.Store, uid string) []storage.RunningCalibrationSnapshot {
	t.Helper()
	rows, err := st.RunningCalibrationSnapshotsForUser(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

// Preview is read-only: it must expose the full evolved report (for acceptance
// review and T6 display) without touching any table.
func TestUserEvolvedPreviewReadOnlyMySQL(t *testing.T) {
	ctx, st := openCalibrationReviewMySQL(t)
	uid := uuid.NewString()
	labels := seedUserOrdinaryTraining(t, st, uid, 23, 3.6)
	t.Cleanup(func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Error(err)
		}
	})
	today := timefmt.ShanghaiToday()
	if got := userCalibrationSnapshots(t, st, uid); len(got) != 0 {
		t.Fatalf("fixture must start clean, got %d snapshots", len(got))
	}
	preview, err := PreviewUserEvolvedCalibration(ctx, st, uid, today)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Result.AlgorithmRevision != calibration.EvolvedCandidateAlgorithmRevision || preview.Result.Snapshot.AlgorithmVersion != calibration.CandidateVersion {
		t.Fatalf("preview identity: %+v", preview.Result)
	}
	if preview.Result.Snapshot.ThresholdSpeedMps == nil || *preview.Result.Snapshot.ThresholdSpeedMps <= 0 {
		t.Fatalf("ordinary training must yield a finite speed estimate: %+v", preview.Result.Snapshot)
	}
	if preview.Result.Evolved == nil || preview.Result.Evolved.Speed == nil || preview.Result.Evolved.Speed.State == calibration.StateUnavailable {
		t.Fatalf("speed state must be a declared estimate state, not unavailable: %+v", preview.Result.Evolved)
	}
	if !preview.Publishable {
		t.Fatalf("ordinary-training preview must be publishable: %+v", preview.RefusalReasons)
	}
	if preview.Selection.Mode != storage.CalibrationActive || preview.Selection.Override != nil {
		t.Fatalf("preview selection must describe the current (pre-publish) state: %+v", preview.Selection)
	}
	// No writes anywhere: no snapshot, no override, no derived rows.
	if got := userCalibrationSnapshots(t, st, uid); len(got) != 0 {
		t.Fatalf("preview wrote %d snapshots", len(got))
	}
	if o, err := st.UserCalibrationOverride(ctx, uid); err != nil || o != nil {
		t.Fatalf("preview must not write an override: %+v %v", o, err)
	}
	for _, label := range labels {
		if a, err := st.ActivityTrainingLoad(ctx, uid, label); err != nil || a != nil {
			t.Fatalf("preview must not write load rows: %+v %v", a, err)
		}
	}
	if daily, err := st.DailyTrainingLoadSeries(ctx, uid, 30); err != nil || len(daily) != 0 {
		t.Fatalf("preview must not write daily rows: %+v %v", daily, err)
	}
}

// The closed loop: publish (idempotent, override-authorized) -> per-user
// effective switch while global and other users stay on v3 -> daily sync
// continues on the user's pinned version -> derived recompute under the
// override -> revoke restores v3 -> explicit recompute rebuilds the derived
// rows under v3. Invalid estimates refuse without touching anything.
func TestUserEvolvedPublishClosedLoopMySQL(t *testing.T) {
	ctx, st := openCalibrationReviewMySQL(t)
	userA := uuid.NewString()
	userB := uuid.NewString()
	empty := uuid.NewString()
	seedUserOrdinaryTraining(t, st, userA, 23, 3.6)
	labelsB := seedUserOrdinaryTraining(t, st, userB, 23, 3.9)
	for _, uid := range []string{userA, userB, empty} {
		t.Cleanup(func() {
			if err := st.DeleteUserData(ctx, uid); err != nil {
				t.Error(err)
			}
		})
	}
	today := timefmt.ShanghaiToday()
	day := today.Format("2006-01-02")
	policyBefore, err := st.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	run := func(h job.Handler, user, input string) (string, error) {
		t.Helper()
		return h(ctx, &job.Job{UserID: user, InputJSON: input}, func(string, int) error { return nil })
	}
	handler := NewUserCalibration(st)

	// Target UUID is a hard partition constraint.
	if _, err := run(handler, "not-a-uuid", `{"action":"publish"}`); err == nil || !strings.Contains(fmt.Sprint(err), "user UUID") {
		t.Fatalf("non-UUID partition must be rejected: %v", err)
	}

	// A is an existing v3 user: four days of v3 snapshots (the trial starts
	// from a real production shape, and historical days must keep v3 lineage).
	for i := 3; i >= 0; i-- {
		if _, _, err := runCalibrationVersion(ctx, st, userA, today.AddDate(0, 0, -i), 3); err != nil {
			t.Fatal(err)
		}
	}
	// B stays on the global v3 selection the whole time.
	if _, _, err := runCalibrationVersion(ctx, st, userB, today, 3); err != nil {
		t.Fatal(err)
	}
	bundleB, err := st.ReadEffectiveRunningCalibration(ctx, userB, day, storage.CalibrationActive)
	if err != nil || bundleB.Snapshot == nil || bundleB.Snapshot.AlgorithmVersion != 3 {
		t.Fatalf("user B baseline: %+v %v", bundleB, err)
	}

	// Empty user: no valid estimate -> publish refuses (permanent, coded),
	// nothing written.
	refused, err := run(handler, empty, `{"action":"publish","actor":"test","note":"empty"}`)
	if err == nil {
		t.Fatalf("empty user publish must refuse, got %s", refused)
	}
	if pe, ok := job.AsPermanent(err); !ok || pe.Code != "invalid_estimate" {
		t.Fatalf("empty user publish must refuse with the invalid_estimate permanent code: %v", err)
	}
	if got := userCalibrationSnapshots(t, st, empty); len(got) != 0 {
		t.Fatalf("refused publish wrote rows: %+v", got)
	}
	if o, err := st.UserCalibrationOverride(ctx, empty); err != nil || o != nil {
		t.Fatalf("refused publish activated an override: %+v %v", o, err)
	}

	// Publish for A: snapshot row + active override, effective switches to the
	// pinned evolved identity, prior_dominated/model states are successes.
	var published struct {
		Status           string `json:"status"`
		CalibrationRowID uint64 `json:"calibration_snapshot_id"`
		AlgorithmVersion int    `json:"algorithm_version"`
		AlgorithmRevison string `json:"algorithm_revision"`
		SpeedState       string `json:"speed_state"`
		HRState          string `json:"hr_state"`
		Fingerprint      string `json:"fingerprint"`
		OverrideRevision uint64 `json:"override_revision"`
	}
	first, err := run(handler, userA, `{"action":"publish","actor":"test","note":"single-user trial"}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(first), &published); err != nil {
		t.Fatal(err)
	}
	if published.Status != "published" || published.AlgorithmVersion != 4 || published.AlgorithmRevison != calibration.EvolvedCandidateAlgorithmRevision || published.Fingerprint == "" || published.OverrideRevision == 0 {
		t.Fatalf("publish result: %s", first)
	}
	if published.SpeedState == string(calibration.StateUnavailable) || published.HRState == string(calibration.StateUnavailable) {
		t.Fatalf("published states must be declared estimates, not unavailable: %s", first)
	}
	bundleA, err := st.ReadEffectiveRunningCalibration(ctx, userA, day, storage.CalibrationActive)
	if err != nil || bundleA.Snapshot == nil || bundleA.Snapshot.AlgorithmVersion != 4 || bundleA.Snapshot.AlgorithmRevision != calibration.EvolvedCandidateAlgorithmRevision {
		t.Fatalf("user A effective after publish: %+v %v", bundleA, err)
	}
	if bundleA.Selection.State != "selected" || bundleA.Selection.Override == nil || bundleA.Fingerprint != published.Fingerprint {
		t.Fatalf("user A selection: %+v", bundleA.Selection)
	}
	if rows := userCalibrationSnapshots(t, st, userA); countRevisions(t, rows, calibration.EvolvedCandidateAlgorithmRevision) != 1 || countRevisions(t, rows, "") != 4 {
		t.Fatalf("user A snapshots after publish: %+v", rows)
	}

	// Global policy and user B are untouched by A's publish.
	policyNow, err := st.CalibrationPolicy(ctx)
	if err != nil || policyNow.Revision != policyBefore.Revision || policyNow.ActiveVersion != policyBefore.ActiveVersion {
		t.Fatalf("publish must not touch global policy: %+v %+v", policyBefore, policyNow)
	}
	bundleB2, err := st.ReadEffectiveRunningCalibration(ctx, userB, day, storage.CalibrationActive)
	if err != nil || bundleB2.Snapshot.ID != bundleB.Snapshot.ID || bundleB2.Snapshot.AlgorithmVersion != 3 {
		t.Fatalf("user B must remain on its v3 row: %+v %v", bundleB2, err)
	}

	// Retried publish is idempotent: same row id, no override churn.
	second, err := run(handler, userA, `{"action":"publish","actor":"test","note":"retry"}`)
	if err != nil {
		t.Fatal(err)
	}
	var republished struct {
		CalibrationRowID uint64 `json:"calibration_snapshot_id"`
		OverrideRevision uint64 `json:"override_revision"`
	}
	if err := json.Unmarshal([]byte(second), &republished); err != nil {
		t.Fatal(err)
	}
	if republished.CalibrationRowID != published.CalibrationRowID || republished.OverrideRevision != published.OverrideRevision {
		t.Fatalf("publish is not idempotent: %s vs %s", first, second)
	}
	if rows := userCalibrationSnapshots(t, st, userA); len(rows) != 5 {
		t.Fatalf("retry added snapshot rows: %+v", rows)
	}

	// Daily sync continues on the user's pinned version: the default (no
	// opt-in) calibration job recomputes A's evolved row, while B refreshes v3.
	outA, err := run(NewCalibration(st), userA, fmt.Sprintf(`{"mode":"full","label_ids":%s}`, mustJSON(t, labelsForUser(t, st, userA))))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(outA, fmt.Sprintf(`"algorithm_version":%d`, calibration.CandidateVersion)) {
		t.Fatalf("user A daily sync must keep the pinned evolved version: %s", outA)
	}
	rows := userCalibrationSnapshots(t, st, userA)
	if countRevisions(t, rows, calibration.EvolvedCandidateAlgorithmRevision) != 1 || len(rows) != 5 || rows[len(rows)-1].AsOfDate != day {
		t.Fatalf("user A daily sync snapshot: %+v", rows)
	}
	outB, err := run(NewCalibration(st), userB, fmt.Sprintf(`{"mode":"full","label_ids":%s}`, mustJSON(t, labelsB)))
	if err != nil || !strings.Contains(outB, `"algorithm_version":3`) {
		t.Fatalf("user B daily sync must stay v3: %s %v", outB, err)
	}

	// Derived recompute under the override: the user's explicit selection
	// authorizes active-v4 derived writes for exactly this user.
	recomputeOut, err := run(handler, userA, `{"action":"recompute","days":30,"actor":"test"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(recomputeOut, `"calibration_snapshot_id":`) {
		t.Fatalf("recompute result: %s", recomputeOut)
	}
	// Historical days are not backfilled with today's thresholds: the
	// pre-publish as-of falls back to that day's v3 row with an explicit
	// override-miss reason, never to today's evolved row.
	historical, err := st.ReadEffectiveRunningCalibration(ctx, userA, today.AddDate(0, 0, -3).Format("2006-01-02"), storage.CalibrationActive)
	if err != nil || historical.Snapshot == nil || historical.Snapshot.AlgorithmVersion != 3 || historical.Snapshot.AsOfDate != today.AddDate(0, 0, -3).Format("2006-01-02") {
		t.Fatalf("historical as-of must resolve to the historical v3 row: %+v %v", historical, err)
	}
	if historical.Selection.State != "fallback" || historical.Selection.Reason != "override_snapshot_missing" {
		t.Fatalf("historical selection must explain the miss: %+v", historical.Selection)
	}
	seenToday := false
	for _, label := range labelsForUser(t, st, userA) {
		a, err := st.ActivityTrainingLoad(ctx, userA, label)
		if err != nil || a == nil {
			t.Fatalf("missing derived load for %s: %v", label, err)
		}
		prov, state := storage.ReadCalibrationProvenance(*a)
		if state != "available" {
			t.Fatalf("provenance unavailable for %s: %s", label, state)
		}
		if a.ActivityDate == day {
			seenToday = true
			if prov.Inputs[0].AlgorithmVersion != 4 || prov.Inputs[0].Selection.Override == nil {
				t.Fatalf("today's row must carry the overridden v4 lineage: %+v", prov.Inputs[0])
			}
		} else if prov.Inputs[0].AlgorithmVersion != 3 {
			t.Fatalf("historical rows must keep v3 lineage (no threshold backfill): %+v", prov.Inputs[0])
		}
	}
	if !seenToday {
		t.Fatal("no same-day derived load after recompute")
	}
	// The recompute must not touch B's derived rows.
	for _, label := range labelsB {
		if a, err := st.ActivityTrainingLoad(ctx, userB, label); err != nil || a != nil {
			t.Fatalf("user B derived rows must stay untouched by A's recompute: %+v %v", a, err)
		}
	}

	// B's compute (default options) still refuses nothing and stays v3-derived;
	// A's revoke restores the global v3 selection as an explicit, audited op.
	out, err := run(handler, userA, `{"action":"revoke","actor":"test","note":"trial ended"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"restored"`) {
		t.Fatalf("revoke result: %s", out)
	}
	bundleA3, err := st.ReadEffectiveRunningCalibration(ctx, userA, day, storage.CalibrationActive)
	if err != nil || bundleA3.Snapshot == nil || bundleA3.Snapshot.AlgorithmVersion != 3 || bundleA3.Selection.Override != nil {
		t.Fatalf("revoke must restore the global v3 selection: %+v %v", bundleA3, err)
	}

	// Recovery: revoking the policy is not a derived-data rollback — the
	// explicit recompute under the restored selection rebuilds them with v3
	// lineage.
	if _, err := run(handler, userA, `{"action":"recompute","days":30,"actor":"test"}`); err != nil {
		t.Fatal(err)
	}
	for _, label := range labelsForUser(t, st, userA) {
		a, err := st.ActivityTrainingLoad(ctx, userA, label)
		if err != nil || a == nil {
			t.Fatalf("missing recovered load: %v", err)
		}
		prov, state := storage.ReadCalibrationProvenance(*a)
		if state != "available" || prov.Inputs[0].AlgorithmVersion != 3 || prov.Inputs[0].Selection.Override != nil {
			t.Fatalf("recovered rows must carry v3 lineage: %+v %s", prov, state)
		}
	}
	// The evolved snapshot row survives the revoke (history is immutable), and
	// the recovery recompute refreshed today's v3 row.
	if rows := userCalibrationSnapshots(t, st, userA); countRevisions(t, rows, calibration.EvolvedCandidateAlgorithmRevision) != 1 || len(rows) != 5 {
		t.Fatalf("post-revoke snapshots: %+v", rows)
	}
	// Final: global policy never moved.
	policyEnd, err := st.CalibrationPolicy(ctx)
	if err != nil || !reflect.DeepEqual(policyEnd, policyBefore) {
		t.Fatalf("global policy must never change in the loop: %+v %+v", policyBefore, policyEnd)
	}
}

func labelsForUser(t *testing.T, st *storage.Store, uid string) []string {
	t.Helper()
	rows, err := st.AllRunningActivities(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	labels := make([]string, 0, len(rows))
	for _, r := range rows {
		labels = append(labels, r.LabelID)
	}
	return labels
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func countRevisions(t *testing.T, rows []storage.RunningCalibrationSnapshot, revision string) int {
	t.Helper()
	n := 0
	for _, r := range rows {
		if r.AlgorithmRevision == revision {
			n++
		}
	}
	return n
}
