// workout_push.go wires the COROS workout-push / schedule / exercise-library
// methods onto the Provider adapter. Go port of the push half of
// coros_sync.adapter.CorosDataSource: normalized workout → translate → the
// calculate→update push flow, plus the [STRIDE]-guarded delete sweep.
package coros

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/zhaochy1990/stride/internal/provider"
)

// PushRunWorkout pushes a normalized run workout to the user's COROS schedule
// and returns the COROS idInPlan (the watch-side identifier) as a string.
func (p *Provider) PushRunWorkout(ctx context.Context, user string, w provider.RunWorkout) (string, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return "", err
	}
	corosWorkout, err := NormalizedToCorosRun(w)
	if err != nil {
		return "", err
	}
	return pushWorkout(ctx, client, corosWorkout)
}

// PushStrengthWorkout pushes a normalized strength workout to the user's COROS
// schedule. Each spec's provider_id (COROS T-code) is matched against the
// built-in + custom exercise library; misses create a custom exercise via
// AddExercise and re-translate against the refreshed library.
func (p *Provider) PushStrengthWorkout(ctx context.Context, user string, w provider.StrengthWorkout) (string, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return "", err
	}
	available, err := client.QueryExercises(ctx, 4)
	if err != nil {
		return "", err
	}
	var library []map[string]any
	if err := json.Unmarshal(available, &library); err != nil {
		return "", fmt.Errorf("coros: decode exercise library: %w", err)
	}

	corosWorkout, missing := NormalizedToCorosStrength(w, library)
	if len(missing) > 0 {
		for _, exPayload := range missing {
			if _, err := client.AddExercise(ctx, exPayload); err != nil {
				return "", err
			}
		}
		refreshed, err := client.QueryExercises(ctx, 4)
		if err != nil {
			return "", err
		}
		library = nil
		if err := json.Unmarshal(refreshed, &library); err != nil {
			return "", fmt.Errorf("coros: decode refreshed exercise library: %w", err)
		}
		corosWorkout, _ = NormalizedToCorosStrength(w, library)
	}
	return pushStrengthWorkout(ctx, client, corosWorkout)
}

// DeleteScheduledWorkout removes previously-pushed [STRIDE] workouts on `date`
// from the watch schedule. Mirrors the Python adapter: never deletes non-STRIDE
// entries (protects the user's own watch entries). When `name` is non-empty,
// only entries whose program name matches exactly are deleted (e.g. only the
// prior push of THIS session); otherwise all [STRIDE]-prefixed entries on the
// date are removed (legacy aggressive sweep, kept for CLI use).
//
// date arrives as ISO YYYY-MM-DD (matches scheduled_workout.date); COROS API
// expects YYYYMMDD so it is coerced. Returns true when at least one matching
// entity was deleted, false when no STRIDE entries existed (still success).
func (p *Provider) DeleteScheduledWorkout(ctx context.Context, user, date, name string) (bool, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return false, err
	}
	corosDate := strings.ReplaceAll(date, "-", "")
	data, err := client.QuerySchedule(ctx, corosDate, corosDate)
	if err != nil {
		return false, err
	}
	var sched struct {
		PlanID   any              `json:"id"`
		Entities []map[string]any `json:"entities"`
		Programs []map[string]any `json:"programs"`
	}
	if err := json.Unmarshal(data, &sched); err != nil {
		return false, fmt.Errorf("coros: decode schedule: %w", err)
	}
	// The schedule API returns names in programs[] (parallel array), not on the
	// entity itself — entities only carry idInPlan / planProgramId references.
	namesByIDInPlan := make(map[string]string, len(sched.Programs))
	for _, prog := range sched.Programs {
		if idip := firstNonEmpty(prog, "idInPlan", "id"); idip != "" {
			namesByIDInPlan[idip] = strAny(prog["name"])
		}
	}
	deleted := 0
	for _, entity := range sched.Entities {
		if strAny(entity["happenDay"]) != corosDate {
			continue
		}
		idip := firstNonEmpty(entity, "idInPlan", "planProgramId")
		programName := namesByIDInPlan[idip]
		// Always require the [STRIDE] prefix (project rule: never delete
		// user-authored watch entries).
		if !strings.HasPrefix(programName, "[STRIDE]") {
			continue
		}
		if name != "" && programName != name {
			continue
		}
		if _, err := client.DeleteScheduledWorkout(ctx, entity, strAny(sched.PlanID)); err != nil {
			return false, err
		}
		deleted++
	}
	return deleted > 0, nil
}

// QuerySchedule lists the workouts scheduled in [start, end] (ISO YYYY-MM-DD)
// with their watch-side ids and STRIDE-management flag.
func (p *Provider) QuerySchedule(ctx context.Context, user, start, end string) ([]provider.ScheduledWorkoutSummary, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return nil, err
	}
	data, err := client.QuerySchedule(ctx, strings.ReplaceAll(start, "-", ""), strings.ReplaceAll(end, "-", ""))
	if err != nil {
		return nil, err
	}
	var sched struct {
		Entities []struct {
			HappenDay any `json:"happenDay"`
			IDInPlan  any `json:"idInPlan"`
		} `json:"entities"`
		Programs []struct {
			IDInPlan  any    `json:"idInPlan"`
			Name      string `json:"name"`
			SportType int    `json:"sportType"`
		} `json:"programs"`
	}
	if err := json.Unmarshal(data, &sched); err != nil {
		return nil, fmt.Errorf("coros: decode schedule: %w", err)
	}
	namesByID := make(map[string]string, len(sched.Programs))
	sportsByID := make(map[string]string, len(sched.Programs))
	for _, prog := range sched.Programs {
		id := strAny(prog.IDInPlan)
		if id != "" {
			namesByID[id] = prog.Name
			sportsByID[id] = normalizedSport(prog.SportType)
		}
	}
	out := make([]provider.ScheduledWorkoutSummary, 0, len(sched.Entities))
	for _, e := range sched.Entities {
		id := strAny(e.IDInPlan)
		out = append(out, provider.ScheduledWorkoutSummary{
			Date:              corosDateToISO(strAny(e.HappenDay)),
			Name:              namesByID[id],
			Sport:             sportsByID[id],
			ProviderWorkoutID: id,
			IsStrideManaged:   strings.HasPrefix(namesByID[id], "[STRIDE]"),
		})
	}
	return out, nil
}

// QueryExercises returns the COROS exercise library for a normalized sport
// ("strength" / "running"). sport=strength is the default.
func (p *Provider) QueryExercises(ctx context.Context, user, sport string) ([]map[string]any, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return nil, err
	}
	sportType := 4
	if sport == "running" {
		sportType = 1
	}
	data, err := client.QueryExercises(ctx, sportType)
	if err != nil {
		return nil, err
	}
	var list []map[string]any
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("coros: decode exercise library: %w", err)
	}
	return list, nil
}

// AddCustomExercise creates a custom exercise in the COROS library and returns
// the new exercise id as a string.
func (p *Provider) AddCustomExercise(ctx context.Context, user string, exercise map[string]any) (string, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return "", err
	}
	data, err := client.AddExercise(ctx, exercise)
	if err != nil {
		return "", err
	}
	var created map[string]any
	if err := json.Unmarshal(data, &created); err != nil {
		return "", fmt.Errorf("coros: decode created exercise: %w", err)
	}
	return strAny(created["id"]), nil
}

// normalizedSport maps a COROS sportType to the normalized sport name used in
// ScheduledWorkoutSummary.Sport. 1=running, 4=strength; anything else is "other".
func normalizedSport(sportType int) string {
	switch sportType {
	case 1:
		return "running"
	case 4:
		return "strength"
	default:
		return "other"
	}
}

// corosDateToISO converts "20260504" → "2026-05-04" ("" stays "").
func corosDateToISO(yyyymmdd string) string {
	if len(yyyymmdd) != 8 {
		return yyyymmdd
	}
	return yyyymmdd[:4] + "-" + yyyymmdd[4:6] + "-" + yyyymmdd[6:]
}
