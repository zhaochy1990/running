// compute_models.go holds the onboarding-compute derived tables — rows STRIDE
// computes from synced watch data (calibration baselines, personal bests, and
// later training load + ability), as opposed to the watch_models.go tables which
// mirror provider-synced data. Go owns this schema (ADR 0006); it mirrors the
// Python SQLite columns (stride_storage/sqlite) plus a user_id tenant key so the
// reconcile diff (ADR 0005) compares like-for-like. See ADR 0013.
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

// RunningCalibrationZone is one training zone derived from a snapshot (table
// "running_calibration_zone"). Mirrors the Python zone rows; zone_kind is
// "pace" or "heart_rate". For HR zones min_speed_mps/max_speed_mps are NULL.
type RunningCalibrationZone struct {
	ID          uint64   `gorm:"column:id;primaryKey;autoIncrement"`
	UserID      string   `gorm:"column:user_id;type:char(36);not null;uniqueIndex:uq_run_cal_zone,priority:1"`
	SnapshotID  uint64   `gorm:"column:snapshot_id;not null;uniqueIndex:uq_run_cal_zone,priority:2"`
	ZoneKind    string   `gorm:"column:zone_kind;type:varchar(16);not null;uniqueIndex:uq_run_cal_zone,priority:3"`
	Name        string   `gorm:"column:name;type:varchar(32);not null;uniqueIndex:uq_run_cal_zone,priority:4"`
	MinValue    *float64 `gorm:"column:min_value"`
	MaxValue    *float64 `gorm:"column:max_value"`
	MinSpeedMps *float64 `gorm:"column:min_speed_mps"`
	MaxSpeedMps *float64 `gorm:"column:max_speed_mps"`
	Confidence  string   `gorm:"column:confidence;type:varchar(16);not null"`
}

func (RunningCalibrationZone) TableName() string { return "running_calibration_zone" }

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
	ExcludedFromPMC        bool      `gorm:"column:excluded_from_pmc;not null;default:true"`
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

// computeModels is the set of onboarding-compute derived models, migrated
// alongside the watch models by AutoMigrateWatch.
func computeModels() []any {
	return []any{
		&RunningCalibrationSnapshot{},
		&RunningCalibrationZone{},
		&PersonalBest{},
		&ActivityTrainingLoad{},
		&DailyTrainingLoad{},
	}
}
