// Package racedetection identifies half-marathon and marathon race efforts from
// synced activities. It is intentionally independent from Coach Agent: a
// deterministic sport/distance gate selects candidates, Go derives route and
// other factual evidence, and an injected LLM assesses only semantic evidence.
// Go owns the final weighted decision.
package racedetection

import (
	"context"
	"encoding/json"
	"time"

	"github.com/zhaochy1990/stride/internal/activityarea"
	"github.com/zhaochy1990/stride/internal/normalize"
)

// RaceType is the standard distance band which admitted a candidate.
type RaceType string

const (
	RaceTypeHalfMarathon RaceType = "half_marathon"
	RaceTypeMarathon     RaceType = "marathon"

	HalfMarathonMinDistanceM = 20_900
	HalfMarathonMaxDistanceM = 22_000
	MarathonMinDistanceM     = 41_900
	MarathonMaxDistanceM     = 44_000
)

// TracePoint is one ordered sample of the activity's geographic and elevation
// trace. Nil values preserve gaps from the watch instead of inventing data.
type TracePoint struct {
	Timestamp *int64   `json:"时间戳,omitempty"`
	Latitude  *float64 `json:"纬度,omitempty"`
	Longitude *float64 `json:"经度,omitempty"`
	AltitudeM *float64 `json:"海拔_米,omitempty"`
}

// PauseInterval is one watch-recorded pause rendered in the user's local
// timezone. DurationS is derived from the recorded interval when the provider's
// duration field is absent or inconsistent.
type PauseInterval struct {
	StartLocal string  `json:"pause_start_local"`
	EndLocal   string  `json:"pause_end_local"`
	DurationS  float64 `json:"duration_s"`
}

// PauseContext is the compact pause evidence supplied to the classifier.
type PauseContext struct {
	Count          int             `json:"count"`
	TotalDurationS float64         `json:"total_duration_s"`
	Intervals      []PauseInterval `json:"intervals"`
}

type storedPause struct {
	StartTimestamp *int64 `json:"startTimestamp"`
	EndTimestamp   *int64 `json:"endTimestamp"`
	StartTS        *int64 `json:"start_ts"`
	EndTS          *int64 `json:"end_ts"`
}

// ParsePauseContext accepts both the current COROS camelCase shape and the
// legacy snake_case shape. Stored timestamps are absolute centiseconds. Invalid
// entries are ignored; nil means there is no reliable recorded pause evidence.
func ParsePauseContext(raw *string, location *time.Location) *PauseContext {
	if raw == nil || *raw == "" {
		return nil
	}
	var stored []storedPause
	if err := json.Unmarshal([]byte(*raw), &stored); err != nil {
		return nil
	}
	if location == nil {
		location = time.UTC
	}
	intervals := make([]PauseInterval, 0, len(stored))
	var total float64
	for _, pause := range stored {
		start, end := pause.StartTimestamp, pause.EndTimestamp
		if start == nil {
			start = pause.StartTS
		}
		if end == nil {
			end = pause.EndTS
		}
		if start == nil || end == nil || *end <= *start {
			continue
		}
		durationS := float64(*end-*start) / 100
		total += durationS
		intervals = append(intervals, PauseInterval{
			StartLocal: centisecondEpoch(*start).In(location).Format("2006-01-02 15:04:05"),
			EndLocal:   centisecondEpoch(*end).In(location).Format("2006-01-02 15:04:05"),
			DurationS:  durationS,
		})
	}
	if len(intervals) == 0 {
		return nil
	}
	return &PauseContext{Count: len(intervals), TotalDurationS: total, Intervals: intervals}
}

func centisecondEpoch(value int64) time.Time {
	seconds := value / 100
	nanoseconds := (value % 100) * int64(10*time.Millisecond)
	return time.Unix(seconds, nanoseconds).UTC()
}

// LocationContext describes the majority cluster of historical activity starts
// and the candidate's distance from that cluster. Nil means the history did not
// contain a reliable majority area.
type LocationContext struct {
	TypicalLatitude          float64
	TypicalLongitude         float64
	SupportingActivityCount  int
	CandidateStartDistanceKM *float64
}

const usualActivityAreaRadiusKM = activityarea.RadiusKM

// LocationContextForTrace adds only the candidate-specific start distance to a
// previously inferred historical area.
func LocationContextForTrace(area *activityarea.Area, trace []TracePoint) *LocationContext {
	if area == nil {
		return nil
	}
	context := &LocationContext{
		TypicalLatitude: area.Latitude, TypicalLongitude: area.Longitude,
		SupportingActivityCount: area.SupportingActivityCount,
	}
	for _, point := range trace {
		if point.Latitude == nil || point.Longitude == nil || !validCoordinate(*point.Latitude, *point.Longitude) {
			continue
		}
		distance := activityarea.DistanceKM(activityarea.Coordinate{Latitude: area.Latitude, Longitude: area.Longitude}, activityarea.Coordinate{Latitude: *point.Latitude, Longitude: *point.Longitude})
		context.CandidateStartDistanceKM = &distance
		break
	}
	return context
}

func validCoordinate(latitude, longitude float64) bool {
	return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180 && (latitude != 0 || longitude != 0)
}

// Candidate is the activity context sent to the classifier after the
// deterministic sport and distance gate has admitted it.
type Candidate struct {
	LabelID       string           `json:"-"`
	Name          string           `json:"name,omitempty"`
	Sport         string           `json:"sport"`
	Date          string           `json:"date"`
	Weekday       string           `json:"weekday,omitempty"`
	DistanceM     float64          `json:"distance_m"`
	DurationS     *float64         `json:"duration_s,omitempty"`
	AvgPaceSKm    *float64         `json:"avg_pace_s_km,omitempty"`
	AvgHR         *int             `json:"avg_hr,omitempty"`
	MaxHR         *int             `json:"max_hr,omitempty"`
	AscentM       *float64         `json:"ascent_m,omitempty"`
	TrainKind     string           `json:"train_kind,omitempty"`
	SportNote     string           `json:"sport_note,omitempty"`
	CandidateType RaceType         `json:"candidate_type"`
	Trace         []TracePoint     `json:"trace,omitempty"`
	Location      *LocationContext `json:"location,omitempty"`
	Pauses        *PauseContext    `json:"pauses,omitempty"`
}

// Classifier asks the model only for semantic evidence. It does not let the
// model choose weights, compute the score, or make the final decision.
type Classifier interface {
	Assess(ctx context.Context, candidate Candidate) (ModelAssessment, error)
}

// TokenUsage is the provider-reported cost of one model request. Counts are
// never estimated locally. Available=false means the endpoint returned no usage
// object (for example, after a transport failure or from a partial-compatible
// bridge).
type TokenUsage struct {
	APIKind      string
	Model        string
	InputTokens  int
	OutputTokens int
	TotalTokens  int
	Available    bool
}

// ModelAssessmentResult carries the semantic model output and exact usage.
type ModelAssessmentResult struct {
	Assessment ModelAssessment
	Usage      TokenUsage
}

// ClassificationResult carries the Go-computed score and provider usage.
type ClassificationResult struct {
	ScoreResult
	Assessment ModelAssessment
	Route      RouteAnalysis
	Usage      TokenUsage
}

type usageClassifier interface {
	AssessWithUsage(ctx context.Context, candidate Candidate) (ModelAssessmentResult, error)
}

// Detector owns the deterministic gate and delegates only admitted candidates.
type Detector struct {
	classifier Classifier
}

func New(classifier Classifier) *Detector {
	return &Detector{classifier: classifier}
}

// CandidateType admits only outdoor or track runs in the agreed inclusive HM
// and FM bands. Indoor, trail, treadmill, unknown, 25K and 30K runs are rejected
// before any LLM call.
func CandidateType(sport string, distanceM float64) (RaceType, bool) {
	if sport != string(normalize.SportRunOutdoor) && sport != string(normalize.SportRunTrack) {
		return "", false
	}
	switch {
	case distanceM >= HalfMarathonMinDistanceM && distanceM <= HalfMarathonMaxDistanceM:
		return RaceTypeHalfMarathon, true
	case distanceM >= MarathonMinDistanceM && distanceM <= MarathonMaxDistanceM:
		return RaceTypeMarathon, true
	default:
		return "", false
	}
}

// Detect returns false without calling the classifier when the deterministic
// gate rejects the activity.
func (d *Detector) Detect(ctx context.Context, candidate Candidate) (bool, error) {
	result, err := d.DetectWithUsage(ctx, candidate)
	return result.IsRace, err
}

// DetectWithUsage analyzes the complete route in Go, asks the model for only
// semantic evidence, then computes the final weighted score in Go. Raw trace
// points are removed before the model call.
func (d *Detector) DetectWithUsage(ctx context.Context, candidate Candidate) (ClassificationResult, error) {
	raceType, ok := CandidateType(candidate.Sport, candidate.DistanceM)
	if !ok {
		return ClassificationResult{}, nil
	}
	candidate.CandidateType = raceType
	route := AnalyzeRoute(candidate.Trace)
	candidate.Trace = nil
	var assessed ModelAssessmentResult
	var err error
	if classifier, ok := d.classifier.(usageClassifier); ok {
		assessed, err = classifier.AssessWithUsage(ctx, candidate)
	} else {
		assessed.Assessment, err = d.classifier.Assess(ctx, candidate)
	}
	result := ClassificationResult{Assessment: assessed.Assessment, Route: route, Usage: assessed.Usage}
	if err != nil {
		return result, err
	}
	result.ScoreResult, err = ScoreAssessment(buildScoringEvidence(candidate, assessed.Assessment, route))
	return result, err
}
