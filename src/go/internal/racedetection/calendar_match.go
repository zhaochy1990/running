package racedetection

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/racetypes"
)

// Calendar matching turns race detection from semantic guessing into factual
// verification: when a candidate activity starts at a calendar item's start
// point around its gun time, the activity IS that race. The comparison runs
// entirely on wall-clock components (local date string plus minutes of local
// day), so no timezone arithmetic is involved: the caller supplies the
// candidate start already converted to Asia/Shanghai, exactly like the
// scoring path.
const (
	// calendarStartMaxDistanceM tolerates GPS drift plus the distance between
	// a rear corral and the start arch of large marathons.
	calendarStartMaxDistanceM = 1_500.0
	// calendarGunEarlyS allows watch activity starts slightly before the
	// recorded gun time (clock skew, self-started warmup keyed into the same
	// activity).
	calendarGunEarlyS = 15 * 60
	// calendarGunLateS tolerates rear-corral crossing: big marathons release
	// the last corrals more than an hour after the elite gun.
	calendarGunLateS = 120 * 60
	// Without a published gun time the matcher only accepts morning starts,
	// when Chinese road races overwhelmingly start. Afternoon races without
	// gun-time data fall through to scoring instead of matching loosely.
	calendarFallbackWindowStartMin = 5 * 60
	calendarFallbackWindowEndMin   = 11*60 + 30
)

// Evidence recorded on each races row: how the race was confirmed.
const (
	// RaceEvidenceCalendarMatch marks a race confirmed deterministically by
	// the calendar matcher (start point + gun-time window + distance band).
	RaceEvidenceCalendarMatch = "calendar_match"
	// RaceEvidenceModelScore marks a race confirmed by the weighted scoring
	// pipeline (LLM semantic assessment plus Go evidence).
	RaceEvidenceModelScore = "model_score"
)

// CalendarItem is the projection of one race_calendar_item row needed for
// deterministic matching. GunTime is the local "HH:MM" start; StartLat and
// StartLng are WGS84 coordinates, nil when the calendar has not been
// geo-enriched yet.
type CalendarItem struct {
	ItemID     int64
	RaceDate   string
	Type       string
	DistanceKM *float64
	GunTime    *string
	StartLat   *float64
	StartLng   *float64
}

// CalendarMatchResult reports which item matched and the diagnostics that
// justified it, for logging and for the races-table mapping.
type CalendarMatchResult struct {
	Item           CalendarItem
	StartDistanceM float64
	// GunOffsetS is the candidate start minus the item gun time in seconds;
	// nil when the item carried no gun time.
	GunOffsetS *int
}

// ConsensusCentroid returns the mean coordinate when at least minCount inputs
// agree within maxSpreadM of each other (maximum pairwise distance). It backs
// the crowd-sourced geo-enrichment of calendar start points: several users'
// watches observing the same race venue.
func ConsensusCentroid(coords []Coordinate, minCount int, maxSpreadM float64) *Coordinate {
	if len(coords) < minCount {
		return nil
	}
	for i := range coords {
		for j := i + 1; j < len(coords); j++ {
			if haversineKM(coords[i], coords[j])*1000 > maxSpreadM {
				return nil
			}
		}
	}
	var latitude, longitude float64
	for _, coord := range coords {
		latitude += coord.Latitude
		longitude += coord.Longitude
	}
	return &Coordinate{Latitude: latitude / float64(len(coords)), Longitude: longitude / float64(len(coords))}
}

// ValidStartCoordinate returns the coordinate when it is a usable GPS fix,
// or nil. It is the exported guard for callers holding raw column values.
func ValidStartCoordinate(latitude, longitude float64) *Coordinate {
	if !validCoordinate(latitude, longitude) {
		return nil
	}
	return &Coordinate{Latitude: latitude, Longitude: longitude}
}

// FirstValidCoordinate returns the first usable GPS fix of a trace, or nil.
func FirstValidCoordinate(trace []TracePoint) *Coordinate {
	for _, point := range trace {
		if point.Latitude == nil || point.Longitude == nil {
			continue
		}
		if !validCoordinate(*point.Latitude, *point.Longitude) {
			continue
		}
		return &Coordinate{Latitude: *point.Latitude, Longitude: *point.Longitude}
	}
	return nil
}

// MatchCalendarItem deterministically matches one candidate against calendar
// items of its date. A match requires the item's distance band to equal the
// candidate's, the candidate start within calendarStartMaxDistanceM of the
// item start point, and the start time inside the gun-time tolerance (or the
// morning fallback window when no gun time is published). Among multiple
// matches the spatially closest start wins. Candidates without a GPS fix, or
// items without coordinates, never match: spatial verification is mandatory.
func MatchCalendarItem(localStart time.Time, distanceM float64, start *Coordinate, items []CalendarItem) (*CalendarMatchResult, error) {
	if start == nil {
		return nil, nil
	}
	date := localStart.Format("2006-01-02")
	minutes := localStart.Hour()*60 + localStart.Minute()
	var best *CalendarMatchResult
	for _, item := range items {
		if item.RaceDate != date {
			continue
		}
		if !itemMatchesDistanceBand(item, distanceM) {
			continue
		}
		if item.StartLat == nil || item.StartLng == nil || !validCoordinate(*item.StartLat, *item.StartLng) {
			continue
		}
		distance := haversineKM(*start, Coordinate{Latitude: *item.StartLat, Longitude: *item.StartLng}) * 1000
		if distance > calendarStartMaxDistanceM {
			continue
		}
		var gunOffset *int
		if item.GunTime != nil {
			gunMinutes, err := parseClockMinutes(*item.GunTime)
			if err != nil {
				return nil, fmt.Errorf("race detection: calendar item %d gun time %q: %w", item.ItemID, *item.GunTime, err)
			}
			offset := (minutes - gunMinutes) * 60
			if offset < -calendarGunEarlyS || offset > calendarGunLateS {
				continue
			}
			gunOffset = &offset
		} else if minutes < calendarFallbackWindowStartMin || minutes > calendarFallbackWindowEndMin {
			continue
		}
		if best == nil || distance < best.StartDistanceM {
			best = &CalendarMatchResult{Item: item, StartDistanceM: distance, GunOffsetS: gunOffset}
		}
	}
	return best, nil
}

// itemMatchesDistanceBand requires the candidate distance to fall inside the
// band of the item's event type. A published distance_km contradicting the
// type token disables the item entirely rather than being trusted.
func itemMatchesDistanceBand(item CalendarItem, distanceM float64) bool {
	switch item.Type {
	case racetypes.Marathon:
		if item.DistanceKM != nil && *item.DistanceKM > 0 && (*item.DistanceKM < 40 || *item.DistanceKM > 44) {
			return false
		}
		return distanceM >= MarathonMinDistanceM && distanceM <= MarathonMaxDistanceM
	case racetypes.HalfMarathon:
		if item.DistanceKM != nil && *item.DistanceKM > 0 && (*item.DistanceKM < 20 || *item.DistanceKM > 23) {
			return false
		}
		return distanceM >= HalfMarathonMinDistanceM && distanceM <= HalfMarathonMaxDistanceM
	default:
		return false
	}
}

func parseClockMinutes(clock string) (int, error) {
	parts := strings.Split(strings.TrimSpace(clock), ":")
	if len(parts) != 2 || len(parts[0]) != 2 || len(parts[1]) != 2 {
		return 0, fmt.Errorf("expected zero-padded HH:MM, got %q", clock)
	}
	hour, err := strconv.Atoi(parts[0])
	if err != nil || hour < 0 || hour > 23 {
		return 0, fmt.Errorf("invalid hour in %q", clock)
	}
	minute, err := strconv.Atoi(parts[1])
	if err != nil || minute < 0 || minute > 59 {
		return 0, fmt.Errorf("invalid minute in %q", clock)
	}
	return hour*60 + minute, nil
}
