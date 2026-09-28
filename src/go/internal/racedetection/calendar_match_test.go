package racedetection

import (
	"testing"
	"time"
)

// The fixtures below mirror production-verified races: coordinates are the
// actual GPS starts of confirmed races (Beijing Marathon at Tiananmen,
// Shanghai Marathon at the Bund), so the tolerances encoded here are the ones
// real corral offsets and GPS drift required.
func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.ParseInLocation("2006-01-02 15:04:05", value, time.FixedZone("CST", 8*3600))
	if err != nil {
		t.Fatalf("parse %q: %v", value, err)
	}
	return parsed
}

func gunTime(value string) *string { return &value }

func beijingMarathonItem() CalendarItem {
	lat, lng := 39.902, 116.393 // 天安门广场
	return CalendarItem{
		ItemID: 101, RaceDate: "2023-10-29", Type: "Marathon",
		DistanceKM: floatPtr(42.195), GunTime: gunTime("07:30"), StartLat: &lat, StartLng: &lng,
	}
}

func floatPtr(v float64) *float64 { return &v }

func TestMatchCalendarItemConfirmsGunTimeStart(t *testing.T) {
	start := mustTime(t, "2023-10-29 07:29:40")
	match, err := MatchCalendarItem(start, 42_500, &Coordinate{Latitude: 39.9023, Longitude: 116.3928}, []CalendarItem{beijingMarathonItem()})
	if err != nil {
		t.Fatalf("MatchCalendarItem: %v", err)
	}
	if match == nil {
		t.Fatal("expected a match for a start at Tiananmen at gun time")
	}
	if match.Item.ItemID != 101 {
		t.Fatalf("matched item = %d, want 101", match.Item.ItemID)
	}
	if match.GunOffsetS == nil || *match.GunOffsetS < -calendarGunEarlyS || *match.GunOffsetS > calendarGunLateS {
		t.Fatalf("gun offset = %v, want within tolerance", match.GunOffsetS)
	}
}

func TestMatchCalendarItemAllowsRearCorralCrossing(t *testing.T) {
	// D-corral runner crossing 78 minutes after the elite gun still matches.
	start := mustTime(t, "2023-10-29 08:48:00")
	match, err := MatchCalendarItem(start, 42_400, &Coordinate{Latitude: 39.902, Longitude: 116.393}, []CalendarItem{beijingMarathonItem()})
	if err != nil {
		t.Fatalf("MatchCalendarItem: %v", err)
	}
	if match == nil {
		t.Fatal("rear-corral start must match")
	}
}

func TestMatchCalendarItemRejectsLateCourseRecee(t *testing.T) {
	// Running the course at noon, after roads reopen, must not match even
	// from the exact start point.
	start := mustTime(t, "2023-10-29 12:10:00")
	match, err := MatchCalendarItem(start, 42_100, &Coordinate{Latitude: 39.902, Longitude: 116.393}, []CalendarItem{beijingMarathonItem()})
	if err != nil {
		t.Fatalf("MatchCalendarItem: %v", err)
	}
	if match != nil {
		t.Fatalf("noon course reccee matched item %d, want no match", match.Item.ItemID)
	}
}

func TestMatchCalendarItemRejectsWrongDateAndDistance(t *testing.T) {
	item := beijingMarathonItem()
	coord := &Coordinate{Latitude: 39.902, Longitude: 116.393}
	cases := []struct {
		name  string
		start time.Time
		dist  float64
	}{
		{"wrong date", mustTime(t, "2023-10-28 07:30:00"), 42_500},
		{"half distance against marathon item", mustTime(t, "2023-10-29 07:30:00"), 21_400},
	}
	for _, tc := range cases {
		match, err := MatchCalendarItem(tc.start, tc.dist, coord, []CalendarItem{item})
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if match != nil {
			t.Errorf("%s: matched item %d, want no match", tc.name, match.Item.ItemID)
		}
	}
}

func TestMatchCalendarItemRejectsDistantStart(t *testing.T) {
	// A habitual long run starting 8 km from the venue on race morning —
	// the dominant production false-positive profile — must not match.
	start := mustTime(t, "2023-10-29 07:00:00")
	match, err := MatchCalendarItem(start, 42_200, &Coordinate{Latitude: 39.83, Longitude: 116.35}, []CalendarItem{beijingMarathonItem()})
	if err != nil {
		t.Fatalf("MatchCalendarItem: %v", err)
	}
	if match != nil {
		t.Fatalf("far-away start matched item %d, want no match", match.Item.ItemID)
	}
}

func TestMatchCalendarItemRequiresSpatialEvidence(t *testing.T) {
	start := mustTime(t, "2023-10-29 07:30:00")
	item := beijingMarathonItem()

	// Item without geo enrichment never matches, even with date+time+distance.
	noCoords := item
	noCoords.StartLat, noCoords.StartLng = nil, nil
	if match, err := MatchCalendarItem(start, 42_500, &Coordinate{Latitude: 39.902, Longitude: 116.393}, []CalendarItem{noCoords}); err != nil || match != nil {
		t.Fatalf("item without start point matched (%v, %v), want no match", match, err)
	}

	// Candidate without a GPS fix never matches either.
	if match, err := MatchCalendarItem(start, 42_500, nil, []CalendarItem{item}); err != nil || match != nil {
		t.Fatalf("candidate without GPS matched (%v, %v), want no match", match, err)
	}
}

func TestMatchCalendarItemFallbackWindowWithoutGunTime(t *testing.T) {
	item := beijingMarathonItem()
	item.GunTime = nil
	coord := &Coordinate{Latitude: 39.902, Longitude: 116.393}
	earlyMorning := mustTime(t, "2023-10-29 05:45:00")
	afternoon := mustTime(t, "2023-10-29 15:00:00")
	if match, err := MatchCalendarItem(earlyMorning, 42_500, coord, []CalendarItem{item}); err != nil || match == nil {
		t.Fatalf("morning start without gun time should match (%v, %v)", match, err)
	}
	if match, err := MatchCalendarItem(afternoon, 42_500, coord, []CalendarItem{item}); err != nil || match != nil {
		t.Fatalf("afternoon start without gun time matched (%v, %v), want no match", match, err)
	}
}

func TestMatchCalendarItemPicksNearestStart(t *testing.T) {
	// Two half marathons in the same city on the same day: the candidate
	// start sits 200 m from venue B and ~2 km from venue A, so B wins.
	latA, lngA := 31.24, 121.48 // 外滩
	latB, lngB := 31.144, 121.089
	items := []CalendarItem{
		{ItemID: 1, RaceDate: "2024-12-15", Type: "HalfMarathon", GunTime: gunTime("08:00"), StartLat: &latA, StartLng: &lngA},
		{ItemID: 2, RaceDate: "2024-12-15", Type: "HalfMarathon", GunTime: gunTime("08:00"), StartLat: &latB, StartLng: &lngB},
	}
	start := mustTime(t, "2024-12-15 08:02:00")
	match, err := MatchCalendarItem(start, 21_460, &Coordinate{Latitude: 31.1445, Longitude: 121.0905}, items)
	if err != nil {
		t.Fatalf("MatchCalendarItem: %v", err)
	}
	if match == nil || match.Item.ItemID != 2 {
		t.Fatalf("nearest-start selection = %+v, want item 2", match)
	}
}

func TestMatchCalendarItemDistanceKMBandCheck(t *testing.T) {
	// A mislabeled item (type Marathon, distance 21 km) must not admit a
	// marathon candidate: published distance wins over the type token.
	lat, lng := 39.902, 116.393
	item := CalendarItem{ItemID: 9, RaceDate: "2023-10-29", Type: "Marathon", DistanceKM: floatPtr(21.0975), GunTime: gunTime("07:30"), StartLat: &lat, StartLng: &lng}
	match, err := MatchCalendarItem(mustTime(t, "2023-10-29 07:30:00"), 42_500, &Coordinate{Latitude: 39.902, Longitude: 116.393}, []CalendarItem{item})
	if err != nil {
		t.Fatalf("MatchCalendarItem: %v", err)
	}
	if match != nil {
		t.Fatalf("mislabeled item matched marathon candidate, want no match")
	}
}

func TestMatchCalendarItemInvalidGunTimeFails(t *testing.T) {
	lat, lng := 39.902, 116.393
	item := CalendarItem{ItemID: 1, RaceDate: "2023-10-29", Type: "Marathon", GunTime: gunTime("7:5"), StartLat: &lat, StartLng: &lng}
	if _, err := MatchCalendarItem(mustTime(t, "2023-10-29 07:30:00"), 42_500, &Coordinate{Latitude: 39.902, Longitude: 116.393}, []CalendarItem{item}); err == nil {
		t.Fatal("invalid gun time must fail the match, not silently skip")
	}
}

func TestFirstValidCoordinate(t *testing.T) {
	invalid := 0.0
	lat, lng := 30.67, 120.552
	trace := []TracePoint{
		{},
		{Latitude: &invalid, Longitude: &invalid},
		{Latitude: &lat, Longitude: &lng},
	}
	got := FirstValidCoordinate(trace)
	if got == nil || got.Latitude != lat || got.Longitude != lng {
		t.Fatalf("FirstValidCoordinate = %+v, want (%v, %v)", got, lat, lng)
	}
	if FirstValidCoordinate(nil) != nil || FirstValidCoordinate([]TracePoint{{}}) != nil {
		t.Fatal("empty or invalid traces must yield nil")
	}
}
