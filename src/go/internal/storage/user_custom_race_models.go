package storage

import "time"

// UserCustomRace state values — the two-state attendance marker (see CONTEXT.md
// 「自定义比赛（Custom Race）」). The runner flips want ↔ registered by hand; the
// API never verifies against a signup platform. There is no "finished" state:
// done is derived at read time from race_date < today (Asia/Shanghai), so a
// past race is never stored, it just derives as finished.
const (
	// CustomRaceStateWant is 想跑 — on the wishlist, not signed up (the default).
	CustomRaceStateWant = "want"
	// CustomRaceStateRegistered is 已报名 — signed up.
	CustomRaceStateRegistered = "registered"
)

// IsCustomRaceState reports whether v is one of the two custom-race states —
// the closed vocabulary a write body is validated against, so a typo cannot
// silently invent a third state.
func IsCustomRaceState(v string) bool {
	switch v {
	case CustomRaceStateWant, CustomRaceStateRegistered:
		return true
	}
	return false
}

// UserCustomRace is a race the user added by hand, outside race_calendar (see
// CONTEXT.md 「自定义比赛（Custom Race）」 — trail/ultra events etc.). Only the
// creator ever sees the row: race_catalog / race_detection / coach
// mysqlDataProvider / race_strategy all read exclusively the race_calendar
// tables, so staying out of those is what keeps a custom race private — the
// table itself is the guarantee.
//
// There is deliberately no UNIQUE(user_id, race_date): v1 does not dedupe
// (#457). State is the want/registered pair above;「已结束」never lands here.
type UserCustomRace struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	// UserID is the athlete's canonical UUID; see canonicalUserID.
	UserID string `gorm:"column:user_id;size:64;not null;index:idx_user_custom_race_user_date,priority:1"`
	Name   string `gorm:"column:name;size:128;not null"`
	// RaceDate is YYYY-MM-DD, the same convention as race_calendar.race_date.
	RaceDate string `gorm:"column:race_date;size:10;not null;index:idx_user_custom_race_user_date,priority:2"`
	// ItemType is a racetypes token (including the custom-only Trail/Ultra).
	ItemType string `gorm:"column:item_type;size:32;not null"`
	// DistanceKm is nullable; NULL means the card badge shows only the type.
	DistanceKm *float64 `gorm:"column:distance_km;type:decimal(6,1)"`
	// AscentM is the trail D+ (vertical ascent metres), nullable.
	AscentM *uint32 `gorm:"column:ascent_m;unsigned"`
	City    string  `gorm:"column:city;size:64;not null;default:''"`
	Website string  `gorm:"column:website;size:512;not null;default:''"`
	Note    string  `gorm:"column:note;size:512;not null;default:''"`
	// State is one of the CustomRaceState* tokens.
	State     string    `gorm:"column:state;size:16;not null"`
	Hotel     bool      `gorm:"column:hotel;not null;default:false"`
	Transit   bool      `gorm:"column:transit;not null;default:false"`
	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (UserCustomRace) TableName() string { return "user_custom_race" }
