package planeval

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"

	"github.com/zhaochy1990/stride/internal/storage"
	"testing"
	"time"
)

func builtinCheck(t *testing.T, id string) Check {
	t.Helper()
	source, err := builtinRuleFiles.ReadFile("preset/rule_" + id + ".js")
	if err != nil {
		t.Fatal(err)
	}
	return StaticRuleCheck{CheckID: id, Version: 1, Source: string(source), Timeout: time.Second, MemoryLimit: DefaultRuleMemoryLimit}
}

func TestStaticRuleCheck_FirstRules(t *testing.T) {
	ctx := context.Background()
	t.Run("same day twice counts once", func(t *testing.T) {
		a := loadValidArtifact(t)
		doc := a["weekly_docs"].([]any)[0].(map[string]any)
		sessions := doc["sessions"].([]any)
		doc["sessions"] = append(sessions, sessions[0])
		if r := builtinCheck(t, "weekly_run_days").Run(ctx, ruleInput(t, a, 1)); r.Status != "pass" {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("banned days and missing input", func(t *testing.T) {
		a := loadValidArtifact(t)
		input := ruleInput(t, a, 5)
		input.Snapshot = json.RawMessage(`{"constraints":{"no_run_days":["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]}}`)
		r := builtinCheck(t, "no_run_days").Run(ctx, input)
		if r.Status != "fail" || len(r.Detail) == 0 {
			t.Fatalf("%+v", r)
		}
		input.Snapshot = json.RawMessage(`{"constraints":{"no_run_days":[]}}`)
		if r = builtinCheck(t, "no_run_days").Run(ctx, input); r.Status != "pass" {
			t.Fatalf("%+v", r)
		}
		input.Snapshot = json.RawMessage(`{}`)
		if r = builtinCheck(t, "no_run_days").Run(ctx, input); r.Error == nil || r.Error.Code != "rule_input_missing" {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("goals and race week", func(t *testing.T) {
		a := loadValidArtifact(t)
		plan := a["plan"].(map[string]any)
		plan["goal"].(map[string]any)["race_date"] = "2026-08-30"
		input := ruleInput(t, a, 5)
		input.Scenario.Request = json.RawMessage(`{"goals":[{"distance":"FM","race_date":"2026-08-30","target_time":"02:50:00","priority":"A"}]}`)
		if r := builtinCheck(t, "race_goal").Run(ctx, input); r.Status != "pass" {
			t.Fatalf("%+v", r)
		}
		for _, field := range []string{"distance", "race_date", "target_time"} {
			goal := plan["goal"].(map[string]any)
			old := goal[field]
			goal[field] = "wrong"
			input.Artifact = mustJSON(a)
			if r := builtinCheck(t, "race_goal").Run(ctx, input); r.Status != "fail" {
				t.Fatalf("%s: %+v", field, r)
			}
			goal[field] = old
		}
		plan["end_date"] = "2026-08-20"
		input.Artifact = mustJSON(a)
		if r := builtinCheck(t, "race_goal").Run(ctx, input); r.Status != "fail" {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("first weeks index and calendar", func(t *testing.T) {
		a := loadValidArtifact(t)
		check := builtinCheck(t, "initial_weeks")
		if r := check.Run(ctx, ruleInput(t, a, 5)); r.Status != "pass" {
			t.Fatalf("%+v", r)
		}
		docs := a["weekly_docs"].([]any)
		for _, field := range []string{"week_index", "week_name"} {
			week := docs[1].(map[string]any)
			old := week[field]
			week[field] = docs[0].(map[string]any)[field]
			if r := check.Run(ctx, ruleInput(t, a, 5)); r.Status != "fail" {
				t.Fatalf("%s: %+v", field, r)
			}
			week[field] = old
		}
		a["weekly_docs"] = docs[1:]
		if r := check.Run(ctx, ruleInput(t, a, 5)); r.Status != "fail" {
			t.Fatalf("missing first week: %+v", r)
		}
	})
	t.Run("C D HM continuation and season end", func(t *testing.T) {
		for _, tc := range []struct {
			kind, event, mode string
			last, want        int
		}{{"rolling_continue", "FM", "boundary", 4, 5}, {"rolling_catch_up", "FM", "catch_up", 2, 4}, {"rolling_continue", "HM", "boundary", 4, 5}} {
			snapshot, plan := testRollingSnapshot(t)
			snapshot["generation_kind"], snapshot["event"] = tc.kind, tc.event
			snapshot["as_of_day"] = "2026-10-26"
			plan["weeks"] = []any{map[string]any{"week_index": tc.last, "key_sessions": []any{map[string]any{"date": "2026-10-10"}}}}
			start := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC).AddDate(0, 0, (tc.want-1)*7).Format("2006-01-02")
			a := map[string]any{"type": "weekly_plan_batch", "master_plan_id": "plan", "window": map[string]any{"start_week": tc.want, "end_week": tc.want, "mode": tc.mode}, "weekly_docs": []any{map[string]any{"week_index": tc.want, "week_name": start + "_end", "sessions": []any{}}}}
			input := CheckInput{Artifact: mustJSON(a), Snapshot: mustJSON(snapshot), AsOf: "2026-10-25T16:30:00Z", Scenario: ScenarioInput{Request: json.RawMessage(`{}`)}}
			check := builtinCheck(t, "rolling_window")
			if r := check.Run(ctx, input); r.Status != "pass" {
				t.Fatalf("%+v: %+v %s", tc, r, r.Detail)
			}
			if tc.mode == "catch_up" {
				a["window"].(map[string]any)["mode"] = "boundary"
				input.Artifact = mustJSON(a)
				if r := check.Run(ctx, input); r.Status != "fail" || !strings.Contains(string(r.Detail), `"field":"window.mode"`) {
					t.Fatalf("mislabeled catch-up: %+v %s", r, r.Detail)
				}
				a["window"].(map[string]any)["mode"] = tc.mode
			}
			a["window"].(map[string]any)["start_week"] = tc.want + 1
			input.Artifact = mustJSON(a)
			if r := check.Run(ctx, input); r.Status != "fail" {
				t.Fatalf("wrong start: %+v", r)
			}
			a["window"].(map[string]any)["start_week"] = tc.want
			a["window"].(map[string]any)["end_week"] = 9
			input.Artifact = mustJSON(a)
			if r := check.Run(ctx, input); r.Status != "fail" {
				t.Fatalf("after season: %+v", r)
			}
		}
	})
	t.Run("catch up uses Shanghai midnight and ignores nutrition", func(t *testing.T) {
		a := loadValidArtifact(t)
		for _, raw := range a["weekly_docs"].([]any) {
			doc := raw.(map[string]any)
			doc["sessions"] = []any{map[string]any{"date": "2026-10-27", "kind": "run"}}
		}
		input := ruleInput(t, a, 5)
		a["window"] = map[string]any{"mode": "catch_up"}
		input.Artifact = mustJSON(a)
		input.Snapshot = json.RawMessage(`{"generation_kind":"rolling_continue"}`)
		input.AsOf = "2026-10-25T16:00:00Z"
		check := builtinCheck(t, "catch_up_dates")
		if r := check.Run(ctx, input); r.Status != "pass" {
			t.Fatalf("%+v", r)
		}
		a["weekly_docs"].([]any)[0].(map[string]any)["sessions"].([]any)[0].(map[string]any)["date"] = "2026-10-26"
		input.Artifact = mustJSON(a)
		if r := check.Run(ctx, input); r.Status != "fail" {
			t.Fatalf("same cutoff date: %+v", r)
		}
		a["window"] = map[string]any{"mode": "boundary"}
		input.Artifact = mustJSON(a)
		input.Snapshot = json.RawMessage(`{"generation_kind":"rolling_catch_up"}`)
		if r := check.Run(ctx, input); r.Status != "fail" {
			t.Fatalf("a catch-up snapshot cannot hide a cutoff violation by reporting boundary: %+v", r)
		}
	})
}

func TestRuleRuntime_DateConstructorAndResultSerialization(t *testing.T) {
	input := ruleInput(t, loadValidArtifact(t), 5)
	source := `function run(input) {return {status:"pass",reason:String(Date.prototype.constructor.now())+":"+new Date.prototype.constructor().toISOString()};}`
	check := StaticRuleCheck{Source: source, Timeout: time.Second}
	one, two := check.Run(context.Background(), input), check.Run(context.Background(), input)
	if one.Status != "pass" || !reflect.DeepEqual(one, two) || one.Reason != "1792771199000:2026-10-23T15:59:59.000Z" {
		t.Fatalf("%+v / %+v", one, two)
	}
	for _, source := range []string{
		`function run(){var r={status:"pass"};r.self=r;return r;}`,
		`function run(){return {status:"fail", reason:"bad", violations:{expected:1}};}`,
		`function run(){return {status:"fail", reason:"bad"};}`,
		`function run(){return {status:"error", error:{code:"x"}};}`,
		`function run(){return {status:"fail", reason:"bad", violations:[{}]};}`,
		`function run(){return {status:"fail", reason:"bad", violations:[null]};}`,
		`function run(){return {status:"fail", reason:"bad", violations:[{expected:1,actual:2}]};}`,
		`function run(){return {status:"fail", reason:"bad", violations:[{field:"",expected:1,actual:2}]};}`,
		`function run(){return {status:"fail", reason:"bad", violations:[{date:"x",actual:2}]};}`,
		`function run(){return {status:"pass", reason:"中".repeat(21846)};}`,
		`function run(){return {status:"error", reason:"x".repeat(65536),error:{code:"x",message:"x"}};}`,
	} {
		check.Source = source
		if r := check.Run(context.Background(), input); r.Error == nil || r.Error.Code != errRuleResultInvalid {
			t.Fatalf("%s: %+v", source, r)
		}
	}
	check.Source = `function run(){throw new Error("rule_timeout rule_memory_exceeded");}`
	if r := check.Run(context.Background(), input); r.Error == nil || r.Error.Code != errRuleThrew {
		t.Fatalf("error text spoofed budget: %+v", r)
	}
	check.Source = `function run(){return {toJSON:function(){while(true){}}};}`
	check.Timeout = 50 * time.Millisecond
	if r := check.Run(context.Background(), input); r.Error == nil || r.Error.Code != errRuleTimeout {
		t.Fatalf("toJSON budget: %+v", r)
	}
}

func TestRuleResult_NullValuesAndTextBoundary(t *testing.T) {
	for _, source := range []string{
		`function run(){return {status:"fail",reason:"bad",violations:[{week_index:1,expected:null,actual:null}]};}`,
		`function run(){return {status:"pass",reason:"中".repeat(21845)};}`,
	} {
		check := StaticRuleCheck{Source: source, Timeout: time.Second}
		if r := check.Run(context.Background(), ruleInput(t, nil, 5)); r.Status == "error" {
			t.Fatalf("%s: %+v", source, r)
		}
	}
}

func TestRuleObjectAndDescriptionBoundaries(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `[{}]`, `{broken`, `{}` + `[]`} {
		if jsonObject(json.RawMessage(raw)) {
			t.Fatalf("accepted %s", raw)
		}
	}
	if !jsonObject(json.RawMessage(` {"nested":[{},null]} `)) {
		t.Fatal("valid object rejected")
	}
	rule := storage.PlanEvalRule{ID: "new", Version: 1, Name: "name", ArtifactType: "*", Source: `function run(){return {status:"pass"};}`}
	rule.Description = strings.Repeat("中", 21845)
	if e := validateRule(rule); e != nil {
		t.Fatal(e)
	}
	rule.Description += "a"
	if e := validateRule(rule); e == nil || e.Code != "invalid_rule" {
		t.Fatalf("description accepted: %+v", e)
	}
}

func TestRollingWindow_CandidateRowsAndPhaseEnd(t *testing.T) {
	snapshot, plan := testRollingSnapshot(t)
	plan["weekly_docs"] = []any{}
	plan["weeks"] = []any{map[string]any{"week_index": 6, "key_sessions": []any{map[string]any{"date": "2026-11-09"}}}}
	delete(plan, "end_date")
	plan["phases"] = []any{nil, map[string]any{"start_date": "2026-10-05", "end_date": "2026-11-29"}}
	snapshot["records"].(map[string]any)["weekly_plan_weeks"] = []any{map[string]any{"week_start": "2026-10-05"}, map[string]any{"week_start": "2026-10-12"}, map[string]any{"week_start": "2026-10-19"}}
	a := map[string]any{"master_plan_id": "plan", "window": map[string]any{"start_week": 4, "end_week": 4, "mode": "boundary"}, "weekly_docs": []any{map[string]any{"week_index": 4, "week_name": "2026-10-26_end", "sessions": []any{}}}}
	input := CheckInput{Artifact: mustJSON(a), Snapshot: mustJSON(snapshot), AsOf: "2026-10-23T00:00:00+08:00"}
	check := builtinCheck(t, "rolling_window")
	if r := check.Run(context.Background(), input); r.Status != "pass" {
		t.Fatalf("preview treated as applied: %+v %s", r, r.Detail)
	}
	snapshot["expected_start_week"] = 4
	input.Snapshot = mustJSON(snapshot)
	if r := check.Run(context.Background(), input); r.Status != "pass" {
		t.Fatal(r)
	}
	a["weekly_docs"].([]any)[0].(map[string]any)["sessions"] = []any{map[string]any{"date": "2026-11-30"}}
	input.Artifact = mustJSON(a)
	if r := check.Run(context.Background(), input); r.Status != "fail" {
		t.Fatalf("phase end ignored: %+v", r)
	}
}

func TestRaceGoal_TargetTimeGrammar(t *testing.T) {
	a := loadValidArtifact(t)
	plan := a["plan"].(map[string]any)
	plan["goal"].(map[string]any)["race_date"] = "2026-08-30"
	check := builtinCheck(t, "race_goal")
	for _, tc := range []struct{ expected, actual, status string }{
		{"4:00:00", "04:00:00", "pass"}, {"04:00:00", "4:00:00", "pass"},
		{"4:00:00", "3:60:00", "fail"}, {"4:00:00", "3:59:60", "fail"},
		{"3:60:00", "3:60:00", "fail"}, {"4:00", "4:00", "fail"},
	} {
		plan["goal"].(map[string]any)["target_time"] = tc.actual
		input := ruleInput(t, a, 5)
		input.Scenario.Request = mustJSON(map[string]any{"goals": []any{map[string]any{"distance": "FM", "race_date": "2026-08-30", "target_time": tc.expected}}})
		if r := check.Run(context.Background(), input); r.Status != tc.status {
			t.Fatalf("%+v: %+v", tc, r)
		}
	}
}
