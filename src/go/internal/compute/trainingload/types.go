// Package trainingload is a pure Go port of stride_core.training_load: objective
// per-activity load (cardio TRIMP, external/pace TSS, high-intensity TSS,
// mechanical load) and the daily PMC (CTL/ATL/Form). Infra-free so it unit-tests
// and reconciles against the Python single source (ADR 0013). Ported in
// dependency-ordered sub-slices; this file establishes the shared types.
package trainingload

import "time"

const ModelVersion = 2

// SessionClass mirrors types.SessionClass.
type SessionClass string

const (
	SessionEasy     SessionClass = "easy"
	SessionLong     SessionClass = "long"
	SessionTempo    SessionClass = "tempo"
	SessionInterval SessionClass = "interval"
	SessionRace     SessionClass = "race"
	SessionStrength SessionClass = "strength"
	SessionCross    SessionClass = "cross"
	SessionMobility SessionClass = "mobility"
	SessionUnknown  SessionClass = "unknown"
)

// LoadConfidence mirrors types.LoadConfidence.
type LoadConfidence string

const (
	ConfidenceHigh   LoadConfidence = "high"
	ConfidenceMedium LoadConfidence = "medium"
	ConfidenceLow    LoadConfidence = "low"
	ConfidenceNone   LoadConfidence = "none"
)

// CoverageStatus mirrors types.LoadCoverageStatus.
type CoverageStatus string

const (
	CoverageComplete      CoverageStatus = "complete"
	CoveragePartial       CoverageStatus = "partial"
	CoverageUnknown       CoverageStatus = "unknown"
	CoverageRestConfirmed CoverageStatus = "rest_confirmed"
)

// Sample mirrors types.ActivitySample.
type Sample struct {
	TimestampS   *float64
	ElapsedS     *float64
	DistanceM    *float64
	HeartRateBpm *float64
	SpeedMps     *float64
	PowerW       *float64
	AltitudeM    *float64
}

// ActivityInput mirrors types.ActivityLoadInput. ActivityDate is a UTC-midnight
// Shanghai civil day (like the calibration port).
type ActivityInput struct {
	LabelID      string
	ActivityDate time.Time
	Sport        string
	SessionClass SessionClass
	DurationS    *float64
	DistanceM    *float64
	AscentM      *float64
	DescentM     *float64
	AvgHR        *float64
	MaxHR        *float64
	AvgPower     *float64
	CaloriesKcal *float64
	Samples      []Sample
	RPE          *int
}

// CalibrationSnapshot mirrors types.CalibrationSnapshot (the load-relevant
// baseline subset).
type CalibrationSnapshot struct {
	RHRBaseline       *float64
	HRMaxEstimate     *float64
	ThresholdHR       *float64
	ThresholdSpeedMps *float64
	CriticalPowerW    *float64
	ID                *int
	AlgorithmVersion  int
}

// ActivityLoadResult mirrors types.ActivityLoadResult.
type ActivityLoadResult struct {
	LabelID                 string
	ActivityDate            time.Time
	Sport                   string
	SessionClass            SessionClass
	DurationMinutes         *float64
	AlgorithmVersion        int
	CalibrationID           *int
	CardioLoadRaw           *float64
	CardioTSS               *float64
	ExternalTSS             *float64
	HighIntensityTSS        *float64
	MechanicalLoad          *float64
	SubjectiveInternalLoad  *float64
	TrainingDose            *float64
	TrainingDoseSource      *string
	CardioCoverage          float64
	ExternalCoverage        float64
	HighIntensityCoverage   float64
	CoverageStatus          CoverageStatus
	LoadConfidence          LoadConfidence
	ExcludedFromPMC         bool
	Reasons                 []string
}

// DailyLoadResult mirrors types.DailyLoadResult.
type DailyLoadResult struct {
	Date             time.Time
	AlgorithmVersion int
	CalibrationID    *int
	TrainingDose     float64
	AcuteLoad        float64
	ChronicLoad      float64
	Form             float64
	LoadRatio        *float64
	CoverageStatus   CoverageStatus
	ReadinessGate    string
	ReadinessReasons []string
}

// PriorLoadState mirrors types.PriorLoadState.
type PriorLoadState struct {
	AcuteLoad   float64
	ChronicLoad float64
}

// HealthRow mirrors types.HealthRow (daily readiness inputs).
type HealthRow struct {
	Date        time.Time
	RHR         *float64
	SleepTotalS *float64
	SleepScore  *float64
}

// HrvRow mirrors types.HrvRow.
type HrvRow struct {
	Date         time.Time
	LastNightAvg *float64
	Status       *string
}

// FeedbackRow mirrors types.FeedbackRow (per-activity subjective effort).
type FeedbackRow struct {
	LabelID         string
	ActivityDate    time.Time
	RPE             *int
	DurationMinutes *float64
}

// ReadinessLoadHistory mirrors types.ReadinessLoadHistory.
type ReadinessLoadHistory struct {
	ActivityDate           time.Time
	Sport                  string
	SessionClass           SessionClass
	SubjectiveInternalLoad float64
	TrainingDose           float64
}
