package storage

import "time"

// Race content is admin-maintained with NO lifecycle: an admin edit is the
// content (save = live). There is no draft/published gate and no version
// history — the feature never shipped with consumers of either, and the
// overhead was dropped before launch.

// RaceContent is the admin-maintained structured content of ONE race event
// (issue #318 赛事级内容). It is a content asset, not a calendar mirror row: the
// upstream sync (ReplaceRaceCalendarYear / ReplaceRaceCalendarItems) never
// touches this table — the same name_cn-class invariant as admin overrides.
//
// Attachment identity. A content row is attached to a RaceCalendarEvent either
// by RaceEventID (the live link) or, when the link is broken, by the business
// key snapshot (Source, RaceName, RaceDate) copied from the event at attach
// time. The upstream sync identifies events by that same business key and can
// delete+insert a row on rename/reschedule; when that happens the content row
// survives untouched (it is never written by the sync) and is re-attachable:
// a rescheduled race keeps its (source, name) but gets a new date, so the
// lookup falls back to the orphan list and an administrator re-links it via
// AttachRaceContent. RaceDate is part of the snapshot key because the calendar
// allows two same-name races in one year (different dates) — see
// RaceCalendarEvent.
//
// The race-level fields are deliberately the ones the spec assigns to the race
// (not per distance): partition rules, signup timeline, signup channels and
// packet pickup. Per-distance content lives in RaceContentItem.
type RaceContent struct {
	ID uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	// RaceEventID is the live link to race_calendar.id. NULL means the link is
	// broken (upstream renamed/rescheduled the race) or not yet attached. The
	// index is unique: one content row per live event. MySQL permits many NULLs
	// in a unique index, which is exactly what the orphan list needs.
	RaceEventID *uint64 `gorm:"column:race_event_id;uniqueIndex:uidx_race_content_event"`
	Source      string  `gorm:"column:source;size:32;not null;uniqueIndex:uidx_race_content_biz,priority:1"`
	RaceName    string  `gorm:"column:race_name;size:255;not null;uniqueIndex:uidx_race_content_biz,priority:2"`
	RaceDate    string  `gorm:"column:race_date;size:10;not null;uniqueIndex:uidx_race_content_biz,priority:3"`
	// Year is derived from RaceDate at write time (the calendar year of the
	// event) so the dashboard can group/filter without string slicing.
	Year int `gorm:"column:year;not null;index:idx_race_content_year"`

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

	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceContent) TableName() string { return "race_content" }

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

// RaceContentItem is the admin-maintained structured content of ONE race
// distance (全程/半马/迷你马…) of one race event (user stories 14-22). 项目 is a
// first-class content entity: everything here is per-distance because that is
// how runners evaluate a race.
//
// Identity is (race_content_id, item_name): the item name must match the
// RaceCalendarItem.Name of the corresponding calendar row (e.g. 全程马拉松).
// Keying by name — not by race_calendar_item.id — is what makes the content
// survive the sync's delete+insert of sync items: the upstream item ids churn,
// the names do not.
type RaceContentItem struct {
	ID            uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	RaceContentID uint64 `gorm:"column:race_content_id;not null;uniqueIndex:uidx_race_content_item,priority:1"`
	ItemName      string `gorm:"column:item_name;size:255;not null;uniqueIndex:uidx_race_content_item,priority:2"`

	DistanceKm      *float64             `gorm:"column:distance_km"`
	StartPoint      *RacePoint           `gorm:"column:start_point;type:json;serializer:json"`
	FinishPoint     *RacePoint           `gorm:"column:finish_point;type:json;serializer:json"`
	TotalAscentM    *int                 `gorm:"column:total_ascent_m"`
	ElevationPoints []RaceElevationPoint `gorm:"column:elevation_points;type:json;serializer:json"`
	Quota           *int                 `gorm:"column:quota"`
	AidStations     []RaceAidStation     `gorm:"column:aid_stations;type:json;serializer:json"`
	Cutoffs         []RaceCutoff         `gorm:"column:cutoffs;type:json;serializer:json"`
	// EntryFee is in whole CNY yuan (the dashboard form's unit; the calendar
	// row's fen-level EntryFee stays untouched by content).
	EntryFee   *int            `gorm:"column:entry_fee"`
	Prizes     []RacePrize     `gorm:"column:prizes;type:json;serializer:json"`
	Reputation *RaceReputation `gorm:"column:reputation;type:json;serializer:json"`
	Photos     []RacePhoto     `gorm:"column:photos;type:json;serializer:json"`

	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceContentItem) TableName() string { return "race_content_item" }

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
// race date. A struct keeps every RaceContent section a named JSON object and
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

// RaceCityContent is the admin-maintained content of ONE city (user stories
// 4-8), shared by every race held in that city — 一城一条. City is the Chinese
// city name as stored on race_calendar.city (with administrative suffix, e.g.
// 厦门市), so a race's city links to its city content verbatim.
//
// Like RaceContent this is a content asset the sync never touches.一期 only
// covers Chinese cities; the schema carries no country column because the
// calendar's China rows are the only一期 targets (overseas is二期, same shape).
type RaceCityContent struct {
	ID       uint64  `gorm:"column:id;primaryKey;autoIncrement"`
	City     string  `gorm:"column:city;size:64;not null;uniqueIndex:uidx_race_city_content_city"`
	Province *string `gorm:"column:province;size:64"`

	// Intro is the four rich-text columns of the city introduction (user story
	// 4): 风土人情/吃喝/历史/特色景点总览.
	Intro       *CityIntro       `gorm:"column:intro;type:json;serializer:json"`
	Attractions []CityAttraction `gorm:"column:attractions;type:json;serializer:json"`

	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (RaceCityContent) TableName() string { return "race_city_content" }

// CityIntro is the four rich-text sections of a city introduction (user story
// 4).一期 stores plain text/HTML from the dashboard textareas.
type CityIntro struct {
	Overview string `json:"overview"`
	Culture  string `json:"culture"`
	Food     string `json:"food"`
	History  string `json:"history"`
}

// CityAttraction is one featured spot (user story 6): name, blurb, optional
// image.
type CityAttraction struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	ImageURL    *string `json:"image_url"`
}
