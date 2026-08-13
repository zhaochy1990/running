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

	"github.com/zhaochy1990/stride/internal/activityarea"
	"github.com/zhaochy1990/stride/internal/job"
	detector "github.com/zhaochy1990/stride/internal/racedetection"
	"github.com/zhaochy1990/stride/internal/storage"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
)

type fakeStore struct {
	candidates     []storage.RaceCandidate
	timeseries     map[string][]storage.TimeseriesPoint
	readErr        map[string]error
	usualArea      *activityarea.Snapshot
	areaReads      int
	insertedResult bool
	listedIDs      []string
	inserted       []storage.Race
	mu             sync.Mutex
}

func (f *fakeStore) UsualActivityArea(_ context.Context, _ string) (*activityarea.Snapshot, error) {
	f.areaReads++
	return f.usualArea, nil
}

func (f *fakeStore) ActivityTimeseries(_ context.Context, _, labelID string) ([]storage.TimeseriesPoint, error) {
	if err := f.readErr[labelID]; err != nil {
		return nil, err
	}
	return f.timeseries[labelID], nil
}

func (f *fakeStore) RaceCandidates(_ context.Context, _ string, labelIDs []string) ([]storage.RaceCandidate, error) {
	if labelIDs == nil {
		f.listedIDs = nil
	} else {
		f.listedIDs = append([]string{}, labelIDs...)
	}
	return f.candidates, nil
}

func (f *fakeStore) InsertRace(_ context.Context, race *storage.Race) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inserted = append(f.inserted, *race)
	if !f.insertedResult {
		return false, nil
	}
	return true, nil
}

type classifier struct{}

func (classifier) Assess(_ context.Context, c detector.Candidate) (detector.ModelAssessment, error) {
	if c.Name == "Official Marathon" {
		return detector.ModelAssessment{EventIntent: detector.EvidenceRace, IntensityContinuity: detector.EvidenceRace}, nil
	}
	return detector.ModelAssessment{EventIntent: detector.EvidenceUnknown, IntensityContinuity: detector.EvidenceUnknown}, nil
}

type partialClassifier struct{}

func (partialClassifier) Assess(_ context.Context, c detector.Candidate) (detector.ModelAssessment, error) {
	if c.LabelID == "failed" {
		return detector.ModelAssessment{}, errors.New("provider timeout")
	}
	return detector.ModelAssessment{EventIntent: detector.EvidenceRace, IntensityContinuity: detector.EvidenceRace}, nil
}

type traceClassifier struct {
	seen chan detector.Candidate
}

func (c *traceClassifier) Assess(_ context.Context, candidate detector.Candidate) (detector.ModelAssessment, error) {
	c.seen <- candidate
	return detector.ModelAssessment{EventIntent: detector.EvidenceUnknown, IntensityContinuity: detector.EvidenceUnknown}, nil
}

type concurrencyClassifier struct {
	active  atomic.Int64
	peak    atomic.Int64
	release <-chan struct{}
}

func (c *concurrencyClassifier) Assess(_ context.Context, _ detector.Candidate) (detector.ModelAssessment, error) {
	active := c.active.Add(1)
	defer c.active.Add(-1)
	for {
		peak := c.peak.Load()
		if active <= peak || c.peak.CompareAndSwap(peak, active) {
			break
		}
	}
	<-c.release
	return detector.ModelAssessment{EventIntent: detector.EvidenceUnknown, IntensityContinuity: detector.EvidenceUnknown}, nil
}

func TestHandlerContinuesAfterOneCandidateFails(t *testing.T) {
	store := &fakeStore{candidates: []storage.RaceCandidate{
		{LabelID: "confirmed-1", Sport: "run_outdoor", DistanceM: 21100},
		{LabelID: "failed", Sport: "run_outdoor", DistanceM: 42195},
		{LabelID: "confirmed-2", Sport: "run_track", DistanceM: 42195},
	}, insertedResult: true}
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

func TestTokenUsageLogContainsExactPerActivityCounts(t *testing.T) {
	core, observed := observer.New(zap.InfoLevel)
	logTokenUsage(zap.New(core), "user-1", "activity-1", detector.TokenUsage{
		APIKind: "responses", Model: "gpt-5.6-luna", Available: true,
		InputTokens: 1234, OutputTokens: 17, TotalTokens: 1251,
	})
	entries := observed.FilterMessage("race detection token usage").All()
	if len(entries) != 1 {
		t.Fatalf("token usage log entries = %d, want 1", len(entries))
	}
	fields := entries[0].ContextMap()
	for key, want := range map[string]any{
		"user_id": "user-1", "label_id": "activity-1",
		"api_kind": "responses", "model": "gpt-5.6-luna",
		"usage_available": true, "input_tokens": int64(1234),
		"output_tokens": int64(17), "total_tokens": int64(1251),
	} {
		if got := fields[key]; got != want {
			t.Errorf("log field %s = %#v, want %#v", key, got, want)
		}
	}
}

func TestClassificationLogContainsScoreAndCoordinateFreeRouteMetrics(t *testing.T) {
	core, observed := observer.New(zap.InfoLevel)
	logClassification(zap.New(core), "user-1", "activity-1", detector.ClassificationResult{
		ScoreResult: detector.ScoreResult{IsRace: true, Score: 45, Threshold: 35, Dimensions: []detector.ScoreContribution{{
			Dimension: detector.DimensionRouteShape, Evidence: detector.EvidenceRace, RaceWeight: 15, TrainingWeight: 15, Contribution: 15, Source: detector.EvidenceSourceGo,
		}}},
		Assessment: detector.ModelAssessment{EventIntent: detector.EvidenceUnknown, IntensityContinuity: detector.EvidenceRace},
		Route: detector.RouteAnalysis{
			Shape: detector.RouteShapeLargeLoopOrPointToPoint, ValidPoints: 12_345, PathLengthM: 21_234,
			BoundingWidthM: 4_000, BoundingHeightM: 3_000, StartEndDistanceM: 1_200, PathToPerimeter: 1.52,
		},
	})
	entries := observed.FilterMessage("race detection classification").All()
	if len(entries) != 1 {
		t.Fatalf("classification log entries = %d, want 1", len(entries))
	}
	fields := entries[0].ContextMap()
	for key, want := range map[string]any{
		"user_id": "user-1", "label_id": "activity-1", "is_race": true,
		"score": int64(45), "threshold": int64(35), "route_shape": "large_loop_or_point_to_point",
		"route_valid_points": int64(12_345), "route_path_length_m": float64(21_234),
	} {
		if got := fields[key]; got != want {
			t.Errorf("log field %s = %#v, want %#v", key, got, want)
		}
	}
	for _, forbidden := range []string{"latitude", "longitude", "trace"} {
		if _, exists := fields[forbidden]; exists {
			t.Errorf("classification log includes forbidden field %q", forbidden)
		}
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
	store := &fakeStore{candidates: []storage.RaceCandidate{{LabelID: "new-race", Name: "Official Marathon", Sport: "run_outdoor", DistanceM: 42195}}, insertedResult: true}
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

func TestCandidateUsesShanghaiLocalStartAndWeekday(t *testing.T) {
	row := storage.RaceCandidate{
		LabelID: "morning-race", Sport: "run_outdoor", DistanceM: 21_100,
		Date: time.Date(2024, time.March, 9, 23, 30, 0, 0, time.UTC),
	}
	candidate := toCandidate(row, nil)
	if candidate.Date != "2024-03-10 07:30:00" || candidate.Weekday != "Sunday" {
		t.Fatalf("local calendar context = date %q weekday %q", candidate.Date, candidate.Weekday)
	}
}

func TestCandidateIncludesRecordedPauseTiming(t *testing.T) {
	pauseStart := time.Date(2024, time.March, 9, 23, 45, 0, 0, time.UTC).Unix() * 100
	rawPauses := fmt.Sprintf(`[{"startTimestamp":%d,"endTimestamp":%d,"duration":1234}]`, pauseStart, pauseStart+1234)
	candidate := toCandidate(storage.RaceCandidate{
		LabelID: "paused-run", Sport: "run_outdoor", DistanceM: 21_100,
		Date: time.Date(2024, time.March, 9, 23, 30, 0, 0, time.UTC), Pauses: &rawPauses,
	}, nil)
	if candidate.Pauses == nil || candidate.Pauses.Count != 1 || candidate.Pauses.TotalDurationS != 12.34 {
		t.Fatalf("pause summary = %+v", candidate.Pauses)
	}
	if len(candidate.Pauses.Intervals) != 1 || candidate.Pauses.Intervals[0].StartLocal != "2024-03-10 07:45:00" || candidate.Pauses.Intervals[0].EndLocal != "2024-03-10 07:45:12" {
		t.Fatalf("pause intervals = %+v", candidate.Pauses.Intervals)
	}
}

func TestHandlerKeepsTraceOutOfModelClassifierWhileBuildingLocationContext(t *testing.T) {
	points := []storage.TimeseriesPoint{
		{Timestamp: int64Pointer(100), GPSLat: float64Pointer(31.2304), GPSLon: float64Pointer(121.4737), Altitude: float64Pointer(8.5)},
		{Timestamp: int64Pointer(200), GPSLat: float64Pointer(31.2310), GPSLon: float64Pointer(121.4742), Altitude: float64Pointer(9.0)},
	}
	store := &fakeStore{
		candidates: []storage.RaceCandidate{{LabelID: "trace-race", Sport: "run_outdoor", DistanceM: 21_100}},
		timeseries: map[string][]storage.TimeseriesPoint{"trace-race": points},
		usualArea:  &activityarea.Snapshot{Computed: true, Area: &activityarea.Area{Latitude: 31.23, Longitude: 121.47, SupportingActivityCount: 3}},
	}
	classifier := &traceClassifier{seen: make(chan detector.Candidate, 1)}
	h := New(store, detector.New(classifier), 1)
	if _, err := h(context.Background(), &job.Job{
		UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532", InputJSON: "{\"label_ids\":[\"trace-race\"]}",
	}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("handler: %v", err)
	}
	seen := <-classifier.seen
	if len(seen.Trace) != 0 {
		t.Fatalf("classifier received %d trace points, want none", len(seen.Trace))
	}
	if seen.Location == nil || seen.Location.SupportingActivityCount != 3 || seen.Location.CandidateStartDistanceKM == nil {
		t.Fatalf("classifier usual activity area = %+v", seen.Location)
	}
	if store.areaReads != 1 {
		t.Fatalf("usual activity area reads = %d, want one profile read", store.areaReads)
	}
}

func TestHandlerTreatsMissingPersistedAreaAsUnknownWithoutHistoricalFallback(t *testing.T) {
	store := &fakeStore{
		candidates: []storage.RaceCandidate{{LabelID: "race", Sport: "run_outdoor", DistanceM: 21_100}},
		timeseries: map[string][]storage.TimeseriesPoint{"race": {{
			GPSLat: float64Pointer(39.9042), GPSLon: float64Pointer(116.4074),
		}}},
	}
	classifier := &traceClassifier{seen: make(chan detector.Candidate, 1)}
	h := New(store, detector.New(classifier), 1)
	if _, err := h(context.Background(), &job.Job{
		UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532", InputJSON: "{\"label_ids\":[\"race\"]}",
	}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("handler: %v", err)
	}
	seen := <-classifier.seen
	if seen.Location != nil || store.areaReads != 1 {
		t.Fatalf("location = %+v, profile reads = %d; want unknown from one profile read", seen.Location, store.areaReads)
	}
}

func int64Pointer(v int64) *int64       { return &v }
func float64Pointer(v float64) *float64 { return &v }

func TestHandlerResultCountsOnlyCurrentConfirmations(t *testing.T) {
	store := &fakeStore{
		insertedResult: true,
		candidates: []storage.RaceCandidate{
			{LabelID: "race", Name: "Official Marathon", Sport: "run_outdoor", DistanceM: 42_195},
			{LabelID: "training", Name: "Long run", Sport: "run_outdoor", DistanceM: 21_100},
		},
	}
	h := NewBackfill(store, detector.New(classifier{}), 2)
	result, err := h(context.Background(), &job.Job{
		UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532",
	}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(result), &got); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if got["candidates"] != float64(2) || got["confirmed"] != float64(1) {
		t.Fatalf("result = %s", result)
	}
	if _, ok := got["previousConfirmed"]; ok {
		t.Fatalf("result must not include redundant previousConfirmed: %s", result)
	}
}

func TestHandlerDoesNotCountIdempotentRaceInsertAsCurrentConfirmation(t *testing.T) {
	store := &fakeStore{
		candidates: []storage.RaceCandidate{{
			LabelID: "concurrently-confirmed", Name: "Official Marathon", Sport: "run_outdoor", DistanceM: 42_195,
		}},
	}
	h := NewBackfill(store, detector.New(classifier{}), 1)
	result, err := h(context.Background(), &job.Job{
		UserID: "f10bc353-01ab-4db1-af9f-d9305ea9a532",
	}, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if !strings.Contains(result, `"confirmed":0`) {
		t.Fatalf("result = %s", result)
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
