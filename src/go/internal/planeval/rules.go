package planeval

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/dop251/goja"
	"github.com/zhaochy1990/stride/internal/storage"
)

const (
	maxRuleSourceBytes = 256 << 10
	maxMySQLTextBytes  = 65535
)

var ruleIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

// '*' means the two v1 artifact types; existing single-type versions stay intact.
func ruleAppliesTo(ruleType, artifactType string) bool {
	return ruleType == artifactType || ruleType == "*"
}

func validateRule(rule storage.PlanEvalRule) *Error {
	if !ruleIDPattern.MatchString(rule.ID) || rule.ID == SchemaCheckID {
		return fail(422, "invalid_rule", "ID: 使用 1–64 位字母、数字、_、. 或 -；schema 为保留 ID")
	}
	if rule.Version < 1 || rule.Version > 2147483647 || strings.TrimSpace(rule.Name) == "" || len(rule.Name) > 128 || len(rule.Description) > maxMySQLTextBytes {
		return fail(422, "invalid_rule", "Version/Name/Description: 版本须为正整数，名称必填且 ≤128 字节，说明 ≤65535 UTF-8 字节")
	}
	if rule.ArtifactType != "master_plan" && rule.ArtifactType != "weekly_plan_batch" && rule.ArtifactType != "*" {
		return fail(422, "invalid_rule", "ArtifactType: 仅支持 master_plan、weekly_plan_batch 或 *（两者）")
	}
	if strings.TrimSpace(rule.Source) == "" || len(rule.Source) > maxRuleSourceBytes {
		return fail(422, "invalid_rule", "Source: 必填且 ≤256 KiB")
	}
	return nil
}

func (s *Service) publishRule(ctx context.Context, rule storage.PlanEvalRule) (*storage.PlanEvalRule, *Error) {
	if e := validateRule(rule); e != nil {
		return nil, e
	}
	if _, err := goja.Compile("rule", rule.Source, false); err != nil {
		return nil, fail(422, "rule_source_invalid", err.Error())
	}
	if err := s.store.PublishPlanEvalRule(ctx, &rule); err != nil {
		if errors.Is(err, storage.ErrPlanEvalRuleConflict) {
			return nil, fail(409, "rule_version_conflict", "版本已存在或不是下一版本；请读取最新版本后发布，历史版本不可覆盖")
		}
		return nil, s.internal(err)
	}
	return &rule, nil
}

type ruleTrialRequest struct {
	Rule  storage.PlanEvalRule `json:"rule"`
	Input CheckInput           `json:"input"`
}

func (s *Service) trialRule(ctx context.Context, req ruleTrialRequest) (CheckResult, *Error) {
	if e := validateRule(req.Rule); e != nil {
		return CheckResult{}, e
	}
	var artifact struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(req.Input.Artifact, &artifact); err != nil || !ruleAppliesTo(req.Rule.ArtifactType, artifact.Type) {
		return CheckResult{}, fail(422, "invalid_input", "artifact.type: 与规则适用产物不一致")
	}
	if req.Input.Scenario.ScenarioID == "" || !jsonObject(req.Input.Scenario.Request) || !jsonObject(req.Input.Snapshot) {
		return CheckResult{}, fail(422, "invalid_input", "CheckInput 须包含 snapshot、scenario.scenario_id 与 scenario.request 对象")
	}
	if _, err := instantMillis(req.Input.AsOf); err != nil {
		return CheckResult{}, fail(422, "invalid_input", err.Error())
	}
	// The same schema gate as Execute: invalid artifacts never enter business rules.
	if result := (SchemaCheck{ArtifactType: artifact.Type}).Run(ctx, req.Input); result.Status != "pass" {
		return result, nil
	}
	check := s.staticRule(req.Rule.ID, req.Rule.Version, req.Rule.Source)
	check.WaitTimeout = s.cfg.RuleTimeout
	return check.Run(ctx, req.Input), nil
}

func jsonObject(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return len(raw) > 0 && raw[0] == '{' && json.Valid(raw)
}

func (s *Service) staticRule(id string, version int, source string) StaticRuleCheck {
	return StaticRuleCheck{CheckID: id, Version: version, Source: source, Timeout: s.cfg.RuleTimeout, MemoryLimit: s.cfg.RuleMemoryLimit}
}
