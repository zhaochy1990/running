package planeval

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

const testAsOf = "2026-10-23T23:59:59+08:00"

func loadValidArtifact(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile("testdata/valid_master_plan_artifact.json")
	if err != nil {
		t.Fatalf("read testdata: %v", err)
	}
	var artifact map[string]any
	if err := json.Unmarshal(raw, &artifact); err != nil {
		t.Fatalf("decode testdata: %v", err)
	}
	return artifact
}

func ruleInput(t *testing.T, artifact any, maxRunDays int) CheckInput {
	t.Helper()
	snapshot := map[string]any{"constraints": map[string]any{"max_run_days_per_week": maxRunDays}}
	if maxRunDays < 0 {
		snapshot["constraints"] = map[string]any{}
	}
	input := CheckInput{
		Snapshot: mustJSON(snapshot),
		Scenario: ScenarioInput{ScenarioID: "scenario", Request: json.RawMessage(`{"requested_mode":"new_season"}`)},
		AsOf:     testAsOf,
	}
	if artifact != nil {
		input.Artifact = mustJSON(artifact)
	}
	return input
}

// addRunDay clones the first run session of a weekly doc onto another day of
// the same week, so the doc has two distinct run days.
func addRunDay(t *testing.T, artifact map[string]any) {
	t.Helper()
	docs := artifact["weekly_docs"].([]any)
	doc := docs[0].(map[string]any)
	sessions := doc["sessions"].([]any)
	for _, session := range sessions {
		if run, ok := session.(map[string]any); ok && run["kind"] == "run" {
			clone := map[string]any{}
			for key, value := range run {
				clone[key] = value
			}
			clone["date"] = "2026-08-13"
			clone["session_index"] = 0
			doc["sessions"] = append(sessions, clone)
			return
		}
	}
	t.Fatalf("fixture weekly doc has no run session")
}

func TestStaticRuleCheck_PresetRule(t *testing.T) {
	check := StaticRuleCheck{CheckID: PresetRuleID, Version: 1, Source: presetRuleSource, Timeout: 5 * time.Second}
	ctx := context.Background()

	pass := check.Run(ctx, ruleInput(t, loadValidArtifact(t), 5))
	if pass.Status != "pass" || pass.Reason == "" {
		t.Fatalf("within the limit: %+v, want pass", pass)
	}

	busy := loadValidArtifact(t)
	addRunDay(t, busy)
	fail := check.Run(ctx, ruleInput(t, busy, 1))
	if fail.Status != "fail" {
		t.Fatalf("over the limit: %+v, want fail", fail)
	}
	var violations []map[string]any
	if err := json.Unmarshal(fail.Detail, &violations); err != nil || len(violations) != 1 {
		t.Fatalf("violations = %s (%v), want one", fail.Detail, err)
	}
	if violations[0]["week_name"] != "2026-08-10_08-16" || violations[0]["expected"] != float64(1) || violations[0]["actual"] != float64(2) {
		t.Fatalf("violation = %+v, want week/expected/actual locating the offence", violations[0])
	}

	missing := check.Run(ctx, ruleInput(t, loadValidArtifact(t), -1))
	if missing.Status != "error" || missing.Error == nil || missing.Error.Code != "rule_input_missing" {
		t.Fatalf("snapshot without the limit: %+v, want error rule_input_missing", missing)
	}
}

func runRule(t *testing.T, source string, opts ...func(*int64)) CheckResult {
	t.Helper()
	limit := DefaultRuleMemoryLimit
	for _, opt := range opts {
		opt(&limit)
	}
	check := StaticRuleCheck{CheckID: "probe", Source: source, Timeout: 300 * time.Millisecond, MemoryLimit: limit}
	return check.Run(context.Background(), ruleInput(t, loadValidArtifact(t), 5))
}

func TestRuleRuntime_FreezesClockAndRandomness(t *testing.T) {
	source := `function run() {
  return { status: "pass", reason: "probe", violations: [
    { now: Date.now(), iso: new Date().toISOString(), r1: Math.random(), r2: Math.random(), parsed: Date.parse("2026-10-23T15:59:59.000Z") } ] };
}`
	first := runRule(t, source)
	second := runRule(t, source)
	if first.Status != "pass" || second.Status != "pass" {
		t.Fatalf("probe failed: %+v / %+v", first, second)
	}
	if string(first.Detail) != string(second.Detail) {
		t.Fatalf("two runs of the same rule disagreed:\n%s\n%s", first.Detail, second.Detail)
	}
	var probe []struct {
		Now    int64  `json:"now"`
		ISO    string `json:"iso"`
		R1, R2 float64
	}
	if err := json.Unmarshal(first.Detail, &probe); err != nil || len(probe) != 1 {
		t.Fatalf("decode: %v (%d)", err, len(probe))
	}
	detail := probe[0]
	want, err := time.Parse(time.RFC3339Nano, testAsOf)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Now != want.UnixMilli() || detail.ISO != "2026-10-23T15:59:59.000Z" {
		t.Fatalf("clock is not frozen to as_of: now=%d iso=%s", detail.Now, detail.ISO)
	}
	if detail.R1 == detail.R2 {
		t.Fatalf("seeded randomness should still produce a sequence")
	}
}

func TestRuleRuntime_ExposesNoHostCapabilities(t *testing.T) {
	source := `function run() {
  var names = ["require", "process", "fetch", "XMLHttpRequest", "setTimeout", "setInterval", "WebSocket", "Java", "WeakRef", "__input", "__inputJSON", "__asOf"];
  var found = names.filter(function (name) { return typeof globalThis[name] !== "undefined"; });
  return { status: "pass", reason: found.join(",") };
}`
	result := runRule(t, source)
	if result.Status != "pass" {
		t.Fatalf("probe failed: %+v", result)
	}
	if result.Reason != "" {
		t.Fatalf("rule reached host capabilities: %q", result.Reason)
	}
}

func TestRuleRuntime_InputIsReadOnly(t *testing.T) {
	source := `function run(input) {
  var threw = false;
  try { input.artifact.type = "tampered"; input.snapshot.constraints.max_run_days_per_week = 99; } catch (e) { threw = true; }
  return { status: "pass", reason: input.artifact.type + ":" + input.snapshot.constraints.max_run_days_per_week + ":" + threw };
}`
	result := runRule(t, source)
	// Sloppy-mode writes to a frozen object are ignored, strict-mode ones throw;
	// either way the input the rule reads back is unchanged.
	if result.Status != "pass" || !strings.HasPrefix(result.Reason, "master_plan:5:") {
		t.Fatalf("input was mutable: %+v", result)
	}
}

func TestRuleRuntime_EnforcesBudgets(t *testing.T) {
	timeout := runRule(t, `function run() { while (true) {} }`)
	if timeout.Status != "error" || timeout.Error.Code != errRuleTimeout {
		t.Fatalf("infinite loop: %+v, want error rule_timeout", timeout)
	}
	memory := runRule(t, `function run() { var all = []; while (true) { all.push(new Array(1 << 20).fill(1)); } }`, func(limit *int64) { *limit = 32 << 20 })
	if memory.Status != "error" || memory.Error.Code != errRuleMemory {
		t.Fatalf("allocation bomb: %+v, want error rule_memory_exceeded", memory)
	}
}

func TestRuleRuntime_ReportsBrokenRules(t *testing.T) {
	cases := map[string]struct {
		source string
		code   string
	}{
		"syntax error":   {`function run( {`, errRuleSyntax},
		"no entry":       {`function evaluate() { return 1; }`, errRuleNoEntry},
		"throws":         {`function run() { throw new Error("boom"); }`, errRuleThrew},
		"not an object":  {`function run() { return "pass"; }`, errRuleResultInvalid},
		"bad status":     {`function run() { return { status: "ok" }; }`, errRuleResultInvalid},
		"error w/o code": {`function run() { return { status: "error", error: { message: "x" } }; }`, errRuleResultInvalid},
	}
	for name, tc := range cases {
		result := runRule(t, tc.source)
		if result.Status != "error" || result.Error == nil || result.Error.Code != tc.code {
			t.Errorf("%s: %+v, want error %s", name, result, tc.code)
		}
	}
	if got := runRule(t, `function run() { return { status: "error", error: { code: "rule_input_missing", message: "缺约束" } }; }`); got.Error == nil || got.Error.Message != "缺约束" || got.Error.Code != "rule_input_missing" {
		t.Errorf("a rule's own error must be preserved verbatim: %+v", got)
	}
}

func TestSchemaCheck(t *testing.T) {
	check := SchemaCheck{}
	valid := ruleInput(t, loadValidArtifact(t), 5)
	if got := check.Run(context.Background(), valid); got.Status != "pass" || !strings.Contains(got.Reason, "3 份") {
		t.Fatalf("valid artifact: %+v, want pass over 3 weekly docs", got)
	}

	notJSON := valid
	notJSON.Artifact = json.RawMessage("{not json")
	if got := check.Run(context.Background(), notJSON); got.Status != "fail" {
		t.Fatalf("non-JSON: %+v", got)
	}

	cases := map[string]func(artifact map[string]any){
		"type": func(a map[string]any) { a["type"] = "weekly_plan" },
		"plan": func(a map[string]any) { delete(a["plan"].(map[string]any), "goal") },
		"weekly_docs[1]": func(a map[string]any) {
			doc := a["weekly_docs"].([]any)[1].(map[string]any)
			doc["nutrition"] = doc["nutrition"].([]any)[:6] // schema: exactly 7 days
		},
		"weekly_docs[2]": func(a map[string]any) {
			doc := a["weekly_docs"].([]any)[2].(map[string]any)
			var kept []any
			for _, session := range doc["sessions"].([]any) {
				if session.(map[string]any)["kind"] != "run" {
					kept = append(kept, session)
				}
			}
			doc["sessions"] = kept // refinement only: at least one run session
		},
	}
	for path, corrupt := range cases {
		artifact := loadValidArtifact(t)
		corrupt(artifact)
		got := check.Run(context.Background(), ruleInput(t, artifact, 5))
		if got.Status != "fail" || !strings.Contains(string(got.Detail), `"path":"`+path+`"`) {
			t.Errorf("%s: %+v, want fail pointing at %s", path, got, path)
		}
	}
}
