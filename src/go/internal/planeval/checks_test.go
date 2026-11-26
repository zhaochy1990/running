package planeval

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
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

func runRule(t *testing.T, source string) CheckResult {
	t.Helper()
	check := StaticRuleCheck{CheckID: "probe", Source: source, Timeout: 300 * time.Millisecond, MemoryLimit: DefaultRuleMemoryLimit}
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
	if timeout.Status != "error" || timeout.Error == nil || timeout.Error.Code != errRuleTimeout {
		t.Fatalf("infinite loop: %+v, want error rule_timeout", timeout.Error)
	}
	// Keep a bounded allocation live until the heap guard observes it. Give
	// the memory probe its own deadline so runner contention cannot make the
	// two independent budget checks race.
	runtime.GC()
	check := StaticRuleCheck{
		CheckID: "memory-probe", Timeout: 5 * time.Second, MemoryLimit: 16 << 20,
		Source: `function run() {
			var retained = [];
			for (var i = 0; i < 8; i++) retained.push(new ArrayBuffer(8 << 20));
			while (retained.length === 8) {}
		}`,
	}
	memory := check.Run(context.Background(), ruleInput(t, loadValidArtifact(t), 5))
	if memory.Status != "error" || memory.Error == nil || memory.Error.Code != errRuleMemory {
		t.Fatalf("memory budget: %+v, want error rule_memory_exceeded", memory.Error)
	}
}

// Dense synthetic history exercises JSON object allocation and deepFreeze, not
// just a large string; no private snapshot data is used.
func largeRuleInput(t *testing.T) CheckInput {
	t.Helper()
	input := ruleInput(t, loadValidArtifact(t), 5)
	const snapshotBytes = 6147264
	const row = `{"date":"2026-01-01T00:00:00Z","metrics":{"distance":10,"duration":3600,"hr":140}},`
	prefix := `{"constraints":{"max_run_days_per_week":5},"records":{"activities":[`
	rows := strings.Repeat(row, (snapshotBytes-len(prefix)-32)/len(row))
	raw := prefix + rows + `{}]},"padding":"`
	input.Snapshot = json.RawMessage(raw + strings.Repeat("x", snapshotBytes-len(raw)-2) + `"}`)
	if len(input.Snapshot) != snapshotBytes || !json.Valid(input.Snapshot) {
		t.Fatal("synthetic snapshot must be valid JSON at the reproduction size")
	}
	return input
}

func TestStaticRuleCheck_LargeSnapshot(t *testing.T) {
	input := largeRuleInput(t)
	if result := (SchemaCheck{}).Run(context.Background(), input); result.Status != "pass" {
		t.Fatalf("schema gate: %+v", result)
	}
	check := StaticRuleCheck{CheckID: PresetRuleID, Version: PresetRuleVersion, Source: presetRuleSource,
		Timeout: 30 * time.Second, MemoryLimit: DefaultRuleMemoryLimit}
	if result := check.Run(context.Background(), input); result.Status != "pass" {
		t.Fatalf("large snapshot with the unchanged rule budget: status=%s error=%+v", result.Status, result.Error)
	}
}

func TestRuleRuntime_LargeSnapshotStillEnforcesRuleMemory(t *testing.T) {
	input := largeRuleInput(t)
	allocation := `var retained = [];
		for (var i = 0; i < 8; i++) retained.push(new ArrayBuffer(16 << 20));
		while (retained.length === 8) {}`
	for _, phase := range []string{"load", "run"} {
		t.Run(phase, func(t *testing.T) {
			source := allocation + ` function run() { return {status: "pass"}; }`
			if phase == "run" {
				source = `function run() {` + allocation + `}`
			}
			check := StaticRuleCheck{CheckID: "memory-probe", Source: source,
				Timeout: 30 * time.Second, MemoryLimit: DefaultRuleMemoryLimit}
			result := check.Run(context.Background(), input)
			if result.Error == nil || result.Error.Code != errRuleMemory {
				t.Fatalf("%s allocation: status=%s error=%+v", phase, result.Status, result.Error)
			}
		})
	}
}

func TestRuleRuntime_DeepInputIsReadOnly(t *testing.T) {
	input := ruleInput(t, loadValidArtifact(t), 5)
	input.Snapshot = json.RawMessage(`{"constraints":{"max_run_days_per_week":5},"records":{"activities":[{"metrics":{"hr":140}}]}}`)
	input.Scenario.Request = json.RawMessage(`{"nested":{"days":[1,2]}}`)
	source := `function run(input) {
		"use strict";
		var nodes = [input, input.artifact.weekly_docs, input.artifact.weekly_docs[0].sessions,
			input.artifact.weekly_docs[0].sessions[0], input.snapshot.records.activities,
			input.snapshot.records.activities[0].metrics, input.scenario.request.nested.days];
		var blocked = 0;
		for (var node of nodes) {
			if (!Object.isFrozen(node)) throw new Error("not deeply frozen");
			try { node.tampered = true; } catch (e) { blocked++; }
		}
		try { input.snapshot.records.activities[0].metrics.hr = 999; } catch (e) { blocked++; }
		try { input.scenario.request.nested.days.push(3); } catch (e) { blocked++; }
		return {status: "pass", reason: blocked + ":" + input.snapshot.records.activities[0].metrics.hr + ":" + input.scenario.request.nested.days.length};
	}`
	check := StaticRuleCheck{CheckID: "freeze-probe", Source: source, Timeout: time.Second, MemoryLimit: DefaultRuleMemoryLimit}
	if result := check.Run(context.Background(), input); result.Status != "pass" || result.Reason != "9:140:2" {
		t.Fatalf("deep mutation: %+v error=%+v", result, result.Error)
	}
}

func TestRuleRuntime_PreparationSizeBound(t *testing.T) {
	oversized := json.RawMessage(strings.Repeat(" ", maxRuleInputBytes+1))
	for _, field := range []string{"snapshot", "artifact", "request"} {
		t.Run(field, func(t *testing.T) {
			input := ruleInput(t, nil, 5)
			switch field {
			case "snapshot":
				input.Snapshot = oversized
			case "artifact":
				input.Artifact = oversized
			case "request":
				input.Scenario.Request = oversized
			}
			// Preparation remains bounded even when the rule heap guard is disabled.
			check := StaticRuleCheck{Source: `function run() { return {status:"pass"}; }`, Timeout: time.Second}
			result := check.Run(context.Background(), input)
			if result.Error == nil || result.Error.Code != errRuleInputInvalid {
				t.Fatalf("%s size bound: status=%s error=%+v", field, result.Status, result.Error)
			}
		})
	}
	input := ruleInput(t, nil, 5)
	input.Artifact = json.RawMessage(`{not json`)
	check := StaticRuleCheck{Timeout: time.Second}
	if result := check.Run(context.Background(), input); result.Error == nil || result.Error.Code != errRuleInputUnserializable {
		t.Fatalf("invalid JSON: %+v error=%+v", result, result.Error)
	}
}

func TestRuleRuntime_PreparationTimeout(t *testing.T) {
	input := largeRuleInput(t)
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	asOf, err := instantMillis(input.AsOf)
	if err != nil {
		t.Fatal(err)
	}
	// Test the interpreter seam so the interrupted bootstrap has exited before
	// the next shared-heap probe, and verify its structured budget error.
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	_, err = runJavaScriptSync(ctx, presetRuleSource, encoded, asOf, DefaultRuleMemoryLimit)
	if ruleErrorCode(err) != errRuleTimeout {
		t.Fatalf("bootstrap timeout: %v", err)
	}
	check := StaticRuleCheck{Source: presetRuleSource, Timeout: time.Nanosecond, MemoryLimit: DefaultRuleMemoryLimit}
	start := time.Now()
	if result := check.Run(context.Background(), input); result.Error == nil || result.Error.Code != errRuleTimeout {
		t.Fatalf("end-to-end preparation timeout: %+v error=%+v", result, result.Error)
	}
	if time.Since(start) > time.Second {
		t.Fatal("caller waited for native preparation after its deadline")
	}
}

func TestRuleRuntime_TrialCapacityWaitIsBounded(t *testing.T) {
	input := ruleInput(t, nil, 5)
	check := StaticRuleCheck{
		Source:      `function run() { return {status:"pass"}; }`,
		Timeout:     20 * time.Millisecond,
		WaitTimeout: 20 * time.Millisecond,
	}
	select {
	case ruleRuntimeSlot <- struct{}{}:
	case <-time.After(time.Second):
		t.Fatal("previous rule did not release the runtime slot")
	}
	func() {
		defer func() { <-ruleRuntimeSlot }()
		blocked := check.Run(context.Background(), input)
		if blocked.Error == nil || blocked.Error.Code != errRuleBusy {
			t.Fatalf("waiting rule: status=%s error=%+v", blocked.Status, blocked.Error)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
		defer cancel()
		cancelled := check.Run(ctx, input)
		if cancelled.Error == nil || cancelled.Error.Code != errRuleBusy {
			t.Fatalf("cancelled caller: status=%s error=%+v", cancelled.Status, cancelled.Error)
		}
	}()
	check.Timeout = time.Second
	if result := check.Run(context.Background(), input); result.Status != "pass" {
		t.Fatalf("runtime did not recover: status=%s error=%+v", result.Status, result.Error)
	}
}

func TestRuleRuntime_RuleLoadTimeout(t *testing.T) {
	result := runRule(t, `while (true) {} function run() { return {status: "pass"}; }`)
	if result.Error == nil || result.Error.Code != errRuleTimeout {
		t.Fatalf("rule load timeout: status=%s error=%+v", result.Status, result.Error)
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
		"type":        func(a map[string]any) { a["type"] = "weekly_plan" },
		"plan":        func(a map[string]any) { delete(a["plan"].(map[string]any), "goal") },
		"weekly_docs": func(a map[string]any) { delete(a, "weekly_docs") },
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

func TestSchemaCheck_RollingBatch(t *testing.T) {
	valid := func() map[string]any {
		original := loadValidArtifact(t)
		docs := original["weekly_docs"].([]any)
		for i, doc := range docs {
			doc.(map[string]any)["week_index"] = float64(i + 5)
		}
		return map[string]any{"type": "weekly_plan_batch", "master_plan_id": "season-1", "window": map[string]any{"start_week": 5, "end_week": 5 + len(docs) - 1, "mode": "boundary"}, "weekly_docs": docs}
	}
	if result := (SchemaCheck{}).Run(context.Background(), ruleInput(t, valid(), 5)); result.Status != "pass" {
		t.Fatalf("valid rolling batch: %+v", result)
	}
	cases := map[string]func(map[string]any){
		"missing plan identity":   func(a map[string]any) { delete(a, "master_plan_id") },
		"missing range":           func(a map[string]any) { delete(a, "window") },
		"inverted range":          func(a map[string]any) { a["window"].(map[string]any)["end_week"] = 4 },
		"missing complete week":   func(a map[string]any) { a["weekly_docs"] = []any{} },
		"wrong week index":        func(a map[string]any) { a["weekly_docs"].([]any)[0].(map[string]any)["week_index"] = 99 },
		"invalid weekly contract": func(a map[string]any) { a["weekly_docs"].([]any)[0].(map[string]any)["sessions"] = "not sessions" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			a := valid()
			mutate(a)
			if result := (SchemaCheck{}).Run(context.Background(), ruleInput(t, a, 5)); result.Status != "fail" {
				t.Fatalf("invalid rolling batch: %+v", result)
			}
		})
	}
}

func TestSchemaCheck_ExecutionArtifactIdentity(t *testing.T) {
	result := (SchemaCheck{ArtifactType: "weekly_plan_batch"}).Run(context.Background(), ruleInput(t, loadValidArtifact(t), 5))
	if result.Status != "fail" {
		t.Fatalf("master content cannot pass a rolling execution: %+v", result)
	}
}

func TestSchemaCheck_RollingDuplicateCalendarWeek(t *testing.T) {
	original := loadValidArtifact(t)
	first := original["weekly_docs"].([]any)[0].(map[string]any)
	first["week_index"] = 5
	clone := map[string]any{}
	for key, value := range first {
		clone[key] = value
	}
	clone["week_index"] = 6
	artifact := map[string]any{"type": "weekly_plan_batch", "master_plan_id": "season-1", "window": map[string]any{"start_week": 5, "end_week": 6, "mode": "boundary"}, "weekly_docs": []any{first, clone}}
	result := (SchemaCheck{}).Run(context.Background(), ruleInput(t, artifact, 5))
	if result.Status != "fail" || !strings.Contains(string(result.Detail), "week_name") {
		t.Fatalf("duplicate dates with sequential indices must fail: %+v", result)
	}
}

func TestRuleRuntime_BatchWaitDoesNotConsumeRuleBudget(t *testing.T) {
	input := ruleInput(t, nil, 5)
	check := StaticRuleCheck{Source: `function run(){return {status:"pass"};}`, Timeout: 50 * time.Millisecond}
	select {
	case ruleRuntimeSlot <- struct{}{}:
	case <-time.After(time.Second):
		t.Fatal("runtime still occupied")
	}
	done := make(chan CheckResult, 1)
	go func() { done <- check.Run(context.Background(), input) }()
	select {
	case r := <-done:
		<-ruleRuntimeSlot
		t.Fatalf("capacity wait consumed rule budget: %+v", r)
	case <-time.After(150 * time.Millisecond):
	}
	<-ruleRuntimeSlot
	select {
	case r := <-done:
		if r.Status != "pass" {
			t.Fatalf("did not get full rule budget: %+v", r)
		}
	case <-time.After(time.Second):
		t.Fatal("batch did not resume")
	}
}
