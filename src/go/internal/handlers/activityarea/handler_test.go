package activityarea

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/activityarea"
	"github.com/zhaochy1990/stride/internal/job"
)

type fakeStore struct {
	starts       []activityarea.Coordinate
	snapshot     *activityarea.Snapshot
	startReads   int
	savedArea    *activityarea.Area
	savedAt      time.Time
	profileFound bool
}

func (f *fakeStore) UsualActivityArea(context.Context, string) (*activityarea.Snapshot, error) {
	return f.snapshot, nil
}

func (f *fakeStore) ActivityStartCoordinates(context.Context, string) ([]activityarea.Coordinate, error) {
	f.startReads++
	return f.starts, nil
}

func (f *fakeStore) SaveUsualActivityArea(_ context.Context, _ string, area *activityarea.Area, computedAt time.Time) (bool, error) {
	f.savedArea = area
	f.savedAt = computedAt
	return f.profileFound, nil
}

func TestHandlerComputesAndPersistsUsualActivityArea(t *testing.T) {
	store := &fakeStore{
		profileFound: true,
		snapshot:     &activityarea.Snapshot{},
		starts: []activityarea.Coordinate{
			{Latitude: 31.2304, Longitude: 121.4737},
			{Latitude: 31.2200, Longitude: 121.4800},
			{Latitude: 31.2400, Longitude: 121.4600},
			{Latitude: 39.9042, Longitude: 116.4074},
		},
	}
	h := New(store)
	result, err := h(context.Background(), &job.Job{
		UserID:    "f10bc353-01ab-4db1-af9f-d9305ea9a532",
		InputJSON: "{\"mode\":\"full\",\"label_ids\":[\"a1\"],\"health_dates\":[\"2026-08-12\"]}",
	}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if store.startReads != 1 || store.savedArea == nil || store.savedArea.SupportingActivityCount != 3 || store.savedAt.IsZero() {
		t.Fatalf("persisted area = %+v at %v, start reads = %d", store.savedArea, store.savedAt, store.startReads)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(result), &got); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if got["status"] != "computed" || got["supporting_activities"] != float64(3) {
		t.Fatalf("result = %s", result)
	}
	if _, ok := got["label_ids"]; !ok {
		t.Fatalf("result did not preserve downstream sync fields: %s", result)
	}
}

func TestHandlerReusesPersistedSnapshotWithoutHistoricalScan(t *testing.T) {
	store := &fakeStore{
		snapshot: &activityarea.Snapshot{Computed: true, Area: &activityarea.Area{
			Latitude: 31.23, Longitude: 121.47, SupportingActivityCount: 42,
		}},
		profileFound: true,
	}
	h := New(store)
	result, err := h(context.Background(), &job.Job{
		UserID:    "f10bc353-01ab-4db1-af9f-d9305ea9a532",
		InputJSON: "{\"mode\":\"incremental\",\"label_ids\":[\"new-activity\"]}",
	}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if store.startReads != 0 || !store.savedAt.IsZero() {
		t.Fatalf("cached job scanned or wrote: reads=%d saved_at=%v", store.startReads, store.savedAt)
	}
	want := "{\"label_ids\":[\"new-activity\"],\"mode\":\"incremental\",\"status\":\"cached\",\"supporting_activities\":42}"
	if result != want {
		t.Fatalf("result = %s", result)
	}
}

func TestHandlerPersistsUnknownSnapshotSoItIsNotRescanned(t *testing.T) {
	store := &fakeStore{
		profileFound: true,
		snapshot:     &activityarea.Snapshot{},
		starts: []activityarea.Coordinate{
			{Latitude: 31.2304, Longitude: 121.4737},
			{Latitude: 39.9042, Longitude: 116.4074},
		},
	}
	h := New(store)
	result, err := h(context.Background(), &job.Job{
		UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532",
	}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if store.startReads != 1 || store.savedArea != nil || store.savedAt.IsZero() {
		t.Fatalf("unknown snapshot = area %+v at %v, reads=%d", store.savedArea, store.savedAt, store.startReads)
	}
	if result != "{\"status\":\"unknown\",\"supporting_activities\":0}" {
		t.Fatalf("result = %s", result)
	}
}

func TestHandlerRejectsMissingProfileWithoutCreatingOne(t *testing.T) {
	store := &fakeStore{starts: []activityarea.Coordinate{
		{Latitude: 31.2304, Longitude: 121.4737},
		{Latitude: 31.2200, Longitude: 121.4800},
		{Latitude: 31.2400, Longitude: 121.4600},
	}}
	h := New(store)
	_, err := h(context.Background(), &job.Job{
		UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532",
	}, func(string, int) error { return nil })
	if _, ok := job.AsPermanent(err); err == nil || !ok {
		t.Fatalf("error = %v, want permanent missing-profile error", err)
	}
	if store.startReads != 0 {
		t.Fatalf("missing profile triggered %d historical scans, want zero", store.startReads)
	}
}
