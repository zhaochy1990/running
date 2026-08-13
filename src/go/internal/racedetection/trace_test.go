package racedetection

import (
	"context"
	"math"
	"testing"
)

func TestDetectorKeepsFullTraceInGoAndOmitsItFromModelInput(t *testing.T) {
	const rawCount = 4_000
	trace := make([]TracePoint, rawCount)
	for i := range trace {
		progress := float64(i) / float64(rawCount-1)
		altitude := 20.0 + 5*math.Sin(progress*12*math.Pi)
		trace[i] = TracePoint{
			Timestamp: int64TracePointer(int64(i)),
			Latitude:  float64TracePointer(31.0 + progress*0.2),
			Longitude: float64TracePointer(121.0 + progress*0.2),
			AltitudeM: float64TracePointer(altitude),
		}
	}
	*trace[1_111].AltitudeM = -35
	*trace[2_777].AltitudeM = 180

	classifier := &fakeClassifier{assessments: map[string]ModelAssessment{"race": {EventIntent: EvidenceRace, IntensityContinuity: EvidenceRace}}}
	detector := New(classifier)
	got, err := detector.Detect(context.Background(), Candidate{
		LabelID: "race", Sport: "run_outdoor", DistanceM: 21_100, Trace: trace,
	})
	if err != nil || !got {
		t.Fatalf("Detect() = (%t, %v), want (true, nil)", got, err)
	}
	seen := classifier.seen[0]
	if len(seen.Trace) != 0 {
		t.Fatalf("model received %d raw trace points, want none", len(seen.Trace))
	}
}

func TestDetectorAnalyzesRepeatedLapsWithoutSendingThemToModel(t *testing.T) {
	const (
		laps           = 40
		pointsPerLap   = 80
		trackRadiusDeg = 0.001
	)
	trace := make([]TracePoint, 0, laps*pointsPerLap+1)
	for i := 0; i <= laps*pointsPerLap; i++ {
		angle := 2 * math.Pi * float64(i%pointsPerLap) / pointsPerLap
		trace = append(trace, TracePoint{
			Timestamp: int64TracePointer(int64(i)),
			Latitude:  float64TracePointer(31.2 + trackRadiusDeg*math.Sin(angle)),
			Longitude: float64TracePointer(121.4 + trackRadiusDeg*math.Cos(angle)),
			AltitudeM: float64TracePointer(12),
		})
	}

	classifier := &fakeClassifier{assessments: map[string]ModelAssessment{"laps": {EventIntent: EvidenceUnknown, IntensityContinuity: EvidenceUnknown}}}
	detector := New(classifier)
	_, err := detector.Detect(context.Background(), Candidate{
		LabelID: "laps", Sport: "run_track", DistanceM: 21_100, Trace: trace,
	})
	if err != nil {
		t.Fatalf("Detect(): %v", err)
	}
	if len(classifier.seen[0].Trace) != 0 {
		t.Fatal("model input must omit the complete trace")
	}
}

func TestDetectorAnalyzesOutAndBackWithoutSendingItToModel(t *testing.T) {
	trace := make([]TracePoint, 0, 1_001)
	for i := 0; i <= 1_000; i++ {
		position := i
		if i > 500 {
			position = 1_000 - i
		}
		trace = append(trace, TracePoint{
			Timestamp: int64TracePointer(int64(i)),
			Latitude:  float64TracePointer(31.2),
			Longitude: float64TracePointer(121.4 + float64(position)*0.0001),
			AltitudeM: float64TracePointer(10 + float64(position)/100),
		})
	}

	classifier := &fakeClassifier{assessments: map[string]ModelAssessment{"out-back": {EventIntent: EvidenceUnknown, IntensityContinuity: EvidenceUnknown}}}
	detector := New(classifier)
	_, err := detector.Detect(context.Background(), Candidate{
		LabelID: "out-back", Sport: "run_outdoor", DistanceM: 21_100, Trace: trace,
	})
	if err != nil {
		t.Fatalf("Detect(): %v", err)
	}
	if len(classifier.seen[0].Trace) != 0 {
		t.Fatal("model input must omit the complete trace")
	}
}

func int64TracePointer(value int64) *int64       { return &value }
func float64TracePointer(value float64) *float64 { return &value }
