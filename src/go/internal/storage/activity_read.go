// activity_read.go adds the read surface the activity list + detail API endpoints
// need (ADR 0019): a filtered/paginated activity page with per-visible-month
// summaries, and the per-activity detail rows (laps by type, watch zones,
// objective training load). It mirrors the Python
// stride_storage/sqlite/database.py::list_activities and
// stride_server/routes/activities.py::build_activity_detail queries so the Go
// endpoints emit the same payloads as the FastAPI routes they shadow.
//
// Timezone: activities.date holds a UTC instant; every day/month classification
// is Asia/Shanghai (UTC+8, no DST). The SQL uses `date + INTERVAL 8 HOUR` (the
// MySQL analogue of the Python SHANGHAI_DAY_SQL) and the Go-side month
// derivation adds 8h before formatting — the DSN forces the session to UTC so
// the two agree byte-for-byte.
package storage

import (
	"context"
	"errors"
	"sort"
	"time"

	"gorm.io/gorm"
)

// runningActivityPredicate is the literal running-sport predicate shared by the
// list filter (sport_category=run) and the monthly run-distance aggregate. It is
// a constant built from stride_core.models.RUN_SPORT_IDS + the normalized
// sport/sport_name value sets — no user input is interpolated, so it carries no
// injection surface. The sport_type ids are numerically sorted, matching the
// Python RUN_SPORT_SQL_LIST.
const runningActivityPredicate = `(sport_type IN (100,101,102,103,104,600,601,8001,8002,8003,8004,8005) ` +
	`OR sport IN ('run_outdoor','run_indoor','run_trail','run_track','run_treadmill') ` +
	`OR lower(coalesce(sport_name, '')) IN ('run','indoor run','trail run','track run','treadmill'))`

// strengthActivityPredicate is the literal strength-sport predicate for the list
// filter (sport_category=strength). Mirrors the Python _build_activity_list_filter
// strength branch.
const strengthActivityPredicate = `(sport_type IN (402, 800) ` +
	`OR sport = 'strength' ` +
	`OR lower(coalesce(sport_name, '')) LIKE '%strength%')`

// shanghaiMonthExpr is the MySQL analogue of the Python _activity_month_sql
// (substr(SHANGHAI_DAY_SQL, 1, 7)): the Shanghai-local YYYY-MM of a UTC instant.
const shanghaiMonthExpr = `DATE_FORMAT(date + INTERVAL 8 HOUR, '%Y-%m')`

// ActivityListParams are the activity-list filters. Date bounds are Shanghai-local
// YYYY-MM-DD strings; empty string / nil means "no bound". Mirrors the
// list_activities keyword args.
type ActivityListParams struct {
	Offset        int
	Limit         int
	Sport         string   // exact sport_name match; "" = no filter
	SportCategory string   // "run" | "strength" | "" (no category filter)
	MinDistanceKm *float64 // applied only when > 0; nil = no filter
	DateFrom      string   // Shanghai YYYY-MM-DD lower bound; "" = none
	DateTo        string   // Shanghai YYYY-MM-DD upper bound; "" = none
}

// ActivityMonthly is one Shanghai-month aggregate. TotalRunKm is the raw
// kilometres (metres/1000); the API layer rounds it to one decimal to match the
// Python round(..., 1).
type ActivityMonthly struct {
	ActivityCount int
	TotalRunKm    float64
	RunDurationS  int
	DurationS     int
}

// ActivityPage is one filtered activity page plus the full-month summaries for
// the months visible on that page.
type ActivityPage struct {
	Total            int64
	Rows             []Activity
	MonthlySummaries map[string]ActivityMonthly
}

// ListActivities returns a filtered, paginated activity page (newest first) plus
// the run-distance/duration/count summary for every Shanghai month appearing on
// the page. Mirrors Database.list_activities: the same scope filter is applied
// independently to the count, the row page, and the monthly aggregate.
func (s *Store) ListActivities(ctx context.Context, userID string, p ActivityListParams) (*ActivityPage, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}

	var total int64
	if err := activityListScope(s.db.WithContext(ctx), uid, p).
		Model(&Activity{}).Count(&total).Error; err != nil {
		return nil, err
	}

	var rows []Activity
	if err := activityListScope(s.db.WithContext(ctx), uid, p).
		Order("date DESC, label_id DESC").
		Limit(p.Limit).Offset(p.Offset).
		Find(&rows).Error; err != nil {
		return nil, err
	}

	summaries, err := s.activityMonthlySummaries(ctx, uid, p, rows)
	if err != nil {
		return nil, err
	}

	return &ActivityPage{Total: total, Rows: rows, MonthlySummaries: summaries}, nil
}

// activityListScope applies the tenant key plus the optional sport / category /
// min-distance / date-window filters to a fresh query builder, mirroring
// _build_activity_list_filter. The MySQL store adds the user_id predicate the
// per-user SQLite path does not need.
func activityListScope(db *gorm.DB, uid string, p ActivityListParams) *gorm.DB {
	q := db.Where("user_id = ?", uid)
	if p.Sport != "" {
		q = q.Where("sport_name = ?", p.Sport)
	}
	switch p.SportCategory {
	case "run":
		q = q.Where(runningActivityPredicate)
	case "strength":
		q = q.Where(strengthActivityPredicate)
	}
	if p.MinDistanceKm != nil && *p.MinDistanceKm > 0 {
		q = q.Where("coalesce(distance_m, 0) >= ?", *p.MinDistanceKm*1000.0)
	}
	if p.DateFrom != "" {
		q = q.Where("DATE(date + INTERVAL 8 HOUR) >= ?", p.DateFrom)
	}
	if p.DateTo != "" {
		q = q.Where("DATE(date + INTERVAL 8 HOUR) <= ?", p.DateTo)
	}
	return q
}

// activityMonthlySummaries computes the count / run-km / duration aggregate for
// every Shanghai month present on the page, applying the same scope filter as
// the list (so e.g. a category filter narrows the summary too). Mirrors
// _activity_monthly_summaries_for_visible_months.
func (s *Store) activityMonthlySummaries(ctx context.Context, uid string, p ActivityListParams, rows []Activity) (map[string]ActivityMonthly, error) {
	months := visibleMonths(rows)
	if len(months) == 0 {
		return map[string]ActivityMonthly{}, nil
	}

	type monthAgg struct {
		Month         string  `gorm:"column:month"`
		ActivityCount int     `gorm:"column:activity_count"`
		TotalRunKm    float64 `gorm:"column:total_run_km"`
		RunDurationS  float64 `gorm:"column:run_duration_s"`
		DurationS     float64 `gorm:"column:duration_s"`
	}
	selectExpr := shanghaiMonthExpr + " AS month, " +
		"count(*) AS activity_count, " +
		"coalesce(sum(CASE WHEN " + runningActivityPredicate + " THEN coalesce(distance_m, 0) ELSE 0 END), 0) / 1000.0 AS total_run_km, " +
		"coalesce(sum(CASE WHEN " + runningActivityPredicate + " THEN coalesce(duration_s, 0) ELSE 0 END), 0) AS run_duration_s, " +
		"coalesce(sum(coalesce(duration_s, 0)), 0) AS duration_s"

	var aggs []monthAgg
	if err := activityListScope(s.db.WithContext(ctx), uid, p).
		Model(&Activity{}).
		Select(selectExpr).
		Where(shanghaiMonthExpr+" IN ?", months).
		Group(shanghaiMonthExpr).
		Scan(&aggs).Error; err != nil {
		return nil, err
	}

	out := make(map[string]ActivityMonthly, len(aggs))
	for _, a := range aggs {
		out[a.Month] = ActivityMonthly{
			ActivityCount: a.ActivityCount,
			TotalRunKm:    a.TotalRunKm,
			RunDurationS:  int(a.RunDurationS),
			DurationS:     int(a.DurationS), // int() truncation, matching Python
		}
	}
	return out, nil
}

// visibleMonths returns the sorted, de-duplicated set of Shanghai months
// (YYYY-MM) appearing on the page — the same set the Python serializer derives
// from each row's shanghai_month column.
func visibleMonths(rows []Activity) []string {
	seen := make(map[string]bool, len(rows))
	months := make([]string, 0, len(rows))
	for _, r := range rows {
		m := shanghaiMonth(r.Date)
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		months = append(months, m)
	}
	sort.Strings(months)
	return months
}

// shanghaiMonth renders a UTC instant's Shanghai-local YYYY-MM. The DSN forces
// the connection to UTC, so t carries a UTC instant; adding the fixed +8h offset
// before formatting yields the same civil month as the SQL
// DATE_FORMAT(date + INTERVAL 8 HOUR, '%Y-%m').
func shanghaiMonth(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Add(8 * time.Hour).Format("2006-01")
}

// ActivityByID returns one activity by (user_id, label_id), or (nil, nil) when
// absent. Mirrors build_activity_detail's "SELECT * FROM activities WHERE
// label_id = ?" returning None on no row.
func (s *Store) ActivityByID(ctx context.Context, userID, labelID string) (*Activity, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var a Activity
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Take(&a).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// ActivityLapsByType returns an activity's laps of a given lap_type ('autoKm'
// distance splits or 'type2' strength segments) ordered by lap_index. Mirrors
// the two lap_type-filtered lap queries in build_activity_detail.
func (s *Store) ActivityLapsByType(ctx context.Context, userID, labelID, lapType string) ([]Lap, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []Lap
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ? AND lap_type = ?", uid, labelID, lapType).
		Order("lap_index").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ActivityWatchZones returns an activity's watch-reported zone buckets ordered
// by (zone_type, zone_index). The Python detail endpoint reads a calibrated
// `zones` table that the Go store does not hold; it projects the watch-reported
// zones instead (ADR 0019 records this semantic gap).
func (s *Store) ActivityWatchZones(ctx context.Context, userID, labelID string) ([]ActivityWatchZone, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []ActivityWatchZone
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Order("zone_type, zone_index").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ActivityZones returns one activity's STRIDE-calibrated zone rows (the compute
// job's output, ADR 0019). The detail API serves watch zones when present and
// falls back to these for providers like Garmin that report no watch zones.
func (s *Store) ActivityZones(ctx context.Context, userID, labelID string) ([]ActivityZone, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []ActivityZone
	if err := s.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Order("zone_type, zone_index").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ActivityTrainingLoad returns one activity's objective training-load row, or
// (nil, nil) when absent. Mirrors db.fetch_activity_training_load(label_id).
func (s *Store) ActivityTrainingLoad(ctx context.Context, userID, labelID string) (*ActivityTrainingLoad, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var row ActivityTrainingLoad
	err = s.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Take(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}
