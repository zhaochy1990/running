package racedetection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	detector "github.com/zhaochy1990/stride/internal/racedetection"
	"github.com/zhaochy1990/stride/internal/storage"
)

type fakeStore struct {
	candidates []storage.RaceCandidate
	listedIDs  []string
	inserted   []storage.Race
	mu         sync.Mutex
}

func (f *fakeStore) RaceCandidates(_ context.Context, _ string, labelIDs []string) ([]storage.RaceCandidate, error) {
	if labelIDs == nil {
		f.listedIDs = nil
	} else {
		f.listedIDs = append([]string{}, labelIDs...)
	}
	return f.candidates, nil
}

func (f *fakeStore) InsertRace(_ context.Context, race *storage.Race) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inserted = append(f.inserted, *race)
	return nil
}

type classifier struct{}

func (classifier) Classify(_ context.Context, c detector.Candidate) (bool, error) {
	return c.Name == "Official Marathon", nil
}

type partialClassifier struct{}

func (partialClassifier) Classify(_ context.Context, c detector.Candidate) (bool, error) {
	if c.LabelID == "failed" {
		return false, errors.New("provider timeout")
	}
	return true, nil
}

type concurrencyClassifier struct {
	active  atomic.Int64
	peak    atomic.Int64
	release <-chan struct{}
}

func (c *concurrencyClassifier) Classify(_ context.Context, _ detector.Candidate) (bool, error) {
	active := c.active.Add(1)
	defer c.active.Add(-1)
	for {
		peak := c.peak.Load()
		if active <= peak || c.peak.CompareAndSwap(peak, active) {
			break
		}
	}
	<-c.release
	return false, nil
}

func TestHandlerContinuesAfterOneCandidateFails(t *testing.T) {
	store := &fakeStore{candidates: []storage.RaceCandidate{
		{LabelID: "confirmed-1", Sport: "run_outdoor", DistanceM: 21100},
		{LabelID: "failed", Sport: "run_outdoor", DistanceM: 42195},
		{LabelID: "confirmed-2", Sport: "run_track", DistanceM: 42195},
	}}
	h := New(store, detector.New(partialClassifier{}), 3)
	_, err := h(context.Background(), &job.Job{
		UserID:    "f10bc353-01ab-4db1-af9f-d9305ea9a532",
		InputJSON: `{"mode":"incremental","label_ids":["confirmed-1","failed","confirmed-2"]}`,
	}, func(string, int) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "failed") {
		t.Fatalf("error = %v", err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.inserted) != 2 {
		t.Fatalf("inserted = %+v", store.inserted)
	}
}

func TestIncrementalWithoutLabelsDoesNotRequestBackfill(t *testing.T) {
	store := &fakeStore{}
	h := New(store, detector.New(classifier{}), 8)
	if _, err := h(context.Background(), &job.Job{
		UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532", InputJSON: `{"mode":"incremental"}`,
	}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if store.listedIDs == nil || len(store.listedIDs) != 0 {
		t.Fatalf("label scope = %#v, want non-nil empty", store.listedIDs)
	}
}

func TestIncrementalHandlerScopesReadAndReplacementToSyncedLabels(t *testing.T) {
	store := &fakeStore{candidates: []storage.RaceCandidate{{LabelID: "new-race", Name: "Official Marathon", Sport: "run_outdoor", DistanceM: 42195}}}
	h := New(store, detector.New(classifier{}), 2)
	input, _ := json.Marshal(map[string]any{"mode": "incremental", "label_ids": []string{"new-race", "new-long-run"}, "health_dates": []string{"2026-08-12"}})

	result, err := h(context.Background(), &job.Job{UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532", InputJSON: string(input)}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(store.listedIDs) != 2 {
		t.Fatalf("listed=%v", store.listedIDs)
	}
	if len(store.inserted) != 1 || store.inserted[0].LabelID != "new-race" {
		t.Fatalf("inserted = %+v", store.inserted)
	}
	if !stringsContainAll(result, "label_ids", "health_dates") {
		t.Fatalf("result did not preserve downstream inputs: %s", result)
	}
}

func TestHandlerBoundsClassifierConcurrency(t *testing.T) {
	store := &fakeStore{}
	for i := 0; i < 6; i++ {
		store.candidates = append(store.candidates, storage.RaceCandidate{
			LabelID: fmt.Sprintf("race-%d", i), Sport: "run_outdoor", DistanceM: 21_100,
		})
	}
	release := make(chan struct{})
	classifier := &concurrencyClassifier{release: release}
	done := make(chan error, 1)
	go func() {
		h := New(store, detector.New(classifier), 2)
		_, err := h(context.Background(), &job.Job{
			UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532", InputJSON: "{\"label_ids\":[\"scope\"]}",
		}, func(string, int) error { return nil })
		done <- err
	}()
	deadline := time.After(time.Second)
	for classifier.peak.Load() < 2 {
		select {
		case <-deadline:
			t.Fatal("classifier did not reach configured concurrency")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if peak := classifier.peak.Load(); peak != 2 {
		t.Fatalf("peak concurrency = %d, want 2", peak)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("handler: %v", err)
	}
	if peak := classifier.peak.Load(); peak != 2 {
		t.Fatalf("final peak concurrency = %d, want 2", peak)
	}
}

func stringsContainAll(s string, values ...string) bool {
	for _, value := range values {
		if !strings.Contains(s, value) {
			return false
		}
	}
	return true
}
