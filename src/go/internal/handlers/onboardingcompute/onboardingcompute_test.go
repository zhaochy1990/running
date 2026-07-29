package onboardingcompute

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

const testUser = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

// fakeStore satisfies Store with in-memory data and records what was persisted.
type fakeStore struct {
	acts   []storage.Activity
	health []storage.DailyHealth

	snap  *storage.RunningCalibrationSnapshot
	zones []storage.RunningCalibrationZone
	pbs   []storage.PersonalBest
}

func (f *fakeStore) ActivitiesInWindow(context.Context, string, string, time.Time, time.Time) ([]storage.Activity, error) {
	return f.acts, nil
}
func (f *fakeStore) ActivityTimeseries(context.Context, string, string) ([]storage.TimeseriesPoint, error) {
	return nil, nil
}
func (f *fakeStore) ActivityLaps(context.Context, string, string) ([]storage.Lap, error) {
	return nil, nil
}
func (f *fakeStore) DailyHealthWithRHR(context.Context, string) ([]storage.DailyHealth, error) {
	return f.health, nil
}
func (f *fakeStore) UpsertRunningCalibrationSnapshot(_ context.Context, snap *storage.RunningCalibrationSnapshot) (uint64, error) {
	f.snap = snap
	return 7, nil
}
func (f *fakeStore) ReplaceCalibrationZones(_ context.Context, _ string, snapshotID uint64, zones []storage.RunningCalibrationZone) error {
	f.zones = zones
	return nil
}
func (f *fakeStore) AllRunningActivities(context.Context, string) ([]storage.Activity, error) {
	return f.acts, nil
}
func (f *fakeStore) ReplacePersonalBests(_ context.Context, _ string, pbs []storage.PersonalBest) error {
	f.pbs = pbs
	return nil
}

func TestHandlerStagesAndResult(t *testing.T) {
	run := "run"
	store := &fakeStore{
		acts: []storage.Activity{
			{LabelID: "r1", Date: time.Now().UTC().AddDate(0, 0, -5), Sport: &run, MaxHR: iptr(180)},
		},
		health: []storage.DailyHealth{{Date: "20260728", RHR: iptr(48)}},
	}
	h := New(store)

	var stages []string
	hb := func(stage string, _ int) error { stages = append(stages, stage); return nil }

	res, err := h(context.Background(), &job.Job{PartitionKey: testUser}, hb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var out result
	if e := json.Unmarshal([]byte(res), &out); e != nil {
		t.Fatalf("result is not JSON: %v (%q)", e, res)
	}
	if out.User != testUser || out.CalibrationSnapshot != 7 {
		t.Fatalf("result = %+v, want user=%s snapshot=7", out, testUser)
	}
	if store.snap == nil || store.snap.AlgorithmVersion != 3 {
		t.Fatalf("snapshot not persisted correctly: %+v", store.snap)
	}

	want := []string{"calibration", "training_load", "ability"}
	if len(stages) != len(want) {
		t.Fatalf("stages = %v, want %v", stages, want)
	}
	for i := range want {
		if stages[i] != want[i] {
			t.Fatalf("stage %d = %q, want %q", i, stages[i], want[i])
		}
	}
}

func TestHandlerRejectsNonUUIDPartition(t *testing.T) {
	h := New(&fakeStore{})
	_, err := h(context.Background(), &job.Job{PartitionKey: "not-a-uuid"},
		func(string, int) error { return nil })

	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want a permanent error, got %v", err)
	}
	if pe.Code != "bad_partition" {
		t.Fatalf("error code = %q, want bad_partition", pe.Code)
	}
}

func iptr(v int) *int { return &v }
