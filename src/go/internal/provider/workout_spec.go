// Package provider — provider-agnostic structured workout specifications.
//
// Workouts are authored and stored in this normalized form; adapters translate
// to provider-specific protocol payloads (COROS schedule/update entities,
// Garmin Workouts API steps, etc.) at push time. This file is the Go port of
// stride_core.workout_spec.
//
// Conventions:
//   - A run workout is a flat list of WorkoutBlocks. Each block has a sequence
//     of WorkoutSteps and a repeat count. Single-rep blocks express linear
//     segments (warmup → tempo → cooldown). Multi-rep blocks express interval
//     groups (6× [800m work + 60s recovery]).
//   - Each step has a Duration (distance, time, or open) and an optional Target
//     (pace range, HR range, power range, or open). All durations are in SI
//     base units (meters, seconds) and all paces in seconds-per-km. Adapter-
//     side translation is the only place that touches provider units.
//   - Strength workouts are a flat list of StrengthExerciseSpecs referencing
//     the canonical exercise catalog; adapters look up their provider-specific
//     exercise ID at push time.
//   - All types are JSON-roundtrippable (schema-tagged, like the Python
//     to_dict/from_dict) so the same spec can cross the API boundary.
package provider

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

// StepKind is the role of a step within a workout.
type StepKind string

const (
	StepWarmup   StepKind = "warmup"   // warm-up segment
	StepWork     StepKind = "work"     // main effort (tempo, interval rep, easy run body, …)
	StepRecovery StepKind = "recovery" // active recovery between reps inside an interval block
	StepCooldown StepKind = "cooldown" // cool-down segment
	StepRest     StepKind = "rest"     // passive rest (e.g. between strength sets — rare in run)
)

// DurationKind is how a step's length is measured.
type DurationKind string

const (
	DurationDistanceM DurationKind = "distance_m" // meters
	DurationTimeS     DurationKind = "time_s"     // seconds
	DurationOpen      DurationKind = "open"       // ends manually (no fixed length)
)

// TargetKind is what metric a step targets.
type TargetKind string

const (
	TargetPaceSKM TargetKind = "pace_s_km" // seconds per km
	TargetHRBPM   TargetKind = "hr_bpm"    // beats per minute
	TargetPowerW  TargetKind = "power_w"   // watts
	TargetOpen    TargetKind = "open"      // no specific target
)

// StrengthTargetKind is what a strength exercise set targets.
type StrengthTargetKind string

const (
	StrengthTargetReps  StrengthTargetKind = "reps"   // target reps per set
	StrengthTargetTimeS StrengthTargetKind = "time_s" // target seconds per set
)

// ─────────────────────────────────────────────────────────────────────────────
// Duration / Target
// ─────────────────────────────────────────────────────────────────────────────

// Duration is how long a step lasts. Value is nil iff Kind == DurationOpen.
type Duration struct {
	Kind  DurationKind `json:"kind"`
	Value *float64     `json:"value"`
}

// DurationOfDistanceM builds a distance duration in meters.
func DurationOfDistanceM(m float64) Duration {
	return Duration{Kind: DurationDistanceM, Value: floatPtr(m)}
}

// DurationOfDistanceKM builds a distance duration in kilometers (stored as meters).
func DurationOfDistanceKM(km float64) Duration {
	return Duration{Kind: DurationDistanceM, Value: floatPtr(km * 1000)}
}

// DurationOfTimeS builds a time duration in seconds.
func DurationOfTimeS(s float64) Duration { return Duration{Kind: DurationTimeS, Value: floatPtr(s)} }

// DurationOfTimeMin builds a time duration in minutes (stored as seconds).
func DurationOfTimeMin(minutes float64) Duration {
	return Duration{Kind: DurationTimeS, Value: floatPtr(minutes * 60)}
}

// OpenDuration is a manually-ended step with no fixed length.
func OpenDuration() Duration { return Duration{Kind: DurationOpen} }

// Target is an optional intensity target for a step.
//
// Low / High form an inclusive range in the unit implied by Kind. For
// asymmetric metrics like pace where smaller = faster, Low is the slower bound
// (larger seconds/km) and High is the faster bound (smaller seconds/km) — the
// names refer to *intensity*, not numeric value.
type Target struct {
	Kind TargetKind `json:"kind"`
	Low  *float64   `json:"low"`
	High *float64   `json:"high"`
}

// OpenTarget is a step with no intensity target.
func OpenTarget() Target { return Target{Kind: TargetOpen} }

// PaceRangeSKM builds a pace range; Low ends up the slower bound (larger
// seconds/km), High the faster bound (smaller seconds/km), regardless of the
// argument order.
func PaceRangeSKM(lowSkm, highSkm float64) Target {
	slow, fast := math.Max(lowSkm, highSkm), math.Min(lowSkm, highSkm)
	return Target{Kind: TargetPaceSKM, Low: &slow, High: &fast}
}

// HRRangeBPM builds an HR range; Low is the lower bound.
func HRRangeBPM(low, high int) Target {
	l, h := float64(min(low, high)), float64(max(low, high))
	return Target{Kind: TargetHRBPM, Low: &l, High: &h}
}

// PowerRangeW builds a power range; Low is the lower bound.
func PowerRangeW(low, high int) Target {
	l, h := float64(min(low, high)), float64(max(low, high))
	return Target{Kind: TargetPowerW, Low: &l, High: &h}
}

// ─────────────────────────────────────────────────────────────────────────────
// Step / Block / Run workout
// ─────────────────────────────────────────────────────────────────────────────

// WorkoutStep is a single atomic step in a workout.
type WorkoutStep struct {
	StepKind StepKind `json:"step_kind"`
	Duration Duration `json:"duration"`
	Target   Target   `json:"target"`
	// Note is free-text annotation (e.g. "HR 130-148, 配速参考 6:00-6:30/km").
	Note *string `json:"note,omitempty"`
	// HRCapBPM is a constraint layered on top of the primary target: an HR
	// ceiling that must not be crossed regardless of how the primary target
	// goes (e.g. "4×3K @ 4:05-4:10/km, HR ≤167").
	HRCapBPM *int `json:"hr_cap_bpm,omitempty"`
}

// WorkoutBlock is a sequence of steps performed Repeat times. Repeat == 1 means
// a linear block; Repeat > 1 means an interval group (typically two steps —
// work + recovery — repeated N times).
type WorkoutBlock struct {
	Steps  []WorkoutStep `json:"steps"`
	Repeat int           `json:"repeat"`
}

// Validate reports structural problems (repeat >= 1, at least one step).
func (b WorkoutBlock) Validate() error {
	if b.Repeat < 1 {
		return fmt.Errorf("repeat must be >= 1, got %d", b.Repeat)
	}
	if len(b.Steps) == 0 {
		return fmt.Errorf("workout block must have at least one step")
	}
	return nil
}

// Schema markers, matching the Python to_dict schema discriminators.
const (
	RunWorkoutSchema      = "run-workout/v1"
	StrengthWorkoutSchema = "strength-workout/v1"
)

// RunWorkout is a provider-agnostic running workout. Date is ISO YYYY-MM-DD
// (no timezone — workout days are local-calendar concepts, not instants).
type RunWorkout struct {
	Schema string         `json:"schema"`
	Name   string         `json:"name"`
	Date   string         `json:"date"`
	Note   *string        `json:"note,omitempty"`
	Blocks []WorkoutBlock `json:"blocks"`
}

// Validate checks the workout shape before any adapter consumes it.
func (w RunWorkout) Validate() error {
	if strings.TrimSpace(w.Name) == "" {
		return fmt.Errorf("workout name is required")
	}
	if !validISODate(w.Date) {
		return fmt.Errorf("date must be ISO YYYY-MM-DD, got %q", w.Date)
	}
	if len(w.Blocks) == 0 {
		return fmt.Errorf("run workout must have at least one block")
	}
	for i, b := range w.Blocks {
		if err := b.Validate(); err != nil {
			return fmt.Errorf("block %d: %w", i, err)
		}
	}
	return nil
}

// RunWorkoutFromJSON parses a schema-anchored "run-workout/v1" JSON payload
// (the same shape Python's NormalizedRunWorkout.from_dict consumes) and
// validates it. The schema discriminator is required — a missing or wrong
// schema is rejected rather than guessed.
func RunWorkoutFromJSON(data []byte) (*RunWorkout, error) {
	var head struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("parse run workout: %w", err)
	}
	if head.Schema != RunWorkoutSchema {
		return nil, fmt.Errorf("unexpected run workout schema %q, want %q", head.Schema, RunWorkoutSchema)
	}
	var w RunWorkout
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, fmt.Errorf("parse run workout: %w", err)
	}
	if err := w.Validate(); err != nil {
		return nil, err
	}
	return &w, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Strength
// ─────────────────────────────────────────────────────────────────────────────

// StrengthExerciseSpec is one exercise within a strength workout.
//
// CanonicalID references the canonical exercise catalog; adapters resolve it to
// their provider-specific exercise ID at push time. ProviderID is the
// provider-native exercise identifier authored alongside the spec (for COROS
// this is the T-code, e.g. "T1262"); when nil/empty the adapter falls back to
// creating a custom exercise. DisplayName is captured at authoring time for
// stable rendering even if the canonical catalog is later edited.
type StrengthExerciseSpec struct {
	CanonicalID string             `json:"canonical_id"`
	DisplayName string             `json:"display_name"`
	Sets        int                `json:"sets"`
	TargetKind  StrengthTargetKind `json:"target_kind"`
	TargetValue int                `json:"target_value"`
	RestSeconds int                `json:"rest_seconds"`
	Note        *string            `json:"note,omitempty"`
	ProviderID  *string            `json:"provider_id,omitempty"`
}

// StrengthWorkout is a provider-agnostic strength training workout.
type StrengthWorkout struct {
	Schema    string                 `json:"schema"`
	Name      string                 `json:"name"`
	Date      string                 `json:"date"`
	Note      *string                `json:"note,omitempty"`
	Exercises []StrengthExerciseSpec `json:"exercises"`
}

// Validate checks the workout shape before any adapter consumes it.
func (w StrengthWorkout) Validate() error {
	if strings.TrimSpace(w.Name) == "" {
		return fmt.Errorf("workout name is required")
	}
	if !validISODate(w.Date) {
		return fmt.Errorf("date must be ISO YYYY-MM-DD, got %q", w.Date)
	}
	if len(w.Exercises) == 0 {
		return fmt.Errorf("strength workout must have at least one exercise")
	}
	for i, e := range w.Exercises {
		if e.Sets < 1 {
			return fmt.Errorf("exercise %d: sets must be >= 1, got %d", i, e.Sets)
		}
		if e.TargetValue < 1 {
			return fmt.Errorf("exercise %d: target_value must be >= 1, got %d", i, e.TargetValue)
		}
		if e.RestSeconds < 0 {
			return fmt.Errorf("exercise %d: rest_seconds must be >= 0, got %d", i, e.RestSeconds)
		}
	}
	return nil
}

// StrengthWorkoutFromJSON parses a schema-anchored "strength-workout/v1" JSON
// payload and validates it. See RunWorkoutFromJSON.
func StrengthWorkoutFromJSON(data []byte) (*StrengthWorkout, error) {
	var head struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("parse strength workout: %w", err)
	}
	if head.Schema != StrengthWorkoutSchema {
		return nil, fmt.Errorf("unexpected strength workout schema %q, want %q", head.Schema, StrengthWorkoutSchema)
	}
	var w StrengthWorkout
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, fmt.Errorf("parse strength workout: %w", err)
	}
	if err := w.Validate(); err != nil {
		return nil, err
	}
	return &w, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Pace helpers (authoring convenience)
// ─────────────────────────────────────────────────────────────────────────────

// ParsePaceSKM parses "M:SS" / "MM:SS" (e.g. "5:40", "12:30") or a bare number
// (already seconds-per-km) into integer seconds-per-km.
func ParsePaceSKM(pace string) (int, error) {
	p := strings.TrimSpace(pace)
	parts := strings.Split(p, ":")
	if len(parts) == 1 {
		return strconv.Atoi(parts[0])
	}
	if len(parts) == 2 {
		min, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			return 0, fmt.Errorf("cannot parse pace %q: %w", pace, err)
		}
		sec, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			return 0, fmt.Errorf("cannot parse pace %q: %w", pace, err)
		}
		return min*60 + sec, nil
	}
	return 0, fmt.Errorf("cannot parse pace %q", pace)
}

// FormatPaceSKM formats integer seconds-per-km as "M:SS/km". Nil-safe: a nil
// pointer yields nil.
func FormatPaceSKM(sPerKm *float64) *string {
	if sPerKm == nil {
		return nil
	}
	total := int(math.Round(*sPerKm))
	return stringPtr(fmt.Sprintf("%d:%02d/km", total/60, total%60))
}

// ─────────────────────────────────────────────────────────────────────────────
// small helpers
// ─────────────────────────────────────────────────────────────────────────────

func validISODate(s string) bool {
	return len(s) == 10 && s[4] == '-' && s[7] == '-'
}

func floatPtr(v float64) *float64 { return &v }

func stringPtr(s string) *string { return &s }
