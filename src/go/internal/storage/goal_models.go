package storage

import "time"

// RaceGoal is an athlete's target race plus the weekly-availability preferences
// for training toward it (ADR 0021). It is the greenfield Go/MySQL redesign of
// the Python training-goal blob: race goals only (the old type enum is dropped),
// modelled as a proper entity and enriched toward the downstream MasterPlanGoal.
//
// At most one row per athlete is active; setting a new goal archives the prior
// one. History is retained as an audit trail but is not exposed via the API.
// The ≤1-active invariant is enforced by MySQL: ActiveFlag is 1 on the active
// row and NULL on archived rows, under a composite UNIQUE(user_id, active_flag)
// — MySQL unique indexes do not collide on NULL, so an athlete may have many
// archived rows but only one active. ActiveFlag is app-managed (kept in lockstep
// with Status by the transactional store methods), not a generated column, since
// GORM AutoMigrate has no generated-column support and MySQL has no partial
// indexes.
//
// RaceDate is a plain Shanghai-local calendar date stored as an ISO YYYY-MM-DD
// string, not a time.Time: it has no instant, so it must never undergo a
// timezone conversion (same discipline as UserProfile.DOB).
//
// RaceTimezone is the *race's* local zone (for countdown / race-day), an opaque
// string with no strict IANA validation; it is semantically distinct from the
// user's day-bucketing Shanghai zone. RaceLocation/RaceTimezone are carried for
// the downstream MasterPlanGoal snapshot; when absent the generator keeps
// applying its Asia/Shanghai default.
type RaceGoal struct {
	GoalID              string    `gorm:"column:goal_id;primaryKey;size:36"`
	UserID              string    `gorm:"column:user_id;size:64;not null;uniqueIndex:uidx_race_goal_active,priority:1"`
	Status              string    `gorm:"column:status;size:16;not null"`
	ActiveFlag          *int8     `gorm:"column:active_flag;uniqueIndex:uidx_race_goal_active,priority:2"`
	RaceDate            string    `gorm:"column:race_date;size:10;not null"`
	RaceDistance        string    `gorm:"column:race_distance;size:16;not null"`
	RaceName            *string   `gorm:"column:race_name;size:255"`
	TargetFinishTime    *string   `gorm:"column:target_finish_time;size:16"`
	WeeklyTrainingDays  int       `gorm:"column:weekly_training_days;not null"`
	AvailableTimeSlots  []string  `gorm:"column:available_time_slots;serializer:json"`
	StrengthWillingness *string   `gorm:"column:strength_willingness;size:16"`
	RaceLocation        *string   `gorm:"column:race_location;size:255"`
	RaceTimezone        *string   `gorm:"column:race_timezone;size:64"`
	CreatedAt           time.Time `gorm:"column:created_at"`
	UpdatedAt           time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceGoal) TableName() string { return "race_goal" }

// RaceGoal status values.
const (
	RaceGoalStatusActive   = "active"
	RaceGoalStatusArchived = "archived"
)
