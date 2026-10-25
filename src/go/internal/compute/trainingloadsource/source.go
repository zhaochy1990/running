// Package trainingloadsource maps synced watch rows into trainingload domain
// inputs (the Go equivalent of training_load/adapter._build_activity_input),
// reusing the shared watchmap conversions. Session classification and feedback
// (RPE) are filled by later sub-slices.
package trainingloadsource

import (
	"context"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/sessionclass"
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// Reader is the storage read surface Load needs. *storage.Store satisfies it.
type Reader interface {
	ActivitiesInWindow(ctx context.Context, userID, provider string, start, end time.Time) ([]storage.Activity, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
}

// evidenceReader is the optional surface that upgrades session classification
// with calibration zones, laps and race-detection linkage. *storage.Store
// satisfies it; readers without it get the degraded classification path.
type evidenceReader interface {
	ActivityLaps(ctx context.Context, userID, labelID string) ([]storage.Lap, error)
	LatestCalibrationPaceZones(ctx context.Context, userID string) (*storage.RunningCalibrationSnapshot, []storage.RunningCalibrationPaceZone, error)
	LinkedRaceLabels(ctx context.Context, userID string, labelIDs []string) (map[string]bool, error)
}

// evidence carries the per-window classification inputs so each activity row
// is classified against the same calibration and race context (devops #743).
type evidence struct {
	zones         *sessionclass.Zones
	thresholdHR   *float64
	hrmaxEstimate *float64
	races         map[string]bool
	laps          func(ctx context.Context, labelID string) []storage.Lap
}

func (e *evidence) lapsFor(ctx context.Context, labelID string) []storage.Lap {
	if e == nil || e.laps == nil {
		return nil
	}
	return e.laps(ctx, labelID)
}

// loadEvidence resolves classification evidence once per window. Every piece
// is best-effort: a failing lookup degrades that signal instead of failing
// the whole training-load computation.
func loadEvidence(ctx context.Context, r evidenceReader, user string, rows []storage.Activity) *evidence {
	ev := &evidence{races: map[string]bool{}}
	if r == nil {
		return ev
	}
	if snap, zones, err := r.LatestCalibrationPaceZones(ctx, user); err == nil && snap != nil {
		ev.zones = sessionclass.ZonesFromStorage(zones)
		ev.thresholdHR = snap.ThresholdHR
		if snap.ObservedMaxHR != nil {
			ev.hrmaxEstimate = snap.ObservedMaxHR
		} else {
			ev.hrmaxEstimate = snap.HRMaxEstimate
		}
	}
	labelIDs := make([]string, 0, len(rows))
	for i := range rows {
		labelIDs = append(labelIDs, rows[i].LabelID)
	}
	if linked, err := r.LinkedRaceLabels(ctx, user, labelIDs); err == nil {
		ev.races = linked
	}
	ev.laps = func(ctx context.Context, labelID string) []storage.Lap {
		laps, err := r.ActivityLaps(ctx, user, labelID)
		if err != nil {
			return nil
		}
		return laps
	}
	return ev
}

// Load reads all activities whose Shanghai day is in [start, end] (every sport;
// non-running just yields no external load) with their timeseries, mapped to
// trainingload.ActivityInput.
func Load(ctx context.Context, r Reader, user, provider string, start, end time.Time) ([]trainingload.ActivityInput, error) {
	rows, err := r.ActivitiesInWindow(ctx, user, provider, start, end)
	if err != nil {
		return nil, err
	}
	var ev *evidence
	if er, ok := r.(evidenceReader); ok {
		ev = loadEvidence(ctx, er, user, rows)
	}
	out := make([]trainingload.ActivityInput, 0, len(rows))
	for i := range rows {
		a := rows[i]
		ts, err := r.ActivityTimeseries(ctx, user, a.LabelID)
		if err != nil {
			return nil, err
		}
		distanceM := watchmap.AsActivityDistanceMeters(a.DistanceM)
		out = append(out, trainingload.ActivityInput{
			LabelID:      a.LabelID,
			ActivityDate: timefmt.ShanghaiDay(a.Date),
			Sport:        sportFromRow(a.Sport, a.SportType),
			SessionClass: SessionClassWithEvidence(ctx, ev, a),
			DurationS:    a.DurationS,
			DistanceM:    distanceM,
			AscentM:      a.AscentM,
			DescentM:     a.DescentM,
			AvgHR:        watchmap.IntToFloat(a.AvgHR),
			MaxHR:        watchmap.IntToFloat(a.MaxHR),
			AvgPower:     watchmap.IntToFloat(a.AvgPower),
			CaloriesKcal: watchmap.IntToFloat(a.CaloriesKcal),
			Samples:      mapSamples(ts, distanceM, provider),
			// RPE is filled from feedback in the daily-PMC sub-slice.
		})
	}
	return out, nil
}

func mapSamples(rows []storage.TimeseriesPoint, activityDistanceM *float64, provider string) []trainingload.Sample {
	if len(rows) == 0 {
		return nil
	}
	elapsed := watchmap.NormalizeElapsedSeconds(rows)
	scale := watchmap.DistanceScale(rows, activityDistanceM, provider)
	out := make([]trainingload.Sample, 0, len(rows))
	for i := range rows {
		r := rows[i]
		var dist *float64
		if r.Distance != nil {
			v := *r.Distance * scale
			dist = &v
		}
		out = append(out, trainingload.Sample{
			TimestampS:   elapsed[i],
			ElapsedS:     elapsed[i],
			DistanceM:    dist,
			HeartRateBpm: watchmap.IntToFloat(r.HeartRate),
			SpeedMps:     watchmap.AsSpeedMps(r.Speed),
			PowerW:       watchmap.IntToFloat(r.Power),
			AltitudeM:    r.Altitude,
		})
	}
	return out
}
