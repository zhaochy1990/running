package api

import (
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

func TestDeriveKilometerSplits_InterpolatesBoundariesAndExcludesPauses(t *testing.T) {
	pauses := `[{"startTimestamp":4000,"endTimestamp":4500},{"start_ts":4400,"end_ts":4600}]`
	activity := &storage.Activity{DistanceM: fptr(2250), Pauses: &pauses}
	var points []storage.TimeseriesPoint
	for i := range 26 {
		timestamp := int64(i * 2000)
		points = append(points, storage.TimeseriesPoint{
			Timestamp: &timestamp, Distance: fptr(float64(i * 90)),
			HeartRate: iptr(150), Cadence: iptr(175),
		})
	}
	splits := deriveKilometerSplits(activity, points)
	if len(splits) != 3 {
		t.Fatalf("got %d splits, want 3", len(splits))
	}
	if first := splits[0]; *first.DistanceM != 1000 ||
		math.Abs(*first.DurationS-(2000.0/9-6)) > 0.01 ||
		*first.AvgHR != 150 || *first.AvgCadence != 175 || first.LapType != "timeseriesKm" {
		t.Fatalf("unexpected first split: %+v", first)
	}
	if tail := splits[2]; *tail.DistanceM != 250 || math.Abs(*tail.AvgPace-2000.0/9) > 0.01 {
		t.Fatalf("unexpected final split: %+v", tail)
	}
	if got := deriveKilometerSplits(activity, points[:18]); len(got) != 0 {
		t.Fatalf("truncated source returned %d splits", len(got))
	}
}
