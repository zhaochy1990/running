package calibrationsource

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
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

func TestCandidateReaderPreservesRecordedPauseWhenSamplesHideTheInterruption(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	run := "run_outdoor"
	pauseStart := day.Add(1800*time.Second).Unix() * 100
	for _, shape := range []string{"camel", "legacy"} {
		t.Run(shape, func(t *testing.T) {
			raw := fmt.Sprintf(`[{"startTimestamp":%d,"endTimestamp":%d,"duration":6000}]`, pauseStart, pauseStart+6000)
			if shape == "legacy" {
				raw = fmt.Sprintf(`[{"start_ts":%d,"end_ts":%d}]`, pauseStart, pauseStart+6000)
			}
			row := storage.Activity{LabelID: "pause-hidden-in-samples", Date: day, Sport: &run, DurationS: f(3600), DistanceM: f(14400), Pauses: &raw}
			points := []storage.TimeseriesPoint{}
			for elapsed := 0; elapsed <= 3600; elapsed += 5 {
				points = append(points, storage.TimeseriesPoint{Timestamp: i64(int64(elapsed * 100)), Distance: f(float64(elapsed) * 400), Speed: f(4)})
			}
			r := candidateReader{fakeReader: fakeReader{acts: []storage.Activity{row}, ts: map[string][]storage.TimeseriesPoint{row.LabelID: points}}}
			history, _, metadata, err := LoadCandidate(context.Background(), r, "user", "coros", day, 180)
			if err != nil {
				t.Fatal(err)
			}
			if len(metadata) != 1 || !metadata[0].Interrupted {
				t.Fatal("storage pause counterevidence discarded")
			}
			report := calibration.BuildCandidateEvidence(history, metadata, day)
			full := false
			for _, c := range report.Candidates {
				if c.Continuous || c.Selected || c.ObservedLowerBoundMps != 0 {
					t.Fatal("unlocated provider pause still became continuous Vmax evidence")
				}
				if !slices.Contains(c.CounterReasons, "activity_interruption_window_mapping_unverified") {
					t.Fatal("interruption has no explanatory counterreason")
				}
				if c.FullActivity {
					full = true
					if c.DurationS != 3600 {
						t.Fatal("whole elapsed observation lost")
					}
				}
			}
			if !full {
				t.Fatal("whole elapsed observation dropped")
			}
			serialized, _ := json.Marshal(report)
			if strings.Contains(string(serialized), "startTimestamp") || strings.Contains(string(serialized), fmt.Sprint(pauseStart)) {
				t.Fatal("raw private pause values leaked")
			}
		})
	}
}
