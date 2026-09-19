package storage

import "time"

// CompetitionCalendarEvent is one entry of an externally-sourced competition
// calendar mirrored into MySQL. Currently the only source is the World
// Athletics label road races calendar, written by the competition_calendar_sync
// pipeline. It is a system table — there is no user_id.
//
// Identity is (source, season, event_id): the same World Athletics event can
// appear in more than one season, and the same table can hold other calendar
// sources later. Rows are a mirror of upstream, so a season sync replaces the
// whole season (see ReplaceCompetitionCalendarSeason).
//
// StartDate/EndDate are plain calendar dates ("2006-01-02") with no instant, so
// they must never undergo a timezone conversion (same discipline as
// RaceGoal.RaceDate). Timestamps are UTC.
type CompetitionCalendarEvent struct {
	Source                    string    `gorm:"column:source;size:64;not null;uniqueIndex:uidx_comp_cal_src_season_id,priority:1"`
	Season                    string    `gorm:"column:season;size:8;not null;uniqueIndex:uidx_comp_cal_src_season_id,priority:2"`
	EventID                   int64     `gorm:"column:event_id;not null;uniqueIndex:uidx_comp_cal_src_season_id,priority:3"`
	IaafID                    *int64    `gorm:"column:iaaf_id"`
	Name                      string    `gorm:"column:name;size:255;not null"`
	Venue                     *string   `gorm:"column:venue;size:255"`
	Country                   *string   `gorm:"column:country;size:8"`
	StartDate                 string    `gorm:"column:start_date;size:10"`
	EndDate                   string    `gorm:"column:end_date;size:10"`
	DateRange                 string    `gorm:"column:date_range;size:64"`
	Disciplines               *string   `gorm:"column:disciplines;size:255"`
	RankingCategory           *string   `gorm:"column:ranking_category;size:16"`
	CompetitionSubgroup       *string   `gorm:"column:competition_subgroup;size:64"`
	HasResults                bool      `gorm:"column:has_results"`
	HasStartlist              bool      `gorm:"column:has_startlist"`
	HasAPIResults             bool      `gorm:"column:has_api_results"`
	HasCompetitionInformation bool      `gorm:"column:has_competition_information"`
	CreatedAt                 time.Time `gorm:"column:created_at"`
	UpdatedAt                 time.Time `gorm:"column:updated_at"`
}

// TableName pins the table name (GORM would otherwise pluralize).
func (CompetitionCalendarEvent) TableName() string { return "competition_calendar" }
