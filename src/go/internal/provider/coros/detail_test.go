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
  "zoneList": [
    { "zoneType": 0, "type": 130, "zoneItemList": [ { "leftScope": 300000, "rightScope": 240000, "second": 60, "percent": 25 } ] },
    { "zoneType": 3, "type": 126, "zoneItemList": [ { "leftScope": 140, "rightScope": 150, "second": 90, "percent": 40 } ] }
  ]
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
	if got := derefFl(a.Feel); got != 4 {
		t.Errorf("feel = %v, want 4 (feelType 2 ×2)", got)
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

	// watch zones (ADR 0007): real COROS keys (zoneItemList/leftScope/rightScope/
	// second), raw zoneType preserved, decoded label + unit best-effort.
	if len(zones) != 2 {
		t.Fatalf("watch zones = %d, want 2", len(zones))
	}
	pace := zones[0]
	if pace.ZoneTypeRaw != 0 || pace.ZoneType != "pace" || pace.ZoneIndex != 1 {
		t.Errorf("pace zone raw/type/index = %d/%q/%d", pace.ZoneTypeRaw, pace.ZoneType, pace.ZoneIndex)
	}
	if derefFl(pace.RangeMin) != 300000 || derefFl(pace.RangeMax) != 240000 ||
		deref(pace.RangeUnit) != "ms/km" || pace.DurationS == nil || *pace.DurationS != 60 ||
		derefFl(pace.Percent) != 25 {
		t.Errorf("pace zone values: min=%v max=%v unit=%q dur=%v pct=%v",
			pace.RangeMin, pace.RangeMax, deref(pace.RangeUnit), pace.DurationS, pace.Percent)
	}
	hr := zones[1]
	if hr.ZoneTypeRaw != 3 || hr.ZoneType != "heartRate" || deref(hr.RangeUnit) != "bpm" {
		t.Errorf("hr zone raw/type/unit = %d/%q/%q", hr.ZoneTypeRaw, hr.ZoneType, deref(hr.RangeUnit))
	}
	if hr.DurationS == nil || *hr.DurationS != 90 || derefFl(hr.Percent) != 40 {
		t.Errorf("hr zone dur/pct = %v/%v", hr.DurationS, hr.Percent)
	}
}

func TestParseActivityDetailZeroCodesStayNull(t *testing.T) {
	// COROS reports trainType/feelType == 0 for untagged/unrated activities; they
	// must stay NULL (matching Python truthiness), not map to "unknown". This is
	// the parity bug the live reconciliation caught.
	a, _, _, _, err := ParseActivityDetail("f10bc353-01ab-4db1-af9f-d9305ea9a532", "L0", time.Time{},
		[]byte(`{"summary":{"sportType":100,"trainType":0},"sportFeelInfo":{"feelType":0}}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if a.TrainKind != nil {
		t.Errorf("train_kind = %v, want nil for trainType 0", *a.TrainKind)
	}
	if a.Feel != nil {
		t.Errorf("feel = %v, want nil for feelType 0", *a.Feel)
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
