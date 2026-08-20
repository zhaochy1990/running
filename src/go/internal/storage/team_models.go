package storage

import "time"

// TeamLike is the canonical MySQL record for one user's like on a team
// activity. Team membership remains owned by auth-service; only the social
// signal is persisted here. The four-part primary key keeps likes idempotent
// and prevents the same activity's likes leaking between teams.
type TeamLike struct {
	TeamID           string    `gorm:"column:team_id;type:varchar(64);primaryKey;index:idx_team_likes_activity,priority:1"`
	OwnerUserID      string    `gorm:"column:owner_user_id;type:char(36);primaryKey;index:idx_team_likes_activity,priority:2"`
	LabelID          string    `gorm:"column:label_id;type:varchar(128);primaryKey;index:idx_team_likes_activity,priority:3"`
	LikerUserID      string    `gorm:"column:liker_user_id;type:char(36);primaryKey"`
	LikerDisplayName string    `gorm:"column:liker_display_name;type:varchar(200);not null;default:''"`
	CreatedAt        time.Time `gorm:"column:created_at;type:datetime(6);not null;autoCreateTime:false"`
}

func (TeamLike) TableName() string { return "team_likes" }

// TeamActivityKey identifies an activity in team read models. TeamID is not
// part of the key because a bulk likes lookup is already scoped to one team.
type TeamActivityKey struct {
	OwnerUserID string
	LabelID     string
}

// TeamMileage is one member's running aggregate for a natural Shanghai period.
type TeamMileage struct {
	UserID        string
	TotalKM       float64
	ActivityCount int
}

// TeamMileagePeriod is the supported natural Shanghai calendar period.
type TeamMileagePeriod string

const (
	TeamMileageMonth TeamMileagePeriod = "month"
	TeamMileageWeek  TeamMileagePeriod = "week"
)

// TeamMileageResult includes the period bounds used by the aggregate. Bounds
// retain their fixed UTC+8 location for direct API serialization.
type TeamMileageResult struct {
	PeriodStart time.Time
	PeriodEnd   time.Time
	Rows        []TeamMileage
}
