// translate.go translates provider-agnostic normalized workouts (workout_spec)
// into the COROS-shaped builders. Go port of coros_sync.translate.
//
// The COROS push protocol is wrapped by the RunWorkoutBuilder /
// StrengthWorkoutBuilder — they own the warmup/training/cooldown/interval
// segment vocabulary, the centisecond unit conversions, and the calculate →
// update flow. This file is the thin adapter that converts a provider-agnostic
// workout into the COROS-shaped builder so pushWorkout() stays the single push
// entry point.
//
// Translation rules:
//   - Single-step blocks (repeat=1) → one matching segment per step.
//   - Multi-step blocks (repeat>1) → one COROS interval group per block.
//     The group expects (work, recovery) or (work,) sub-steps; anything else
//     falls back to a best-effort flatten (each repeat emitted as separate
//     training segments).
//   - Pace targets (TargetPaceSKM) → primary path, becomes COROS's pace_low
//     (slower "M:SS") / pace_high (faster "M:SS") strings.
//   - HR / open / power targets → regex-extracts pace from step.note when
//     present (plan.md often writes both, e.g. "HR<148, 配速 6:00-6:30/km").
//     Final fallback: segment runs without a pace target on the watch.
//   - Duration: DISTANCE_M → distance_km, TIME_S → duration_min, OPEN → 5 min
//     default for warmup/cooldown, 30 min for training.
package coros

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/zhaochy1990/stride/internal/provider"
)

// isoToYYYYMMDD converts "2026-05-01" → "20260501" (COROS API date format).
func isoToYYYYMMDD(isoDate string) string {
	return strings.ReplaceAll(isoDate, "-", "")
}

// secondsToPaceStr converts 280 → "4:40" (COROS pace string format).
func secondsToPaceStr(secondsPerKm float64) string {
	s := int(math.Round(secondsPerKm))
	return fmtPace(s)
}

// fmtPace formats total seconds as "M:SS" (zero-padded seconds, like Python
// f"{m}:{s:02d}").
func fmtPace(totalS int) string {
	return strconv.Itoa(totalS/60) + ":" + fmt.Sprintf("%02d", totalS%60)
}

// stepDuration returns (distanceKm, durationMin) — at most one non-nil. OPEN
// durations fall back to defaultMin (COROS doesn't support open-ended steps).
func stepDuration(step provider.WorkoutStep, defaultMin float64) (*float64, *float64) {
	d := step.Duration
	if d.Kind == provider.DurationDistanceM && d.Value != nil {
		return floatPtrOf(*d.Value / 1000), nil
	}
	if d.Kind == provider.DurationTimeS && d.Value != nil {
		return nil, floatPtrOf(*d.Value / 60)
	}
	return nil, floatPtrOf(defaultMin)
}

// Pace-range regexes mirror translate.py: "6:00-6:30/km" (also ～ — － ~),
// "≤4:30/km" / "<4:30/km" ceilings, and "@5:13/km" / "5:13/km" singles.
var (
	paceRangeRe = regexp.MustCompile(`(\d):(\d{2})\s*[-~～–—－]\s*(\d):(\d{2})\s*/?\s*km`)
	paceCeilRe  = regexp.MustCompile(`[≤<]\s*(\d):(\d{2})\s*/?\s*km`)
	paceAtRe    = regexp.MustCompile(`@?\s*(\d):(\d{2})\s*/\s*km`)
)

func paceToSeconds(mm, ss string) int {
	m, _ := strconv.Atoi(mm)
	s, _ := strconv.Atoi(ss)
	return m*60 + s
}

// extractPaceFromNote extracts a pace range (slow, fast) from free-text note.
// Tries in order: range, ceiling (±10s window above), single pace (±5s window).
func extractPaceFromNote(note *string) (*string, *string) {
	if note == nil || *note == "" {
		return nil, nil
	}
	if m := paceRangeRe.FindStringSubmatch(*note); m != nil {
		aS := paceToSeconds(m[1], m[2])
		bS := paceToSeconds(m[3], m[4])
		slowS, fastS := aS, bS
		if aS < bS {
			slowS, fastS = bS, aS
		}
		return stringPtrOf(fmtPace(slowS)), stringPtrOf(fmtPace(fastS))
	}
	if m := paceCeilRe.FindStringSubmatch(*note); m != nil {
		ceilS := paceToSeconds(m[1], m[2])
		// Ceiling is an upper bound; expand to a ±10 s window so the watch
		// shows a range and not a single value.
		return stringPtrOf(fmtPace(ceilS + 10)), stringPtrOf(fmtPace(ceilS))
	}
	if m := paceAtRe.FindStringSubmatch(*note); m != nil {
		atS := paceToSeconds(m[1], m[2])
		return stringPtrOf(fmtPace(atS + 5)), stringPtrOf(fmtPace(atS - 5))
	}
	return nil, nil
}

// paceBounds returns COROS-formatted (paceLow, paceHigh) — slow/fast bounds.
// Primary: step.target with PACE_S_KM kind. Fallback: regex-extract pace from
// step.note (HR/open/power targets often carry pace as free-text annotation).
func paceBounds(step provider.WorkoutStep) (*string, *string) {
	t := step.Target
	if t.Kind == provider.TargetPaceSKM {
		if t.Low == nil || t.High == nil {
			return nil, nil
		}
		// Normalized convention: Low = slower (larger s/km), High = faster.
		return stringPtrOf(secondsToPaceStr(*t.Low)), stringPtrOf(secondsToPaceStr(*t.High))
	}
	return extractPaceFromNote(step.Note)
}

func emitSingleStep(out *RunWorkoutBuilder, step provider.WorkoutStep) {
	paceLow, paceHigh := paceBounds(step)
	switch step.StepKind {
	case provider.StepWarmup:
		dist, dur := stepDuration(step, 5)
		out.addWarmup(dur, dist, paceLow, paceHigh)
	case provider.StepCooldown:
		dist, dur := stepDuration(step, 5)
		out.addCooldown(dur, dist, paceLow, paceHigh)
	case provider.StepRecovery, provider.StepRest:
		dist, dur := stepDuration(step, 3)
		out.addRecovery(dur, dist, paceLow, paceHigh)
	default: // WORK (or anything else) → training segment
		dist, dur := stepDuration(step, 30)
		out.addTraining(dist, dur, paceLow, paceHigh, 1, 0, 0)
	}
}

func emitRepeatBlock(out *RunWorkoutBuilder, block provider.WorkoutBlock) {
	steps := block.Steps
	var work, recovery *provider.WorkoutStep
	if len(steps) > 0 {
		work = &steps[0]
	}
	if len(steps) > 1 {
		recovery = &steps[1]
	}
	if work != nil && (work.StepKind == provider.StepWork || work.StepKind == provider.StepRecovery) &&
		recovery != nil && (recovery.StepKind == provider.StepRecovery || recovery.StepKind == provider.StepRest) &&
		len(steps) == 2 {
		// Pick the work pace as the interval target; recovery uses time.
		paceLow, paceHigh := paceBounds(*work)
		distKm, durMin := stepDuration(*work, 5)
		recoveryS := 60
		if recovery.Duration.Kind == provider.DurationTimeS && recovery.Duration.Value != nil {
			recoveryS = int(*recovery.Duration.Value)
		}
		out.addInterval(block.Repeat, distKm, durMin, paceLow, paceHigh, recoveryS)
		return
	}
	// Fallback: emit each step `repeat` times as flat segments.
	for i := 0; i < block.Repeat; i++ {
		for _, step := range steps {
			emitSingleStep(out, step)
		}
	}
}

// inferCorosWorkoutType heuristically picks the COROS workout_type (used for
// the source image asset):
//   - any block has repeat>1 → "interval"
//   - any work step >= 16km → "long"
//   - any work step has pace target faster than 4:30/km → "tempo"
//   - else "easy"
func inferCorosWorkoutType(w provider.RunWorkout) string {
	for _, b := range w.Blocks {
		if b.Repeat > 1 {
			return "interval"
		}
	}
	for _, b := range w.Blocks {
		for _, step := range b.Steps {
			if step.StepKind != provider.StepWork {
				continue
			}
			if d := step.Duration; d.Kind == provider.DurationDistanceM && d.Value != nil && *d.Value >= 16000 {
				return "long"
			}
			if t := step.Target; t.Kind == provider.TargetPaceSKM && t.High != nil && *t.High <= 270 {
				return "tempo"
			}
		}
	}
	return "easy"
}

// NormalizedToCorosRun translates a normalized run workout into the COROS
// builder (preserving segment order).
func NormalizedToCorosRun(w provider.RunWorkout) (*RunWorkoutBuilder, error) {
	if err := w.Validate(); err != nil {
		return nil, err
	}
	out := NewRunWorkoutBuilder(w.Name, isoToYYYYMMDD(w.Date), inferCorosWorkoutType(w))
	for _, block := range w.Blocks {
		if block.Repeat > 1 {
			emitRepeatBlock(out, block)
		} else {
			for _, step := range block.Steps {
				emitSingleStep(out, step)
			}
		}
	}
	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Strength translation
// ─────────────────────────────────────────────────────────────────────────────

// customExercisePayload builds an add_exercise request body for specs without a
// working provider_id. Mirrors the canonical example: sportType=4,
// exerciseType=2, generic part/muscle/equipment defaults.
func customExercisePayload(spec provider.StrengthExerciseSpec) map[string]any {
	targetType := 3
	if spec.TargetKind == provider.StrengthTargetTimeS {
		targetType = 2
	}
	name := strings.TrimSpace(spec.DisplayName)
	if name == "" {
		name = spec.CanonicalID
	}
	return map[string]any{
		"sportType":            4,
		"exerciseType":         2,
		"name":                 name,
		"overview":             name,
		"part":                 []any{"4"},
		"muscle":               []any{"6"},
		"muscleRelevance":      []any{},
		"equipment":            []any{"1"},
		"access":               1,
		"intensityCustom":      0,
		"intensityMultiplier":  0,
		"intensityType":        1,
		"intensityValue":       0,
		"intensityValueExtend": 0,
		"restType":             1,
		"restValue":            spec.RestSeconds,
		"targetType":           targetType,
		"targetValue":          spec.TargetValue,
	}
}

// NormalizedToCorosStrength translates a normalized strength workout into the
// COROS builder. Each spec's provider_id (COROS T-code) is looked up by
// matching the catalog entry's `name` field; unmatched specs are returned in
// missing so the caller can register a custom exercise via Client.AddExercise
// and re-translate against the refreshed library.
func NormalizedToCorosStrength(w provider.StrengthWorkout, available []map[string]any) (*StrengthWorkoutBuilder, []map[string]any) {
	byTCode := make(map[string]map[string]any, len(available))
	for _, ex := range available {
		name, _ := ex["name"].(string)
		if tcode := strings.TrimSpace(name); tcode != "" {
			byTCode[tcode] = ex
		}
	}
	out := NewStrengthWorkoutBuilder(w.Name, isoToYYYYMMDD(w.Date))
	var missing []map[string]any
	for _, spec := range w.Exercises {
		tcode := ""
		if spec.ProviderID != nil {
			tcode = strings.TrimSpace(*spec.ProviderID)
		}
		var match map[string]any
		if tcode != "" {
			match = byTCode[tcode]
		}
		if match == nil {
			missing = append(missing, customExercisePayload(spec))
			continue
		}
		targetType := 3
		if spec.TargetKind == provider.StrengthTargetTimeS {
			targetType = 2
		}
		out.addExercise(match, spec.Sets, targetType, spec.TargetValue, spec.RestSeconds)
	}
	return out, missing
}
