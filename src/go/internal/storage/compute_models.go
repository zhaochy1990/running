// compute_models.go holds the onboarding-compute derived tables — rows STRIDE
// computes from synced watch data (calibration baselines, personal bests, and
// later training load + ability), as opposed to the watch_models.go tables which
// mirror provider-synced data. Go owns this schema (ADR 0006); it mirrors the
// Python SQLite columns (stride_storage/sqlite) plus a user_id tenant key so the
// reconcile diff (ADR 0005) compares like-for-like. See ADR 0015.
package storage

import "time"

// RunningCalibrationSnapshot is one persisted athlete-baseline snapshot (table
// "running_calibration_snapshot"). Mirrors stride_core.running_calibration; the
// surrogate id + unique (user_id, as_of_date, algorithm_version) mirrors the
// Python autoincrement id + UNIQUE(as_of_date, algorithm_version), scoped per
// user. Nullable metrics are pointers so "no estimate" stays NULL.
type RunningCalibrationSnapshot struct {
	ID               uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID           string `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_run_cal,priority:1"`
	AsOfDate         string `gorm:"column:as_of_date;type:varchar(16);not null;uniqueIndex:uq_run_cal,priority:2"`
	AlgorithmVersion int    `gorm:"column:algorithm_version;not null;uniqueIndex:uq_run_cal,priority:3"`

	ThresholdHR              *float64 `gorm:"column:threshold_hr"`
	ThresholdSpeedMps        *float64 `gorm:"column:threshold_speed_mps"`
	ThresholdHRConfidence    string   `gorm:"column:threshold_hr_confidence;type:varchar(16);not null"`
	ThresholdSpeedConfidence string   `gorm:"column:threshold_speed_confidence;type:varchar(16);not null"`

	RHRBaseline     *float64 `gorm:"column:rhr_baseline"`
	ObservedMaxHR   *float64 `gorm:"column:observed_max_hr"`
	HRMaxEstimate   *float64 `gorm:"column:hrmax_estimate"`
	HRMaxConfidence string   `gorm:"column:hrmax_confidence;type:varchar(16);not null;default:none"`
	HighHRReference *float64 `gorm:"column:high_hr_reference"`

	CriticalPowerW          *float64 `gorm:"column:critical_power_w"`
	CriticalSpeedMps        *float64 `gorm:"column:critical_speed_mps"`
	DPrimeM                 *float64 `gorm:"column:d_prime_m"`
	RiegelK                 *float64 `gorm:"column:riegel_k"`
	EnduranceIndex          *float64 `gorm:"column:endurance_index"`
	SpeedIndex              *float64 `gorm:"column:speed_index"`
	SpeedDurationConfidence string   `gorm:"column:speed_duration_confidence;type:varchar(16);not null;default:none"`

	// SourceJSON is the provenance blob (sorted-key JSON, diagnostic only — not
	// reconciled). longtext preserves the exact string, unlike MySQL json which
	// reorders keys.
	SourceJSON *string   `gorm:"column:source_json;type:longtext"`
	ComputedAt time.Time `gorm:"column:computed_at;type:datetime(6);not null"`
}

func (RunningCalibrationSnapshot) TableName() string { return "running_calibration_snapshot" }

// RunningCalibrationPaceZone is one pace training zone derived from a snapshot
// (table "running_calibration_pace_zone"). Pace and heart-rate zones are stored
// in separate tables (not a shared table with a zone_kind discriminator) so each
// carries its own natural columns instead of overloaded min_value/max_value.
type RunningCalibrationPaceZone struct {
	ID            uint64   `gorm:"column:id;primaryKey;autoIncrement"`
	UserID        string   `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_run_cal_pace_zone,priority:1"`
	SnapshotID    uint64   `gorm:"column:snapshot_id;not null;uniqueIndex:uq_run_cal_pace_zone,priority:2"`
	Name          string   `gorm:"column:name;type:varchar(32);not null;uniqueIndex:uq_run_cal_pace_zone,priority:3"`
	MinPaceSPerKm *float64 `gorm:"column:min_pace_s_per_km"`
	MaxPaceSPerKm *float64 `gorm:"column:max_pace_s_per_km"`
	MinSpeedMps   *float64 `gorm:"column:min_speed_mps"`
	MaxSpeedMps   *float64 `gorm:"column:max_speed_mps"`
	Confidence    string   `gorm:"column:confidence;type:varchar(16);not null"`
}

func (RunningCalibrationPaceZone) TableName() string { return "running_calibration_pace_zone" }

// RunningCalibrationHRZone is one heart-rate training zone derived from a
// snapshot (table "running_calibration_hr_zone"). Kept separate from the pace
// zone table so HR rows only carry the bpm columns (no NULL pace/speed columns).
type RunningCalibrationHRZone struct {
	ID         uint64   `gorm:"column:id;primaryKey;autoIncrement"`
	UserID     string   `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_run_cal_hr_zone,priority:1"`
	SnapshotID uint64   `gorm:"column:snapshot_id;not null;uniqueIndex:uq_run_cal_hr_zone,priority:2"`
	Name       string   `gorm:"column:name;type:varchar(32);not null;uniqueIndex:uq_run_cal_hr_zone,priority:3"`
	MinBpm     *float64 `gorm:"column:min_bpm"`
	MaxBpm     *float64 `gorm:"column:max_bpm"`
	Confidence string   `gorm:"column:confidence;type:varchar(16);not null"`
}

func (RunningCalibrationHRZone) TableName() string { return "running_calibration_hr_zone" }

// PersonalBest is one achieved-time PB per display distance (table
// "personal_bests"). Mirrors stride_core.pb_records; PK (user_id, distance).
// EntryJSON holds the full detector entry (history progression + segment
// offsets); the scalar columns stay queryable.
type PersonalBest struct {
	UserID     string    `gorm:"column:user_id;type:char(36);primaryKey"`
	Distance   string    `gorm:"column:distance;type:varchar(8);primaryKey"` // 1K|3K|5K|10K|HM|FM
	PBTimeSec  float64   `gorm:"column:pb_time_sec;not null"`
	AchievedAt *string   `gorm:"column:achieved_at;type:varchar(16)"` // Shanghai YYYY-MM-DD
	Source     *string   `gorm:"column:source;type:varchar(16)"`      // segment|activity
	EntryJSON  string    `gorm:"column:entry_json;type:longtext;not null"`
	UpdatedAt  time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (PersonalBest) TableName() string { return "personal_bests" }

// ActivityTrainingLoad is one activity's objective load (table
// "activity_training_load"). Mirrors stride_core.training_load; PK
// (user_id, label_id).
type ActivityTrainingLoad struct {
	UserID                 string    `gorm:"column:user_id;type:char(36);primaryKey"`
	LabelID                string    `gorm:"column:label_id;type:varchar(191);primaryKey"`
	ActivityDate           string    `gorm:"column:activity_date;type:varchar(16);not null;index:idx_atl_user_date,priority:2"`
	Sport                  *string   `gorm:"column:sport;type:varchar(64)"`
	SessionClass           *string   `gorm:"column:session_class;type:varchar(32)"`
	AlgorithmVersion       int       `gorm:"column:algorithm_version;not null"`
	CalibrationID          *int      `gorm:"column:calibration_id"`
	CardioLoadRaw          *float64  `gorm:"column:cardio_load_raw"`
	CardioTSS              *float64  `gorm:"column:cardio_tss"`
	ExternalTSS            *float64  `gorm:"column:external_tss"`
	HighIntensityTSS       *float64  `gorm:"column:high_intensity_tss"`
	MechanicalLoad         *float64  `gorm:"column:mechanical_load"`
	SubjectiveInternalLoad *float64  `gorm:"column:subjective_internal_load"`
	TrainingDose           *float64  `gorm:"column:training_dose"`
	TrainingDoseSource     *string   `gorm:"column:training_dose_source;type:varchar(64)"`
	CardioCoverage         float64   `gorm:"column:cardio_coverage;not null;default:0"`
	ExternalCoverage       float64   `gorm:"column:external_coverage;not null;default:0"`
	HighIntensityCoverage  float64   `gorm:"column:high_intensity_coverage;not null;default:0"`
	CoverageStatus         string    `gorm:"column:coverage_status;type:varchar(32);not null;default:unknown"`
	LoadConfidence         *string   `gorm:"column:load_confidence;type:varchar(16)"`
	ExcludedFromPMC        bool      `gorm:"column:excluded_from_pmc;not null"`
	ReasonsJSON            *string   `gorm:"column:reasons_json;type:longtext"`
	ComputedAt             time.Time `gorm:"column:computed_at;type:datetime(6);not null"`
}

func (ActivityTrainingLoad) TableName() string { return "activity_training_load" }

// DailyTrainingLoad is one calendar day's PMC (table "daily_training_load").
// Mirrors stride_core.training_load; PK (user_id, date).
type DailyTrainingLoad struct {
	UserID               string    `gorm:"column:user_id;type:char(36);primaryKey"`
	Date                 string    `gorm:"column:date;type:varchar(16);primaryKey"`
	AlgorithmVersion     int       `gorm:"column:algorithm_version;not null"`
	CalibrationID        *int      `gorm:"column:calibration_id"`
	TrainingDose         float64   `gorm:"column:training_dose;not null;default:0"`
	AcuteLoad            float64   `gorm:"column:acute_load"`
	ChronicLoad          float64   `gorm:"column:chronic_load"`
	Form                 float64   `gorm:"column:form"`
	LoadRatio            *float64  `gorm:"column:load_ratio"`
	CoverageStatus       string    `gorm:"column:coverage_status;type:varchar(32);not null;default:unknown"`
	ReadinessGate        *string   `gorm:"column:readiness_gate;type:varchar(16)"`
	ReadinessReasonsJSON *string   `gorm:"column:readiness_reasons_json;type:longtext"`
	ComputedAt           time.Time `gorm:"column:computed_at;type:datetime(6);not null"`
}

func (DailyTrainingLoad) TableName() string { return "daily_training_load" }

// AbilitySnapshot is one long-form ability dimension row for a Shanghai day
// (table "ability_snapshot"). Mirrors the Python SQLite column set plus a user_id
// tenant key. level ∈ {meta,L2,L3,L4}, dimension ∈ {model_version,total,aerobic,
// lt,vo2max,endurance,economy,recovery,composite,marathon_*_s,hm_*_s}.
type AbilitySnapshot struct {
	ID                  uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	UserID              string    `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_ability,priority:1"`
	Date                string    `gorm:"column:date;type:varchar(16);not null;uniqueIndex:uq_ability,priority:2"`
	Level               string    `gorm:"column:level;type:varchar(8);not null;uniqueIndex:uq_ability,priority:3"`
	Dimension           string    `gorm:"column:dimension;type:varchar(32);not null;uniqueIndex:uq_ability,priority:4"`
	Value               *float64  `gorm:"column:value"`
	EvidenceActivityIDs *string   `gorm:"column:evidence_activity_ids;type:longtext"`
	ComputedAt          time.Time `gorm:"column:computed_at;type:datetime(6);not null"`
}

func (AbilitySnapshot) TableName() string { return "ability_snapshot" }

// ActivityAbility is one activity's L1 quality + contribution (table
// "activity_ability"). PK (user_id, label_id).
type ActivityAbility struct {
	UserID       string    `gorm:"column:user_id;type:char(36);primaryKey"`
	LabelID      string    `gorm:"column:label_id;type:varchar(191);primaryKey"`
	L1Quality    *float64  `gorm:"column:l1_quality"`
	L1Breakdown  *string   `gorm:"column:l1_breakdown;type:longtext"`
	Contribution *string   `gorm:"column:contribution;type:longtext"`
	ComputedAt   time.Time `gorm:"column:computed_at;type:datetime(6);not null"`
}

func (ActivityAbility) TableName() string { return "activity_ability" }

// Vo2MaxPB is one per-race-type best VDOT PB row (table "vo2max_pb"), the
// PB-memory channel input for compute_l3_vo2max. Unique per (race_type, label_id)
// like Python; the reader picks the highest vdot per race_type.
type Vo2MaxPB struct {
	ID        uint64    `gorm:"column:id;primaryKey;autoIncrement"`
	UserID    string    `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_vo2max_pb,priority:1"`
	RaceType  string    `gorm:"column:race_type;type:varchar(16);not null;uniqueIndex:uq_vo2max_pb,priority:2"`
	DistanceM *float64  `gorm:"column:distance_m"`
	DurationS *float64  `gorm:"column:duration_s"`
	Vdot      *float64  `gorm:"column:vdot"`
	PBDate    string    `gorm:"column:pb_date;type:varchar(16)"`
	LabelID   string    `gorm:"column:label_id;type:varchar(191);not null;uniqueIndex:uq_vo2max_pb,priority:3"`
	EvenPaced bool      `gorm:"column:even_paced;not null;default:true"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime(6);not null"`
}

func (Vo2MaxPB) TableName() string { return "vo2max_pb" }

// ActivityZone is one per-activity STRIDE-calibrated zone row (table
// "activity_zones"). Computed post-sync by the compute job from the activity's
// timeseries and the calibration snapshot as-of its date (ADR 0019: calibrated
// zones live separately from activity_watch_zones, and the API picks which
// source to serve at read time). Mirrors the Python SQLite `zones` table plus a
// user_id tenant key; the zone shape matches ActivityWatchZone so the API can
// serve either source through the same DTO.
type ActivityZone struct {
	ID        uint64   `gorm:"column:id;primaryKey;autoIncrement"`
	UserID    string   `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_activity_zones,priority:1"`
	LabelID   string   `gorm:"column:label_id;type:varchar(191);not null;uniqueIndex:uq_activity_zones,priority:2"`
	ZoneType  string   `gorm:"column:zone_type;type:varchar(32);not null;uniqueIndex:uq_activity_zones,priority:3"`
	ZoneIndex int      `gorm:"column:zone_index;not null;uniqueIndex:uq_activity_zones,priority:4"`
	RangeMin  *float64 `gorm:"column:range_min"`
	RangeMax  *float64 `gorm:"column:range_max"`
	RangeUnit *string  `gorm:"column:range_unit;type:varchar(16)"`
	DurationS *int     `gorm:"column:duration_s"`
	Percent   *float64 `gorm:"column:percent"`
}

func (ActivityZone) TableName() string { return "activity_zones" }

// computeModels is the set of onboarding-compute derived models, migrated
// alongside the watch models by AutoMigrateWatch.
func computeModels() []any {
	return []any{
		&RunningCalibrationSnapshot{},
		&RunningCalibrationPaceZone{},
		&RunningCalibrationHRZone{},
		&PersonalBest{},
		&ActivityTrainingLoad{},
		&DailyTrainingLoad{},
		&AbilitySnapshot{},
		&ActivityAbility{},
		&Vo2MaxPB{},
		&ActivityZone{},
	}
}
