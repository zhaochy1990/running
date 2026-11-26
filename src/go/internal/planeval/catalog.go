package planeval

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/storage"
)

//go:embed runner-snapshot.schema.json
var snapshotSchemaJSON []byte

//go:embed master-request.schema.json
var masterRequestSchemaJSON []byte

//go:embed rolling-request.schema.json
var rollingRequestSchemaJSON []byte

//go:embed rolling-master.schema.json
var rollingMasterSchemaJSON []byte

func compileInputSchema(document []byte) *jsonschema.Schema {
	var decoded any
	if err := json.Unmarshal(document, &decoded); err != nil {
		panic(err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err := compiler.AddResource("input.json", decoded); err != nil {
		panic(err)
	}
	schema, err := compiler.Compile("input.json")
	if err != nil {
		panic(err)
	}
	return schema
}

var snapshotInputSchema = compileInputSchema(snapshotSchemaJSON)
var masterInputSchema = compileInputSchema(masterRequestSchemaJSON)
var rollingInputSchema = compileInputSchema(rollingRequestSchemaJSON)
var rollingMasterInputSchema = compileInputSchema(rollingMasterSchemaJSON)

func validateInput(schema *jsonschema.Schema, document string) *Error {
	var decoded any
	if err := json.Unmarshal([]byte(document), &decoded); err != nil {
		return fail(422, "invalid_input", err.Error())
	}
	if err := schema.Validate(decoded); err != nil {
		return fail(422, "invalid_input", schemaMessage(err))
	}
	return nil
}

// JSON Schema omits Zod refinements; enforce the snapshot's cross-field checks here.
func validateSnapshotInput(document string) *Error {
	if e := validateInput(snapshotInputSchema, document); e != nil {
		return e
	}
	var doc struct {
		Day     string `json:"as_of_day"`
		AsOf    string `json:"as_of"`
		Records struct {
			Plans []struct {
				Week    string         `json:"week_start"`
				Content map[string]any `json:"content"`
			} `json:"weekly_plans"`
		} `json:"records"`
	}
	_ = json.Unmarshal([]byte(document), &doc)
	if doc.AsOf != "" {
		instant, err := time.Parse(time.RFC3339, doc.AsOf)
		if err != nil || instant.In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02") != doc.Day {
			return fail(422, "invalid_input", "as_of: 须与 as_of_day 上海日相同")
		}
	}
	for i, row := range doc.Records.Plans {
		name, ok := row.Content["week_name"].(string)
		if !ok || !strings.HasPrefix(name, row.Week+"_") {
			return fail(422, "invalid_input", fmt.Sprintf("records.weekly_plans[%d].week_start: 与 content.week_name 不一致", i))
		}
		if err := api.ValidateWeeklyPlanContract(row.Content); err != nil {
			return fail(422, "invalid_input", fmt.Sprintf("records.weekly_plans[%d].content: %s", i, err))
		}
	}
	return nil
}

func uniqueIDs(field string, ids []string) *Error {
	seen := map[string]bool{}
	for i, id := range ids {
		if strings.TrimSpace(id) == "" || seen[id] {
			return fail(422, "invalid_reference", fmt.Sprintf("%s[%d]: 空或重复 ID %q", field, i, id))
		}
		seen[id] = true
	}
	return nil
}

func validateScenario(doc *scenarioDocument) *Error {
	if strings.TrimSpace(doc.Name) == "" || len(doc.Name) > 128 {
		return fail(422, "invalid_input", "场景 "+doc.ID+" name: 必填且不超过 128 字节")
	}
	if doc.ArtifactType != "master_plan" && doc.ArtifactType != "weekly_plan_batch" {
		return fail(422, "invalid_input", "场景 "+doc.ID+" artifact_type: 不支持的产物类型")
	}
	if len(doc.SnapshotIDs) == 0 {
		return fail(422, "invalid_reference", "场景 "+doc.ID+" snapshot_ids: 至少选择一份数据")
	}
	if e := uniqueIDs("场景 "+doc.ID+" snapshot_ids", doc.SnapshotIDs); e != nil {
		return e
	}
	seen := map[string]bool{}
	for i, ref := range doc.Rules {
		if ref.ID == "" || ref.Version < 1 || seen[ref.ID] {
			return fail(422, "invalid_reference", fmt.Sprintf("场景 %s rules[%d]: 无效或重复规则 %s", doc.ID, i, ref.ID))
		}
		seen[ref.ID] = true
	}
	return nil
}

// generationRequest derives runner-specific goals and constraints from the selected
// snapshot. Other intake choices stay in the scenario's editable request template.
func generationRequest(artifactType, document, template string) (string, string, *Error) {
	if e := validateSnapshotInput(document); e != nil {
		return "", "", e
	}
	var snapshot struct {
		Kind        string  `json:"generation_kind"`
		Event       string  `json:"event"`
		Target      *string `json:"target_time"`
		Day         string  `json:"as_of_day"`
		AsOf        string  `json:"as_of"`
		Constraints struct {
			Max    int      `json:"max_run_days_per_week"`
			NoDays []string `json:"no_run_days"`
		} `json:"constraints"`
		Records struct {
			Profile json.RawMessage `json:"profile"`
			Target  *struct {
				Name string `json:"race_name"`
				Date string `json:"race_date"`
			} `json:"race_target"`
			Active *struct {
				ID      string         `json:"planId"`
				Status  string         `json:"status"`
				Content map[string]any `json:"content"`
			} `json:"active_master_plan"`
			Weeks *[]struct {
				Week   string  `json:"week_start"`
				PlanID *string `json:"master_plan_id"`
			} `json:"weekly_plan_weeks"`
			Plans *[]struct {
				Week    string         `json:"week_start"`
				Content map[string]any `json:"content"`
			} `json:"weekly_plans"`
		} `json:"records"`
	}
	_ = json.Unmarshal([]byte(document), &snapshot)
	asOf := snapshot.Day + "T23:59:59+08:00"
	if snapshot.AsOf != "" {
		asOf = snapshot.AsOf
	}
	instant, err := time.Parse(time.RFC3339, asOf)
	if err != nil || instant.In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006-01-02") != snapshot.Day {
		return "", "", fail(422, "invalid_input", "as_of: 须与 as_of_day 上海日相同")
	}
	var request map[string]any
	if artifactType == "master_plan" {
		if snapshot.Kind != "new_season" {
			return "", "", fail(422, "invalid_input", "generation_kind: master_plan 需要 new_season")
		}
		if snapshot.Records.Target == nil {
			return "", "", fail(422, "invalid_input", "records.race_target: 新建赛季必填")
		}
		if string(snapshot.Records.Profile) == "null" {
			return "", "", fail(422, "invalid_input", "records.profile: 新建赛季必填")
		}
		if snapshot.Target == nil || *snapshot.Target == "0:00:00" || *snapshot.Target == "00:00:00" {
			return "", "", fail(422, "invalid_input", "target_time: 生成须提供目标成绩")
		}
		if snapshot.Records.Target.Date <= snapshot.Day {
			return "", "", fail(422, "invalid_input", "records.race_target.race_date: 须晚于数据截止日")
		}
		if template == "" || template == "{}" {
			var preset presetScenarioFile
			_ = json.Unmarshal(presetScenarioDocument, &preset)
			template = string(preset.Request)
		}
		if err := json.Unmarshal([]byte(template), &request); err != nil || request == nil {
			return "", "", fail(422, "invalid_input", "request: 应为 JSON 对象")
		}
		availability, ok := request["availability"].(map[string]any)
		if !ok {
			return "", "", fail(422, "invalid_input", "request.availability: 必填")
		}
		availability["weekly_run_days_max"] = snapshot.Constraints.Max
		availability["unavailable_days"] = snapshot.Constraints.NoDays
		request["goals"] = []any{map[string]any{"race_name": snapshot.Records.Target.Name, "race_date": snapshot.Records.Target.Date, "distance": snapshot.Event, "target_time": snapshot.Target, "finish_only": false, "priority": "A"}}
		request["requested_mode"] = "new_season"
	} else if artifactType == "weekly_plan_batch" {
		if snapshot.Kind == "new_season" {
			return "", "", fail(422, "invalid_input", "generation_kind: weekly_plan_batch 需要滚动快照")
		}
		if snapshot.Records.Active == nil {
			return "", "", fail(422, "invalid_input", "records.active_master_plan: 滚动必填")
		}
		if snapshot.Records.Weeks == nil {
			return "", "", fail(422, "invalid_input", "records.weekly_plan_weeks: 滚动必填，已记录无周时用 []")
		}
		if snapshot.Records.Plans == nil {
			return "", "", fail(422, "invalid_input", "records.weekly_plans: 滚动必填，已记录无周时用 []")
		}
		if snapshot.Records.Active.Status != "active" {
			return "", "", fail(422, "invalid_input", "records.active_master_plan.status: 滚动需要 active")
		}
		content := snapshot.Records.Active.Content
		if e := validateInput(rollingMasterInputSchema, string(mustJSON(content))); e != nil {
			e.Detail = "records.active_master_plan.content: " + e.Detail
			return "", "", e
		}
		goal := content["goal"].(map[string]any)
		if goal["target_time"] == "finish_only" {
			return "", "", fail(422, "invalid_input", "records.active_master_plan.content.goal.target_time: 滚动需要目标成绩")
		}

		rollingID := snapshot.Records.Active.ID
		if id, ok := content["master_plan_id"].(string); ok && id != "" {
			rollingID = id
		}
		docs := map[string]bool{}
		for i, doc := range *snapshot.Records.Plans {
			if docs[doc.Week] {
				return "", "", fail(422, "invalid_input", fmt.Sprintf("records.weekly_plans[%d].week_start: 重复", i))
			}

			docs[doc.Week] = true
		}
		seen := map[string]bool{}
		for i, week := range *snapshot.Records.Weeks {
			if seen[week.Week] || !docs[week.Week] {
				return "", "", fail(422, "invalid_input", fmt.Sprintf("records.weekly_plan_weeks[%d].week_start: 重复或缺少完整周课表", i))
			}
			if week.PlanID == nil || *week.PlanID != rollingID {
				return "", "", fail(422, "invalid_input", fmt.Sprintf("records.weekly_plan_weeks[%d].master_plan_id: 与 active plan 不一致", i))
			}
			seen[week.Week] = true
		}
		request = map[string]any{"master_plan_id": snapshot.Records.Active.ID}
	} else {
		return "", "", fail(422, "invalid_input", "artifact_type: 不支持的产物类型")
	}
	stamped, err := stampRequest(string(mustJSON(request)), "preview", asOf, artifactType)
	if err != nil {
		return "", "", fail(422, "invalid_input", err.Error())
	}
	schema := masterInputSchema
	if artifactType == "weekly_plan_batch" {
		schema = rollingInputSchema
	}
	if e := validateInput(schema, stamped); e != nil {
		return "", "", e
	}
	if artifactType == "master_plan" {
		availability := request["availability"].(map[string]any)
		if availability["strength_sessions_per_week"].(float64) > 0 && len(availability["strength_available_days"].([]any)) == 0 {
			return "", "", fail(422, "invalid_input", "request.availability.strength_available_days: strength_sessions_per_week > 0 时必填")
		}
	}
	return stamped, asOf, nil
}

type SnapshotView struct {
	ID       string `json:"snapshot_id"`
	Username string `json:"username"`
	Kind     string `json:"generation_kind"`
	Event    string `json:"event"`
	Target   string `json:"target_time"`
	Day      string `json:"as_of_day"`
}

func snapshotView(row storage.PlanEvalRunnerSnapshot) SnapshotView {
	return SnapshotView{row.ID, row.Username, row.GenerationKind, row.Event, row.TargetTime, row.AsOfDay}
}

func (s *Service) saveSnapshot(ctx context.Context, id string, raw json.RawMessage) (*storage.PlanEvalRunnerSnapshot, *Error) {
	if id == "" {
		id = uuid.NewString()
	} else {
		if _, err := s.store.GetPlanEvalRunnerSnapshot(ctx, id); err != nil {
			return nil, s.mapStorageError(err)
		}
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
		return nil, fail(422, "invalid_input", "snapshot: 应为 JSON 对象")
	}
	doc["snapshot_id"] = id
	encoded := string(mustJSON(doc))
	if e := validateSnapshotInput(encoded); e != nil {
		return nil, e
	}
	row := &storage.PlanEvalRunnerSnapshot{ID: id, Username: doc["username"].(string), GenerationKind: doc["generation_kind"].(string), Event: doc["event"].(string), AsOfDay: doc["as_of_day"].(string), ConstraintsJSON: string(mustJSON(doc["constraints"])), SnapshotJSON: encoded}
	if len(row.Username) > 64 {
		return nil, fail(422, "invalid_input", "username: 不超过 64 字节")
	}
	if target, ok := doc["target_time"].(string); ok {
		row.TargetTime = target
	}
	if err := s.store.UpsertPlanEvalRunnerSnapshot(ctx, row); err != nil {
		return nil, s.internal(err)
	}
	return row, nil
}

func (s *Service) saveScenario(ctx context.Context, id string, view ScenarioView) (*ScenarioView, *Error) {
	if id == "" {
		id = uuid.NewString()
	} else {
		if _, e := s.loadScenario(ctx, id); e != nil {
			return nil, e
		}
	}
	request := string(view.Request)
	if request == "" || request == "null" {
		request = "{}"
	}
	doc := &scenarioDocument{PlanEvalScenario: storage.PlanEvalScenario{ID: id, Name: view.Name, ArtifactType: view.ArtifactType, AsOf: view.AsOf, RequestJSON: request}, SnapshotIDs: view.SnapshotIDs, Rules: view.Rules}
	// Reuse submission validation for references and each selected request.
	if _, _, e := s.freeze(ctx, doc); e != nil {
		return nil, e
	}
	if _, err := time.Parse(time.RFC3339, view.AsOf); view.AsOf != "" && err != nil {
		return nil, fail(422, "invalid_input", "as_of: 应为 ISO instant")
	}
	doc.PlanEvalScenario.SnapshotIDs = string(mustJSON(view.SnapshotIDs))
	doc.RuleRefs = string(mustJSON(view.Rules))
	if err := s.store.UpsertPlanEvalScenario(ctx, &doc.PlanEvalScenario); err != nil {
		return nil, s.internal(err)
	}
	saved := scenarioView(doc)
	return &saved, nil
}
