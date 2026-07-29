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

// computeModels is the set of onboarding-compute derived models, migrated
// alongside the watch models by AutoMigrateWatch.
func computeModels() []any {
	return []any{
		&RunningCalibrationSnapshot{},
		&RunningCalibrationZone{},
		&PersonalBest{},
	}
}
