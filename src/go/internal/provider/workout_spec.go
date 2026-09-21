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

// TargetKind is what metric a step targets. The canonical set is closed and
// grouped in three families:
//
//   - Absolute: pace_s_km, hr_bpm, power_w, open.
//   - Relative: pct_max_hr, pct_hrr, pct_lt_hr, pct_lt_pace, pct_race_pace,
//     pct_ftp. The stored Low/High values are plain fractions (0.70 == 70%),
//     never ×100 or ×1000 scaled; adapters own any scaling at their boundary.
//   - Zone: pace_zone, hr_zone. Low/High are 1-based integer zone numbers.
//
// Adding a kind is a schema change: list it in validTargetKinds, give it a
// resolution rule in resolve.go, and cover it in the round-trip tests. Unknown
// kinds are a parse error (never a silent degrade).
//
// Candidate kinds that are deliberately NOT modelled yet: cadence_spm, rpe,
// and a per-100m swim pace unit.
type TargetKind string

const (
	TargetPaceSKM TargetKind = "pace_s_km" // seconds per km
	TargetHRBPM   TargetKind = "hr_bpm"    // beats per minute
	TargetPowerW  TargetKind = "power_w"   // watts
	TargetOpen    TargetKind = "open"      // no specific target

	TargetPctMaxHR    TargetKind = "pct_max_hr"    // fraction of HRmax
	TargetPctHRR      TargetKind = "pct_hrr"       // fraction of heart-rate reserve
	TargetPctLTHR     TargetKind = "pct_lt_hr"     // fraction of lactate-threshold HR
	TargetPctLTPace   TargetKind = "pct_lt_pace"   // speed ratio: v / v_threshold
	TargetPctRacePace TargetKind = "pct_race_pace" // speed ratio: v / v_race_goal
	TargetPctFTP      TargetKind = "pct_ftp"       // fraction of functional threshold power

	TargetPaceZone TargetKind = "pace_zone" // integer pace zone number
	TargetHRZone   TargetKind = "hr_zone"   // integer heart-rate zone number
)

// validTargetKinds is the closed set of kinds the canonical spec accepts.
var validTargetKinds = map[TargetKind]struct{}{
	TargetPaceSKM: {}, TargetHRBPM: {}, TargetPowerW: {}, TargetOpen: {},
	TargetPctMaxHR: {}, TargetPctHRR: {}, TargetPctLTHR: {},
	TargetPctLTPace: {}, TargetPctRacePace: {}, TargetPctFTP: {},
	TargetPaceZone: {}, TargetHRZone: {},
}

var relativeTargetKinds = map[TargetKind]struct{}{
	TargetPctMaxHR: {}, TargetPctHRR: {}, TargetPctLTHR: {},
	TargetPctLTPace: {}, TargetPctRacePace: {}, TargetPctFTP: {},
}

var zoneTargetKinds = map[TargetKind]struct{}{
	TargetPaceZone: {}, TargetHRZone: {},
}

// speedRatioTargetKinds are contractual speed ratios (v / v_reference): a
// fraction below 1 is *slower* than the reference, and absolute pace is
// reference pace ÷ fraction. The direction is pinned so no consumer can invert
// it and emit a dangerously fast target.
var speedRatioTargetKinds = map[TargetKind]struct{}{
	TargetPctLTPace: {}, TargetPctRacePace: {},
}

// IsValid reports whether k is a canonical target kind. Unknown kinds must not
// be accepted: the schema gate rejects them rather than degrading to open.
func (k TargetKind) IsValid() bool { _, ok := validTargetKinds[k]; return ok }

// IsRelative reports whether k is expressed as a fraction of an athlete
// baseline and must be resolved before use.
func (k TargetKind) IsRelative() bool { _, ok := relativeTargetKinds[k]; return ok }

// IsZone reports whether k is expressed as an integer zone number.
func (k TargetKind) IsZone() bool { _, ok := zoneTargetKinds[k]; return ok }

// IsSpeedRatio reports whether k's fraction is a speed ratio (v / v_reference)
// rather than a scalar multiple of a directly-usable value.
func (k TargetKind) IsSpeedRatio() bool { _, ok := speedRatioTargetKinds[k]; return ok }

// maxRelativeFraction is the sanity ceiling for a stored percentage. Values
// are plain fractions, so 0.70 means 70%; anything above 2 is almost certainly
// a ×100 scaling bug, and a value <= 0 is meaningless.
const maxRelativeFraction = 2.0

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
// Low / High form an inclusive range in the unit implied by Kind. Low is always
// the *easier* end and High the *harder* end — the names refer to intensity,
// not numeric value. That means:
//
//   - pace_s_km: Low is the slower bound (larger seconds/km), High the faster.
//   - hr_bpm / power_w and all percentage kinds: Low is numerically smaller.
//   - pct_lt_pace / pct_race_pace: Low is the smaller (slower) speed ratio, so
//     Low <= High numerically and the resolved pace keeps Low > High.
//   - *_zone: Low/High are 1-based integer zone numbers, Low the easier zone.
//
// Ranges, single points (Low == High) and one-sided caps (one side nil) are all
// valid. Percent values are plain fractions (0.70–0.80), never ×100/×1000
// scaled.
type Target struct {
	Kind TargetKind `json:"kind"`
	Low  *float64   `json:"low"`
	High *float64   `json:"high"`
}

// Validate enforces the canonical target contract. It is schema-gated: unknown
// kinds, non-fraction percentages, non-integer zone numbers, and inverted
// speed-ratio ranges are errors, never a silent degrade. Absolute kinds are
// validated only for a known kind so stored legacy plans keep parsing.
func (t Target) Validate() error {
	if !t.Kind.IsValid() {
		// A zero-value Target (no kind, no bounds) is the legacy "no target"
		// shape produced by struct construction and by specs that omit the
		// target entirely; treat it like open for backward compatibility. Any
		// other unknown kind is a schema error.
		if t.Kind == "" && t.Low == nil && t.High == nil {
			return nil
		}
		return fmt.Errorf("unknown target kind %q", t.Kind)
	}
	if t.Kind == TargetOpen {
		return nil
	}
	if t.Kind.IsRelative() || t.Kind.IsZone() {
		for _, b := range []struct {
			name string
			v    *float64
		}{{"low", t.Low}, {"high", t.High}} {
			if b.v == nil {
				continue
			}
			if t.Kind.IsRelative() {
				if err := validateFraction(b.v); err != nil {
					return fmt.Errorf("%s target %s %w", t.Kind, b.name, err)
				}
				continue
			}
			if *b.v < 1 || *b.v != math.Trunc(*b.v) || math.IsInf(*b.v, 0) || math.IsNaN(*b.v) {
				return fmt.Errorf("%s target %s must be a positive integer zone number, got %v", t.Kind, b.name, *b.v)
			}
		}
	}
	if t.Low != nil && t.High != nil && (t.Kind.IsRelative() || t.Kind.IsZone()) {
		if *t.Low > *t.High {
			if t.Kind.IsSpeedRatio() {
				return fmt.Errorf("%s is a speed ratio: low (easier/slower) must be <= high (harder/faster), got low=%v high=%v", t.Kind, *t.Low, *t.High)
			}
			return fmt.Errorf("%s target low (easier) must be <= high (harder), got low=%v high=%v", t.Kind, *t.Low, *t.High)
		}
	}
	return nil
}

// validateFraction rejects any stored percentage that is not a plain fraction
// in (0, maxRelativeFraction].
func validateFraction(v *float64) error {
	if math.IsNaN(*v) || math.IsInf(*v, 0) || *v <= 0 || *v > maxRelativeFraction {
		return fmt.Errorf("must be a fraction in (0, %.1f], got %v", maxRelativeFraction, *v)
	}
	return nil
}

// PctRange builds a relative target from plain fractions (0.70 == 70%). Bounds
// are ordered so Low is the easier end. Speed-ratio kinds keep their pinned
// direction because the easier fraction is always the smaller one.
func PctRange(kind TargetKind, low, high float64) Target {
	lo, hi := math.Min(low, high), math.Max(low, high)
	return Target{Kind: kind, Low: &lo, High: &hi}
}

// ZoneRange builds a zone target from 1-based integer zone numbers; Low is the
// easier (lower) zone.
func ZoneRange(kind TargetKind, low, high int) Target {
	lo, hi := float64(min(low, high)), float64(max(low, high))
	return Target{Kind: kind, Low: &lo, High: &hi}
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

// Validate reports structural problems (repeat >= 1, at least one step) and
// validates each step's target against the canonical schema.
func (b WorkoutBlock) Validate() error {
	if b.Repeat < 1 {
		return fmt.Errorf("repeat must be >= 1, got %d", b.Repeat)
	}
	if len(b.Steps) == 0 {
		return fmt.Errorf("workout block must have at least one step")
	}
	for i, s := range b.Steps {
		if err := s.Target.Validate(); err != nil {
			return fmt.Errorf("step %d: %w", i, err)
		}
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

// RunWorkoutFromJSON parses a "run-workout/v1" JSON payload (the same shape
// Python's NormalizedRunWorkout.from_dict consumes) and validates it.
//
// The schema discriminator is authoring-time metadata that the weekly-plan
// apply path strips from stored content (api.stripStoredWeeklyPlanMetadata). So
// a missing schema is tolerated and normalized to "run-workout/v1" — this keeps
// the push path consuming stored specs unchanged. A present-but-wrong schema is
// still rejected to catch cross-type authoring mistakes.
func RunWorkoutFromJSON(data []byte) (*RunWorkout, error) {
	var head struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("parse run workout: %w", err)
	}
	if head.Schema != "" && head.Schema != RunWorkoutSchema {
		return nil, fmt.Errorf("unexpected run workout schema %q, want %q", head.Schema, RunWorkoutSchema)
	}
	var w RunWorkout
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, fmt.Errorf("parse run workout: %w", err)
	}
	w.Schema = RunWorkoutSchema // normalize stored specs that omitted the discriminator
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

// StrengthWorkoutFromJSON parses a "strength-workout/v1" JSON payload and
// validates it. See RunWorkoutFromJSON — a missing schema is tolerated and
// normalized, a present-but-wrong schema is still rejected.
func StrengthWorkoutFromJSON(data []byte) (*StrengthWorkout, error) {
	var head struct {
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, fmt.Errorf("parse strength workout: %w", err)
	}
	if head.Schema != "" && head.Schema != StrengthWorkoutSchema {
		return nil, fmt.Errorf("unexpected strength workout schema %q, want %q", head.Schema, StrengthWorkoutSchema)
	}
	var w StrengthWorkout
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, fmt.Errorf("parse strength workout: %w", err)
	}
	w.Schema = StrengthWorkoutSchema // normalize stored specs that omitted the discriminator
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
