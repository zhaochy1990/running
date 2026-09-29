package storage

import "time"

// RaceFavorite is a runner's lightweight follow mark on one race-calendar race
// (see CONTEXT.md「收藏（Race Favorite）」). It is deliberately independent of
// RacePlan: favoriting does not imply signing up, and a plan needs no favorite.
// Rows are created only through the toggle on a published race; when a race is
// later unpublished (下架) the row survives but the user-facing reads silently
// filter it out — an offboarded favorite is invisible, not a placeholder card.
type RaceFavorite struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	// UserID is the athlete's canonical UUID; see canonicalUserID.
	UserID string `gorm:"column:user_id;size:64;not null;uniqueIndex:uidx_race_fav_user_event,priority:1"`
	// RaceEventID references race_calendar.id. No FK constraint, the same
	// discipline as race_calendar_item.race_event_id: the calendar is a mirror
	// the sync rewrites, and the app enforces referential policy in the store
	// methods (toggle refuses a race that does not exist).
	RaceEventID uint64    `gorm:"column:race_event_id;not null;uniqueIndex:uidx_race_fav_user_event,priority:2"`
	CreatedAt   time.Time `gorm:"column:created_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceFavorite) TableName() string { return "race_favorite" }
