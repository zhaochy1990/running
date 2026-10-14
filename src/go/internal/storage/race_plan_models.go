package storage

import "time"

// RacePlan state values — the five-state signup machine (see CONTEXT.md
// 「参赛计划（Race Plan）」). The runner drives the transitions by hand from the
// race-center UI: 想报名 → 已报名(等抽签) → 已中签 / 未中签 → 确认参赛, and a
// first-come-first-served race is marked won directly after signing up. The
// transitions are user-owned manual actions (the API never verifies against a
// signup platform), so an upsert accepts any state in this set; the UI
// constrains what is offered.
const (
	// RacePlanStateWant is 想报名 — intends to sign up once registration opens.
	// The pre-signup head of the machine, mirroring the custom-race want state.
	RacePlanStateWant = "want"
	// RacePlanStateRegistered is 已报名（等抽签）— signed up, waiting for lottery.
	RacePlanStateRegistered = "registered"
	// RacePlanStateWon is 已中签 — lottery won (or first-come entry secured).
	RacePlanStateWon = "won"
	// RacePlanStateLost is 未中签 — lottery lost.
	RacePlanStateLost = "lost"
	// RacePlanStateConfirmed is 确认参赛 — committed to start.
	RacePlanStateConfirmed = "confirmed"
)

// IsRacePlanState reports whether v is one of the five signup states — the
// closed vocabulary an upsert body is validated against, so a typo cannot
// silently invent a sixth state.
func IsRacePlanState(v string) bool {
	switch v {
	case RacePlanStateWant, RacePlanStateRegistered, RacePlanStateWon, RacePlanStateLost, RacePlanStateConfirmed:
		return true
	}
	return false
}

// RacePlan is a runner's per-race signup tracking record (see CONTEXT.md
// 「参赛计划（Race Plan）」): which 报名项目 they entered (a racetypes token such
// as Marathon/HalfMarathon, matching race_calendar_item.type), where they are in
// the five-state signup machine, and the two travel booleans (酒店、大交通 订没订).
// It is distinct from RaceGoal (the training target) and from the auto-detected
// race history in the races table.
//
// Identity is (user_id, race_event_id): one plan per user per race — UNIQUE(user,
// event) — because the plan tracks the runner's attendance at the race, and a
// runner signs up for exactly one 项目 of it; re-submitting the 报名 selector with
// another 项目 updates the row rather than adding a second.
//
// Offboarding (下架) is layered per state: a lost plan whose race is unpublished
// is silently dropped from the user's list, while want/registered/won/confirmed
// plans are returned with offboarded=true so「我的赛事」can render the 已下架
// placeholder card and keep the record (ListRacePlans).
type RacePlan struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	// UserID is the athlete's canonical UUID; see canonicalUserID.
	UserID string `gorm:"column:user_id;size:64;not null;uniqueIndex:uidx_race_plan_user_event,priority:1"`
	// RaceEventID references race_calendar.id, with the same no-FK discipline
	// as RaceFavorite.RaceEventID.
	RaceEventID uint64 `gorm:"column:race_event_id;not null;uniqueIndex:uidx_race_plan_user_event,priority:2"`
	// ItemType is the signed-up 项目, a token from internal/racetypes — the same
	// vocabulary as race_calendar_item.type / race_calendar.race_types.
	ItemType string `gorm:"column:item_type;size:32;not null"`
	// State is one of the RacePlanState* tokens.
	State     string    `gorm:"column:state;size:16;not null"`
	Hotel     bool      `gorm:"column:hotel;not null;default:false"`
	Transit   bool      `gorm:"column:transit;not null;default:false"`
	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RacePlan) TableName() string { return "race_plan" }
