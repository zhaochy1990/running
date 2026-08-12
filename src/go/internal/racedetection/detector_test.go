package racedetection

import (
	"context"
	"testing"
)

type fakeClassifier struct {
	decisions map[string]bool
	seen      []Candidate
}

func (f *fakeClassifier) Classify(_ context.Context, candidate Candidate) (bool, error) {
	f.seen = append(f.seen, candidate)
	return f.decisions[candidate.LabelID], nil
}

func TestCandidateTypeUsesOnlyHalfAndFullMarathonBands(t *testing.T) {
	tests := []struct {
		sport     string
		distanceM float64
		want      RaceType
		ok        bool
	}{
		{"run_outdoor", 20899, "", false},
		{"run_outdoor", 20900, RaceTypeHalfMarathon, true},
		{"run_track", 22000, RaceTypeHalfMarathon, true},
		{"run_outdoor", 22001, "", false},
		{"run_outdoor", 30000, "", false},
		{"run_outdoor", 41899, "", false},
		{"run_track", 41900, RaceTypeMarathon, true},
		{"run_outdoor", 44000, RaceTypeMarathon, true},
		{"run_outdoor", 44001, "", false},
		{"run_indoor", 21100, "", false},
		{"run_trail", 42195, "", false},
		{"run_treadmill", 42195, "", false},
	}

	for _, tt := range tests {
		got, ok := CandidateType(tt.sport, tt.distanceM)
		if got != tt.want || ok != tt.ok {
			t.Errorf("CandidateType(%q, %v) = (%q, %v), want (%q, %v)", tt.sport, tt.distanceM, got, ok, tt.want, tt.ok)
		}
	}
}

func TestDetectorClassifiesOnlyDistanceAndSportCandidates(t *testing.T) {
	classifier := &fakeClassifier{decisions: map[string]bool{
		"hm-race": true,
	}}
	detector := New(classifier)
	got, err := detector.Detect(context.Background(), Candidate{
		LabelID: "hm-race", Sport: "run_outdoor", DistanceM: 21100,
	})
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if !got {
		t.Fatal("candidate should be confirmed")
	}
	if len(classifier.seen) != 1 || classifier.seen[0].CandidateType != RaceTypeHalfMarathon {
		t.Fatalf("classifier saw %+v", classifier.seen)
	}
}

func TestDetectorDoesNotClassifyRejectedCandidate(t *testing.T) {
	classifier := &fakeClassifier{decisions: map[string]bool{"long-run": true}}
	detector := New(classifier)
	got, err := detector.Detect(context.Background(), Candidate{
		LabelID: "long-run", Sport: "run_outdoor", DistanceM: 30_000,
	})
	if err != nil || got {
		t.Fatalf("Detect rejected candidate = (%v, %v), want (false, nil)", got, err)
	}
	if len(classifier.seen) != 0 {
		t.Fatalf("classifier called for rejected candidate: %+v", classifier.seen)
	}
}
