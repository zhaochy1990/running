package storage

import (
	"context"
	"testing"
)

type calibrationCacheFixtureReader struct{ calls int }

func (r *calibrationCacheFixtureReader) ReadEffectiveRunningCalibration(_ context.Context, user, day string, mode CalibrationMode) (CalibrationBundle, error) {
	r.calls++
	id := uint64(r.calls)
	return CalibrationBundle{Snapshot: &RunningCalibrationSnapshot{ID: id, UserID: user, AsOfDate: day}}, nil
}
func TestCalibrationComputationCacheSeparatesAthletesDaysAndModes(t *testing.T) {
	r := &calibrationCacheFixtureReader{}
	ctx := WithCalibrationCache(context.Background())
	first, err := ReadCachedRunningCalibration(ctx, r, "athlete-a", "2026-11-01", CalibrationActive)
	if err != nil {
		t.Fatal(err)
	}
	again, _ := ReadCachedRunningCalibration(WithCalibrationCache(ctx), r, "athlete-a", "2026-11-01", CalibrationActive)
	if first.Snapshot.ID != again.Snapshot.ID || r.calls != 1 {
		t.Fatal("one computation did not preserve its same-day baseline")
	}
	for _, x := range []struct {
		user, day string
		mode      CalibrationMode
	}{{"athlete-b", "2026-11-01", CalibrationActive}, {"athlete-a", "2026-11-02", CalibrationActive}, {"athlete-a", "2026-11-01", CalibrationCandidate}} {
		b, err := ReadCachedRunningCalibration(ctx, r, x.user, x.day, x.mode)
		if err != nil {
			t.Fatal(err)
		}
		if b.Snapshot.ID == first.Snapshot.ID || b.Snapshot.UserID != x.user || b.Snapshot.AsOfDate != x.day {
			t.Fatal("cache leaked a different athlete/day/mode")
		}
	}
	fresh, _ := ReadCachedRunningCalibration(WithCalibrationCache(context.Background()), r, "athlete-a", "2026-11-01", CalibrationActive)
	if fresh.Snapshot.ID == first.Snapshot.ID {
		t.Fatal("a new computation reused a stale job-local bundle")
	}
}
