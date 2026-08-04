// health_read.go adds the read surface the training-status metrics endpoints
// need (ADR 0023) for /api/{user}/health, /hrv and /pmc: windowed daily-health
// and daily-hrv rows, the dashboard HRV snapshot, the athlete rhr baseline, and
// the daily PMC series with its 7-days-prior chronic load. It mirrors the
// queries in stride_server/routes/health.py so the Go endpoints emit the same
// payloads as the FastAPI routes they shadow.
//
// Timezone: daily_health.date, daily_hrv.date and daily_training_load.date are
// Shanghai-local calendar-day strings (not UTC instants), so these reads do no
// timezone conversion — they order and window on the raw string column, exactly
// like the SQLite path.
//
// One-watch invariant: the product binds exactly one watch data source per user
// (CONTEXT.md → 手表数据源), so daily_hrv/daily_health hold at most one row per
// date. The Python HRV_PREFERRED_PER_DATE_SQL provider dedup is therefore not
// ported (ADR 0023); these reads use a plain ORDER BY date.
package storage

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// DailyHealthWindow returns the most recent `days` daily_health rows ordered
// newest-first (date DESC). Mirrors the "SELECT * FROM daily_health ORDER BY
// date DESC LIMIT ?" both /health (used as-is) and /pmc (reversed by the
// handler) issue.
func (s *Store) DailyHealthWindow(ctx context.Context, userID string, days int) ([]DailyHealth, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []DailyHealth
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", uid).
		Order("date DESC").
		Limit(limitDays(days)).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// DailyHRVWindow returns the most recent `days` daily_hrv rows ordered
// newest-first (date DESC). Both /hrv and the /health hrv trend reverse it to
// oldest-first for their chart-friendly payloads.
func (s *Store) DailyHRVWindow(ctx context.Context, userID string, days int) ([]DailyHRV, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []DailyHRV
	if err := s.db.WithContext(ctx).
		Where("user_id = ?", uid).
		Order("date DESC").
		Limit(limitDays(days)).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// LatestHRVDate returns the date of the most recent daily_hrv row with a
// non-null last_night_avg, or "" when the user has none. Mirrors the unbounded
// "SELECT date ... WHERE last_night_avg IS NOT NULL ORDER BY date DESC LIMIT 1"
// /health uses to attach an as-of date to the dashboard HRV snapshot.
func (s *Store) LatestHRVDate(ctx context.Context, userID string) (string, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return "", err
	}
	var row DailyHRV
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND last_night_avg IS NOT NULL", uid).
		Order("date DESC").
		Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return row.Date, nil
}

// DashboardSnapshot returns the user's dashboard row, or (nil, nil) when absent.
// /health reads its HRV normal-band snapshot (avg_sleep_hrv, hrv_normal_low/high,
// recovery_pct) from here.
func (s *Store) DashboardSnapshot(ctx context.Context, userID string) (*Dashboard, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row Dashboard
	err = s.db.WithContext(ctx).Where("user_id = ?", uid).Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// LatestRunningCalibrationSnapshotForVersion returns the user's most recent
// calibration snapshot of the given algorithm_version whose as_of_date is on or
// before asOf (a Shanghai YYYY-MM-DD string; "" means no upper bound), or
// (nil, nil) when none. It mirrors the Python calibration_connector.fetch_latest
// exactly: the algorithm_version filter keeps a superseded snapshot from a prior
// model bump from shadowing the current-version baseline, and the tie-break is
// as_of_date DESC, id DESC. /stride/zones and /health (rhr_baseline) read
// through this so both track the current model version.
func (s *Store) LatestRunningCalibrationSnapshotForVersion(ctx context.Context, userID string, algorithmVersion int, asOf string) (*RunningCalibrationSnapshot, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	q := s.db.WithContext(ctx).
		Where("user_id = ? AND algorithm_version = ?", uid, algorithmVersion)
	if asOf != "" {
		q = q.Where("as_of_date <= ?", asOf)
	}
	var rows []RunningCalibrationSnapshot
	if err := q.Order("as_of_date DESC, id DESC").
		Limit(1).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

// DailyLoadWithPrior is one daily_training_load row plus the chronic load
// recorded exactly 7 calendar days earlier (nil when no such row exists) — the
// input the /pmc stride block needs to compute chronic_load_ramp.
type DailyLoadWithPrior struct {
	Row          DailyTrainingLoad
	PriorChronic *float64
}

// DailyTrainingLoadWithPrior returns the most recent `days` daily_training_load
// rows ordered oldest-first, each annotated with the chronic load from 7
// calendar days prior. Mirrors Database.fetch_daily_training_load_with_prior
// (whose LEFT JOIN on date-7-days supplies chronic_load_7d_ago); here the
// prior chronic is resolved via a second keyed lookup so the join stays simple
// and the date arithmetic is explicit.
func (s *Store) DailyTrainingLoadWithPrior(ctx context.Context, userID string, days int) ([]DailyLoadWithPrior, error) {
	rows, err := s.DailyTrainingLoadSeries(ctx, userID, days)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	uid, _ := canonicalUserID(userID) // rows already validated the id above

	// Collect the distinct set of date-7-days keys, then fetch their chronic
	// loads in one query and index by date.
	priorDates := make([]string, 0, len(rows))
	seen := make(map[string]bool, len(rows))
	for _, r := range rows {
		pd := shiftDay(r.Date, -7)
		if pd == "" || seen[pd] {
			continue
		}
		seen[pd] = true
		priorDates = append(priorDates, pd)
	}

	priorChronic := make(map[string]float64, len(priorDates))
	if len(priorDates) > 0 {
		var priors []DailyTrainingLoad
		if err := s.db.WithContext(ctx).
			Select("date", "chronic_load").
			Where("user_id = ? AND date IN ?", uid, priorDates).
			Find(&priors).Error; err != nil {
			return nil, err
		}
		for _, p := range priors {
			priorChronic[p.Date] = p.ChronicLoad
		}
	}

	out := make([]DailyLoadWithPrior, len(rows))
	for i := range rows {
		out[i] = DailyLoadWithPrior{Row: rows[i]}
		if v, ok := priorChronic[shiftDay(rows[i].Date, -7)]; ok {
			vv := v
			out[i].PriorChronic = &vv
		}
	}
	return out, nil
}

// shiftDay adds `days` calendar days to a Shanghai YYYY-MM-DD string, returning
// "" for an unparseable input. Pure date math (no clock/tz) so it is DST-safe.
func shiftDay(date string, days int) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

// limitDays coerces a window size to a positive GORM LIMIT. Handlers already
// clamp `days` to the endpoint's [min,max] bounds; this is a defensive floor so
// a zero/negative never turns into GORM's "no limit".
func limitDays(days int) int {
	if days < 1 {
		return 1
	}
	return days
}
