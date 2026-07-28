// models.go converts Garmin Connect API JSON into storage rows. Go port of
// garmin_sync.models (+ apply_to_detail from garmin_sync.normalize). This is the
// single boundary where Garmin's field names and units are normalized; nothing
// above it sees Garmin quirks. Nullable numerics stay pointers so a missing value
// is NULL (not 0), keeping the shadow store comparable with the Python SQLite path.
package garmin

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Activity summary (list endpoint items == get_activity payload)
// ─────────────────────────────────────────────────────────────────────────────

type rawActivity struct {
	ActivityID   json.Number `json:"activityId"`
	ActivityName *string     `json:"activityName"`
	ActivityType struct {
		TypeKey string `json:"typeKey"`
	} `json:"activityType"`
	StartTimeGMT string `json:"startTimeGMT"`

	Distance     *float64 `json:"distance"` // meters
	Duration     *float64 `json:"duration"` // seconds
	AverageSpeed *float64 `json:"averageSpeed"`
	MaxSpeed     *float64 `json:"maxSpeed"`

	AverageHR     *float64 `json:"averageHR"`
	MaxHR         *float64 `json:"maxHR"`
	AvgRunCadence *float64 `json:"averageRunningCadenceInStepsPerMinute"`
	MaxRunCadence *float64 `json:"maxRunningCadenceInStepsPerMinute"`
	AvgPower      *float64 `json:"avgPower"`
	MaxPower      *float64 `json:"maxPower"`

	AvgStrideLength *float64 `json:"avgStrideLength"`
	ElevationGain   *float64 `json:"elevationGain"`
	ElevationLoss   *float64 `json:"elevationLoss"`
	Calories        *float64 `json:"calories"`

	AerobicTE            *float64 `json:"aerobicTrainingEffect"`
	AnaerobicTE          *float64 `json:"anaerobicTrainingEffect"`
	ActivityTrainingLoad *float64 `json:"activityTrainingLoad"`
	VO2MaxValue          *float64 `json:"vO2MaxValue"`
	TrainingEffectLabel  string   `json:"trainingEffectLabel"`

	Feel        *float64 `json:"feel"`
	Description *string  `json:"description"`

	AvgVerticalOscillation *float64 `json:"avgVerticalOscillation"`
	AvgGroundContactTime   *float64 `json:"avgGroundContactTime"`
	AvgVerticalRatio       *float64 `json:"avgVerticalRatio"`
}

func (a rawActivity) labelID() string { return a.ActivityID.String() }

// dateGMT returns the YYYY-MM-DD prefix of startTimeGMT for since-date cutoffs.
func (a rawActivity) dateGMT() string {
	if len(a.StartTimeGMT) >= 10 {
		return a.StartTimeGMT[:10]
	}
	return ""
}

// parseActivityList decodes the activity-list payload into activity summaries.
func parseActivityList(raw json.RawMessage) ([]rawActivity, error) {
	var out []rawActivity
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("garmin: parse activity list: %w", err)
	}
	return out, nil
}

type rawWeather struct {
	Temp             *float64 `json:"temp"`
	RelativeHumidity *float64 `json:"relativeHumidity"`
	ApparentTemp     *float64 `json:"apparentTemp"`
	WindSpeed        *float64 `json:"windSpeed"`
}

// buildActivity converts a Garmin activity summary (+ optional weather) into a
// storage.Activity. Per-activity zones are intentionally empty (time-in-zone is
// computed post-sync from STRIDE calibration, same as COROS).
func buildActivity(userID string, a rawActivity, weather *rawWeather) *storage.Activity {
	typeKey := a.ActivityType.TypeKey
	act := &storage.Activity{
		UserID:    userID,
		LabelID:   a.labelID(),
		Name:      a.ActivityName,
		SportType: syntheticSportType(typeKey),
		SportName: sportNameOrUnknown(typeKey),
		Date:      gmtToISO(a.StartTimeGMT),

		DistanceM:    distanceOrZero(a.Distance),
		DurationS:    durationOrZero(a.Duration),
		AvgPaceSKm:   msToPaceSKm(a.AverageSpeed),
		MaxPace:      msToPaceSKm(a.MaxSpeed),
		AvgHR:        itrunc(a.AverageHR),
		MaxHR:        itrunc(a.MaxHR),
		AvgCadence:   itrunc(a.AvgRunCadence),
		MaxCadence:   itrunc(a.MaxRunCadence),
		AvgPower:     itrunc(a.AvgPower),
		MaxPower:     itrunc(a.MaxPower),
		AvgStepLenCm: a.AvgStrideLength,
		AscentM:      a.ElevationGain,
		DescentM:     a.ElevationLoss,
		CaloriesKcal: itrunc(a.Calories),

		AerobicEffect:   a.AerobicTE,
		AnaerobicEffect: a.AnaerobicTE,
		TrainingLoad:    a.ActivityTrainingLoad,
		VO2Max:          a.VO2MaxValue,

		VerticalOscillationMm: a.AvgVerticalOscillation,
		GroundContactTimeMs:   a.AvgGroundContactTime,
		VerticalRatioPct:      a.AvgVerticalRatio,

		SportNote: a.Description,

		Sport:    sptr(string(sportFromTypeKey(typeKey))),
		Provider: providerName,
		SyncedAt: time.Now().UTC(),
	}
	// train_type keeps the Garmin label string (readers grep it); train_kind is
	// the normalized value.
	if a.TrainingEffectLabel != "" {
		act.TrainType = sptr(a.TrainingEffectLabel)
	}
	if k, ok := trainKindFromLabel(a.TrainingEffectLabel); ok {
		act.TrainKind = sptr(string(k))
	}
	if a.Feel != nil && *a.Feel > 0 {
		ft := int(*a.Feel)
		act.FeelType = &ft
	}
	if f, ok := feelFromScore(act.FeelType); ok {
		act.Feel = sptr(string(f))
	}
	if weather != nil {
		act.Temperature = weather.Temp
		act.Humidity = weather.RelativeHumidity
		act.FeelsLike = weather.ApparentTemp
		act.WindSpeed = weather.WindSpeed
	}
	return act
}

func sportNameOrUnknown(typeKey string) *string {
	if typeKey == "" {
		return sptr("Unknown")
	}
	return sptr(typeKey)
}

// ─────────────────────────────────────────────────────────────────────────────
// Splits → laps
// ─────────────────────────────────────────────────────────────────────────────

type rawSplits struct {
	LapDTOs []struct {
		LapIndex              *int     `json:"lapIndex"`
		Distance              *float64 `json:"distance"`
		Duration              *float64 `json:"duration"`
		AverageSpeed          *float64 `json:"averageSpeed"`
		AvgGradeAdjustedSpeed *float64 `json:"avgGradeAdjustedSpeed"`
		AverageHR             *float64 `json:"averageHR"`
		MaxHR                 *float64 `json:"maxHR"`
		AverageRunCadence     *float64 `json:"averageRunCadence"`
		AveragePower          *float64 `json:"averagePower"`
		ElevationGain         *float64 `json:"elevationGain"`
		ElevationLoss         *float64 `json:"elevationLoss"`
	} `json:"lapDTOs"`
}

// parseSplits converts a Garmin splits payload into storage.Lap rows.
func parseSplits(raw json.RawMessage) []storage.Lap {
	if len(raw) == 0 {
		return nil
	}
	var s rawSplits
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil
	}
	var laps []storage.Lap
	for i, l := range s.LapDTOs {
		idx := i + 1
		if l.LapIndex != nil {
			idx = *l.LapIndex
		}
		laps = append(laps, storage.Lap{
			LapIndex:     idx,
			LapType:      "autoKm", // Garmin auto-laps ~ 1km
			DistanceM:    distanceOrZero(l.Distance),
			DurationS:    durationOrZero(l.Duration),
			AvgPace:      msToPaceSKm(l.AverageSpeed),
			AdjustedPace: msToPaceSKm(l.AvgGradeAdjustedSpeed),
			AvgHR:        itrunc(l.AverageHR),
			MaxHR:        itrunc(l.MaxHR),
			AvgCadence:   itrunc(l.AverageRunCadence),
			AvgPower:     itrunc(l.AveragePower),
			AscentM:      l.ElevationGain,
			DescentM:     l.ElevationLoss,
		})
	}
	return laps
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity details → timeseries
// ─────────────────────────────────────────────────────────────────────────────

type rawDetails struct {
	MetricDescriptors []struct {
		Key          string `json:"key"`
		MetricsIndex *int   `json:"metricsIndex"`
	} `json:"metricDescriptors"`
	ActivityDetailMetrics []struct {
		Metrics []*float64 `json:"metrics"`
	} `json:"activityDetailMetrics"`
}

// parseDetailsTimeseries converts Garmin activity details into TimeseriesPoint
// rows using metricDescriptors to resolve each per-sample array index.
func parseDetailsTimeseries(raw json.RawMessage) []storage.TimeseriesPoint {
	if len(raw) == 0 {
		return nil
	}
	var d rawDetails
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil
	}
	if len(d.MetricDescriptors) == 0 || len(d.ActivityDetailMetrics) == 0 {
		return nil
	}
	idx := map[string]int{}
	for _, desc := range d.MetricDescriptors {
		if desc.Key != "" && desc.MetricsIndex != nil {
			idx[desc.Key] = *desc.MetricsIndex
		}
	}
	get := func(metrics []*float64, keys ...string) *float64 {
		for _, k := range keys {
			if i, ok := idx[k]; ok && i >= 0 && i < len(metrics) && metrics[i] != nil {
				return metrics[i]
			}
		}
		return nil
	}
	paceFromSpeed := func(metrics []*float64, key string) *float64 {
		return msToPaceSKm(get(metrics, key))
	}

	var out []storage.TimeseriesPoint
	for _, row := range d.ActivityDetailMetrics {
		m := row.Metrics
		pt := storage.TimeseriesPoint{
			Distance:              get(m, "sumDistance"),
			HeartRate:             positiveInt(get(m, "directHeartRate")),
			Speed:                 paceFromSpeed(m, "directSpeed"),
			AdjustedPace:          paceFromSpeed(m, "directGradeAdjustedSpeed"),
			Cadence:               positiveInt(get(m, "directRunCadence", "directDoubleCadence", "directFractionalCadence")),
			Altitude:              get(m, "directElevation"),
			Power:                 positiveInt(get(m, "directPower")),
			GroundContactTimeMs:   get(m, "directGroundContactTime"),
			VerticalOscillationMm: get(m, "directVerticalOscillation"),
			VerticalRatioPct:      get(m, "directVerticalRatio"),
			CadenceLengthCm:       get(m, "directStrideLength"),
			GPSLat:                get(m, "directLatitude"),
			GPSLon:                get(m, "directLongitude"),
		}
		if elapsed := get(m, "sumElapsedDuration", "sumDuration"); elapsed != nil {
			cs := int64(*elapsed*100 + 0.5)
			pt.Timestamp = &cs
		}
		out = append(out, pt)
	}
	return out
}

func positiveInt(f *float64) *int {
	if f == nil || *f <= 0 {
		return nil
	}
	return iround(f)
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily health
// ─────────────────────────────────────────────────────────────────────────────

type rawTrainingStatus struct {
	MostRecentTrainingStatus struct {
		LatestTrainingStatusData map[string]struct {
			PrimaryTrainingDevice bool `json:"primaryTrainingDevice"`
			AcuteTrainingLoadDTO  struct {
				DailyTrainingLoadAcute         *float64 `json:"dailyTrainingLoadAcute"`
				DailyTrainingLoadChronic       *float64 `json:"dailyTrainingLoadChronic"`
				DailyAcuteChronicWorkloadRatio *float64 `json:"dailyAcuteChronicWorkloadRatio"`
				AcwrStatus                     string   `json:"acwrStatus"`
			} `json:"acuteTrainingLoadDTO"`
		} `json:"latestTrainingStatusData"`
	} `json:"mostRecentTrainingStatus"`
	MostRecentVO2Max struct {
		Generic struct {
			VO2MaxValue *float64 `json:"vo2MaxValue"`
		} `json:"generic"`
	} `json:"mostRecentVO2Max"`
}

type rawUserSummary struct {
	RestingHeartRate                 *float64 `json:"restingHeartRate"`
	LastSevenDaysAvgRestingHeartRate *float64 `json:"lastSevenDaysAvgRestingHeartRate"`
	TotalDistanceMeters              *float64 `json:"totalDistanceMeters"`
	BodyBatteryHighestValue          *float64 `json:"bodyBatteryHighestValue"`
	BodyBatteryLowestValue           *float64 `json:"bodyBatteryLowestValue"`
	AverageStressLevel               *float64 `json:"averageStressLevel"`
	AvgWakingRespirationValue        *float64 `json:"avgWakingRespirationValue"`
	AverageSpo2                      *float64 `json:"averageSpo2"`
}

type rawSleep struct {
	DailySleepDTO struct {
		SleepTimeSeconds  *float64 `json:"sleepTimeSeconds"`
		DeepSleepSeconds  *float64 `json:"deepSleepSeconds"`
		LightSleepSeconds *float64 `json:"lightSleepSeconds"`
		RemSleepSeconds   *float64 `json:"remSleepSeconds"`
		AwakeSleepSeconds *float64 `json:"awakeSleepSeconds"`
		SleepScores       struct {
			Overall struct {
				Value *float64 `json:"value"`
			} `json:"overall"`
		} `json:"sleepScores"`
	} `json:"dailySleepDTO"`
}

// primaryLoad returns the acute-training-load DTO for the primary device (or the
// lowest device-id key for determinism when none is flagged primary).
func (t rawTrainingStatus) primaryLoad() (ati, cti, ratio *float64, state string) {
	data := t.MostRecentTrainingStatus.LatestTrainingStatusData
	if len(data) == 0 {
		return nil, nil, nil, ""
	}
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	chosen := keys[0]
	for _, k := range keys {
		if data[k].PrimaryTrainingDevice {
			chosen = k
			break
		}
	}
	load := data[chosen].AcuteTrainingLoadDTO
	return load.DailyTrainingLoadAcute, load.DailyTrainingLoadChronic,
		load.DailyAcuteChronicWorkloadRatio, load.AcwrStatus
}

// buildDailyHealth assembles a daily_health row from the three Garmin endpoints.
func buildDailyHealth(userID, date string, tsRaw, usRaw, sleepRaw json.RawMessage) *storage.DailyHealth {
	var ts rawTrainingStatus
	_ = json.Unmarshal(tsRaw, &ts)
	var us rawUserSummary
	_ = json.Unmarshal(usRaw, &us)
	var sd rawSleep
	_ = json.Unmarshal(sleepRaw, &sd)

	ati, cti, reportedRatio, state := ts.primaryLoad()
	// Prefer the precise ATI/CTI quotient over Garmin's 1-dp rounded ratio.
	var ratio *float64
	if ati != nil && cti != nil && *cti > 0 {
		ratio = fptr(*ati / *cti)
	} else {
		ratio = reportedRatio
	}

	h := &storage.DailyHealth{
		UserID:            userID,
		Date:              date,
		ATI:               ati,
		CTI:               cti,
		RHR:               itrunc(firstTruthyFloat(us.RestingHeartRate, us.LastSevenDaysAvgRestingHeartRate)),
		DistanceM:         truthyDistance(us.TotalDistanceMeters),
		TrainingLoadRatio: ratio,
		Fatigue:           fatigueFromGarmin(ratio, ati, cti),
		BodyBatteryHigh:   itrunc(us.BodyBatteryHighestValue),
		BodyBatteryLow:    itrunc(us.BodyBatteryLowestValue),
		StressAvg:         stressOrNil(us.AverageStressLevel),
		SleepTotalS:       itrunc(sd.DailySleepDTO.SleepTimeSeconds),
		SleepDeepS:        itrunc(sd.DailySleepDTO.DeepSleepSeconds),
		SleepLightS:       itrunc(sd.DailySleepDTO.LightSleepSeconds),
		SleepRemS:         itrunc(sd.DailySleepDTO.RemSleepSeconds),
		SleepAwakeS:       itrunc(sd.DailySleepDTO.AwakeSleepSeconds),
		SleepScore:        itrunc(sd.DailySleepDTO.SleepScores.Overall.Value),
		RespirationAvg:    us.AvgWakingRespirationValue,
		Spo2Avg:           us.AverageSpo2,
		Provider:          providerName,
	}
	if state != "" {
		h.TrainingLoadState = sptr(state)
	}
	return h
}

// hasSignal reports whether a daily_health row carries any usable value (so empty
// days aren't written to shadow real rows in mixed-provider DBs).
func hasSignal(h *storage.DailyHealth) bool {
	return h.ATI != nil || h.CTI != nil || h.RHR != nil || h.TrainingLoadRatio != nil ||
		h.SleepTotalS != nil || h.SleepScore != nil || h.BodyBatteryHigh != nil || h.Fatigue != nil
}

func stressOrNil(f *float64) *int {
	if f == nil || *f == -1 {
		return nil
	}
	return itrunc(f)
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily HRV
// ─────────────────────────────────────────────────────────────────────────────

type rawHRV struct {
	HRVSummary struct {
		WeeklyAvg         *int   `json:"weeklyAvg"`
		LastNightAvg      *int   `json:"lastNightAvg"`
		LastNight5MinHigh *int   `json:"lastNight5MinHigh"`
		Status            string `json:"status"`
		FeedbackPhrase    string `json:"feedbackPhrase"`
		Baseline          struct {
			LowUpper      *int `json:"lowUpper"`
			BalancedLow   *int `json:"balancedLow"`
			BalancedUpper *int `json:"balancedUpper"`
		} `json:"baseline"`
	} `json:"hrvSummary"`
}

// buildDailyHRV assembles a daily_hrv row from get_hrv_data.
func buildDailyHRV(userID, date string, hrvRaw json.RawMessage) *storage.DailyHRV {
	var h rawHRV
	_ = json.Unmarshal(hrvRaw, &h)
	s := h.HRVSummary
	row := &storage.DailyHRV{
		UserID:                userID,
		Date:                  date,
		Provider:              providerName,
		WeeklyAvg:             s.WeeklyAvg,
		LastNightAvg:          s.LastNightAvg,
		LastNight5MinHigh:     s.LastNight5MinHigh,
		BaselineLowUpper:      s.Baseline.LowUpper,
		BaselineBalancedLow:   s.Baseline.BalancedLow,
		BaselineBalancedUpper: s.Baseline.BalancedUpper,
	}
	if s.Status != "" {
		row.Status = sptr(s.Status)
	}
	if s.FeedbackPhrase != "" {
		row.FeedbackPhrase = sptr(s.FeedbackPhrase)
	}
	return row
}

func hrvHasSignal(h *storage.DailyHRV) bool {
	return h.LastNightAvg != nil || h.WeeklyAvg != nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard + race predictions
// ─────────────────────────────────────────────────────────────────────────────

type rawLactateEntry struct {
	Speed     *float64 `json:"speed"`
	HeartRate *float64 `json:"heartRate"`
	HearRate  *float64 `json:"hearRate"` // Garmin's historical typo, seen in the wild
}

// parseLactate reads the latestLactateThreshold payload, which Garmin returns as
// an array of entries (speed and heart rate may live in different entries). Falls
// back to a single-object shape. Returns the first non-nil speed and HR found.
func parseLactate(raw json.RawMessage) (speed, hr *float64) {
	var entries []rawLactateEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		var one rawLactateEntry
		if json.Unmarshal(raw, &one) == nil {
			entries = []rawLactateEntry{one}
		}
	}
	for _, e := range entries {
		if speed == nil && e.Speed != nil {
			speed = e.Speed
		}
		if hr == nil {
			if e.HeartRate != nil {
				hr = e.HeartRate
			} else if e.HearRate != nil {
				hr = e.HearRate
			}
		}
	}
	return speed, hr
}

type rawRacePredictions struct {
	Time5K           *float64 `json:"time5K"`
	Time10K          *float64 `json:"time10K"`
	TimeHalfMarathon *float64 `json:"timeHalfMarathon"`
	TimeMarathon     *float64 `json:"timeMarathon"`
}

// buildDashboard assembles the singleton dashboard row + race predictions.
// COROS-private scores (running_level, aerobic, lactate, anaerobic) stay nil.
func buildDashboard(userID string, tsRaw, usRaw, hrvRaw, ltRaw, rpRaw json.RawMessage) (*storage.Dashboard, []storage.RacePrediction) {
	var us rawUserSummary
	_ = json.Unmarshal(usRaw, &us)
	var hrv rawHRV
	_ = json.Unmarshal(hrvRaw, &hrv)
	ltSpeed, ltHR := parseLactate(ltRaw)

	// Empirical Garmin quirk: latestLactateThreshold reports speed at 1/10th m/s.
	var thresholdPace *float64
	if ltSpeed != nil {
		scaled := *ltSpeed * 10.0
		thresholdPace = msToPaceSKm(&scaled)
	}

	d := &storage.Dashboard{
		UserID:           userID,
		RHR:              itrunc(firstTruthyFloat(us.LastSevenDaysAvgRestingHeartRate, us.RestingHeartRate)),
		ThresholdHR:      itrunc(ltHR),
		ThresholdPaceSKm: thresholdPace,
		AvgSleepHRV:      intToFloatPtr(hrv.HRVSummary.LastNightAvg),
		HRVNormalLow:     intToFloatPtr(hrv.HRVSummary.Baseline.BalancedLow),
		HRVNormalHigh:    intToFloatPtr(hrv.HRVSummary.Baseline.BalancedUpper),
		Provider:         providerName,
		UpdatedAt:        time.Now().UTC(),
	}

	var rp rawRacePredictions
	_ = json.Unmarshal(rpRaw, &rp)
	var preds []storage.RacePrediction
	for _, pr := range []struct {
		secs  *float64
		label string
	}{
		{rp.Time5K, "5K"},
		{rp.Time10K, "10K"},
		{rp.TimeHalfMarathon, "Half Marathon"},
		{rp.TimeMarathon, "Marathon"},
	} {
		if pr.secs != nil && *pr.secs > 0 {
			preds = append(preds, storage.RacePrediction{
				UserID:    userID,
				RaceType:  pr.label,
				DurationS: pr.secs,
				UpdatedAt: time.Now().UTC(),
			})
		}
	}
	return d, preds
}

func intToFloatPtr(p *int) *float64 {
	if p == nil {
		return nil
	}
	f := float64(*p)
	return &f
}
