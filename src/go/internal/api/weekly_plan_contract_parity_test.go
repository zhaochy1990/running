package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

type weeklyPlanContractPatch struct {
	Op    string `json:"op"`
	Path  []any  `json:"path"`
	Value any    `json:"value"`
}

func TestAppliedWeeklyPlanValidatorMatchesSharedContractFixtures(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(source), "..", "..", "..", "..", "tests", "fixtures", "weekly_plan_contract.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared contract fixtures: %v", err)
	}
	var fixtures struct {
		ExpectedWeek string         `json:"expected_week"`
		Base         map[string]any `json:"base"`
		Cases        []struct {
			Name    string                    `json:"name"`
			Valid   bool                      `json:"valid"`
			Patches []weeklyPlanContractPatch `json:"patches"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatalf("decode shared contract fixtures: %v", err)
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			document, err := cloneJSONMap(fixtures.Base)
			if err != nil {
				t.Fatalf("clone shared fixture: %v", err)
			}
			for _, patch := range fixture.Patches {
				applyWeeklyPlanContractPatch(t, document, patch)
			}
			_, err = validateAppliedWeeklyPlan(document, fixtures.ExpectedWeek)
			if (err == nil) != fixture.Valid {
				t.Fatalf("valid=%v err=%v", fixture.Valid, err)
			}
		})
	}
}

func applyWeeklyPlanContractPatch(t *testing.T, document map[string]any, patch weeklyPlanContractPatch) {
	t.Helper()
	var parent any = document
	for _, part := range patch.Path[:len(patch.Path)-1] {
		switch typed := parent.(type) {
		case map[string]any:
			parent = typed[part.(string)]
		case []any:
			parent = typed[int(part.(float64))]
		default:
			t.Fatalf("invalid patch path %v", patch.Path)
		}
	}
	key := patch.Path[len(patch.Path)-1]
	switch typed := parent.(type) {
	case map[string]any:
		name := key.(string)
		if patch.Op == "delete" {
			delete(typed, name)
		} else {
			typed[name] = patch.Value
		}
	case []any:
		index := int(key.(float64))
		if patch.Op == "delete" {
			copy(typed[index:], typed[index+1:])
			typed[len(typed)-1] = nil
			// Slice length cannot be changed through an interface. The shared
			// delete case targets the last item, so nil still fails both schemas.
		} else {
			typed[index] = patch.Value
		}
	default:
		t.Fatalf("invalid patch parent %T", parent)
	}
}
