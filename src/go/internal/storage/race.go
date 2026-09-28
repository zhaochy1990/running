package storage

import (
	"context"
	"encoding/json"
	"time"

	"github.com/zhaochy1990/stride/internal/normalize"
	"github.com/zhaochy1990/stride/internal/racedetection"
	"gorm.io/gorm/clause"
)

// Race is a confirmed race effort. It deliberately stores only an activity
// reference; name, distance, duration and metrics remain canonical in activities.
// RaceCalendarItemID links the activity to the matched race_calendar_item when
// the calendar matcher confirmed it; Evidence records the confirmation path.
type Race struct {
	UserID             string    `gorm:"column:user_id;type:char(36);primaryKey"`
	LabelID            string    `gorm:"column:label_id;type:varchar(191);primaryKey"`
	RaceCalendarItemID *int64    `gorm:"column:race_calendar_item_id;type:bigint;index"`
	Evidence           string    `gorm:"column:evidence;type:varchar(32);not null;default:model_score"`
	CreatedAt          time.Time `gorm:"column:created_at;type:datetime(6);not null;autoCreateTime:false"`
}

func (Race) TableName() string { return "races" }

// RaceCandidate is the bounded activity-row projection used by the independent
// race detection module. GPS/timeseries are loaded separately only after this
// deterministic query admits the activity. StartGPSLat/StartGPSLon carry the
// activity-level start fix cached during watch sync for calendar matching.
type RaceCandidate struct {
	LabelID     string
	Name        string
	Sport       string
	Date        time.Time
	DistanceM   float64
	DurationS   *float64
	AvgPaceSKm  *float64
	AvgHR       *int
	MaxHR       *int
	AscentM     *float64
	TrainKind   string
	SportNote   string
	Pauses      *string
	StartGPSLat *float64
	StartGPSLon *float64
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
            COALESCE(a.sport_note, '') AS sport_note, a.pauses,
            a.start_gps_lat AS start_gps_lat, a.start_gps_lon AS start_gps_lon`).
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

// ActivityStartCoordinates returns the activity-level start coordinate cached
// during watch sync. It scans only the user's activity rows and never reads the
// potentially multi-million-row timeseries table.
func (s *Store) ActivityStartCoordinates(ctx context.Context, userID string) ([]racedetection.Coordinate, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Latitude  float64 `gorm:"column:latitude"`
		Longitude float64 `gorm:"column:longitude"`
	}
	if err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("start_gps_lat AS latitude, start_gps_lon AS longitude").
		Where("user_id = ?", uid).
		Where("start_gps_lat IS NOT NULL AND start_gps_lon IS NOT NULL").
		Where("start_gps_lat BETWEEN -90 AND 90 AND start_gps_lon BETWEEN -180 AND 180").
		Where("NOT (start_gps_lat = 0 AND start_gps_lon = 0)").
		Order("date, label_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	coordinates := make([]racedetection.Coordinate, len(rows))
	for i, row := range rows {
		coordinates[i] = racedetection.Coordinate{Latitude: row.Latitude, Longitude: row.Longitude}
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
	if race.Evidence == "" {
		race.Evidence = racedetection.RaceEvidenceModelScore
	}
	tx := s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(race)
	return tx.RowsAffected == 1, tx.Error
}

// LinkRaceToCalendarItem attaches a calendar match to an already-confirmed
// race without overwriting an existing link. It reports whether this call
// performed the update.
func (s *Store) LinkRaceToCalendarItem(ctx context.Context, userID, labelID string, itemID int64) (bool, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return false, err
	}
	tx := s.db.WithContext(ctx).Model(&Race{}).
		Where("user_id = ? AND label_id = ? AND race_calendar_item_id IS NULL", uid, labelID).
		Updates(map[string]any{
			"race_calendar_item_id": itemID,
			"evidence":              racedetection.RaceEvidenceCalendarMatch,
		})
	return tx.RowsAffected == 1, tx.Error
}

// RacesWithoutCalendarLink returns the activity projections of a user's
// confirmed races that carry no calendar mapping yet. The rematch path uses it
// to backfill race_calendar_item_id for races confirmed before the matcher
// existed.
func (s *Store) RacesWithoutCalendarLink(ctx context.Context, userID string) ([]RaceCandidate, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	var rows []RaceCandidate
	if err := s.db.WithContext(ctx).Table("activities AS a").
		Select(`a.label_id, COALESCE(a.name, '') AS name, COALESCE(a.sport, '') AS sport,
            a.date, a.distance_m, a.duration_s, a.avg_pace_s_km, a.avg_hr, a.max_hr,
            a.ascent_m, COALESCE(a.train_kind, '') AS train_kind,
            COALESCE(a.sport_note, '') AS sport_note, a.pauses,
            a.start_gps_lat AS start_gps_lat, a.start_gps_lon AS start_gps_lon`).
		Where("a.user_id = ?", uid).
		Where(`EXISTS (SELECT 1 FROM races r
            WHERE r.user_id = a.user_id AND r.label_id = a.label_id AND r.race_calendar_item_id IS NULL)`).
		Order("a.date, a.label_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// RaceCalendarItemsForDates loads marathon and half-marathon calendar items
// for the given local dates (YYYY-MM-DD), projecting each into the matcher's
// shape including the parsed start_point. Items without usable coordinates
// are still returned: the matcher requires them, but callers may reuse the
// rows for geo-enrichment.
func (s *Store) RaceCalendarItemsForDates(ctx context.Context, dates []string) ([]racedetection.CalendarItem, error) {
	if len(dates) == 0 {
		return nil, nil
	}
	var rows []struct {
		ItemID     int64
		RaceDate   string
		Type       string
		DistanceKM *float64
		StartTime  *string
		StartPoint *string
	}
	if err := s.db.WithContext(ctx).Table("race_calendar_item AS ri").
		Select(`ri.id AS item_id, rc.race_date AS race_date, ri.type AS type,
            ri.distance_km AS distance_km, ri.start_time AS start_time,
            CAST(ri.start_point AS CHAR) AS start_point`).
		Joins("JOIN race_calendar AS rc ON rc.id = ri.race_event_id").
		Where("rc.race_date IN ?", dates).
		Where("ri.type IN ?", []string{"Marathon", "HalfMarathon"}).
		Order("ri.id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	items := make([]racedetection.CalendarItem, 0, len(rows))
	for _, row := range rows {
		item := racedetection.CalendarItem{
			ItemID: row.ItemID, RaceDate: row.RaceDate, Type: row.Type,
			DistanceKM: row.DistanceKM, GunTime: row.StartTime,
		}
		if row.StartPoint != nil && *row.StartPoint != "" {
			var point struct {
				Lat *float64 `json:"lat"`
				Lng *float64 `json:"lng"`
			}
			if err := json.Unmarshal([]byte(*row.StartPoint), &point); err == nil {
				item.StartLat, item.StartLng = point.Lat, point.Lng
			}
		}
		items = append(items, item)
	}
	return items, nil
}

// UpdateRaceCalendarItemStartFromConsensus crowd-sources the start
// coordinates of one calendar item from the activity-level GPS starts of all
// users whose races link to it. It writes only when the item has at least
// minUsers distinct confirmed starts agreeing within maxSpreadM and the item
// does not already carry coordinates. It reports whether it wrote.
func (s *Store) UpdateRaceCalendarItemStartFromConsensus(ctx context.Context, itemID int64, minUsers int, maxSpreadM float64) (bool, error) {
	existing, err := s.GetRaceCalendarItem(ctx, uint64(itemID))
	if err != nil {
		return false, err
	}
	if existing == nil || (existing.StartPoint != nil && existing.StartPoint.Lat != nil && existing.StartPoint.Lng != nil) {
		return false, nil
	}
	var rows []struct {
		Latitude  float64 `gorm:"column:latitude"`
		Longitude float64 `gorm:"column:longitude"`
	}
	if err := s.db.WithContext(ctx).Table("races AS r").
		Select("DISTINCT a.start_gps_lat AS latitude, a.start_gps_lon AS longitude").
		Joins("JOIN activities AS a ON a.user_id = r.user_id AND a.label_id = r.label_id").
		Where("r.race_calendar_item_id = ?", itemID).
		Where("a.start_gps_lat IS NOT NULL AND a.start_gps_lon IS NOT NULL").
		Where("a.start_gps_lat BETWEEN -90 AND 90 AND a.start_gps_lon BETWEEN -180 AND 180").
		Where("NOT (a.start_gps_lat = 0 AND a.start_gps_lon = 0)").
		Scan(&rows).Error; err != nil {
		return false, err
	}
	coordinates := make([]racedetection.Coordinate, len(rows))
	for i, row := range rows {
		coordinates[i] = racedetection.Coordinate{Latitude: row.Latitude, Longitude: row.Longitude}
	}
	consensus := racedetection.ConsensusCentroid(coordinates, minUsers, maxSpreadM)
	if consensus == nil {
		return false, nil
	}
	name := ""
	if existing.StartPoint != nil {
		name = existing.StartPoint.Name
	}
	point, err := json.Marshal(RacePoint{Name: name, Lat: &consensus.Latitude, Lng: &consensus.Longitude})
	if err != nil {
		return false, err
	}
	tx := s.db.WithContext(ctx).Exec(
		"UPDATE race_calendar_item SET start_point = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
		string(point), itemID)
	return tx.RowsAffected == 1, tx.Error
}
