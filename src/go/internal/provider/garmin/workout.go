// workout.go wires the Garmin run-workout push onto the Provider adapter. Go
// port of garmin_sync.adapter.GarminDataSource.push_run_workout: translate the
// normalized workout → upload the template (POST /workout-service/workout) →
// schedule it on the calendar (POST /workout-service/schedule/{id}).
//
// Strength push, delete, schedule query and the exercise catalog are NOT
// implemented for Garmin (mirrors the Python v1 capability set) — the
// BaseProvider defaults return *FeatureNotSupported.
package garmin

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/zhaochy1990/stride/internal/provider"
)

// PushRunWorkout pushes a normalized run workout to the user's Garmin calendar
// and returns the Garmin workoutId as a string. The watch picks it up on next
// sync. Two API calls:
//
//  1. POST upload_workout → returns workoutId (template stored on Garmin)
//  2. POST schedule_workout(workoutId, date) → places it on the calendar
func (p *Provider) PushRunWorkout(ctx context.Context, user string, w provider.RunWorkout) (string, error) {
	client, err := p.clientFor(ctx, user)
	if err != nil {
		return "", err
	}
	payload, err := NormalizedToGarminWorkout(w)
	if err != nil {
		return "", err
	}

	upload, err := client.UploadWorkout(ctx, payload)
	if err != nil {
		return "", err
	}
	var uploaded struct {
		WorkoutID any `json:"workoutId"`
	}
	if err := json.Unmarshal(upload, &uploaded); err != nil {
		return "", fmt.Errorf("garmin: decode upload response: %w", err)
	}
	workoutID := intAny(uploaded.WorkoutID)
	if workoutID == 0 {
		return "", fmt.Errorf("garmin: upload_workout returned no workoutId: %s", string(upload))
	}

	if _, err := client.ScheduleWorkout(ctx, workoutID, w.Date); err != nil {
		return "", fmt.Errorf("garmin: schedule workout %d for %s: %w", workoutID, w.Date, err)
	}
	return fmt.Sprintf("%d", workoutID), nil
}

// intAny flexibly coerces a JSON number (float64) or numeric string to int.
func intAny(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case float32:
		return int(t)
	case int:
		return t
	case int64:
		return int(t)
	case string:
		var n int
		_, _ = fmt.Sscanf(t, "%d", &n)
		return n
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	default:
		return 0
	}
}
