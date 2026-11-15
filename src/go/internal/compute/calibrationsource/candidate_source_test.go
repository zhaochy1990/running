package calibrationsource

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/storage"
)

type candidateReader struct {
	fakeReader
	races []storage.UserRaceRow
}

func (r candidateReader) UserRaces(_ context.Context, _ string) ([]storage.UserRaceRow, error) {
	return r.races, nil
}
func TestCandidateReaderMapsSourceWithoutPromotingNamesFeelOrLeakingNotes(t *testing.T) {
	run := "run"
	note := "PRIVATE 非全力并保留余力"
	name := "all-out hour test"
	device := "watch-2"
	at := time.Date(2026, 11, 14, 17, 0, 0, 0, time.UTC)
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	r := candidateReader{fakeReader: fakeReader{acts: []storage.Activity{{LabelID: "run", Date: at, Sport: &run, Name: &name, FeelNote: &note, Feel: f(10), Device: &device, Temperature: f(32), AscentM: f(80), DurationS: f(3600), DistanceM: f(14400)}}, ts: map[string][]storage.TimeseriesPoint{"run": {{Timestamp: i64(0), Distance: f(0), Speed: f(4)}, {Timestamp: i64(500), Distance: f(2000), Speed: f(4)}, {Timestamp: i64(360000), Distance: f(1440000), Speed: f(4)}}}}, races: []storage.UserRaceRow{{LabelID: "run", Date: at}}}
	history, _, metadata, err := LoadCandidate(context.Background(), r, "user", "coros", day, 180)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || !history[0].ActivityDate.Equal(day) || *history[0].Samples[1].DistanceM != 20 {
		t.Fatalf("date/unit conversion: %+v", history)
	}
	if len(metadata) != 1 || !metadata[0].Submaximal || !metadata[0].RaceIdentity || metadata[0].Device != "watch-2" || *metadata[0].TemperatureC != 32 {
		t.Fatalf("metadata=%+v", metadata)
	}
	if metadata[0].AvailableAt != nil || metadata[0].ProtocolVerified {
		t.Fatal("reader invented historical availability or maximal protocol")
	}
	b, _ := json.Marshal(metadata)
	if strings.Contains(string(b), "PRIVATE") || strings.Contains(string(b), name) {
		t.Fatal("raw private note/name leaked")
	}
	report := calibration.BuildCandidateEvidence(history, metadata, day)
	for _, e := range report.Candidates {
		if e.EffortSupport != calibration.EffortSubmaximal {
			t.Fatal("submaximal source lost")
		}
	}
}
