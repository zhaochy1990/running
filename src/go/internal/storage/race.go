package storage

import (
	"context"
	"time"

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
// historical activity. Race detection uses this bounded projection to infer
// the athlete's usual activity area; it does not claim a home address or call a
// geocoding service.
func (s *Store) ActivityStartCoordinates(ctx context.Context, userID string) ([]racedetection.Coordinate, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	firstPointIDs := s.db.WithContext(ctx).Model(&TimeseriesPoint{}).
		Select("MIN(id)").
		Where("user_id = ? AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL", uid).
		Where("gps_lat BETWEEN -90 AND 90 AND gps_lon BETWEEN -180 AND 180").
		Where("NOT (gps_lat = 0 AND gps_lon = 0)").
		Group("label_id")
	var rows []struct {
		Latitude  float64 `gorm:"column:latitude"`
		Longitude float64 `gorm:"column:longitude"`
	}
	if err := s.db.WithContext(ctx).Model(&TimeseriesPoint{}).
		Select("gps_lat AS latitude, gps_lon AS longitude").
		Where("user_id = ? AND id IN (?)", uid, firstPointIDs).
		Order("id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	coordinates := make([]racedetection.Coordinate, len(rows))
	for i, row := range rows {
		coordinates[i] = racedetection.Coordinate{Latitude: row.Latitude, Longitude: row.Longitude}
	}
	return coordinates, nil
}

// InsertRace idempotently persists one confirmed race activity reference.
func (s *Store) InsertRace(ctx context.Context, race *Race) error {
	uid, err := canonicalUserID(race.UserID)
	if err != nil {
		return err
	}
	race.UserID = uid
	if race.CreatedAt.IsZero() {
		race.CreatedAt = time.Now().UTC()
	}
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(race).Error
}
