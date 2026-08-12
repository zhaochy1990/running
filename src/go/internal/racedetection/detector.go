// Package racedetection identifies half-marathon and marathon race efforts from
// synced activities. It is intentionally independent from Coach Agent: a
// deterministic sport/distance gate selects candidates, then an injected LLM
// classifier makes the final boolean decision.
package racedetection

import "context"

// RaceType is the standard distance band which admitted a candidate.
type RaceType string

const (
	RaceTypeHalfMarathon RaceType = "half_marathon"
	RaceTypeMarathon     RaceType = "marathon"

	SportOutdoorRun = "run_outdoor"
	SportTrackRun   = "run_track"

	HalfMarathonMinDistanceM = 20_900
	HalfMarathonMaxDistanceM = 22_000
	MarathonMinDistanceM     = 41_900
	MarathonMaxDistanceM     = 44_000
)

// Candidate is the bounded activity summary sent to the classifier. GPS and
// timeseries data are deliberately excluded.
type Candidate struct {
	LabelID       string   `json:"-"`
	Name          string   `json:"name,omitempty"`
	Sport         string   `json:"sport"`
	Date          string   `json:"date"`
	DistanceM     float64  `json:"distance_m"`
	DurationS     *float64 `json:"duration_s,omitempty"`
	AvgPaceSKm    *float64 `json:"avg_pace_s_km,omitempty"`
	AvgHR         *int     `json:"avg_hr,omitempty"`
	MaxHR         *int     `json:"max_hr,omitempty"`
	AscentM       *float64 `json:"ascent_m,omitempty"`
	TrainKind     string   `json:"train_kind,omitempty"`
	SportNote     string   `json:"sport_note,omitempty"`
	CandidateType RaceType `json:"candidate_type"`
}

// Classifier decides whether a gated candidate represents a race effort. Both
// organized races and personal HM/FM time trials count as races.
type Classifier interface {
	Classify(ctx context.Context, candidate Candidate) (bool, error)
}

// Detector owns the deterministic gate and delegates only admitted candidates.
type Detector struct{ classifier Classifier }

func New(classifier Classifier) *Detector { return &Detector{classifier: classifier} }

// CandidateType admits only outdoor or track runs in the agreed inclusive HM
// and FM bands. Indoor, trail, treadmill, unknown, 25K and 30K runs are rejected
// before any LLM call.
func CandidateType(sport string, distanceM float64) (RaceType, bool) {
	if sport != SportOutdoorRun && sport != SportTrackRun {
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
	raceType, ok := CandidateType(candidate.Sport, candidate.DistanceM)
	if !ok {
		return false, nil
	}
	candidate.CandidateType = raceType
	return d.classifier.Classify(ctx, candidate)
}
