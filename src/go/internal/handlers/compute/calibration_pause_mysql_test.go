package compute

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

func TestSpecCandidatePersistenceRetainsPauseCounterevidence(t *testing.T) {
	ctx, st := openCalibrationReviewMySQL(t)
	uid := uuid.NewString()
	defer func() {
		if err := st.DeleteUserData(ctx, uid); err != nil {
			t.Error(err)
		}
		acts, e := st.AllRunningActivities(ctx, uid)
		if e != nil || len(acts) != 0 {
			t.Error("cleanup failed", e)
		}
	}()
	day := timefmt.ShanghaiToday()
	label := "spec-review-pause"
	dur, dist := 3600., 14400.
	run := "run_outdoor"
	pauseStart := day.Add(1800*time.Second).Unix() * 100
	pauses := fmt.Sprintf(`[{"startTimestamp":%d,"endTimestamp":%d,"duration":6000}]`, pauseStart, pauseStart+6000)
	a := storage.Activity{UserID: uid, LabelID: label, Provider: "coros", SyncedAt: time.Now().UTC(), Sport: &run, SportType: 100, Date: day.Add(8 * time.Hour), DurationS: &dur, DistanceM: &dist, Pauses: &pauses}
	var points []storage.TimeseriesPoint
	for i := 0; i <= 3600; i += 5 {
		clock := int64(i * 100)
		d := float64(i) * 400
		s := 4.
		points = append(points, storage.TimeseriesPoint{Timestamp: &clock, Distance: &d, Speed: &s})
	}
	if err := st.UpsertActivity(ctx, &a, nil, points, nil); err != nil {
		t.Fatal(err)
	}
	history, health, metadata, err := calibrationsource.LoadCandidate(ctx, st, uid, "", day, 180)
	if err != nil {
		t.Fatal(err)
	}
	if len(metadata) != 1 || !metadata[0].Interrupted {
		t.Fatalf("invalid fixture %+v", metadata)
	}
	expected, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, history, day, health, metadata)
	if err != nil {
		t.Fatal(err)
	}
	source := calibration.SummarizeSource(expected)
	if source.Speed.EvidenceCount != 0 {
		t.Fatalf("fixture failed: pause admitted %+v", source.Speed)
	}
	_, err = NewCalibrationWithOptions(st, CalibrationOptions{AllowCandidatePersistence: true})(ctx, &job.Job{UserID: uid, InputJSON: `{"selection_mode":"candidate"}`}, func(string, int) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.ReadEffectiveRunningCalibration(ctx, uid, day.Format("2006-01-02"), storage.CalibrationCandidate)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got.Source.Speed)
	t.Logf("expected_metadata_aware_count=%d persisted=%s", source.Speed.EvidenceCount, b)
	if got.Source.Speed.EvidenceCount != 0 {
		t.Errorf("candidate persistence dropped storage pause counterevidence: %d continuous contributors", got.Source.Speed.EvidenceCount)
	}
	// A separate continuous control retains actual metadata identity/as-of;
	// neither it nor a future row may erase the paused activity's counterevidence.
	a.LabelID = "spec-review-continuous"
	a.Pauses = nil
	if err := st.UpsertActivity(ctx, &a, nil, points, nil); err != nil {
		t.Fatal(err)
	}
	future := a
	future.LabelID = "spec-review-future"
	future.Date = day.AddDate(0, 0, 1).Add(8 * time.Hour)
	if err := st.UpsertActivity(ctx, &future, nil, points, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := NewCalibrationWithOptions(st, CalibrationOptions{AllowCandidatePersistence: true})(ctx, &job.Job{UserID: uid, InputJSON: `{"selection_mode":"candidate"}`}, func(string, int) error { return nil }); err != nil {
		t.Fatal(err)
	}
	control, err := st.ReadEffectiveRunningCalibration(ctx, uid, day.Format("2006-01-02"), storage.CalibrationCandidate)
	if err != nil || control.Source.Speed.EvidenceCount == 0 {
		t.Fatal("continuous control missing", err)
	}
	for _, e := range control.Source.Speed.Evidence {
		if e.ActivityID != "spec-review-continuous" || e.RootActivityID != e.ActivityID || e.SourceVersion != "storage-candidate-v1" || e.ActivityDay != day.Format("2006-01-02") {
			t.Fatalf("metadata binding/source/cutoff lost %+v", e)
		}
	}
	policy, err := st.CalibrationPolicy(ctx)
	if err != nil || policy.ActiveVersion != 3 || policy.CandidateVersion == nil || *policy.CandidateVersion != 4 || policy.FallbackVersion != 3 {
		t.Error("policy changed", policy, err)
	}
}
