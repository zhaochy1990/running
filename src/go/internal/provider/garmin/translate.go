// translate.go translates provider-agnostic normalized workouts (workout_spec)
// into the Garmin Workout API payload. Go port of garmin_sync.translate.
//
// Reverse-engineered from the garminconnect get_workout_by_id() response. The
// shape upload_running_workout expects:
//
//	{
//	  workoutName, sportType, subSportType,
//	  estimatedDurationInSecs, estimatedDistanceInMeters,
//	  workoutSegments: [{
//	    segmentOrder: 1,
//	    sportType: {...},
//	    workoutSteps: [
//	      # repeat group:
//	      {type: "RepeatGroupDTO", stepOrder, stepType: {key:"repeat"},
//	       numberOfIterations: N, workoutSteps: [...]},
//	      # executable step:
//	      {type: "ExecutableStepDTO", stepOrder, stepType: {...},
//	       endCondition: {key:"time"|"distance"|"lap.button"},
//	       endConditionValue: float,
//	       preferredEndConditionUnit: {key:"meter"|"kilometer"|...},
//	       targetType: {key:"no.target"|"pace.zone"|"heart.rate.zone"|...},
//	       targetValueOne: float, targetValueTwo: float},
//	    ],
//	  }]
//	}
//
// Critical unit gotcha: Garmin's pace.zone target values are stored as **m/s**
// (not s/km). For Target(PACE_S_KM, low=slow, high=fast):
//
//	targetValueOne = 1000/slow  (slower bound = smaller m/s)
//	targetValueTwo = 1000/fast  (faster bound = larger m/s)
package garmin

import (
	"github.com/zhaochy1990/stride/internal/provider"
)

var runSportType = map[string]any{
	"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1,
}

// StepKind → Garmin stepType.
var stepTypeByKind = map[provider.StepKind]map[string]any{
	provider.StepWarmup:   {"stepTypeId": 1, "stepTypeKey": "warmup", "displayOrder": 1},
	provider.StepCooldown: {"stepTypeId": 2, "stepTypeKey": "cooldown", "displayOrder": 2},
	provider.StepWork:     {"stepTypeId": 3, "stepTypeKey": "interval", "displayOrder": 3},
	provider.StepRecovery: {"stepTypeId": 4, "stepTypeKey": "recovery", "displayOrder": 4},
	provider.StepRest:     {"stepTypeId": 5, "stepTypeKey": "rest", "displayOrder": 5},
}

var repeatStepType = map[string]any{"stepTypeId": 6, "stepTypeKey": "repeat", "displayOrder": 6}

// endCondition returns (endCondition, endConditionValue, preferredEndConditionUnit).
func endCondition(step provider.WorkoutStep) (map[string]any, any, any) {
	d := step.Duration
	if d.Kind == provider.DurationTimeS && d.Value != nil {
		return map[string]any{
			"conditionTypeId": 2, "conditionTypeKey": "time", "displayOrder": 2, "displayable": true,
		}, *d.Value, nil
	}
	if d.Kind == provider.DurationDistanceM && d.Value != nil {
		return map[string]any{
			"conditionTypeId": 3, "conditionTypeKey": "distance", "displayOrder": 3, "displayable": true,
		}, *d.Value, map[string]any{"unitId": 1, "unitKey": "meter", "factor": 100.0}
	}
	// OPEN — user presses lap button to end the step manually.
	return map[string]any{
		"conditionTypeId": 1, "conditionTypeKey": "lap.button", "displayOrder": 1, "displayable": true,
	}, nil, nil
}

// targetBlock returns the targetType + targetValueOne/Two slice of an
// executable step.
func targetBlock(step provider.WorkoutStep) map[string]any {
	t := step.Target
	switch t.Kind {
	case provider.TargetPaceSKM:
		if t.Low != nil && t.High != nil {
			// NormalizedRunWorkout: low = slower s/km (larger), high = faster
			// (smaller). Garmin pace.zone stores m/s: slower = smaller m/s.
			return map[string]any{
				"targetType":      map[string]any{"workoutTargetTypeId": 6, "workoutTargetTypeKey": "pace.zone", "displayOrder": 6},
				"targetValueOne":  1000.0 / *t.Low,
				"targetValueTwo":  1000.0 / *t.High,
				"targetValueUnit": nil,
				"zoneNumber":      nil,
			}
		}
	case provider.TargetHRBPM:
		if t.Low != nil && t.High != nil {
			return map[string]any{
				"targetType":      map[string]any{"workoutTargetTypeId": 4, "workoutTargetTypeKey": "heart.rate.zone", "displayOrder": 4},
				"targetValueOne":  *t.Low,
				"targetValueTwo":  *t.High,
				"targetValueUnit": nil,
				"zoneNumber":      nil,
			}
		}
	case provider.TargetPowerW:
		if t.Low != nil && t.High != nil {
			return map[string]any{
				"targetType":      map[string]any{"workoutTargetTypeId": 2, "workoutTargetTypeKey": "power.zone", "displayOrder": 2},
				"targetValueOne":  *t.Low,
				"targetValueTwo":  *t.High,
				"targetValueUnit": nil,
				"zoneNumber":      nil,
			}
		}
	}
	// OPEN — no target.
	return map[string]any{
		"targetType":      map[string]any{"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target", "displayOrder": 1},
		"targetValueOne":  nil,
		"targetValueTwo":  nil,
		"targetValueUnit": nil,
		"zoneNumber":      nil,
	}
}

func executableStep(step provider.WorkoutStep, stepOrder int) map[string]any {
	endCond, endValue, endUnit := endCondition(step)
	payload := map[string]any{
		"type":                      "ExecutableStepDTO",
		"stepOrder":                 stepOrder,
		"stepType":                  stepTypeByKind[step.StepKind],
		"childStepId":               1,
		"description":               "",
		"endCondition":              endCond,
		"endConditionValue":         endValue,
		"preferredEndConditionUnit": endUnit,
	}
	if step.Note != nil {
		payload["description"] = *step.Note
	}
	for k, v := range targetBlock(step) {
		payload[k] = v
	}
	return payload
}

func repeatBlock(block provider.WorkoutBlock, stepOrder, baseChildStepID int) map[string]any {
	nested := make([]map[string]any, 0, len(block.Steps))
	for i, step := range block.Steps {
		child := executableStep(step, stepOrder+i+1)
		child["childStepId"] = baseChildStepID
		nested = append(nested, child)
	}
	return map[string]any{
		"type":               "RepeatGroupDTO",
		"stepOrder":          stepOrder,
		"stepType":           repeatStepType,
		"childStepId":        baseChildStepID,
		"numberOfIterations": block.Repeat,
		"workoutSteps":       nested,
	}
}

// buildSteps flattens blocks → workoutSteps; one RepeatGroupDTO per repeat>1
// block. Mirrors translate.py's stepOrder bookkeeping exactly.
func buildSteps(workout provider.RunWorkout) []map[string]any {
	var out []map[string]any
	stepOrder := 0
	childStepID := 0
	for _, block := range workout.Blocks {
		stepOrder++
		if block.Repeat > 1 {
			childStepID++
			out = append(out, repeatBlock(block, stepOrder, childStepID))
			// The nested executables consume their own stepOrder slots; bump.
			stepOrder += len(block.Steps)
		} else {
			for _, step := range block.Steps {
				out = append(out, executableStep(step, stepOrder))
				stepOrder++
			}
			stepOrder-- // we incremented once at top of loop already
		}
	}
	return out
}

// estimateDurationSeconds is a best-effort total duration estimate (Garmin uses
// this for the workout summary — exact match isn't required, the watch
// recomputes on push).
func estimateDurationSeconds(workout provider.RunWorkout) int {
	total := 0.0
	for _, block := range workout.Blocks {
		for _, step := range block.Steps {
			d := step.Duration
			switch {
			case d.Kind == provider.DurationTimeS && d.Value != nil:
				total += *d.Value * float64(block.Repeat)
			case d.Kind == provider.DurationDistanceM && d.Value != nil:
				// rough: 5 min/km if no target pace
				pace := 300.0
				if t := step.Target; t.Kind == provider.TargetPaceSKM && t.Low != nil && t.High != nil {
					pace = (*t.Low + *t.High) / 2.0
				}
				total += (*d.Value / 1000.0) * pace * float64(block.Repeat)
			}
		}
	}
	return int(total)
}

func estimateDistanceMeters(workout provider.RunWorkout) int {
	total := 0.0
	for _, block := range workout.Blocks {
		for _, step := range block.Steps {
			if d := step.Duration; d.Kind == provider.DurationDistanceM && d.Value != nil {
				total += *d.Value * float64(block.Repeat)
			}
		}
	}
	return int(total)
}

// NormalizedToGarminWorkout builds the Garmin upload_running_workout payload
// for a normalized run workout. Returns a JSON-serializable map; the caller
// posts it via the authenticated client.
func NormalizedToGarminWorkout(workout provider.RunWorkout) (map[string]any, error) {
	if err := workout.Validate(); err != nil {
		return nil, err
	}
	note := ""
	if workout.Note != nil {
		note = *workout.Note
	}
	return map[string]any{
		"workoutName":               workout.Name,
		"description":               note,
		"sportType":                 runSportType,
		"subSportType":              "GENERIC",
		"estimatedDurationInSecs":   estimateDurationSeconds(workout),
		"estimatedDistanceInMeters": estimateDistanceMeters(workout),
		"estimateType":              "DISTANCE_ESTIMATED",
		"workoutSegments": []any{map[string]any{
			"segmentOrder":   1,
			"sportType":      runSportType,
			"poolLengthUnit": nil,
			"poolLength":     nil,
			"workoutSteps":   buildSteps(workout),
		}},
	}, nil
}
