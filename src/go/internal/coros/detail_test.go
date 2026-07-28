package coros

import (
	"testing"
	"time"
)

const sampleDetail = `{
  "summary": {
    "name": "Morning Run", "sportType": 100, "startTimestamp": 175000000000,
    "distance": 1000000, "totalTime": 360000, "avgSpeed": 300, "avgHr": 150, "maxHr": 170,
    "avgCadence": 180, "calories": 500000, "trainType": 2, "currentVo2Max": 52.3, "elevGain": 50
  },
  "weather": { "temperature": 215, "humidity": 600 },
  "sportFeelInfo": { "feelType": 2, "sportNote": "felt good" },
  "lapList": [ { "type": 10, "lapItemList": [ { "distance": 100000, "time": 36000, "avgHr": 150 } ] } ],
  "frequencyList": [ { "timestamp": 1, "heart": 140, "verticalStrideRatio": 87, "gpsLat": 311337430, "gpsLon": 1210000000 } ],
  "zoneList": [ { "zoneType": 0, "list": [ { "min": 0, "max": 120, "duration": 60, "percent": 25 } ] } ]
}`

func TestParseActivityDetail(t *testing.T) {
	const uid = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
	a, laps, ts, zones, err := ParseActivityDetail(uid, "L1", time.Time{}, []byte(sampleDetail))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	// activity scalar conversions
	if a.UserID != uid || a.LabelID != "L1" {
		t.Errorf("identity = %s/%s", a.UserID, a.LabelID)
	}
	if a.SportType != 100 || deref(a.Sport) != "run_outdoor" {
		t.Errorf("sport = %d/%q", a.SportType, deref(a.Sport))
	}
	if got := derefFl(a.DistanceM); got != 10000 {
		t.Errorf("distance_m = %v, want 10000 (cm→m)", got)
	}
	if got := derefFl(a.DurationS); got != 3600 {
		t.Errorf("duration_s = %v, want 3600 (cs→s)", got)
	}
	wantDate := time.Unix(1750000000, 0).UTC()
	if !a.Date.Equal(wantDate) {
		t.Errorf("date = %v, want %v", a.Date, wantDate)
	}
	if deref(a.TrainKind) != "aerobic" {
		t.Errorf("train_kind = %q, want aerobic", deref(a.TrainKind))
	}
	if deref(a.Feel) != "good" {
		t.Errorf("feel = %q, want good", deref(a.Feel))
	}
	if got := derefFl(a.Temperature); got != 21.5 {
		t.Errorf("temperature = %v, want 21.5 (×10)", got)
	}
	if got := derefFl(a.Humidity); got != 60 {
		t.Errorf("humidity = %v, want 60", got)
	}
	if a.CaloriesKcal == nil || *a.CaloriesKcal != 500 {
		t.Errorf("calories_kcal = %v, want 500 (/1000)", a.CaloriesKcal)
	}
	if got := derefFl(a.VO2Max); got != 52.3 {
		t.Errorf("vo2max = %v, want 52.3", got)
	}
	if a.Provider != "coros" {
		t.Errorf("provider = %q", a.Provider)
	}

	// laps
	if len(laps) != 1 {
		t.Fatalf("laps = %d, want 1", len(laps))
	}
	if laps[0].LapType != "autoKm" || laps[0].LapIndex != 1 {
		t.Errorf("lap type/index = %q/%d", laps[0].LapType, laps[0].LapIndex)
	}
	if got := derefFl(laps[0].DistanceM); got != 1000 {
		t.Errorf("lap distance_m = %v, want 1000", got)
	}
	if got := derefFl(laps[0].DurationS); got != 360 {
		t.Errorf("lap duration_s = %v, want 360", got)
	}

	// timeseries
	if len(ts) != 1 {
		t.Fatalf("timeseries = %d, want 1", len(ts))
	}
	if got := derefFl(ts[0].VerticalRatioPct); got != 8.7 {
		t.Errorf("vertical_ratio_pct = %v, want 8.7 (÷10)", got)
	}
	if got := derefFl(ts[0].GPSLat); !approx(got, 31.133743) {
		t.Errorf("gps_lat = %v, want 31.133743", got)
	}
	if got := derefFl(ts[0].GPSLon); !approx(got, 121.0) {
		t.Errorf("gps_lon = %v, want 121.0", got)
	}

	// watch zones (ADR 0007): raw preserved, decoded best-effort
	if len(zones) != 1 {
		t.Fatalf("watch zones = %d, want 1", len(zones))
	}
	z := zones[0]
	if z.ZoneTypeRaw != 0 || z.ZoneType != "pace" || z.ZoneIndex != 1 {
		t.Errorf("zone raw/type/index = %d/%q/%d", z.ZoneTypeRaw, z.ZoneType, z.ZoneIndex)
	}
	if derefFl(z.RangeMax) != 120 || z.DurationS == nil || *z.DurationS != 60 || derefFl(z.Percent) != 25 {
		t.Errorf("zone values: max=%v dur=%v pct=%v", z.RangeMax, z.DurationS, z.Percent)
	}
}

func TestParseActivityDetailFallbackDate(t *testing.T) {
	fallback := time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC)
	a, _, _, _, err := ParseActivityDetail("f10bc353-01ab-4db1-af9f-d9305ea9a532", "L2", fallback,
		[]byte(`{"summary":{"sportType":100}}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !a.Date.Equal(fallback) {
		t.Errorf("date = %v, want fallback %v when startTimestamp absent", a.Date, fallback)
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func derefFl(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
