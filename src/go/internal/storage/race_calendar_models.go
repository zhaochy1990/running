package storage

import "time"

// RaceCalendarEvent is one race in an externally-sourced race calendar
// (currently the World Athletics label road races, source value 国际田联)
// mirrored into MySQL by the race_calendar_sync pipeline. It is a system
// table — there is no user_id.
//
// Identity is (source, name, race_date): the same race name on the same date
// from the same source is one row. race_date carries the year, so no separate
// year column exists (query a year with race_date LIKE "2026-%"). race_date is
// part of the key because upstream can list two genuinely different races with
// the same name in one year (e.g. two "Medio Maraton Sevilla" half marathons),
// while a same-name same-date duplicate listing is correctly merged. There is
// deliberately no upstream event id, so a race is identified purely by its
// business key; an upstream rename or re-date becomes a delete + insert on the
// next sync.
//
// RaceDate is a plain calendar date ("2006-01-02") with no instant, so it must
// never undergo a timezone conversion (same discipline as RaceGoal.RaceDate).
// Month/DayOfMonth are derived from RaceDate at write time so a "races in
// March" query is a plain indexed equality.
//
// NameCN is the Chinese name. The upstream only provides English, so it stays
// NULL until an app-side/curated value exists, and the sync never overwrites
// it (it is excluded from the upsert update columns).
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
// undeterminable is ["Unknown"] — no name-pattern guessing. Timestamps are UTC.
type RaceCalendarEvent struct {
	Source     string    `gorm:"column:source;size:32;not null;uniqueIndex:uidx_race_cal_src_name_date,priority:1"`
	Name       string    `gorm:"column:name;size:255;not null;uniqueIndex:uidx_race_cal_src_name_date,priority:2"`
	NameCN     *string   `gorm:"column:name_cn;size:255"`
	RaceDate   string    `gorm:"column:race_date;size:10;not null;uniqueIndex:uidx_race_cal_src_name_date,priority:3"`
	Month      int8      `gorm:"column:month;not null"`
	DayOfMonth int8      `gorm:"column:dayofmonth;not null"`
	Country    string    `gorm:"column:country;size:8;not null"`
	Province   *string   `gorm:"column:province;size:64"`
	City       *string   `gorm:"column:city;size:64"`
	Label      *string   `gorm:"column:label;size:32"`
	RaceTypes  *string   `gorm:"column:race_types;size:255"`
	CreatedAt  time.Time `gorm:"column:created_at"`
	UpdatedAt  time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceCalendarEvent) TableName() string { return "race_calendar" }
