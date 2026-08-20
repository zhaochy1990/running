package storage

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm/clause"
)

const shanghaiOffset = 8 * time.Hour

var shanghaiLocation = time.FixedZone("Asia/Shanghai", int(shanghaiOffset/time.Second))

// AutoMigrateTeamLikes independently creates or reconciles only team_likes.
// Likes start empty: this migration intentionally performs no Azure/file
// backfill and creates no team or team-member tables.
func (s *Store) AutoMigrateTeamLikes(ctx context.Context) error {
	if err := s.db.WithContext(ctx).AutoMigrate(&TeamLike{}); err != nil {
		return fmt.Errorf("storage: automigrate team likes: %w", err)
	}
	return nil
}

const teamFeedQuery = `
SELECT ranked.*
FROM (
    SELECT activities.*,
           ROW_NUMBER() OVER (
               PARTITION BY user_id
               ORDER BY date DESC, label_id DESC
           ) AS team_row_num
    FROM activities
    WHERE user_id IN ?
      AND DATE(date + INTERVAL 8 HOUR) >= ?
) AS ranked
WHERE ranked.team_row_num <= ?
ORDER BY ranked.date DESC, ranked.label_id DESC`

// TeamFeed returns recent activities for the supplied auth-service member IDs.
// MySQL 8 applies the per-member cap with ROW_NUMBER before returning the
// unified feed newest-first. The cutoff is a Shanghai civil day, matching the
// legacy team feed's inclusive days window.
func (s *Store) TeamFeed(ctx context.Context, memberIDs []string, days, limitPerUser int, now time.Time) ([]Activity, error) {
	uids, err := canonicalUserIDs(memberIDs)
	if err != nil {
		return nil, err
	}
	if len(uids) == 0 || limitPerUser <= 0 {
		return []Activity{}, nil
	}
	if days < 0 {
		return nil, fmt.Errorf("storage: team feed days must be non-negative")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	cutoff := now.In(shanghaiLocation).AddDate(0, 0, -days).Format("2006-01-02")

	var rows []Activity
	if err := s.db.WithContext(ctx).
		Raw(teamFeedQuery, uids, cutoff, limitPerUser).
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// TeamMileage returns every supplied auth-service member, including zero rows,
// aggregated over the current natural Shanghai month or Monday-start week.
func (s *Store) TeamMileage(ctx context.Context, memberIDs []string, period TeamMileagePeriod, now time.Time) (*TeamMileageResult, error) {
	uids, err := canonicalUserIDs(memberIDs)
	if err != nil {
		return nil, err
	}
	start, end, err := teamMileageWindow(period, now)
	if err != nil {
		return nil, err
	}

	out := &TeamMileageResult{
		PeriodStart: start,
		PeriodEnd:   end,
		Rows:        make([]TeamMileage, 0, len(uids)),
	}
	if len(uids) == 0 {
		return out, nil
	}

	type mileageAggregate struct {
		UserID        string  `gorm:"column:user_id"`
		TotalKM       float64 `gorm:"column:total_km"`
		ActivityCount int     `gorm:"column:activity_count"`
	}
	var aggs []mileageAggregate
	if err := s.db.WithContext(ctx).Model(&Activity{}).
		Select("user_id, coalesce(sum(coalesce(distance_m, 0)), 0) / 1000.0 AS total_km, count(*) AS activity_count").
		Where("user_id IN ?", uids).
		Where("sport_type IN ?", runSportIDs).
		Where("date >= ? AND date <= ?", start.UTC(), end.UTC()).
		Group("user_id").
		Scan(&aggs).Error; err != nil {
		return nil, err
	}

	byUser := make(map[string]TeamMileage, len(aggs))
	for _, agg := range aggs {
		byUser[agg.UserID] = TeamMileage{
			UserID:        agg.UserID,
			TotalKM:       agg.TotalKM,
			ActivityCount: agg.ActivityCount,
		}
	}
	for _, uid := range uids {
		row, ok := byUser[uid]
		if !ok {
			row = TeamMileage{UserID: uid}
		}
		out.Rows = append(out.Rows, row)
	}
	return out, nil
}

// UserProfilesByIDs returns the existing STRIDE profiles for the supplied IDs.
// Missing profiles are omitted so the API can fall back to auth-service names.
func (s *Store) UserProfilesByIDs(ctx context.Context, userIDs []string) (map[string]UserProfile, error) {
	uids, err := canonicalUserIDs(userIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[string]UserProfile, len(uids))
	if len(uids) == 0 {
		return out, nil
	}
	var rows []UserProfile
	if err := s.db.WithContext(ctx).Where("user_id IN ?", uids).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.UserID] = row
	}
	return out, nil
}

// PutTeamLike upserts a like. Repeating a like is idempotent and refreshes the
// display-name snapshot while preserving the original creation timestamp.
func (s *Store) PutTeamLike(ctx context.Context, like *TeamLike) error {
	if like == nil {
		return fmt.Errorf("storage: team like is nil")
	}
	ownerID, err := canonicalUserID(like.OwnerUserID)
	if err != nil {
		return err
	}
	likerID, err := canonicalUserID(like.LikerUserID)
	if err != nil {
		return err
	}
	if err := validateTeamLikeKey(like.TeamID, like.LabelID); err != nil {
		return err
	}
	like.TeamID = strings.TrimSpace(like.TeamID)
	like.LabelID = strings.TrimSpace(like.LabelID)
	like.OwnerUserID = ownerID
	like.LikerUserID = likerID
	like.LikerDisplayName = truncateUTF8(strings.TrimSpace(like.LikerDisplayName), 200)
	if like.CreatedAt.IsZero() {
		like.CreatedAt = time.Now().UTC().Truncate(time.Microsecond)
	} else {
		like.CreatedAt = like.CreatedAt.UTC().Truncate(time.Microsecond)
	}
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "team_id"}, {Name: "owner_user_id"},
			{Name: "label_id"}, {Name: "liker_user_id"},
		},
		DoUpdates: clause.AssignmentColumns([]string{"liker_display_name"}),
	}).Create(like).Error
}

// DeleteTeamLike removes one team-scoped like and reports whether it existed.
func (s *Store) DeleteTeamLike(ctx context.Context, teamID, ownerUserID, labelID, likerUserID string) (bool, error) {
	ownerID, err := canonicalUserID(ownerUserID)
	if err != nil {
		return false, err
	}
	likerID, err := canonicalUserID(likerUserID)
	if err != nil {
		return false, err
	}
	if err := validateTeamLikeKey(teamID, labelID); err != nil {
		return false, err
	}
	result := s.db.WithContext(ctx).Where(
		"team_id = ? AND owner_user_id = ? AND label_id = ? AND liker_user_id = ?",
		strings.TrimSpace(teamID), ownerID, strings.TrimSpace(labelID), likerID,
	).Delete(&TeamLike{})
	return result.RowsAffected > 0, result.Error
}

// TeamLikesForActivity returns a team activity's likes oldest-first.
func (s *Store) TeamLikesForActivity(ctx context.Context, teamID, ownerUserID, labelID string) ([]TeamLike, error) {
	ownerID, err := canonicalUserID(ownerUserID)
	if err != nil {
		return nil, err
	}
	if err := validateTeamLikeKey(teamID, labelID); err != nil {
		return nil, err
	}
	var rows []TeamLike
	if err := s.db.WithContext(ctx).Where(
		"team_id = ? AND owner_user_id = ? AND label_id = ?",
		strings.TrimSpace(teamID), ownerID, strings.TrimSpace(labelID),
	).Order("created_at, liker_user_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// TeamLikesForActivities bulk-loads likes for requested activity keys in one
// team. Every requested key appears in the result, including keys with no likes.
func (s *Store) TeamLikesForActivities(ctx context.Context, teamID string, targets []TeamActivityKey) (map[TeamActivityKey][]TeamLike, error) {
	if strings.TrimSpace(teamID) == "" || len(strings.TrimSpace(teamID)) > 64 {
		return nil, fmt.Errorf("storage: invalid team_id")
	}
	out := make(map[TeamActivityKey][]TeamLike, len(targets))
	if len(targets) == 0 {
		return out, nil
	}

	canonicalTargets := make([]TeamActivityKey, 0, len(targets))
	seen := make(map[TeamActivityKey]struct{}, len(targets))
	for _, target := range targets {
		uid, err := canonicalUserID(target.OwnerUserID)
		if err != nil {
			return nil, err
		}
		if err := validateTeamLikeKey(teamID, target.LabelID); err != nil {
			return nil, err
		}
		key := TeamActivityKey{OwnerUserID: uid, LabelID: strings.TrimSpace(target.LabelID)}
		out[key] = []TeamLike{}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		canonicalTargets = append(canonicalTargets, key)
	}

	targetPairs := make([][]any, 0, len(canonicalTargets))
	for _, target := range canonicalTargets {
		targetPairs = append(targetPairs, []any{target.OwnerUserID, target.LabelID})
	}
	var rows []TeamLike
	if err := s.db.WithContext(ctx).
		Where("team_id = ?", strings.TrimSpace(teamID)).
		Where("(owner_user_id, label_id) IN ?", targetPairs).
		Order("created_at, liker_user_id").Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		key := TeamActivityKey{OwnerUserID: row.OwnerUserID, LabelID: row.LabelID}
		out[key] = append(out[key], row)
	}
	return out, nil
}

func canonicalUserIDs(userIDs []string) ([]string, error) {
	out := make([]string, 0, len(userIDs))
	seen := make(map[string]struct{}, len(userIDs))
	for _, userID := range userIDs {
		uid, err := canonicalUserID(userID)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[uid]; ok {
			continue
		}
		seen[uid] = struct{}{}
		out = append(out, uid)
	}
	return out, nil
}

func teamMileageWindow(period TeamMileagePeriod, now time.Time) (time.Time, time.Time, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	end := now.In(shanghaiLocation)
	var start time.Time
	switch period {
	case TeamMileageMonth:
		start = time.Date(end.Year(), end.Month(), 1, 0, 0, 0, 0, shanghaiLocation)
	case TeamMileageWeek:
		daysSinceMonday := (int(end.Weekday()) + 6) % 7
		day := end.AddDate(0, 0, -daysSinceMonday)
		start = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, shanghaiLocation)
	default:
		return time.Time{}, time.Time{}, fmt.Errorf("storage: invalid team mileage period %q", period)
	}
	return start, end, nil
}

func truncateUTF8(value string, maxRunes int) string {
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}

func validateTeamLikeKey(teamID, labelID string) error {
	teamID = strings.TrimSpace(teamID)
	labelID = strings.TrimSpace(labelID)
	if teamID == "" || len(teamID) > 64 {
		return fmt.Errorf("storage: invalid team_id")
	}
	if labelID == "" || len(labelID) > 128 {
		return fmt.Errorf("storage: invalid label_id")
	}
	return nil
}

// SortTeamMileage orders a leaderboard by mileage descending, activity count
// descending, then user ID ascending. The API may apply display-name tie-breaks
// after joining auth-service member data.
func SortTeamMileage(rows []TeamMileage) {
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].TotalKM != rows[j].TotalKM {
			return rows[i].TotalKM > rows[j].TotalKM
		}
		if rows[i].ActivityCount != rows[j].ActivityCount {
			return rows[i].ActivityCount > rows[j].ActivityCount
		}
		return rows[i].UserID < rows[j].UserID
	})
}
