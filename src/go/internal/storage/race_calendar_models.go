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
	DayOfMonth     int8     `gorm:"column:dayofmonth;not null"`
	Country        string   `gorm:"column:country;size:8;not null"`
	Province       *string  `gorm:"column:province;size:64"`
	City           *string  `gorm:"column:city;size:64"`
	Label          *string  `gorm:"column:label;size:32"`
	RaceTypes      *string  `gorm:"column:race_types;size:255"`
	Origin         string   `gorm:"column:origin;size:16;not null;default:sync"`
	AdminOverrides []string `gorm:"column:admin_overrides;type:json;serializer:json"`

	// The six admin-maintained content sections live on the same row as the
	// calendar mirror (one race = one row, consumed as a whole downstream).
	// They are the same name_cn-class invariant as the overrides above: the
	// sync NEVER writes them — they are absent from raceCalendarUpsertCols, so
	// an OnConflict merge leaves them untouched and a fresh insert takes NULL.
	// What the sync DOES do is protect them at stale-delete time: a stale row
	// carrying content is flagged ContentStale instead of being deleted (see
	// ReplaceRaceCalendarYear).
	PartitionRule  *RacePartitionRule  `gorm:"column:partition_rule;type:json;serializer:json"`
	SignupTimeline *RaceSignupTimeline `gorm:"column:signup_timeline;type:json;serializer:json"`
	SignupChannels []RaceSignupChannel `gorm:"column:signup_channels;type:json;serializer:json"`
	PacketPickup   []RacePacketPickup  `gorm:"column:packet_pickup;type:json;serializer:json"`
	// Climate and WeatherWindows are the race-period weather picture (moved
	// from city level — a city hosts races in different months, so the
	// season-agnostic city climate was replaced by per-race climatology keyed
	// to the race date).
	Climate        *RaceClimate        `gorm:"column:climate;type:json;serializer:json"`
	WeatherWindows []RaceWeatherWindow `gorm:"column:weather_windows;type:json;serializer:json"`
	// ContentStale marks a row the upstream no longer lists but that carries
	// admin-maintained content, so the stale-delete kept it. An administrator
	// resolves it via the stale list (move the content to the fresh row, or
	// delete the row); the flag clears when upstream re-lists the key.
	ContentStale bool `gorm:"column:content_stale;not null;default:false"`

	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceCalendarEvent) TableName() string { return "race_calendar" }

// HasContent reports whether the event row carries any of the six admin
// content sections. Admin data on the event's items is not part of this check —
// the stale scan consults RaceCalendarItem.HasAdminData separately.
func (row RaceCalendarEvent) HasContent() bool {
	return row.PartitionRule != nil ||
		row.SignupTimeline != nil ||
		row.Climate != nil ||
		len(row.SignupChannels) > 0 ||
		len(row.PacketPickup) > 0 ||
		len(row.WeatherWindows) > 0
}

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
// the full marathon and half marathon of one event). It carries both the
// upstream-supplied segments and the finer details an external calendar does not
// reliably provide — start time, entry fee, quota — plus the whole per-distance
// content asset (course profile, aid stations, cutoffs…, user stories 14-22).
// 项目 is a first-class content entity: everything here is per-distance because
// that is how runners evaluate a race.
//
// Identity is (race_event_id, name): one item name per event. Only the 中国田协
// source produces sync items (its upstream raceItem list is a list of event
// names); the World Athletics source has no item-level data and leaves the child
// table empty for its rows.
//
// Type is a token from the shared internal/racetypes vocabulary. StartTime is a
// wall-clock "HH:MM" (no instant, never timezone-converted); EntryFee is in
// fen/cents (the smallest unit) and defaults to CNY.
//
// Provenance mirrors the event row exactly: Origin plus AdminOverrides, merged
// per field by ReplaceRaceCalendarItems. Editing name (the identity key) detaches
// the row to origin='manual'; editing any other sync-managed field records it in
// AdminOverrides instead. StartTime/EntryFee/Quota are NOT sync-managed (中国田协
// never supplies them), so they are absent from raceCalendarItemUpsertCols: the
// sync can never overwrite what an administrator fills in there.
//
// The ten course-content columns are the item-level counterpart of the event's
// six content sections: same invariant, the sync NEVER writes them, and the
// stale-delete flags ContentStale instead of deleting a row carrying them.
type RaceCalendarItem struct {
	ID          uint64  `gorm:"column:id;primaryKey;autoIncrement"`
	RaceEventID uint64  `gorm:"column:race_event_id;not null;uniqueIndex:uidx_race_cal_item_event_name,priority:1"`
	Name        string  `gorm:"column:name;size:255;not null;uniqueIndex:uidx_race_cal_item_event_name,priority:2"`
	Type        string  `gorm:"column:type;size:32;not null"`
	StartTime   *string `gorm:"column:start_time;size:8"`
	EntryFee    *int    `gorm:"column:entry_fee"`
	Quota       *int    `gorm:"column:quota"`
	Origin      string  `gorm:"column:origin;size:16;not null;default:sync"`

	AdminOverrides []string `gorm:"column:admin_overrides;type:json;serializer:json"`

	DistanceKm      *float64             `gorm:"column:distance_km"`
	StartPoint      *RacePoint           `gorm:"column:start_point;type:json;serializer:json"`
	FinishPoint     *RacePoint           `gorm:"column:finish_point;type:json;serializer:json"`
	TotalAscentM    *int                 `gorm:"column:total_ascent_m"`
	ElevationPoints []RaceElevationPoint `gorm:"column:elevation_points;type:json;serializer:json"`
	AidStations     []RaceAidStation     `gorm:"column:aid_stations;type:json;serializer:json"`
	Cutoffs         []RaceCutoff         `gorm:"column:cutoffs;type:json;serializer:json"`
	Prizes          []RacePrize          `gorm:"column:prizes;type:json;serializer:json"`
	Reputation      *RaceReputation      `gorm:"column:reputation;type:json;serializer:json"`
	Photos          []RacePhoto          `gorm:"column:photos;type:json;serializer:json"`

	// ContentStale marks an item the upstream no longer lists but that carries
	// admin-maintained data, so the stale-delete kept it. Same meaning as the
	// event-level flag, and it clears the same way: when upstream re-lists the
	// name, the merge's upsert writes content_stale=false.
	ContentStale bool `gorm:"column:content_stale;not null;default:false"`

	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceCalendarItem) TableName() string { return "race_calendar_item" }

// HasContent reports whether the item carries any of the ten per-distance
// content columns. MoveRaceContent uses it to refuse a target that already
// carries content of its own.
func (row RaceCalendarItem) HasContent() bool {
	return row.DistanceKm != nil ||
		row.StartPoint != nil ||
		row.FinishPoint != nil ||
		row.TotalAscentM != nil ||
		len(row.ElevationPoints) > 0 ||
		len(row.AidStations) > 0 ||
		len(row.Cutoffs) > 0 ||
		len(row.Prizes) > 0 ||
		row.Reputation != nil ||
		len(row.Photos) > 0
}

// HasAdminData reports whether an administrator has contributed anything at all
// to the item — content, one of the entry fields the upstream never supplies, a
// field override, or a full detach. Any of them makes the row survive the sync's
// stale-delete (and keeps its event from being deleted out from under it).
func (row RaceCalendarItem) HasAdminData() bool {
	return row.Origin == RaceOriginManual ||
		len(row.AdminOverrides) > 0 ||
		row.StartTime != nil || row.EntryFee != nil || row.Quota != nil ||
		row.HasContent()
}

// RaceCalendarItemOverrideableFields are the sync-managed item fields an
// administrator can take over. name (the identity key) is NOT here: editing it
// upgrades the whole row to manual instead of recording a field override.
// StartTime/EntryFee/Quota are not here either — the sync never writes them, so
// there is nothing to override; an administrator simply owns them.
var RaceCalendarItemOverrideableFields = []string{"type"}

// IsRaceCalendarItemOverrideable reports whether field is a valid item
// admin-override field name (used to reject unknown names in a PATCH body).
func IsRaceCalendarItemOverrideable(field string) bool {
	for _, f := range RaceCalendarItemOverrideableFields {
		if f == field {
			return true
		}
	}
	return false
}

// RacePartitionRule is the race-level start-corral arrangement (user story 9).
// Mode is "mixed" (所有项目混合分区) or "by_item" (分项先后出发); Description
// carries the free-text explanation.
type RacePartitionRule struct {
	Mode        string `json:"mode"`
	Description string `json:"description"`
}

// RaceSignupTimeline is the race-level signup window (user story 10). StartAt /
// Deadline / LotteryResultAt are calendar dates ("2006-01-02"), never
// timezone-converted; LotteryResultAt is nil when there is no lottery.
type RaceSignupTimeline struct {
	StartAt         string  `json:"start_at"`
	Deadline        string  `json:"deadline"`
	Lottery         bool    `json:"lottery"`
	LotteryResultAt *string `json:"lottery_result_at"`
}

// RaceSignupChannel is one signup entry point (user story 11). Type is a free
// label (官网 / 公众号 / 合作App); QrCodeURL is optional media, selectable.
type RaceSignupChannel struct {
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	URL       string  `json:"url"`
	QrCodeURL *string `json:"qr_code_url"`
}

// RacePacketPickup is one packet-pickup window (user story 12): when and where
// bibs/packs are collected.
type RacePacketPickup struct {
	Time     string `json:"time"`
	Location string `json:"location"`
}

// RacePoint is a named geographic point (start/finish of a distance, user
// story 14). Lat/Lng are WGS84 decimal degrees, nil when unknown.
type RacePoint struct {
	Name string   `json:"name"`
	Lat  *float64 `json:"lat"`
	Lng  *float64 `json:"lng"`
}

// RaceElevationPoint is one sample on the course profile (user story 15):
// distance along the course and the elevation at that point.
type RaceElevationPoint struct {
	DistanceKm float64 `json:"distance_km"`
	ElevationM int     `json:"elevation_m"`
}

// RaceAidStation is one aid station (user story 17): distance along the course
// plus the supplies offered there (水/能量胶/香蕉…).
type RaceAidStation struct {
	DistanceKm float64  `json:"distance_km"`
	Supplies   []string `json:"supplies"`
}

// RaceCutoff is one cutoff (user story 18): Point names the location ("21K" /
// "终点"), CutoffAt is a wall-clock "HH:MM" on race day (never
// timezone-converted).
type RaceCutoff struct {
	Point      string   `json:"point"`
	DistanceKm *float64 `json:"distance_km"`
	CutoffAt   string   `json:"cutoff_at"`
}

// RacePrize is one prize tier (user story 20): Rank is a display label ("1" /
// "冠军"), Amount is in whole CNY yuan.
type RacePrize struct {
	Rank   string `json:"rank"`
	Amount int    `json:"amount"`
}

// RaceReputation is the curated course reputation (user story 21).
type RaceReputation struct {
	Summary string   `json:"summary"`
	Pros    []string `json:"pros"`
	Cons    []string `json:"cons"`
}

// RaceClimate is the race-period climate note (moved from city level): one
// free-text paragraph describing the climate a runner should expect around the
// race date. A struct keeps every race content section a named JSON object and
// leaves room to grow (generated_at, per-distance notes).
type RaceClimate struct {
	Summary string `json:"summary"`
}

// RaceWeatherWindow is one historical-weather window around the race period
// (moved from city level; the JSON shape is identical to the former
// CityWeatherWindow so previously published snapshots stay readable).
// WindowStart/WindowEnd are "MM-DD" (never timezone-converted); temperatures
// are °C, probabilities/humidity are percent, Wind is free text.
type RaceWeatherWindow struct {
	WindowStart        string   `json:"window_start"`
	WindowEnd          string   `json:"window_end"`
	AvgTempC           *float64 `json:"avg_temp_c"`
	TempHighC          *float64 `json:"temp_high_c"`
	TempLowC           *float64 `json:"temp_low_c"`
	RainProbabilityPct *int     `json:"rain_probability_pct"`
	HumidityPct        *int     `json:"humidity_pct"`
	Wind               *string  `json:"wind"`
}

// RacePhoto is one course photo (user story 22): where along the course it was
// taken plus optional media. URL is optional in the schema but a row without
// one carries no information — the API layer validates it.
type RacePhoto struct {
	DistanceKm *float64 `json:"distance_km"`
	Location   string   `json:"location"`
	URL        string   `json:"url"`
	Caption    string   `json:"caption"`
}
