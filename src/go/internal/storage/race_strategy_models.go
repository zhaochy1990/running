package storage

import "time"

// RaceStrategy is a runner's coach-generated execution strategy for one race
// (#396): target time, per-segment pace table, fueling plan and course/weather
// tips, stored as one JSON content blob (the RaceStrategy contract lives in
// src/coach_contract). It is produced by the TS coach (race_strategy sub-agent)
// and hand-edited by the runner in the mini-program report page; both writes go
// through the API — the coach via the internal POST, the runner via the user
// PUT — so the DB has a single writer surface like every other race table.
//
// Identity is (user_id, race_event_id): one strategy per user per race —
// UNIQUE(user, event) — and only the latest version is kept (the upsert
// overwrites in place; no revision history, by design #386: 再聊一轮=更新版本).
type RaceStrategy struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	// UserID is the athlete's canonical UUID; see canonicalUserID.
	UserID string `gorm:"column:user_id;size:64;not null;uniqueIndex:uidx_race_strategy_user_event,priority:1"`
	// RaceEventID references race_calendar.id, with the same no-FK discipline
	// as RacePlan.RaceEventID.
	RaceEventID uint64 `gorm:"column:race_event_id;not null;uniqueIndex:uidx_race_strategy_user_event,priority:2"`
	// ItemType is the strategy's 项目, a token from internal/racetypes — the
	// same vocabulary as race_calendar_item.type / RacePlan.ItemType.
	ItemType string `gorm:"column:item_type;size:32;not null"`
	// Content is the JSON-encoded RaceStrategy document (LONGTEXT, not a JSON
	// column: the writer owns canonical validation, MySQL stays a byte store).
	Content   string    `gorm:"column:content;type:longtext;not null"`
	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceStrategy) TableName() string { return "race_strategy" }
