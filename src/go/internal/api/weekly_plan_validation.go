package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"
)

var providerIDPattern = regexp.MustCompile(`^T\d+$`)

const (
	minSafeJSONInteger = -(1<<53 - 1)
	maxSafeJSONInteger = 1<<53 - 1
)

// validateAppliedWeeklyPlan enforces the canonical content_version=2 contract
// at the API boundary. The Admin Dashboard performs the same validation for
// feedback, but the server must reject malformed nested data independently.
func validateAppliedWeeklyPlan(document map[string]any, expectedWeek string) ([]byte, error) {
	if document == nil {
		return nil, errors.New("weekly plan content must be a JSON object")
	}
	if !hasExactKeys(document, "schema", "week_name", "sessions", "nutrition", "notes_md", "coach_notes") {
		return nil, errors.New("weekly plan fields do not match the canonical schema")
	}
	if document["schema"] != "weekly-plan/v1" || document["week_name"] != expectedWeek {
		return nil, errors.New("weekly plan identity mismatch")
	}
	if !nullableString(document["notes_md"]) || !nullableString(document["coach_notes"]) {
		return nil, errors.New("weekly plan notes must be strings or null")
	}
	sessions, sessionsOK := document["sessions"].([]any)
	nutrition, nutritionOK := document["nutrition"].([]any)
	if !sessionsOK || !nutritionOK {
		return nil, errors.New("weekly plan arrays are missing")
	}
	start, _, ok := weekIdentity(expectedWeek)
	if !ok {
		return nil, errors.New("invalid expected week")
	}
	startDate, _ := time.Parse("2006-01-02", start)
	endDate := startDate.AddDate(0, 0, 6)
	sessionKeys := make(map[string]bool, len(sessions))
	for _, item := range sessions {
		row, ok := item.(map[string]any)
		if !ok {
			return nil, errors.New("session must be an object")
		}
		date, index, err := validateAppliedSession(row, startDate, endDate)
		if err != nil {
			return nil, err
		}
		key := date + ":" + fmt.Sprint(index)
		if sessionKeys[key] {
			return nil, errors.New("duplicate session date and index")
		}
		sessionKeys[key] = true
	}
	nutritionDates := make(map[string]bool, 7)
	for _, item := range nutrition {
		row, ok := item.(map[string]any)
		if !ok {
			return nil, errors.New("nutrition must be an object")
		}
		date, err := validateAppliedNutrition(row, startDate, endDate)
		if err != nil {
			return nil, err
		}
		if nutritionDates[date] {
			return nil, errors.New("duplicate nutrition date")
		}
		nutritionDates[date] = true
	}
	for offset := range 7 {
		expectedDate := startDate.AddDate(0, 0, offset).Format("2006-01-02")
		if !nutritionDates[expectedDate] {
			return nil, fmt.Errorf("nutrition is missing %s", expectedDate)
		}
	}
	stored, err := cloneJSONMap(document)
	if err != nil {
		return nil, fmt.Errorf("clone weekly plan content: %w", err)
	}
	delete(stored, "schema")
	delete(stored, "week_name")
	stripStoredWeeklyPlanMetadata(stored)
	return json.Marshal(stored)
}

func cloneJSONMap(document map[string]any) (map[string]any, error) {
	raw, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	var clone map[string]any
	if err := json.Unmarshal(raw, &clone); err != nil {
		return nil, err
	}
	return clone, nil
}

func stripStoredWeeklyPlanMetadata(value any) {
	switch typed := value.(type) {
	case map[string]any:
		delete(typed, "schema")
		delete(typed, "scheduled_workout_id")
		for _, child := range typed {
			stripStoredWeeklyPlanMetadata(child)
		}
	case []any:
		for _, child := range typed {
			stripStoredWeeklyPlanMetadata(child)
		}
	}
}

func validateAppliedSession(row map[string]any, start, end time.Time) (string, int64, error) {
	if !hasExactKeys(row, "schema", "date", "session_index", "kind", "summary", "spec", "notes_md", "total_distance_m", "total_duration_s") || row["schema"] != "plan-session/v1" {
		return "", 0, errors.New("session fields do not match plan-session/v1")
	}
	date, ok := dateWithinWeek(row["date"], start, end)
	if !ok {
		return "", 0, errors.New("session is outside target week")
	}
	index, ok := jsonInteger(row["session_index"], 0)
	if !ok {
		return "", 0, errors.New("session_index must be a non-negative integer")
	}
	kind, ok := enumString(row["kind"], "run", "strength", "rest", "cross", "note")
	if !ok || !nonEmptyString(row["summary"]) || !nullableString(row["notes_md"]) ||
		!nullableNumber(row["total_distance_m"]) || !nullableNumber(row["total_duration_s"]) {
		return "", 0, errors.New("session values do not match plan-session/v1")
	}
	if row["spec"] == nil {
		return date, index, nil
	}
	spec, ok := row["spec"].(map[string]any)
	if !ok {
		return "", 0, errors.New("session spec must be an object or null")
	}
	switch kind {
	case "run":
		ok = validateRunWorkout(spec, date)
	case "strength":
		ok = validateStrengthWorkout(spec, date)
	default:
		ok = false
	}
	if !ok {
		return "", 0, errors.New("session spec does not match its kind")
	}
	return date, index, nil
}

func validateRunWorkout(row map[string]any, sessionDate string) bool {
	if !hasExactKeys(row, "schema", "name", "date", "note", "blocks") ||
		row["schema"] != "run-workout/v1" || !nonEmptyString(row["name"]) ||
		row["date"] != sessionDate || !nullableString(row["note"]) {
		return false
	}
	blocks, ok := nonEmptyArray(row["blocks"])
	if !ok {
		return false
	}
	for _, value := range blocks {
		block, ok := value.(map[string]any)
		if !ok || !hasExactKeys(block, "repeat", "steps") {
			return false
		}
		if _, ok := jsonInteger(block["repeat"], 1); !ok {
			return false
		}
		steps, ok := nonEmptyArray(block["steps"])
		if !ok {
			return false
		}
		for _, item := range steps {
			step, ok := item.(map[string]any)
			if !ok || !validateWorkoutStep(step) {
				return false
			}
		}
	}
	return true
}

func validateWorkoutStep(row map[string]any) bool {
	if !hasExactKeys(row, "step_kind", "duration", "target", "note", "hr_cap_bpm") {
		return false
	}
	if _, ok := enumString(row["step_kind"], "warmup", "work", "recovery", "cooldown", "rest"); !ok {
		return false
	}
	if !nullableString(row["note"]) || !nullableInteger(row["hr_cap_bpm"]) {
		return false
	}
	duration, durationOK := row["duration"].(map[string]any)
	target, targetOK := row["target"].(map[string]any)
	if !durationOK || !targetOK || !hasExactKeys(duration, "kind", "value") ||
		!hasExactKeys(target, "kind", "low", "high") {
		return false
	}
	if _, ok := enumString(duration["kind"], "distance_m", "time_s", "open"); !ok || !nullableNumber(duration["value"]) {
		return false
	}
	if _, ok := enumString(target["kind"], "pace_s_km", "hr_bpm", "power_w", "open"); !ok {
		return false
	}
	return nullableNumber(target["low"]) && nullableNumber(target["high"])
}

func validateStrengthWorkout(row map[string]any, sessionDate string) bool {
	if !hasExactKeys(row, "schema", "name", "date", "note", "exercises") ||
		row["schema"] != "strength-workout/v1" || !nonEmptyString(row["name"]) ||
		row["date"] != sessionDate || !nullableString(row["note"]) {
		return false
	}
	exercises, ok := nonEmptyArray(row["exercises"])
	if !ok {
		return false
	}
	for _, value := range exercises {
		exercise, ok := value.(map[string]any)
		if !ok || !hasExactKeys(exercise, "canonical_id", "display_name", "sets", "target_kind", "target_value", "rest_seconds", "note", "provider_id") ||
			!nonEmptyString(exercise["canonical_id"]) || !nonEmptyString(exercise["display_name"]) ||
			!nullableString(exercise["note"]) || !providerID(exercise["provider_id"]) {
			return false
		}
		if _, ok := jsonInteger(exercise["sets"], 1); !ok {
			return false
		}
		if _, ok := enumString(exercise["target_kind"], "reps", "time_s"); !ok {
			return false
		}
		if _, ok := jsonInteger(exercise["target_value"], 1); !ok {
			return false
		}
		if _, ok := jsonInteger(exercise["rest_seconds"], 0); !ok {
			return false
		}
	}
	return true
}

func validateAppliedNutrition(row map[string]any, start, end time.Time) (string, error) {
	if !hasExactKeys(row, "schema", "date", "kcal_target", "carbs_g", "protein_g", "fat_g", "water_ml", "meals", "notes_md") ||
		row["schema"] != "plan-nutrition/v1" {
		return "", errors.New("nutrition fields do not match plan-nutrition/v1")
	}
	date, ok := dateWithinWeek(row["date"], start, end)
	if !ok {
		return "", errors.New("nutrition is outside target week")
	}
	for _, key := range []string{"kcal_target", "carbs_g", "protein_g", "fat_g", "water_ml"} {
		if !nullableNumber(row[key]) {
			return "", errors.New("nutrition metric must be a number or null")
		}
	}
	if !nullableString(row["notes_md"]) {
		return "", errors.New("nutrition notes must be a string or null")
	}
	meals, ok := row["meals"].([]any)
	if !ok {
		return "", errors.New("nutrition meals must be an array")
	}
	for _, value := range meals {
		meal, ok := value.(map[string]any)
		if !ok || !hasExactKeys(meal, "name", "time_hint", "kcal", "carbs_g", "protein_g", "fat_g", "items_md") ||
			!nonEmptyString(meal["name"]) || !nullableString(meal["time_hint"]) || !nullableString(meal["items_md"]) {
			return "", errors.New("meal fields do not match the canonical schema")
		}
		for _, key := range []string{"kcal", "carbs_g", "protein_g", "fat_g"} {
			if !nullableNumber(meal[key]) {
				return "", errors.New("meal metric must be a number or null")
			}
		}
	}
	return date, nil
}

func hasExactKeys(document map[string]any, keys ...string) bool {
	if len(document) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := document[key]; !ok {
			return false
		}
	}
	return true
}

func enumString(value any, allowed ...string) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	for _, candidate := range allowed {
		if text == candidate {
			return text, true
		}
	}
	return "", false
}

func nonEmptyString(value any) bool {
	text, ok := value.(string)
	return ok && strings.TrimSpace(text) != ""
}

func nullableString(value any) bool {
	if value == nil {
		return true
	}
	_, ok := value.(string)
	return ok
}

func nullableNumber(value any) bool {
	if value == nil {
		return true
	}
	number, ok := value.(float64)
	return ok && !math.IsInf(number, 0) && !math.IsNaN(number)
}

func nullableInteger(value any) bool {
	if value == nil {
		return true
	}
	_, ok := jsonInteger(value, minSafeJSONInteger)
	return ok
}

func jsonInteger(value any, minimum int64) (int64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsInf(number, 0) || math.IsNaN(number) || number < float64(minimum) ||
		number > maxSafeJSONInteger || math.Trunc(number) != number {
		return 0, false
	}
	return int64(number), true
}

func providerID(value any) bool {
	if value == nil {
		return true
	}
	text, ok := value.(string)
	return ok && providerIDPattern.MatchString(text)
}

func nonEmptyArray(value any) ([]any, bool) {
	values, ok := value.([]any)
	return values, ok && len(values) > 0
}

func dateWithinWeek(value any, start, end time.Time) (string, bool) {
	dateString, ok := value.(string)
	if !ok {
		return "", false
	}
	date, err := time.Parse("2006-01-02", dateString)
	return dateString, err == nil && !date.Before(start) && !date.After(end)
}
