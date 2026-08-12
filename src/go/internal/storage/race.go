package storage

import (
	"context"
	"time"

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

// RaceCandidate is the storage projection used by the independent race
// detection module. It contains no GPS or timeseries data.
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
            COALESCE(a.sport_note, '') AS sport_note`).
		Where("a.user_id = ?", uid).
		Where("a.sport IN ?", []string{racedetection.SportOutdoorRun, racedetection.SportTrackRun}).
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
