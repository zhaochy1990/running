package storage

import "time"

// Race content value types (race-level sections, item content, and the shared
// JSON shapes) live in race_calendar_models.go next to the row that carries
// them. This file holds what is left: the city content table.

// RaceCityContent is the admin-maintained content of ONE city (user stories
// 4-8), shared by every race held in that city — 一城一条. City is the Chinese
// city name as stored on race_calendar.city (with administrative suffix, e.g.
// 厦门市), so a race's city links to its city content verbatim.
//
// Like the race content columns this is a content asset the sync never
// touches.一期 only covers Chinese cities; the schema carries no country column
// because the calendar's China rows are the only一期 targets (overseas is二期,
// same shape).
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
