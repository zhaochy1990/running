package api

import (
	"math"
	"sort"
)

// Adjustment accept-time merge (#952): a proposal replaces tomorrow onward,
// never the arrangements that are already past. The worker generates the
// proposal at time T; the athlete may accept at T+n, so the cutoff must be the
// write day, not the generation day — the days in between are already past by
// the time the accept endpoint runs and must keep the active week's sessions.
//
// mergeAdjustedWeeklyPlan returns applied=false when this week cannot safely
// replace the active row: the week already ended, the payload has nothing from
// tomorrow on (Sunday / cross-week), no run session survives the merge, or the
// active row cannot be parsed. The caller then keeps the active row untouched
// instead of falling back to the unfrozen proposal.

// mergeAdjustedWeeklyPlan keeps the active week's sessions and nutrition dated
// on or before today and takes the proposal's sessions dated after today.
// key_sessions follow the same split and are re-truncated to the week's limit
// (≤1 recovery / ≤3 otherwise), so a retained past arrangement never points at
// a replaced future key session. planned_dose is recomputed from the merged
// sessions when past arrangements were actually retained.
func mergeAdjustedWeeklyPlan(document, active map[string]any, today string) (map[string]any, bool) {
	weekName, _ := document["week_name"].(string)
	_, weekEnd, ok := weekIdentity(weekName)
	if !ok {
		return nil, false
	}
	if weekEnd.Format("2006-01-02") < today {
		return nil, false
	}
	oldSessions, ok := jsonObjects(active["sessions"])
	if !ok {
		return nil, false
	}
	newSessions, ok := jsonObjects(document["sessions"])
	if !ok {
		return nil, false
	}
	past := sessionsOnOrBefore(oldSessions, today)
	future := sessionsAfter(newSessions, today)
	if len(future) == 0 {
		return nil, false
	}
	sessions := append(append(make([]any, 0, len(past)+len(future)), past...), future...)
	sortSessions(sessions)
	if !hasRunSession(sessions) {
		return nil, false
	}
	oldNutrition, ok := jsonObjects(active["nutrition"])
	if !ok {
		return nil, false
	}
	newNutrition, ok := jsonObjects(document["nutrition"])
	if !ok {
		return nil, false
	}
	nutrition := append(append(make([]any, 0, 7), sessionsOnOrBefore(oldNutrition, today)...), sessionsAfter(newNutrition, today)...)
	sortByDate(nutrition)
	if len(nutrition) != 7 {
		return nil, false
	}

	merged := make(map[string]any, len(document))
	for key, value := range document {
		merged[key] = value
	}
	merged["sessions"] = sessions
	merged["nutrition"] = nutrition
	if keys, hasKeys := mergedKeySessions(active, document, today); hasKeys {
		merged["key_sessions"] = keys
	}
	if len(past) > 0 {
		if dose, ok := plannedDoseOf(sessions); ok {
			merged["planned_dose"] = dose
		}
	}
	return merged, true
}

func jsonObjects(value any) ([]any, bool) {
	list, ok := value.([]any)
	if !ok || list == nil {
		return nil, false
	}
	for _, item := range list {
		if _, ok := item.(map[string]any); !ok {
			return nil, false
		}
	}
	return list, true
}

func itemDate(item any) (string, bool) {
	record, ok := item.(map[string]any)
	if !ok {
		return "", false
	}
	day, ok := record["date"].(string)
	return day, ok
}

func sessionsOnOrBefore(items []any, cutoff string) []any {
	kept := make([]any, 0, len(items))
	for _, item := range items {
		if day, ok := itemDate(item); ok && day <= cutoff {
			kept = append(kept, item)
		}
	}
	return kept
}

func sessionsAfter(items []any, cutoff string) []any {
	kept := make([]any, 0, len(items))
	for _, item := range items {
		if day, ok := itemDate(item); ok && day > cutoff {
			kept = append(kept, item)
		}
	}
	return kept
}

func sortSessions(items []any) {
	sort.SliceStable(items, func(i, j int) bool {
		leftDay, leftIndex := sessionOrder(items[i])
		rightDay, rightIndex := sessionOrder(items[j])
		if leftDay != rightDay {
			return leftDay < rightDay
		}
		return leftIndex < rightIndex
	})
}

func sessionOrder(item any) (string, float64) {
	record := item.(map[string]any)
	day, _ := record["date"].(string)
	index, _ := record["session_index"].(float64)
	return day, index
}

func sortByDate(items []any) {
	sort.SliceStable(items, func(i, j int) bool {
		left, _ := itemDate(items[i])
		right, _ := itemDate(items[j])
		return left < right
	})
}

func hasRunSession(items []any) bool {
	for _, item := range items {
		if kind, _ := item.(map[string]any)["kind"].(string); kind == "run" {
			return true
		}
	}
	return false
}

func mergedKeySessions(active, document map[string]any, today string) ([]any, bool) {
	oldRaw, oldHas := active["key_sessions"]
	newRaw, newHas := document["key_sessions"]
	if !oldHas && !newHas {
		return nil, false
	}
	oldKeys, _ := oldRaw.([]any)
	newKeys, _ := newRaw.([]any)
	keys := append(
		append(make([]any, 0, len(oldKeys)+len(newKeys)), keySessionsOnOrBefore(oldKeys, today)...),
		keySessionsAfter(newKeys, today)...,
	)
	sort.SliceStable(keys, func(i, j int) bool { return keyDistance(keys[i]) > keyDistance(keys[j]) })
	limit := 3
	if recovery, _ := document["is_recovery_week"].(bool); recovery {
		limit = 1
	}
	if len(keys) > limit {
		keys = keys[:limit]
	}
	return keys, true
}

func keySessionDay(item any) (string, bool) {
	record, ok := item.(map[string]any)
	if !ok {
		return "", false
	}
	structure, ok := record["workout_structure"].(map[string]any)
	if !ok {
		return "", false
	}
	day, ok := structure["date"].(string)
	return day, ok
}

func keySessionsOnOrBefore(items []any, cutoff string) []any {
	kept := make([]any, 0, len(items))
	for _, item := range items {
		if day, ok := keySessionDay(item); ok && day <= cutoff {
			kept = append(kept, item)
		}
	}
	return kept
}

func keySessionsAfter(items []any, cutoff string) []any {
	kept := make([]any, 0, len(items))
	for _, item := range items {
		if day, ok := keySessionDay(item); ok && day > cutoff {
			kept = append(kept, item)
		}
	}
	return kept
}

func keyDistance(item any) float64 {
	distance, _ := item.(map[string]any)["distance_km"].(float64)
	return distance
}

func plannedDoseOf(sessions []any) (float64, bool) {
	total := 0.0
	found := false
	for _, item := range sessions {
		if dose, ok := item.(map[string]any)["estimated_dose"].(float64); ok {
			total += dose
			found = true
		}
	}
	if !found {
		return 0, false
	}
	return math.Round(total*10) / 10, true
}
