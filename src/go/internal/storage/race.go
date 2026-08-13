package storage

import (
	"context"
	"time"

	"github.com/zhaochy1990/stride/internal/activityarea"
	"github.com/zhaochy1990/stride/internal/normalize"
	"github.com/zhaochy1990/stride/internal/racedetection"
	"gorm.io/gorm/clause"
)

// Race is a confirmed race effort. It deliberately stores only an activity
// reference; name, distance, duration and metrics remain canonical in activities.
type Race struct {
	UserID    string    `gorm:"column:user_id;type:char(36);primaryKey"`
	LabelID   string    `gorm:"column:label_id;type:varchar(191);primaryKey"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime(6);not null;autoCreateTime:false"`
}

func (Race) TableName() string { return "races" }

// RaceCandidate is the bounded activity-row projection used by the independent
// race detection module. GPS/timeseries are loaded separately only after this
// deterministic query admits the activity.
type RaceCandidate struct {
	LabelID    string
	Name       string
	Sport      string
	Date       time.Time
	DistanceM  float64
	DurationS  *float64
	AvgPaceSKm *float64
	AvgHR      *int
	MaxHR      *int
	AscentM    *float64
	TrainKind  string
	SportNote  string
	Pauses     *string
}

// RaceCandidates returns unconfirmed outdoor/track HM/FM distance candidates.
// A non-empty labelIDs slice restricts incremental detection to the current
// sync. A non-nil empty slice returns no rows; nil scans all history and is
// reserved for the one-time backfill job.
func (s *Store) RaceCandidates(ctx context.Context, userID string, labelIDs []string) ([]RaceCandidate, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	if labelIDs != nil && len(labelIDs) == 0 {
		return []RaceCandidate{}, nil
	}
	q := s.db.WithContext(ctx).Table("activities AS a").
		Select(`a.label_id, COALESCE(a.name, '') AS name, COALESCE(a.sport, '') AS sport,
            a.date, a.distance_m, a.duration_s, a.avg_pace_s_km, a.avg_hr, a.max_hr,
            a.ascent_m, COALESCE(a.train_kind, '') AS train_kind,
            COALESCE(a.sport_note, '') AS sport_note, a.pauses`).
		Where("a.user_id = ?", uid).
		Where("a.sport IN ?", []normalize.Sport{normalize.SportRunOutdoor, normalize.SportRunTrack}).
		Where(`((a.distance_m BETWEEN ? AND ?)
             OR (a.distance_m BETWEEN ? AND ?))`,
			racedetection.HalfMarathonMinDistanceM, racedetection.HalfMarathonMaxDistanceM,
			racedetection.MarathonMinDistanceM, racedetection.MarathonMaxDistanceM).
		Where(`NOT EXISTS (SELECT 1 FROM races r
            WHERE r.user_id = a.user_id AND r.label_id = a.label_id)`)
	if labelIDs != nil {
		q = q.Where("a.label_id IN ?", labelIDs)
	}
	var rows []RaceCandidate
	if err := q.Order("a.date, a.label_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ActivityStartCoordinates returns the first valid GPS point from every
// historical activity. Only the independent usual_activity_area job calls this
// expensive all-history query; race detection reads the persisted profile
// snapshot and must never call it or fall back to it.
func (s *Store) ActivityStartCoordinates(ctx context.Context, userID string) ([]activityarea.Coordinate, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Latitude  *float64 `gorm:"column:latitude"`
		Longitude *float64 `gorm:"column:longitude"`
	}
	// Drive from the much smaller activities table, then perform one indexed
	// first-point lookup per activity. LATERAL avoids both the all-user GROUP BY
	// and duplicated scalar subqueries for latitude/longitude (MySQL 8.0.14+).
	query := s.db.WithContext(ctx).Raw(`
        SELECT first_point.gps_lat AS latitude, first_point.gps_lon AS longitude
        FROM activities AS a
        JOIN LATERAL (
            SELECT t.gps_lat, t.gps_lon
            FROM timeseries AS t FORCE INDEX (idx_timeseries_user_label)
            WHERE t.user_id = a.user_id AND t.label_id = a.label_id
              AND t.gps_lat IS NOT NULL AND t.gps_lon IS NOT NULL
              AND t.gps_lat BETWEEN -90 AND 90 AND t.gps_lon BETWEEN -180 AND 180
              AND NOT (t.gps_lat = 0 AND t.gps_lon = 0)
            ORDER BY t.id
            LIMIT 1
        ) AS first_point ON TRUE
        WHERE a.user_id = ?
        ORDER BY a.date, a.label_id`, uid)
	if err := query.Scan(&rows).Error; err != nil {
		return nil, err
	}
	coordinates := make([]activityarea.Coordinate, 0, len(rows))
	for _, row := range rows {
		if row.Latitude != nil && row.Longitude != nil {
			coordinates = append(coordinates, activityarea.Coordinate{Latitude: *row.Latitude, Longitude: *row.Longitude})
		}
	}
	return coordinates, nil
}

// InsertRace idempotently persists one confirmed race activity reference and
// reports whether this call inserted the row.
func (s *Store) InsertRace(ctx context.Context, race *Race) (bool, error) {
	uid, err := canonicalUserID(race.UserID)
	if err != nil {
		return false, err
	}
	race.UserID = uid
	if race.CreatedAt.IsZero() {
		race.CreatedAt = time.Now().UTC()
	}
	tx := s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(race)
	return tx.RowsAffected == 1, tx.Error
}
