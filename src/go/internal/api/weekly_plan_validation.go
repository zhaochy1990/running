package api

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

const weeklyPlanSchemaURL = "https://stride-running.cn/schemas/weekly-plan-v1.json"

// weeklyPlanSchemaJSON is generated from the canonical Coach Zod schema by
// `pnpm run generate:weekly-plan-schema`. CI verifies that the committed copy
// stays current, so Go does not maintain a second structural validator.
//
//go:embed weekly_plan_schema.json
var weeklyPlanSchemaJSON []byte

var appliedWeeklyPlanSchema = mustCompileWeeklyPlanSchema()

func mustCompileWeeklyPlanSchema() *jsonschema.Schema {
	var document any
	if err := json.Unmarshal(weeklyPlanSchemaJSON, &document); err != nil {
		panic(fmt.Sprintf("decode embedded Weekly Plan schema: %v", err))
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err := compiler.AddResource(weeklyPlanSchemaURL, document); err != nil {
		panic(fmt.Sprintf("load embedded Weekly Plan schema: %v", err))
	}
	schema, err := compiler.Compile(weeklyPlanSchemaURL)
	if err != nil {
		panic(fmt.Sprintf("compile embedded Weekly Plan schema: %v", err))
	}
	return schema
}

// validateAppliedWeeklyPlan enforces the canonical content_version=2 contract
// at the API seam. The generated JSON Schema owns the complete structural
// contract; this function adds only Zod superRefine constraints that JSON
// Schema cannot express, then normalizes authoring metadata for storage.
func validateAppliedWeeklyPlan(document map[string]any, expectedWeek string) ([]byte, error) {
	if document == nil {
		return nil, errors.New("weekly plan content must be a JSON object")
	}
	if err := appliedWeeklyPlanSchema.Validate(document); err != nil {
		return nil, fmt.Errorf("weekly plan schema: %w", err)
	}
	weekStart, weekEnd, ok := weekIdentity(expectedWeek)
	if !ok || document["week_name"] != expectedWeek {
		return nil, errors.New("weekly plan identity mismatch")
	}
	startDate, _ := time.Parse("2006-01-02", weekStart)

	sessions := document["sessions"].([]any)
	sessionKeys := make(map[string]bool, len(sessions))
	for _, item := range sessions {
		session := item.(map[string]any)
		date := session["date"].(string)
		if !dateInRange(date, startDate, weekEnd) {
			return nil, errors.New("session is outside target week")
		}
		key := fmt.Sprintf("%s:%v", date, session["session_index"])
		if sessionKeys[key] {
			return nil, errors.New("duplicate session date and index")
		}
		sessionKeys[key] = true
		if spec, ok := session["spec"].(map[string]any); ok && spec["date"] != date {
			return nil, errors.New("workout date must match session date")
		}
	}

	nutritionDates := make(map[string]bool, 7)
	for _, item := range document["nutrition"].([]any) {
		nutrition := item.(map[string]any)
		date := nutrition["date"].(string)
		if !dateInRange(date, startDate, weekEnd) {
			return nil, errors.New("nutrition is outside target week")
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

func dateInRange(value string, start, end time.Time) bool {
	date, err := time.Parse("2006-01-02", value)
	return err == nil && !date.Before(start) && !date.After(end)
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
