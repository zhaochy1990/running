package garmin

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/normalize"
)

const testUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

func mustActivity(t *testing.T, js string) rawActivity {
	t.Helper()
	var a rawActivity
	if err := json.Unmarshal([]byte(js), &a); err != nil {
		t.Fatalf("decode activity: %v", err)
	}
	return a
}

func TestBuildActivity(t *testing.T) {
	a := mustActivity(t, `{
		"activityId": 987654321,
		"activityName": "Morning Run",
		"activityType": {"typeKey": "running"},
		"startTimeGMT": "2026-05-09 23:30:00",
		"distance": 10005.7, "duration": 3000.0,
		"averageSpeed": 3.333, "maxSpeed": 5.0,
		"averageHR": 152.4, "maxHR": 176.0,
		"averageRunningCadenceInStepsPerMinute": 172.6,
		"calories": 640.0,
		"vO2MaxValue": 54.0,
		"trainingEffectLabel": "TEMPO",
		"feel": 75,
		"avgVerticalOscillation": 8.2
	}`)
	weather := &rawWeather{Temp: fptr(18.5), RelativeHumidity: fptr(60), ApparentTemp: fptr(19.0), WindSpeed: fptr(3.0)}

	act := buildActivity(testUID, a, weather)

	if act.LabelID != "987654321" {
		t.Errorf("labelID = %q", act.LabelID)
	}
	if act.SportType != 8001 {
		t.Errorf("sportType = %d, want 8001", act.SportType)
	}
	if act.SportName == nil || *act.SportName != "running" {
		t.Errorf("sportName = %v, want running", act.SportName)
	}
	if act.Provider != "garmin" {
		t.Errorf("provider = %q", act.Provider)
	}
	if act.Sport == nil || *act.Sport != string(normalize.SportRunOutdoor) {
		t.Errorf("sport = %v, want run_outdoor", act.Sport)
	}
	if act.TrainKind == nil || *act.TrainKind != string(normalize.TrainTempo) {
		t.Errorf("trainKind = %v, want tempo", act.TrainKind)
	}
	if act.TrainType == nil || *act.TrainType != "TEMPO" {
		t.Errorf("trainType = %v, want TEMPO", act.TrainType)
	}
	if act.Feel == nil || *act.Feel != string(normalize.FeelGood) {
		t.Errorf("feel = %v, want good (75)", act.Feel)
	}
	if act.DistanceM == nil || math.Abs(*act.DistanceM-10005.7) > 1e-6 {
		t.Errorf("distance = %v, want 10005.7", act.DistanceM)
	}
	if act.AvgPaceSKm == nil || math.Abs(*act.AvgPaceSKm-300.03) > 0.1 {
		t.Errorf("avgPace = %v, want ~300 s/km", act.AvgPaceSKm)
	}
	if act.AvgHR == nil || *act.AvgHR != 152 {
		t.Errorf("avgHR = %v, want 152", act.AvgHR)
	}
	if act.AvgCadence == nil || *act.AvgCadence != 172 {
		t.Errorf("avgCadence = %v, want 172 (int() truncation of 172.6)", act.AvgCadence)
	}
	if act.Temperature == nil || *act.Temperature != 18.5 {
		t.Errorf("temperature = %v, want 18.5", act.Temperature)
	}
	if act.Date.IsZero() || act.Date.Format("2006-01-02 15:04:05") != "2026-05-09 23:30:00" {
		t.Errorf("date = %v, want 2026-05-09 23:30:00 UTC", act.Date)
	}
}

func TestBuildActivity_MissingDistanceDurationCoerced(t *testing.T) {
	// Missing distance/duration must coerce to 0.0 (never NULL), matching Python.
	a := mustActivity(t, `{"activityId": 42, "activityType": {"typeKey": "strength_training"}, "startTimeGMT": "2026-01-01 00:00:00"}`)
	act := buildActivity(testUID, a, nil)
	if act.DistanceM == nil || *act.DistanceM != 0.0 {
		t.Errorf("missing distance = %v, want 0.0", act.DistanceM)
	}
	if act.DurationS == nil || *act.DurationS != 0.0 {
		t.Errorf("missing duration = %v, want 0.0", act.DurationS)
	}
}

func TestParseLactate(t *testing.T) {
	// Real endpoint shape: an array (speed and HR may be split across entries).
	sp, hr := parseLactate(json.RawMessage(`[{"speed":0.44},{"heartRate":168}]`))
	if sp == nil || *sp != 0.44 || hr == nil || *hr != 168 {
		t.Errorf("array parse: speed=%v hr=%v, want 0.44/168", sp, hr)
	}
	// Historical typo `hearRate` is accepted.
	_, hr2 := parseLactate(json.RawMessage(`[{"hearRate":170}]`))
	if hr2 == nil || *hr2 != 170 {
		t.Errorf("hearRate typo: hr=%v, want 170", hr2)
	}
	// Single-object fallback still works.
	sp3, hr3 := parseLactate(json.RawMessage(`{"speed":0.5,"heartRate":160}`))
	if sp3 == nil || *sp3 != 0.5 || hr3 == nil || *hr3 != 160 {
		t.Errorf("object fallback: speed=%v hr=%v", sp3, hr3)
	}
}

func TestBuildDailyHealth_ZeroDistanceNil(t *testing.T) {
	// A present totalDistanceMeters of 0 maps to NULL (Python truthiness).
	h := buildDailyHealth(testUID, "2026-05-09", nil,
		json.RawMessage(`{"restingHeartRate":50,"totalDistanceMeters":0}`), nil)
	if h.DistanceM != nil {
		t.Errorf("zero distance = %v, want nil", h.DistanceM)
	}
}

func TestBuildActivity_UnknownSport(t *testing.T) {
	a := mustActivity(t, `{"activityId": 1, "activityType": {"typeKey": "quidditch"}, "startTimeGMT": "2026-01-01 00:00:00"}`)
	act := buildActivity(testUID, a, nil)
	if act.SportType != garminSportTypeBase {
		t.Errorf("unknown sportType = %d, want base", act.SportType)
	}
	if act.Sport == nil || *act.Sport != string(normalize.SportUnknown) {
		t.Errorf("unknown sport = %v, want unknown", act.Sport)
	}
}

func TestParseSplits(t *testing.T) {
	laps := parseSplits(json.RawMessage(`{"lapDTOs":[
		{"lapIndex":1,"distance":1000.0,"duration":300.0,"averageSpeed":3.33,"averageHR":150.0},
		{"lapIndex":2,"distance":1000.0,"duration":295.0,"averageSpeed":3.39,"averageHR":155.0}
	]}`))
	if len(laps) != 2 {
		t.Fatalf("laps = %d, want 2", len(laps))
	}
	if laps[0].LapType != "autoKm" || laps[0].LapIndex != 1 {
		t.Errorf("lap0 = %+v", laps[0])
	}
	if laps[1].AvgHR == nil || *laps[1].AvgHR != 155 {
		t.Errorf("lap1 avgHR = %v, want 155", laps[1].AvgHR)
	}
}

func TestParseDetailsTimeseries(t *testing.T) {
	raw := json.RawMessage(`{
		"metricDescriptors":[
			{"key":"sumElapsedDuration","metricsIndex":0},
			{"key":"directHeartRate","metricsIndex":1},
			{"key":"directSpeed","metricsIndex":2}
		],
		"activityDetailMetrics":[
			{"metrics":[10.0,150.0,4.0]},
			{"metrics":[20.0,155.0,0.0]}
		]
	}`)
	ts := parseDetailsTimeseries(raw)
	if len(ts) != 2 {
		t.Fatalf("points = %d, want 2", len(ts))
	}
	if ts[0].Timestamp == nil || *ts[0].Timestamp != 1000 {
		t.Errorf("ts0 timestamp = %v, want 1000 (centiseconds)", ts[0].Timestamp)
	}
	if ts[0].HeartRate == nil || *ts[0].HeartRate != 150 {
		t.Errorf("ts0 hr = %v, want 150", ts[0].HeartRate)
	}
	if ts[0].Speed == nil || math.Abs(*ts[0].Speed-250.0) > 1e-6 {
		t.Errorf("ts0 speed(pace) = %v, want 250", ts[0].Speed)
	}
	// second point has speed 0 → nil pace
	if ts[1].Speed != nil {
		t.Errorf("ts1 speed = %v, want nil (0 m/s)", ts[1].Speed)
	}
}

func TestBuildDailyHealth(t *testing.T) {
	ts := json.RawMessage(`{"mostRecentTrainingStatus":{"latestTrainingStatusData":{
		"dev1":{"primaryTrainingDevice":true,"acuteTrainingLoadDTO":{
			"dailyTrainingLoadAcute":300.0,"dailyTrainingLoadChronic":200.0,
			"dailyAcuteChronicWorkloadRatio":1.4,"acwrStatus":"OPTIMAL"}}}}}`)
	us := json.RawMessage(`{"restingHeartRate":44,"totalDistanceMeters":8000.4,
		"bodyBatteryHighestValue":92,"bodyBatteryLowestValue":18,"averageStressLevel":33,
		"avgWakingRespirationValue":14.2,"averageSpo2":97}`)
	sleep := json.RawMessage(`{"dailySleepDTO":{"sleepTimeSeconds":27000,"deepSleepSeconds":6000,
		"lightSleepSeconds":15000,"remSleepSeconds":5000,"awakeSleepSeconds":1000,
		"sleepScores":{"overall":{"value":82}}}}`)

	h := buildDailyHealth(testUID, "2026-05-09", ts, us, sleep)

	if h.ATI == nil || *h.ATI != 300 || h.CTI == nil || *h.CTI != 200 {
		t.Errorf("ati/cti = %v/%v", h.ATI, h.CTI)
	}
	// ratio should be the precise 300/200 = 1.5, not the reported 1.4
	if h.TrainingLoadRatio == nil || math.Abs(*h.TrainingLoadRatio-1.5) > 1e-9 {
		t.Errorf("ratio = %v, want 1.5 (precise quotient)", h.TrainingLoadRatio)
	}
	// fatigue from ratio 1.5 → 60
	if h.Fatigue == nil || *h.Fatigue != 60.0 {
		t.Errorf("fatigue = %v, want 60", h.Fatigue)
	}
	if h.TrainingLoadState == nil || *h.TrainingLoadState != "OPTIMAL" {
		t.Errorf("state = %v, want OPTIMAL", h.TrainingLoadState)
	}
	if h.RHR == nil || *h.RHR != 44 {
		t.Errorf("rhr = %v, want 44", h.RHR)
	}
	if h.BodyBatteryHigh == nil || *h.BodyBatteryHigh != 92 {
		t.Errorf("bb high = %v, want 92", h.BodyBatteryHigh)
	}
	if h.StressAvg == nil || *h.StressAvg != 33 {
		t.Errorf("stress = %v, want 33", h.StressAvg)
	}
	if h.SleepTotalS == nil || *h.SleepTotalS != 27000 {
		t.Errorf("sleep total = %v, want 27000", h.SleepTotalS)
	}
	if h.SleepScore == nil || *h.SleepScore != 82 {
		t.Errorf("sleep score = %v, want 82", h.SleepScore)
	}
	if h.Spo2Avg == nil || *h.Spo2Avg != 97 {
		t.Errorf("spo2 = %v, want 97", h.Spo2Avg)
	}
	if !hasSignal(h) {
		t.Errorf("hasSignal should be true")
	}
}

func TestBuildDailyHealth_StressMinusOne(t *testing.T) {
	// averageStressLevel = -1 means "no data" → nil.
	h := buildDailyHealth(testUID, "2026-05-09", nil,
		json.RawMessage(`{"averageStressLevel":-1,"restingHeartRate":50}`), nil)
	if h.StressAvg != nil {
		t.Errorf("stress = %v, want nil (-1 sentinel)", h.StressAvg)
	}
}

func TestBuildDailyHealth_EmptyNoSignal(t *testing.T) {
	h := buildDailyHealth(testUID, "2026-05-09", nil, nil, nil)
	if hasSignal(h) {
		t.Errorf("empty day should have no signal")
	}
}

func TestBuildDailyHRV(t *testing.T) {
	raw := json.RawMessage(`{"hrvSummary":{"weeklyAvg":65,"lastNightAvg":70,"lastNight5MinHigh":90,
		"status":"BALANCED","feedbackPhrase":"good","baseline":{"balancedLow":55,"balancedUpper":80}}}`)
	h := buildDailyHRV(testUID, "2026-05-09", raw)
	if h.LastNightAvg == nil || *h.LastNightAvg != 70 {
		t.Errorf("lastNightAvg = %v, want 70", h.LastNightAvg)
	}
	if h.Status == nil || *h.Status != "BALANCED" {
		t.Errorf("status = %v", h.Status)
	}
	if !hrvHasSignal(h) {
		t.Errorf("hrvHasSignal should be true")
	}
	if !hrvHasSignal(buildDailyHRV(testUID, "d", json.RawMessage(`{}`))) == false {
		// empty → no signal
		t.Errorf("empty hrv should have no signal")
	}
}

func TestBuildDashboard(t *testing.T) {
	us := json.RawMessage(`{"lastSevenDaysAvgRestingHeartRate":45}`)
	hrv := json.RawMessage(`{"hrvSummary":{"lastNightAvg":68,"baseline":{"balancedLow":55,"balancedUpper":80}}}`)
	lt := json.RawMessage(`[{"heartRate":170,"speed":0.4417}]`)
	rp := json.RawMessage(`{"time5K":1200,"time10K":2500,"timeHalfMarathon":5400,"timeMarathon":11400}`)

	d, preds := buildDashboard(testUID, nil, us, hrv, lt, rp)

	if d.RHR == nil || *d.RHR != 45 {
		t.Errorf("dashboard rhr = %v, want 45", d.RHR)
	}
	if d.ThresholdHR == nil || *d.ThresholdHR != 170 {
		t.Errorf("threshold hr = %v, want 170", d.ThresholdHR)
	}
	// speed 0.4417 *10 = 4.417 m/s → 1000/4.417 ≈ 226.4 s/km
	if d.ThresholdPaceSKm == nil || math.Abs(*d.ThresholdPaceSKm-226.4) > 0.5 {
		t.Errorf("threshold pace = %v, want ~226 s/km (x10 scaling)", d.ThresholdPaceSKm)
	}
	if len(preds) != 4 {
		t.Fatalf("predictions = %d, want 4", len(preds))
	}
	if preds[0].RaceType != "5K" || preds[0].DurationS == nil || *preds[0].DurationS != 1200 {
		t.Errorf("pred0 = %+v", preds[0])
	}
}
