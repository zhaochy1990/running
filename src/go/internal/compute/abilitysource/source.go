// Package abilitysource is the Go equivalent of the Python ability connector
// (stride_storage/sqlite connector _fetch_recent_activities / _fetch_recent_daily_health
// / _fetch_dashboard + the vo2max_pb reader): it reads the synced watch tables and
// maps them into the infra-free ability domain types, keeping the ability math
// pure (ADR 0015). The HRMax is resolved from the persisted calibration snapshot
// (single source rule) — never recomputed here.
package abilitysource

import (
	"context"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	"github.com/zhaochy1990/stride/internal/normalize"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// Reader is the storage read surface Load needs. *storage.Store satisfies it.
type Reader interface {
	ActivitiesInWindow(ctx context.Context, userID, provider string, start, end time.Time) ([]storage.Activity, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
	ActivityLaps(ctx context.Context, userID, labelID string) ([]storage.Lap, error)
	AllDailyHealth(ctx context.Context, userID string) ([]storage.DailyHealth, error)
	DashboardSnapshot(ctx context.Context, userID string) (*storage.Dashboard, error)
	BestVo2MaxPBs(ctx context.Context, userID string) ([]storage.Vo2MaxPB, error)
	LatestRunningCalibrationSnapshot(ctx context.Context, userID string) (*storage.RunningCalibrationSnapshot, error)
}

// Load assembles a Source for one athlete on a given Shanghai day, mirroring
// Python's compute_ability_snapshot data-fetch step. lookbackDays defaults to
// ability.AbilityLookbackDays when 0.
func Load(ctx context.Context, r Reader, user string, asOf time.Time, lookbackDays int) (*ability.Source, error) {
	if lookbackDays <= 0 {
		lookbackDays = ability.AbilityLookbackDays
	}
	start := asOf.AddDate(0, 0, -lookbackDays)
	rows, err := r.ActivitiesInWindow(ctx, user, "", start, asOf)
	if err != nil {
		return nil, err
	}
	// Mirror Python _fetch_recent_activities' ORDER BY date DESC so activities[0]
	// is the most recent (drives latest_l1).
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Date.After(rows[j].Date) })
	activities := make([]ability.Activity, 0, len(rows))
	for i := range rows {
		a := rows[i]
		sport := watchmap.SportFromRow(a.Sport, a.SportType)
		if !watchmap.IsRunningSport(sport) {
			continue
		}
		samples, err := r.ActivityTimeseries(ctx, user, a.LabelID)
		if err != nil {
			return nil, err
		}
		laps, err := r.ActivityLaps(ctx, user, a.LabelID)
		if err != nil {
			return nil, err
		}
		activities = append(activities, ability.Activity{
			LabelID:    a.LabelID,
			SportType:  a.SportType,
			Date:       timefmt.ShanghaiDayStr(a.Date),
			DistanceM:  derefF(watchmap.AsActivityDistanceMeters(a.DistanceM)),
			DurationS:  derefF(a.DurationS),
			AvgPaceSKm: a.AvgPaceSKm,
			AvgHR:      a.AvgHR,
			MaxHR:      a.MaxHR,
			AvgCadence: a.AvgCadence,
			TrainKind:  resolveTrainKind(a.TrainKind, a.TrainType),
			TrainType:  a.TrainType,
			Laps:       mapLaps(laps),
			Samples:    mapSamples(samples),
		})
	}

	health, err := r.AllDailyHealth(ctx, user)
	if err != nil {
		return nil, err
	}
	health28d := windowHealth(health, asOf, 28)

	dash, err := r.DashboardSnapshot(ctx, user)
	if err != nil {
		return nil, err
	}
	var abilityDash *ability.Dashboard
	if dash != nil {
		abilityDash = &ability.Dashboard{
			AvgSleepHRV:   dash.AvgSleepHRV,
			HRVNormalLow:  dash.HRVNormalLow,
			HRVNormalHigh: dash.HRVNormalHigh,
		}
	}

	vo2maxPbs, err := r.BestVo2MaxPBs(ctx, user)
	if err != nil {
		return nil, err
	}
	pbs := make([]ability.Vo2MaxPB, 0, len(vo2maxPbs))
	for i := range vo2maxPbs {
		pbs = append(pbs, ability.Vo2MaxPB{
			RaceType:  vo2maxPbs[i].RaceType,
			DistanceM: derefF(vo2maxPbs[i].DistanceM),
			DurationS: derefF(vo2maxPbs[i].DurationS),
			Vdot:      derefF(vo2maxPbs[i].Vdot),
			PBDate:    vo2maxPbs[i].PBDate,
			LabelID:   vo2maxPbs[i].LabelID,
			EvenPaced: vo2maxPbs[i].EvenPaced,
		})
	}

	hrMax, err := resolveHRMax(ctx, r, user)
	if err != nil {
		return nil, err
	}

	return &ability.Source{
		Activities: activities,
		Health28D:  health28d,
		Dashboard:  abilityDash,
		Vo2MaxPBs:  pbs,
		HRMax:      hrMax,
	}, nil
}

func mapLaps(rows []storage.Lap) []ability.Lap {
	if len(rows) == 0 {
		return nil
	}
	out := make([]ability.Lap, 0, len(rows))
	for i := range rows {
		r := rows[i]
		out = append(out, ability.Lap{
			LapIndex:     r.LapIndex,
			LapType:      r.LapType,
			ExerciseType: r.ExerciseType,
			DistanceM:    derefF(watchmap.AsActivityDistanceMeters(r.DistanceM)),
			DurationS:    derefF(r.DurationS),
			AvgPace:      r.AvgPace,
			AvgHR:        r.AvgHR,
			MaxHR:        r.MaxHR,
			AvgCadence:   r.AvgCadence,
		})
	}
	return out
}

func mapSamples(rows []storage.TimeseriesPoint) []ability.Sample {
	if len(rows) == 0 {
		return nil
	}
	out := make([]ability.Sample, 0, len(rows))
	for i := range rows {
		out = append(out, ability.Sample{
			HeartRate: rows[i].HeartRate,
			Speed:     watchmap.AsSpeedMps(rows[i].Speed),
		})
	}
	return out
}

func windowHealth(rows []storage.DailyHealth, asOf time.Time, days int) []ability.HealthRow {
	// daily_health.date is a Shanghai civil day (YYYYMMDD or YYYY-MM-DD); compare
	// as civil-date strings to avoid a timezone shift (asOf is itself a Shanghai day).
	asOfStr := asOf.Format("2006-01-02")
	startStr := asOf.AddDate(0, 0, -days).Format("2006-01-02")
	out := make([]ability.HealthRow, 0, len(rows))
	for i := range rows {
		h := rows[i]
		d, ok := parseHealthDay(h.Date)
		if !ok {
			continue
		}
		ds := d.Format("2006-01-02")
		if ds < startStr || ds > asOfStr {
			continue
		}
		out = append(out, ability.HealthRow{
			Date:    ds,
			ATI:     h.ATI,
			CTI:     h.CTI,
			RHR:     h.RHR,
			Fatigue: h.Fatigue,
		})
	}
	return out
}

func resolveHRMax(ctx context.Context, r Reader, user string) (*int, error) {
	snap, err := r.LatestRunningCalibrationSnapshot(ctx, user)
	if err != nil {
		return nil, err
	}
	if snap == nil || snap.HRMaxEstimate == nil {
		return nil, nil
	}
	v := int(math.Round(*snap.HRMaxEstimate))
	return &v, nil
}

func resolveTrainKind(kind *string, trainType *string) normalize.TrainKind {
	if kind != nil && *kind != "" {
		return normalize.TrainKind(*kind)
	}
	if trainType != nil && *trainType != "" {
		if k, ok := normalize.KindFromLegacyTrainType(*trainType); ok {
			return k
		}
	}
	return normalize.TrainUnknown
}

func parseHealthDay(s string) (time.Time, bool) {
	clean := strings.ReplaceAll(strings.TrimSpace(s), "-", "")
	if len(clean) < 8 {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102", clean[:8])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func derefF(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
