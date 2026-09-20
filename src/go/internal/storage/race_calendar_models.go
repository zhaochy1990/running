package storage

import "time"

// Race calendar provenance. Every event and item row carries an Origin telling
// the sync pipeline whether the row still mirrors upstream (sync) or has been
// taken over by an administrator (manual). Manual rows are never overwritten or
// stale-deleted by the sync.
const (
	// RaceOriginSync marks a row still owned by the mirror sync.
	RaceOriginSync = "sync"
	// RaceOriginManual marks a row an administrator owns: a manually created
	// row, or a sync row upgraded because a key field (name/race_date) was
	// edited so it no longer maps to an upstream record.
	RaceOriginManual = "manual"
	// RaceSourceManual is the Source value stored on manually created events.
	// It is deliberately distinct from the upstream source labels (国际田联 /
	// 中国田协) so the sync can never match or clobber a manual row; the
	// dashboard renders it as 管理员 / Manual.
	RaceSourceManual = "manual"
)

// RaceCalendarEvent is one race in an externally-sourced race calendar
// (currently the World Athletics label road races and the 中国田协 competition
// catalogue) mirrored into MySQL by the race-calendar sync pipelines, plus
// administrator-authored rows. It is a system table — there is no user_id.
//
// ID is an internal, database-owned surrogate key. The sync and the API identify
// races by their business key (see below); the dashboard never shows the id, but
// the item child table needs a stable foreign key, so this table gained an
// explicit auto-increment primary key (the row-value uniqueness of the business
// key is still enforced by uidx_race_cal_src_name_date).
//
// Identity is (source, name, race_date): the same race name on the same date
// from the same source is one row. race_date carries the year, so no separate
// year column exists (query a year with race_date BETWEEN "2026-01-01" AND
// "2026-12-31"). race_date is part of the key because upstream can list two
// genuinely different races with the same name in one year (e.g. two "Medio
// Maraton Sevilla" half marathons), while a same-name same-date duplicate
// listing is correctly merged. There is deliberately no upstream event id, so a
// race is identified purely by its business key.
//
// RaceDate is a plain calendar date ("2006-01-02") with no instant, so it must
// never undergo a timezone conversion (same discipline as RaceGoal.RaceDate).
// Month/DayOfMonth are derived from RaceDate at write time so a "races in
// March" query is a plain indexed equality.
//
// NameCN is the Chinese name. The World Athletics upstream only provides
// English, so it stays NULL until an app-side/curated value exists; 中国田协
// fills it from the upstream Chinese name on insert. The sync merge never
// overwrites an existing NameCN (existing semantics) — an administrator may
// curate it, and editing it records an override so stale-delete protects the row.
//
// Address is stored as three levels: Country (3-letter ISO code), Province
// (中文省 for China, English state/province abroad) and City (Chinese city
// name for China — with administrative suffix, e.g. 厦门市 — the upstream
// English name abroad). They are parsed from the upstream venue string at write
// time; venue itself is not stored.
//
// Label is the World Athletics road-race label tier (Platinum/Gold/Elite/Label)
// or the 中国田协 certification grade (A/B/C（属地办赛）/系列赛) — a
// source-specific value space.
//
// RaceTypes is a JSON array of race types from the shared internal/racetypes
// vocabulary (Marathon / HalfMarathon / "{n}Km" / Other / Unknown), e.g.
// ["Marathon","HalfMarathon"]. Both sources fill it from explicit upstream
// markers (the 中国田协 raceItem field; the WA rankingCategory GW/GL); anything
// undeterminable is ["Unknown"] — no name-pattern guessing. For 中国田协 the
// finer-grained per-item rows live in RaceCalendarItem. Timestamps are UTC.
//
// AdminOverrides is a JSON array of the sync-managed field names an
// administrator has taken over (a subset of the RaceCalendarOverrideableFields
// vocabulary, e.g. ["city","label"]). The sync merge keeps the current value for
// each listed field instead of the upstream value, and the stale-delete skips
// any row with a non-empty override set, so an administrator's corrections
// survive the next sync.
type RaceCalendarEvent struct {
	ID       uint64  `gorm:"column:id;primaryKey;autoIncrement"`
	Source   string  `gorm:"column:source;size:32;not null;uniqueIndex:uidx_race_cal_src_name_date,priority:1"`
	Name     string  `gorm:"column:name;size:255;not null;uniqueIndex:uidx_race_cal_src_name_date,priority:2"`
	NameCN   *string `gorm:"column:name_cn;size:255"`
	RaceDate string  `gorm:"column:race_date;size:10;not null;uniqueIndex:uidx_race_cal_src_name_date,priority:3"`
	Month    int8    `gorm:"column:month;not null"`
	// DayOfMonth derives from RaceDate (day-of-month); the field name avoids the
	// reserved-looking "day" column name while the column stays dayofmonth.
	DayOfMonth     int8      `gorm:"column:dayofmonth;not null"`
	Country        string    `gorm:"column:country;size:8;not null"`
	Province       *string   `gorm:"column:province;size:64"`
	City           *string   `gorm:"column:city;size:64"`
	Label          *string   `gorm:"column:label;size:32"`
	RaceTypes      *string   `gorm:"column:race_types;size:255"`
	Origin         string    `gorm:"column:origin;size:16;not null;default:sync"`
	AdminOverrides []string  `gorm:"column:admin_overrides;type:json;serializer:json"`
	CreatedAt      time.Time `gorm:"column:created_at"`
	UpdatedAt      time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceCalendarEvent) TableName() string { return "race_calendar" }

// RaceCalendarOverrideableFields are the sync-managed event fields an
// administrator can take over. Key fields (name, race_date) are NOT here: editing
// one upgrades the whole row to manual instead of recording a field override.
// name_cn is included because curating a Chinese name must protect the row from
// the stale-delete even though the sync merge always preserves it.
var RaceCalendarOverrideableFields = []string{
	"name_cn", "country", "province", "city", "label", "race_types",
}

// IsRaceCalendarOverrideable reports whether field is a valid admin-override
// field name (used to reject unknown names in a PATCH body).
func IsRaceCalendarOverrideable(field string) bool {
	for _, f := range RaceCalendarOverrideableFields {
		if f == field {
			return true
		}
	}
	return false
}

// RaceCalendarItem is one race distance/entry inside a RaceCalendarEvent (e.g.
// the full marathon and half marathon of one event). It carries the finer
// details an external calendar does not reliably provide — start time, entry
// fee and quota — so an administrator can complete them.
//
// Identity is (race_event_id, name): one item name per event. Only the 中国田协
// source produces sync items (its upstream raceItem list is a list of event
// names); the World Athletics source has no item-level data and leaves the child
// table empty for its rows.
//
// Type is a token from the shared internal/racetypes vocabulary. StartTime is a
// wall-clock "HH:MM" (no instant, never timezone-converted); EntryFee is in
// fen/cents (the smallest unit) and defaults to CNY; both are NULL when unknown.
// Origin follows the event row: sync items are regenerated on each sync, manual
// items are never touched.
type RaceCalendarItem struct {
	ID          uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	RaceEventID uint64    `gorm:"column:race_event_id;not null;uniqueIndex:uidx_race_cal_item_event_name,priority:1"`
	Name        string    `gorm:"column:name;size:255;not null;uniqueIndex:uidx_race_cal_item_event_name,priority:2"`
	Type        string    `gorm:"column:type;size:32;not null"`
	StartTime   *string   `gorm:"column:start_time;size:8"`
	EntryFee    *int      `gorm:"column:entry_fee"`
	Quota       *int      `gorm:"column:quota"`
	Origin      string    `gorm:"column:origin;size:16;not null;default:sync"`
	CreatedAt   time.Time `gorm:"column:created_at"`
	UpdatedAt   time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceCalendarItem) TableName() string { return "race_calendar_item" }
