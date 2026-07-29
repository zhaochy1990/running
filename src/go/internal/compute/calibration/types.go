// Package calibration is a pure Go port of stride_core.running_calibration: it
// estimates an athlete's baseline metrics (threshold HR/speed, HRmax profile,
// RHR baseline, critical power, speed-duration model, zones) from a window of
// running activities plus daily resting-HR rows. It is infra-free (no DB, no
// provider units) so it unit-tests and reconciles against the Python single
// source (AGENTS.md, ADR 0015). The storage reader converts MySQL rows into
// these domain types.
package calibration

import "time"

// ModelVersion mirrors RUNNING_CALIBRATION_MODEL_VERSION.
const ModelVersion = 3

// Confidence mirrors CalibrationConfidence.
type Confidence string

const (
	ConfidenceHigh   Confidence = "high"
	ConfidenceMedium Confidence = "medium"
	ConfidenceLow    Confidence = "low"
	ConfidenceNone   Confidence = "none"
)

// Sample is one timeseries point. Nil = missing, matching Python's None.
type Sample struct {
	TimestampS   *float64
	ElapsedS     *float64
	DistanceM    *float64
	HeartRateBpm *float64
	SpeedMps     *float64
	PowerW       *float64
	AltitudeM    *float64
}

// Lap mirrors RunningLap.
type Lap struct {
	LapIndex    int
	DurationS   *float64
	DistanceM   *float64
	AvgHR       *float64
	MaxHR       *float64
	AvgSpeedMps *float64
	AvgPowerW   *float64
	LapType     *string
}

// Activity mirrors RunningActivity. ActivityDate is the Shanghai-local civil day
// as a UTC-midnight time.Time (the reader normalises it), so day arithmetic
// matches Python date subtraction.
type Activity struct {
	LabelID      string
	ActivityDate time.Time
	Sport        string
	DurationS    *float64
	DistanceM    *float64
	AvgHR        *float64
	MaxHR        *float64
	AvgPowerW    *float64
	Samples      []Sample
	Laps         []Lap
	Source       *string
}

// HealthRow mirrors RunningHealthRow (one daily resting-HR reading).
type HealthRow struct {
	Date time.Time
	RHR  *float64
}

// HrMaxProfile mirrors HrMaxProfile — the HRmax estimation result.
type HrMaxProfile struct {
	ObservedMaxHR   *float64
	EstimatedHRMax  *float64
	Confidence      Confidence
	HighHRReference *float64
	SampleCount     int
}

// Snapshot mirrors RunningCalibrationSnapshot's persisted scalar fields. Zones
// and evidence are carried separately.
type Snapshot struct {
	AsOfDate                 time.Time
	ThresholdHR              *float64
	ThresholdSpeedMps        *float64
	ThresholdHRConfidence    Confidence
	ThresholdSpeedConfidence Confidence
	RHRBaseline              *float64
	ObservedMaxHR            *float64
	HRMaxEstimate            *float64
	HRMaxConfidence          Confidence
	HighHRReference          *float64
	CriticalPowerW           *float64
	CriticalSpeedMps         *float64
	DPrimeM                  *float64
	RiegelK                  *float64
	EnduranceIndex           *float64
	SpeedIndex               *float64
	SpeedDurationConfidence  Confidence
	AlgorithmVersion         int
}

// f64 returns a pointer to v (nil-free literal helper for callers/tests).
func f64(v float64) *float64 { return &v }
