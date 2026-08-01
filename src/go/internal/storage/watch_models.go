// watch_models.go defines the GORM models for the watch-sync data domain — the
// canonical MySQL schema (ADR 0006). Conventions match the job models: DATETIME(6)
// holding UTC, char(36) user_id, varchar(191) indexed strings, domain-owns-time
// (AutoCreateTime/UpdateTime disabled at the store level).
//
// Multi-tenancy: every table is keyed by user_id (the STRIDE UUID, never the
// COROS account id). activities identity is composite (user_id, label_id); child
// tables carry (user_id, label_id) and a surrogate key.
//
// Nullable numeric/text columns are pointers so a missing value stays NULL (not
// 0/""), keeping the store byte-comparable with the Python SQLite path
// (cmd/reconcile).
package storage

import "time"

// Activity is the top-level activity row (table "activities").
//
// ADR 0006: the Python MySQL design has a persisted generated `shanghai_date`
// column for calendar queries. It is deferred here — the Shanghai day is
// computed at query time by readers — to avoid a GORM generated-column migration
// the shadow store does not need (reconcile aligns by label_id).
type Activity struct {
	UserID    string    `gorm:"column:user_id;type:char(36);primaryKey"`
	LabelID   string    `gorm:"column:label_id;type:varchar(191);primaryKey"`
	Name      *string   `gorm:"column:name;type:text"`
	SportType int       `gorm:"column:sport_type;not null"`
	SportName *string   `gorm:"column:sport_name;type:varchar(191)"`
	Date      time.Time `gorm:"column:date;type:datetime(6);not null;index:idx_activities_user_date,priority:2"`

	DistanceM    *float64 `gorm:"column:distance_m"`
	DurationS    *float64 `gorm:"column:duration_s"`
	AvgPaceSKm   *float64 `gorm:"column:avg_pace_s_km"`
	AdjustedPace *float64 `gorm:"column:adjusted_pace"`
	BestKmPace   *float64 `gorm:"column:best_km_pace"`
	MaxPace      *float64 `gorm:"column:max_pace"`

	AvgHR      *int `gorm:"column:avg_hr"`
	MaxHR      *int `gorm:"column:max_hr"`
	AvgCadence *int `gorm:"column:avg_cadence"`
	MaxCadence *int `gorm:"column:max_cadence"`
	AvgPower   *int `gorm:"column:avg_power"`
	MaxPower   *int `gorm:"column:max_power"`

	AvgStepLenCm *float64 `gorm:"column:avg_step_len_cm"`
	AscentM      *float64 `gorm:"column:ascent_m"`
	DescentM     *float64 `gorm:"column:descent_m"`
	CaloriesKcal *int     `gorm:"column:calories_kcal"`

	AerobicEffect   *float64 `gorm:"column:aerobic_effect"`
	AnaerobicEffect *float64 `gorm:"column:anaerobic_effect"`
	TrainingLoad    *float64 `gorm:"column:training_load"`
	VO2Max          *float64 `gorm:"column:vo2max"`
	Performance     *float64 `gorm:"column:performance"`
	TrainType       *string  `gorm:"column:train_type;type:varchar(191)"`

	Temperature *float64 `gorm:"column:temperature"`
	Humidity    *float64 `gorm:"column:humidity"`
	FeelsLike   *float64 `gorm:"column:feels_like"`
	WindSpeed   *float64 `gorm:"column:wind_speed"`

	Device    *string `gorm:"column:device;type:varchar(255)"`
	FeelType  *int    `gorm:"column:feel_type"`
	SportNote *string `gorm:"column:sport_note;type:text"`

	// Provider-agnostic normalized fields (adapter-written). Feel is a unified
	// numeric 0–10 scale (COROS feelType×2, Garmin raw÷10), NULL when unrated.
	Sport     *string  `gorm:"column:sport;type:varchar(64)"`
	TrainKind *string  `gorm:"column:train_kind;type:varchar(64)"`
	Feel      *float64 `gorm:"column:feel"`

	// Running dynamics + JSON blobs (Python MySQL superset).
	VerticalOscillationMm *float64 `gorm:"column:vertical_oscillation_mm"`
	GroundContactTimeMs   *float64 `gorm:"column:ground_contact_time_ms"`
	VerticalRatioPct      *float64 `gorm:"column:vertical_ratio_pct"`
	Pauses                *string  `gorm:"column:pauses;type:json"`
	RouteThumbJSON        *string  `gorm:"column:route_thumb_json;type:json"`

	Provider string    `gorm:"column:provider;type:varchar(32);not null;default:coros"`
	SyncedAt time.Time `gorm:"column:synced_at;type:datetime(6);not null"`
}

func (Activity) TableName() string { return "activities" }

// Lap is one lap of an activity (table "laps").
type Lap struct {
	ID       uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID   string `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_laps,priority:1"`
	LabelID  string `gorm:"column:label_id;type:varchar(191);not null;uniqueIndex:uq_laps,priority:2"`
	LapIndex int    `gorm:"column:lap_index;not null;uniqueIndex:uq_laps,priority:3"`
	LapType  string `gorm:"column:lap_type;type:varchar(64);not null;uniqueIndex:uq_laps,priority:4"`

	DistanceM       *float64 `gorm:"column:distance_m"`
	DurationS       *float64 `gorm:"column:duration_s"`
	AvgPace         *float64 `gorm:"column:avg_pace"`
	AdjustedPace    *float64 `gorm:"column:adjusted_pace"`
	AvgHR           *int     `gorm:"column:avg_hr"`
	MaxHR           *int     `gorm:"column:max_hr"`
	AvgCadence      *int     `gorm:"column:avg_cadence"`
	AvgPower        *int     `gorm:"column:avg_power"`
	AscentM         *float64 `gorm:"column:ascent_m"`
	DescentM        *float64 `gorm:"column:descent_m"`
	ExerciseType    *int     `gorm:"column:exercise_type"`
	ExerciseNameKey *string  `gorm:"column:exercise_name_key;type:varchar(191)"`
	Mode            *int     `gorm:"column:mode"`
}

func (Lap) TableName() string { return "laps" }

// TimeseriesPoint is one sampled point of an activity (table "timeseries").
type TimeseriesPoint struct {
	ID      uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID  string `gorm:"column:user_id;type:char(36);not null;index:idx_timeseries_user_label,priority:1"`
	LabelID string `gorm:"column:label_id;type:varchar(191);not null;index:idx_timeseries_user_label,priority:2"`

	Timestamp             *int64   `gorm:"column:timestamp"`
	Distance              *float64 `gorm:"column:distance"`
	HeartRate             *int     `gorm:"column:heart_rate"`
	Speed                 *float64 `gorm:"column:speed"`
	AdjustedPace          *float64 `gorm:"column:adjusted_pace"`
	Cadence               *int     `gorm:"column:cadence"`
	Altitude              *float64 `gorm:"column:altitude"`
	Power                 *int     `gorm:"column:power"`
	GroundContactTimeMs   *float64 `gorm:"column:ground_contact_time_ms"`
	VerticalOscillationMm *float64 `gorm:"column:vertical_oscillation_mm"`
	VerticalRatioPct      *float64 `gorm:"column:vertical_ratio_pct"`
	CadenceLengthCm       *float64 `gorm:"column:cadence_length_cm"`
	Slope                 *int     `gorm:"column:slope"`
	HeartLevel            *int     `gorm:"column:heart_level"`
	GPSLat                *float64 `gorm:"column:gps_lat"`
	GPSLon                *float64 `gorm:"column:gps_lon"`
}

func (TimeseriesPoint) TableName() string { return "timeseries" }

// ActivityWatchZone is a WATCH-REPORTED zone bucket (table "activity_watch_zones",
// ADR 0007). Distinct from calibrated zones. ZoneTypeRaw preserves the raw COROS
// zoneType integer so its known encoding churn is observable.
type ActivityWatchZone struct {
	ID          uint64   `gorm:"column:id;primaryKey;autoIncrement"`
	UserID      string   `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_watch_zones,priority:1"`
	LabelID     string   `gorm:"column:label_id;type:varchar(191);not null;uniqueIndex:uq_watch_zones,priority:2"`
	ZoneType    string   `gorm:"column:zone_type;type:varchar(32);not null;uniqueIndex:uq_watch_zones,priority:3"`
	ZoneIndex   int      `gorm:"column:zone_index;not null;uniqueIndex:uq_watch_zones,priority:4"`
	ZoneTypeRaw int      `gorm:"column:zone_type_raw;not null"`
	RangeMin    *float64 `gorm:"column:range_min"`
	RangeMax    *float64 `gorm:"column:range_max"`
	RangeUnit   *string  `gorm:"column:range_unit;type:varchar(16)"`
	DurationS   *int     `gorm:"column:duration_s"`
	Percent     *float64 `gorm:"column:percent"`
}

func (ActivityWatchZone) TableName() string { return "activity_watch_zones" }

// DailyHealth is a daily training-status row (table "daily_health"). Date is the
// Shanghai calendar day key (kept as a string to stay comparable with SQLite).
//
// The sleep / body-battery / stress / respiration / spo2 columns mirror the
// Python daily_health schema exactly (ADR 0006 superset). COROS leaves them NULL;
// Garmin populates them (there is no COROS equivalent for most). Nullable → pointer.
type DailyHealth struct {
	UserID            string   `gorm:"column:user_id;type:char(36);primaryKey"`
	Date              string   `gorm:"column:date;type:varchar(16);primaryKey"`
	ATI               *float64 `gorm:"column:ati"`
	CTI               *float64 `gorm:"column:cti"`
	RHR               *int     `gorm:"column:rhr"`
	DistanceM         *float64 `gorm:"column:distance_m"`
	DurationS         *float64 `gorm:"column:duration_s"`
	TrainingLoadRatio *float64 `gorm:"column:training_load_ratio"`
	TrainingLoadState *string  `gorm:"column:training_load_state;type:varchar(32)"`
	Fatigue           *float64 `gorm:"column:fatigue"`

	// Garmin-populated signals (COROS-null). Sleep durations are seconds.
	BodyBatteryHigh *int     `gorm:"column:body_battery_high"`
	BodyBatteryLow  *int     `gorm:"column:body_battery_low"`
	StressAvg       *int     `gorm:"column:stress_avg"`
	SleepTotalS     *int     `gorm:"column:sleep_total_s"`
	SleepDeepS      *int     `gorm:"column:sleep_deep_s"`
	SleepLightS     *int     `gorm:"column:sleep_light_s"`
	SleepRemS       *int     `gorm:"column:sleep_rem_s"`
	SleepAwakeS     *int     `gorm:"column:sleep_awake_s"`
	SleepScore      *int     `gorm:"column:sleep_score"`
	RespirationAvg  *float64 `gorm:"column:respiration_avg"`
	Spo2Avg         *float64 `gorm:"column:spo2_avg"`

	Provider string `gorm:"column:provider;type:varchar(32);not null;default:coros"`
}

func (DailyHealth) TableName() string { return "daily_health" }

// Dashboard is the per-user summary snapshot (table "dashboard"). One row per
// user (SQLite pins id=1; here the tenant key is the PK).
type Dashboard struct {
	UserID                  string    `gorm:"column:user_id;type:char(36);primaryKey"`
	RunningLevel            *float64  `gorm:"column:running_level"`
	AerobicScore            *float64  `gorm:"column:aerobic_score"`
	LactateThresholdScore   *float64  `gorm:"column:lactate_threshold_score"`
	AnaerobicEnduranceScore *float64  `gorm:"column:anaerobic_endurance_score"`
	AnaerobicCapacityScore  *float64  `gorm:"column:anaerobic_capacity_score"`
	RHR                     *int      `gorm:"column:rhr"`
	ThresholdHR             *int      `gorm:"column:threshold_hr"`
	ThresholdPaceSKm        *float64  `gorm:"column:threshold_pace_s_km"`
	RecoveryPct             *float64  `gorm:"column:recovery_pct"`
	AvgSleepHRV             *float64  `gorm:"column:avg_sleep_hrv"`
	HRVNormalLow            *float64  `gorm:"column:hrv_normal_low"`
	HRVNormalHigh           *float64  `gorm:"column:hrv_normal_high"`
	WeeklyDistanceM         *float64  `gorm:"column:weekly_distance_m"`
	WeeklyDurationS         *float64  `gorm:"column:weekly_duration_s"`
	Provider                string    `gorm:"column:provider;type:varchar(32);not null;default:coros"`
	UpdatedAt               time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (Dashboard) TableName() string { return "dashboard" }

// DailyHRV is per-day HRV detail (table "daily_hrv"). Composite PK
// (user_id, date, provider) so a dual-watch user keeps both nights.
type DailyHRV struct {
	UserID                string  `gorm:"column:user_id;type:char(36);primaryKey"`
	Date                  string  `gorm:"column:date;type:varchar(16);primaryKey"`
	Provider              string  `gorm:"column:provider;type:varchar(32);primaryKey;default:coros"`
	WeeklyAvg             *int    `gorm:"column:weekly_avg"`
	LastNightAvg          *int    `gorm:"column:last_night_avg"`
	LastNight5MinHigh     *int    `gorm:"column:last_night_5min_high"`
	Status                *string `gorm:"column:status;type:varchar(32)"`
	BaselineLowUpper      *int    `gorm:"column:baseline_low_upper"`
	BaselineBalancedLow   *int    `gorm:"column:baseline_balanced_low"`
	BaselineBalancedUpper *int    `gorm:"column:baseline_balanced_upper"`
	FeedbackPhrase        *string `gorm:"column:feedback_phrase;type:text"`
}

func (DailyHRV) TableName() string { return "daily_hrv" }

// RacePrediction is a per-race-type prediction (table "race_predictions").
type RacePrediction struct {
	UserID    string    `gorm:"column:user_id;type:char(36);primaryKey"`
	RaceType  string    `gorm:"column:race_type;type:varchar(32);primaryKey"`
	DurationS *float64  `gorm:"column:duration_s"`
	AvgPace   *float64  `gorm:"column:avg_pace"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (RacePrediction) TableName() string { return "race_predictions" }

// SyncMeta holds per-user sync cursors (table "sync_meta"). The column is
// meta_key (not the reserved word "key").
type SyncMeta struct {
	UserID string  `gorm:"column:user_id;type:char(36);primaryKey"`
	Key    string  `gorm:"column:meta_key;type:varchar(191);primaryKey"`
	Value  *string `gorm:"column:value;type:text"`
}

func (SyncMeta) TableName() string { return "sync_meta" }

// ProviderCredential is a per-user watch login credential (table
// "provider_credentials", ADR 0008). Secret holds the provider-specific credential
// blob (COROS: pwd_hash + access_token; Garmin: the full OAuth1+OAuth2 bundle). It
// is PLAINTEXT for v1 (envelope encryption is a deferred follow-up). The column is
// a BLOB (not a bounded varbinary): a Garmin garth-style token dump is ~4 KB and
// its size is governed by Garmin's JWT, not us, so an opaque off-page BLOB avoids
// ever re-guessing a cap (ADR 0009).
type ProviderCredential struct {
	UserID         string    `gorm:"column:user_id;type:char(36);primaryKey"`
	Provider       string    `gorm:"column:provider;type:varchar(32);primaryKey"`
	Email          *string   `gorm:"column:email;type:varchar(255)"`
	Region         *string   `gorm:"column:region;type:varchar(16)"`
	ProviderUserID *string   `gorm:"column:provider_user_id;type:varchar(64)"`
	Secret         []byte    `gorm:"column:secret;type:blob"`
	UpdatedAt      time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (ProviderCredential) TableName() string { return "provider_credentials" }

// watchModels is the full set of watch-domain models, in dependency order.
func watchModels() []any {
	return []any{
		&Activity{}, &Lap{}, &TimeseriesPoint{}, &ActivityWatchZone{},
		&DailyHealth{}, &Dashboard{}, &DailyHRV{}, &RacePrediction{},
		&SyncMeta{}, &ProviderCredential{},
	}
}
