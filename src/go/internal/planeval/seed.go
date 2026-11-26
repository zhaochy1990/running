package planeval

import (
	"compress/gzip"
	"context"
	"embed"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/zhaochy1990/stride/internal/storage"
)

// The scenario and rule ship with the binary. The runner snapshot is supplied
// privately at deployment time. Tasks freeze their own copies.

//go:embed preset/scenario_new_season_fm.json
var presetScenarioDocument []byte

//go:embed preset/rule_weekly_run_days.js
var presetRuleSource string

//go:embed preset/rule_*.js
var builtinRuleFiles embed.FS

// Preset IDs.
const (
	PresetScenarioID  = "preset-new-season-fm"
	PresetRuleID      = "weekly_run_days"
	PresetRuleVersion = 1
)

// presetScenarioFile is the shape of preset/scenario_*.json.
type presetScenarioFile struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	ArtifactType string          `json:"artifact_type"`
	AsOf         string          `json:"as_of"`
	Rules        []RuleRef       `json:"rules"`
	Request      json.RawMessage `json:"request"`
}

// RuleRef pins one rule version a scenario is judged with.
type RuleRef struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
}

// SeedPresetFile reconciles the preset from an optional private mount.
func (s *Service) SeedPresetFile(ctx context.Context, path string) error {
	if err := s.SeedRules(ctx); err != nil {
		return err
	}
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open plan-eval snapshot: %w", err)
	}
	defer file.Close()
	var reader io.Reader = file
	if strings.HasSuffix(path, ".gz") {
		compressed, err := gzip.NewReader(file)
		if err != nil {
			return fmt.Errorf("open compressed plan-eval snapshot: %w", err)
		}
		defer compressed.Close()
		reader = compressed
	}
	const maxSnapshotBytes = 16 << 20
	document, err := io.ReadAll(io.LimitReader(reader, maxSnapshotBytes+1))
	if err != nil {
		return fmt.Errorf("read plan-eval snapshot: %w", err)
	}
	if len(document) > maxSnapshotBytes {
		return fmt.Errorf("plan-eval snapshot exceeds %d bytes", maxSnapshotBytes)
	}
	return s.seedPreset(ctx, document)
}

func (s *Service) seedPreset(ctx context.Context, document []byte) error {
	// The preset is now editable through the catalog; boot must not undo edits.
	if _, err := s.store.GetPlanEvalScenario(ctx, PresetScenarioID); err == nil {
		return nil
	} else if !errors.Is(err, storage.ErrPlanEvalNotFound) {
		return err
	}

	var scenario presetScenarioFile
	if err := json.Unmarshal(presetScenarioDocument, &scenario); err != nil {
		return err
	}
	var snapshot struct {
		ID             string          `json:"snapshot_id"`
		Username       string          `json:"username"`
		GenerationKind string          `json:"generation_kind"`
		Event          string          `json:"event"`
		TargetTime     *string         `json:"target_time"`
		AsOfDay        string          `json:"as_of_day"`
		Constraints    json.RawMessage `json:"constraints"`
		Schema         string          `json:"schema"`
		Records        json.RawMessage `json:"records"`
	}
	if err := json.Unmarshal(document, &snapshot); err != nil {
		return fmt.Errorf("decode plan-eval snapshot: %w", err)
	}
	if snapshot.Schema != "plan-eval-runner-snapshot/v1" || snapshot.ID == "" || snapshot.Username == "" ||
		snapshot.GenerationKind != "new_season" || snapshot.Event != "FM" ||
		snapshot.AsOfDay != scenario.AsOf[:10] || snapshot.TargetTime == nil || *snapshot.TargetTime != "3:10:00" ||
		len(snapshot.Records) == 0 || len(snapshot.Constraints) == 0 {
		return errors.New("plan-eval snapshot must match the preset full-marathon scenario (including cutoff day and goal)")
	}
	snapshotIDs, err := json.Marshal([]string{snapshot.ID})
	if err != nil {
		return err
	}
	ruleRefs, err := json.Marshal(scenario.Rules)
	if err != nil {
		return err
	}
	targetTime := ""
	if snapshot.TargetTime != nil {
		targetTime = *snapshot.TargetTime
	}
	if err := s.store.UpsertPlanEvalRule(ctx, &storage.PlanEvalRule{
		ID: PresetRuleID, Version: PresetRuleVersion, Name: "每周跑步日上限",
		Description:  "同一上海日历日多次跑步计为一天；每周跑步日不得超过快照给出的上限。",
		ArtifactType: scenario.ArtifactType, Source: presetRuleSource,
	}); err != nil {
		return err
	}
	if err := s.store.UpsertPlanEvalRunnerSnapshot(ctx, &storage.PlanEvalRunnerSnapshot{
		ID: snapshot.ID, Username: snapshot.Username, GenerationKind: snapshot.GenerationKind, Event: snapshot.Event,
		TargetTime: targetTime, AsOfDay: snapshot.AsOfDay, ConstraintsJSON: string(snapshot.Constraints),
		SnapshotJSON: string(document),
	}); err != nil {
		return err
	}
	return s.store.UpsertPlanEvalScenario(ctx, &storage.PlanEvalScenario{
		ID: scenario.ID, Name: scenario.Name, ArtifactType: scenario.ArtifactType, AsOf: scenario.AsOf,
		RequestJSON: string(scenario.Request), SnapshotIDs: string(snapshotIDs), RuleRefs: string(ruleRefs),
	})
}

// SeedRules inserts the first fixed checks without editing scenarios or prior
// versions. Administrators explicitly choose the versions for future tasks.
func (s *Service) SeedRules(ctx context.Context) error {
	rules := []struct {
		id                                    string
		version                               int
		name, description, artifactType, file string
	}{
		{PresetRuleID, 1, "每周跑步日上限", "同一上海日多次跑步计一天。", "master_plan", "weekly_run_days"},
		{PresetRuleID, 2, "每周跑步日上限", "同一上海日多次跑步计一天；新建与滚动共用。", "*", "weekly_run_days"},
		{"no_run_days", 1, "禁训日", "快照明确给出禁训星期；无禁训日使用 []。", "*", "no_run_days"},
		{"race_goal", 1, "主比赛目标", "距离、比赛日、目标成绩与冻结请求一致；覆盖比赛周。", "master_plan", "race_goal"},
		{"initial_weeks", 1, "首批周课连续性", "从赛季第 1 周开始，周号连续无重复且日期一致。", "master_plan", "initial_weeks"},
		{"rolling_window", 1, "滚动接续窗口", "核对冻结赛季身份、预期首周、周号与日期；不得越过终点。", "weekly_plan_batch", "rolling_window"},
		{"catch_up_dates", 1, "追赶日期边界", "新课程必须晚于上海执行日；营养项仍保留完整七天。", "weekly_plan_batch", "catch_up_dates"},
	}
	for _, rule := range rules {
		source, err := builtinRuleFiles.ReadFile("preset/rule_" + rule.file + ".js")
		if err != nil {
			return err
		}
		if err := s.store.UpsertPlanEvalRule(ctx, &storage.PlanEvalRule{ID: rule.id, Version: rule.version, Name: rule.name, Description: rule.description, ArtifactType: rule.artifactType, Source: string(source)}); err != nil {
			return err
		}
	}
	return nil
}
