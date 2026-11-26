// Package planeval is the training-plan evaluation service (devops#1055): it
// freezes inputs for a published Coach Agent version, hands them to that
// version's worker over RabbitMQ, and judges the artifacts it returns.
package planeval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/dop251/goja"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/zhaochy1990/stride/internal/api"
)

// CheckInput is the read-only packet one check receives for one snapshot
// execution (devops#1049): the artifact, the runner snapshot, the frozen
// scenario request and the frozen execution instant.
type CheckInput struct {
	Artifact json.RawMessage `json:"artifact"`
	Snapshot json.RawMessage `json:"snapshot"`
	Scenario ScenarioInput   `json:"scenario"`
	AsOf     string          `json:"as_of"`
}

// ScenarioInput names the scenario and carries its frozen generation request.
type ScenarioInput struct {
	ScenarioID string          `json:"scenario_id"`
	Request    json.RawMessage `json:"request"`
}

// CheckResult is the unified verdict: pass, fail or error.
type CheckResult struct {
	CheckID string          `json:"check_id"`
	Version int             `json:"version"`
	Status  string          `json:"status"`
	Reason  string          `json:"reason"`
	Detail  json.RawMessage `json:"detail,omitempty"`
	Error   *CheckError     `json:"error,omitempty"`
}

// CheckError is a structured execution error (not a "did not pass").
type CheckError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Check is the seam every judge implements. The SchemaCheck is the gate an
// artifact must pass before business rules (StaticRuleCheck, and later LLM
// judges) see it. Implementations never mutate their input and never touch
// anything outside it.
type Check interface {
	ID() string
	Run(ctx context.Context, input CheckInput) CheckResult
}

// DefaultRuleMemoryLimit is the heap growth one rule run may cause before it
// is interrupted, excluding bounded trusted input preparation (best-effort
// guard on a shared heap).
const DefaultRuleMemoryLimit int64 = 64 << 20

// Allow a 16 MiB imported snapshot plus room for the artifact and request.
// Bound trusted parsing/freezing even without a rule heap budget.
const maxRuleInputBytes = 3 * (16 << 20)

// SchemaCheckID is the check_id the schema gate is recorded under.
const SchemaCheckID = "schema"

// SchemaCheck validates an artifact's raw content against the existing
// contracts: the season plan snapshot and every weekly plan in it.
type SchemaCheck struct{ ArtifactType string }

func (SchemaCheck) ID() string { return SchemaCheckID }

func (c SchemaCheck) Run(_ context.Context, input CheckInput) CheckResult {
	result := CheckResult{CheckID: SchemaCheckID, Status: "pass"}
	var envelope struct {
		Type         string            `json:"type"`
		Plan         json.RawMessage   `json:"plan"`
		WeeklyDocs   []json.RawMessage `json:"weekly_docs"`
		MasterPlanID string            `json:"master_plan_id"`
		Window       *struct {
			StartWeek int    `json:"start_week"`
			EndWeek   int    `json:"end_week"`
			Mode      string `json:"mode"`
		} `json:"window"`
	}
	if err := json.Unmarshal(input.Artifact, &envelope); err != nil {
		return schemaFail(result, "artifact", "产物不是合法的 JSON 对象："+err.Error())
	}
	if c.ArtifactType != "" && envelope.Type != c.ArtifactType {
		return schemaFail(result, "type", "产物类型与执行项预期不一致。")
	}
	switch envelope.Type {
	case "master_plan":
		var plan any
		if err := json.Unmarshal(envelope.Plan, &plan); err != nil {
			return schemaFail(result, "plan", "赛季计划不是合法 JSON："+err.Error())
		}
		if err := api.ValidateMasterPlanSnapshot(plan); err != nil {
			return schemaFail(result, "plan", schemaMessage(err))
		}
	case "weekly_plan_batch":
		if envelope.MasterPlanID == "" {
			return schemaFail(result, "master_plan_id", "滚动产物必须标明赛季计划 ID。")
		}
		w := envelope.Window
		if w == nil || w.StartWeek < 1 || w.EndWeek < w.StartWeek || (w.Mode != "boundary" && w.Mode != "catch_up") {
			return schemaFail(result, "window", "滚动产物必须包含合法的生成周范围和模式。")
		}
		if len(envelope.WeeklyDocs) != w.EndWeek-w.StartWeek+1 {
			return schemaFail(result, "weekly_docs", "滚动产物必须包含生成周范围内的全部周课表。")
		}
	default:
		return schemaFail(result, "type", "产物类型应为 master_plan 或 weekly_plan_batch，实际为 "+fmt.Sprintf("%q", envelope.Type))
	}
	if len(envelope.WeeklyDocs) == 0 {
		return schemaFail(result, "weekly_docs", "产物必须至少包含一份完整周课表。")
	}
	var previousWeek time.Time
	for i, raw := range envelope.WeeklyDocs {
		var doc map[string]any
		if err := json.Unmarshal(raw, &doc); err != nil {
			return schemaFail(result, fmt.Sprintf("weekly_docs[%d]", i), "周课表不是合法 JSON 对象："+err.Error())
		}
		if err := api.ValidateWeeklyPlanContract(doc); err != nil {
			return schemaFail(result, fmt.Sprintf("weekly_docs[%d]", i), err.Error())
		}
		if envelope.Type == "weekly_plan_batch" && doc["week_index"] != float64(envelope.Window.StartWeek+i) {
			return schemaFail(result, fmt.Sprintf("weekly_docs[%d].week_index", i), "周课表周号必须与生成范围连续对应。")
		}
		if envelope.Type == "weekly_plan_batch" {
			weekName, _ := doc["week_name"].(string)
			weekStart, err := time.Parse("2006-01-02", strings.SplitN(weekName, "_", 2)[0])
			if err != nil || (i > 0 && !weekStart.Equal(previousWeek.AddDate(0, 0, 7))) {
				return schemaFail(result, fmt.Sprintf("weekly_docs[%d].week_name", i), "滚动周课表日期必须按周连续，不能重复。")
			}
			previousWeek = weekStart
		}
	}
	result.Reason = fmt.Sprintf("%s 产物与 %d 份完整周课表均符合契约", envelope.Type, len(envelope.WeeklyDocs))
	return result
}

func schemaFail(result CheckResult, path, message string) CheckResult {
	result.Status = "fail"
	result.Reason = "产物不符合现有契约。"
	result.Detail, _ = json.Marshal(map[string]any{"errors": []map[string]string{{"path": path, "message": message}}})
	return result
}

// schemaMessage flattens a JSON Schema validation error into "path: reason".
func schemaMessage(err error) string {
	var validation *jsonschema.ValidationError
	if !errors.As(err, &validation) {
		return err.Error()
	}
	leaf := validation
	for len(leaf.Causes) > 0 {
		leaf = leaf.Causes[0]
	}
	// A leaf's Error() is "jsonschema validation … at '/instance/path'".
	return leaf.Error()
}

// StaticRuleCheck runs one frozen JavaScript rule (`run(input)`) in an
// isolated interpreter: no host capabilities, a frozen clock and seeded
// randomness, a read-only input and hard time/memory budgets.
type StaticRuleCheck struct {
	CheckID     string
	Version     int
	Source      string
	Timeout     time.Duration
	MemoryLimit int64 // bytes of heap growth this rule may cause; <= 0 disables the guard
}

func (c StaticRuleCheck) ID() string { return c.CheckID }

func (c StaticRuleCheck) Run(ctx context.Context, input CheckInput) CheckResult {
	result := CheckResult{CheckID: c.CheckID, Version: c.Version}
	value, err := runJavaScript(ctx, c.Source, input, c.Timeout, c.MemoryLimit)
	if err != nil {
		return ruleError(result, ruleErrorCode(err), err.Error())
	}
	var verdict struct {
		Status     string          `json:"status"`
		Reason     string          `json:"reason"`
		Violations json.RawMessage `json:"violations"`
		Error      *CheckError     `json:"error"`
	}
	if err := json.Unmarshal(value, &verdict); err != nil {
		return ruleError(result, "rule_result_invalid", "run(input) 的返回值不是合法的 JSON 对象")
	}
	switch verdict.Status {
	case "pass", "fail":
		if len(verdict.Violations) > 0 {
			result.Detail = verdict.Violations
		}
		result.Status, result.Reason = verdict.Status, verdict.Reason
		return result
	case "error":
		if verdict.Error == nil || verdict.Error.Code == "" {
			return ruleError(result, "rule_result_invalid", "error 结果必须带 error.code 与 error.message")
		}
		result.Status, result.Reason, result.Error = "error", verdict.Reason, verdict.Error
		return result
	}
	return ruleError(result, "rule_result_invalid", fmt.Sprintf("status 应为 pass / fail / error，实际为 %q", verdict.Status))
}

func ruleError(result CheckResult, code, message string) CheckResult {
	result.Status = "error"
	result.Error = &CheckError{Code: code, Message: message}
	return result
}

// Error codes a failed rule run is reported under.
const (
	errRuleTimeout             = "rule_timeout"
	errRuleMemory              = "rule_memory_exceeded"
	errRuleSyntax              = "rule_source_invalid"
	errRuleThrew               = "rule_runtime_error"
	errRuleNoEntry             = "rule_entry_missing"
	errRuleBusy                = "rule_busy"
	errRuleResultInvalid       = "rule_result_invalid"
	errRuleInputUnserializable = "rule_input_unserializable"
)

// ruleError is the sentinel family runJavaScript fails with; the code tells a
// broken rule (author's fault) from an overload (ours).
type ruleRunError struct{ code string }

func (e *ruleRunError) Error() string { return e.code }

func ruleErrorCode(err error) string {
	var re *ruleRunError
	if errors.As(err, &re) {
		return re.code
	}
	return errRuleThrew
}

// bootstrap runs before every rule in a fresh interpreter: it pins the clock
// to the frozen instant, seeds Math.random and returns the input deep-frozen
// and bound to nothing global — it reaches the rule as run()'s argument.
const ruleBootstrap = `
(function () {
  var AS_OF = __asOf;
  var inputJSON = __inputJSON;
  var RealDate = Date;
  function FrozenDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof FrozenDate)) { return new RealDate(AS_OF).toString(); }
    return args.length === 0 ? new RealDate(AS_OF) : new (RealDate.bind.apply(RealDate, [null].concat(args)))();
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = function () { return AS_OF; };
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  Object.defineProperty(globalThis, "Date", { value: FrozenDate, writable: false, configurable: false });

  var seed = 0x9e3779b9 >>> 0;
  function seededRandom() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    var t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  Object.defineProperty(Math, "random", { value: seededRandom, writable: false, configurable: false });
  Object.freeze(Math);

  function deepFreeze(node) {
    if (node && typeof node === "object" && !Object.isFrozen(node)) {
      Object.freeze(node);
      Object.keys(node).forEach(function (key) { deepFreeze(node[key]); });
    }
    return node;
  }
  delete globalThis.__inputJSON;
  delete globalThis.__asOf;
  return deepFreeze(JSON.parse(inputJSON));
})();
`

// Only one rule may prepare input or measure shared heap growth at a time.
// The worker owns the slot until it exits, even when native work outlasts the
// caller's deadline.
var ruleRuntimeSlot = make(chan struct{}, 1)

// runJavaScript evaluates the rule program and calls its `run` with the frozen
// input, returning run's result as JSON.
func runJavaScript(ctx context.Context, source string, input CheckInput, timeout time.Duration, memoryLimit int64) ([]byte, error) {
	if ctx.Err() != nil {
		return nil, &ruleRunError{code: errRuleBusy}
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if len(input.Artifact)+len(input.Snapshot)+len(input.Scenario.Request)+len(input.Scenario.ScenarioID)+len(input.AsOf) > maxRuleInputBytes {
		return nil, &ruleRunError{code: errRuleInputInvalid}
	}
	asOfMs, err := instantMillis(input.AsOf)
	if err != nil {
		return nil, &ruleRunError{code: errRuleInputInvalid}
	}
	select {
	case ruleRuntimeSlot <- struct{}{}:
	case <-runCtx.Done():
		return nil, ruleContextError(ctx, runCtx)
	}
	type outcome struct {
		value json.RawMessage
		err   error
	}
	done := make(chan outcome, 1)
	go func() {
		defer func() { <-ruleRuntimeSlot }()
		if err := ruleContextError(ctx, runCtx); err != nil {
			done <- outcome{err: err}
			return
		}
		inputJSON, err := json.Marshal(input)
		if err != nil {
			done <- outcome{err: fmt.Errorf("%w: %v", &ruleRunError{code: errRuleInputUnserializable}, err)}
			return
		}
		if len(inputJSON) > maxRuleInputBytes {
			done <- outcome{err: &ruleRunError{code: errRuleInputInvalid}}
			return
		}
		value, err := runJavaScriptSync(runCtx, source, inputJSON, asOfMs, memoryLimit)
		done <- outcome{value: value, err: err}
	}()
	select {
	case out := <-done:
		if err := ruleContextError(ctx, runCtx); err != nil {
			return nil, err
		}
		return out.value, out.err
	case <-runCtx.Done():
		return nil, ruleContextError(ctx, runCtx)
	}
}

func ruleContextError(parent, runCtx context.Context) error {
	if parent.Err() != nil {
		return &ruleRunError{code: errRuleBusy}
	}
	return ruleRunContextError(runCtx)
}

func ruleRunContextError(ctx context.Context) error {
	switch ctx.Err() {
	case nil:
		return nil
	case context.DeadlineExceeded:
		return &ruleRunError{code: errRuleTimeout}
	default:
		return &ruleRunError{code: errRuleBusy}
	}
}

func runJavaScriptSync(ctx context.Context, source string, inputJSON []byte, asOfMs int64, memoryLimit int64) (json.RawMessage, error) {
	if err := ruleRunContextError(ctx); err != nil {
		return nil, err
	}
	vm := goja.New()
	// One deadline covers both trusted preparation and rule execution.
	stop := make(chan struct{})
	var once atomic.Bool
	interrupt := func(reason string) {
		if once.CompareAndSwap(false, true) {
			vm.Interrupt(reason)
		}
	}
	stopInterrupt := context.AfterFunc(ctx, func() { interrupt(errRuleTimeout) })

	defer func() {
		close(stop)
		stopInterrupt()
	}()

	if err := vm.Set("__inputJSON", string(inputJSON)); err != nil {
		return nil, fmt.Errorf("rule runtime: %w", err)
	}
	if err := vm.Set("__asOf", asOfMs); err != nil {
		return nil, fmt.Errorf("rule runtime: %w", err)
	}
	frozenInput, err := vm.RunString(ruleBootstrap)
	if err != nil {
		return nil, ruleFailure(err)
	}
	if err := ruleRunContextError(ctx); err != nil {
		return nil, err
	}
	// Only trusted bootstrap has run. Collect its temporary objects before
	// measuring rule growth, so their reclamation cannot credit the rule.
	if memoryLimit > 0 {
		runtime.GC()
		if err := ruleRunContextError(ctx); err != nil {
			return nil, err
		}
	}
	var memStats runtime.MemStats
	if memoryLimit > 0 {
		runtime.ReadMemStats(&memStats)
	}
	baseline := memStats.HeapAlloc
	if memoryLimit > 0 {
		go func() {
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case <-ticker.C:
					var current runtime.MemStats
					runtime.ReadMemStats(&current)
					if int64(current.HeapAlloc) > int64(baseline)+memoryLimit {
						interrupt(errRuleMemory)
						return
					}
				}
			}
		}()
	}
	program, err := goja.Compile("rule", source, false)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", &ruleRunError{code: errRuleSyntax}, err)
	}
	if _, err := vm.RunProgram(program); err != nil {
		return nil, ruleFailure(err)
	}
	entry, ok := goja.AssertFunction(vm.Get("run"))
	if !ok {
		return nil, &ruleRunError{code: errRuleNoEntry}
	}
	value, err := entry(goja.Undefined(), frozenInput)
	if err != nil {
		return nil, ruleFailure(err)
	}
	if err := ruleRunContextError(ctx); err != nil {
		return nil, err
	}
	exported := value.Export()
	encoded, err := json.Marshal(exported)
	if err != nil {
		return nil, &ruleRunError{code: errRuleResultInvalid}
	}
	return encoded, nil
}

// ruleFailure maps an interpreter failure to a code: our interrupts are
// budget outcomes, anything else is the rule throwing.
func ruleFailure(err error) error {
	if strings.Contains(err.Error(), errRuleTimeout) {
		return fmt.Errorf("%w: exceeded %s", &ruleRunError{code: errRuleTimeout}, "the time budget")
	}
	if strings.Contains(err.Error(), errRuleMemory) {
		return fmt.Errorf("%w: exceeded the memory budget", &ruleRunError{code: errRuleMemory})
	}
	return fmt.Errorf("%w: %v", &ruleRunError{code: errRuleThrew}, err)
}

func instantMillis(asOf string) (int64, error) {
	instant, err := time.Parse(time.RFC3339Nano, asOf)
	if err != nil {
		return 0, fmt.Errorf("%w: as_of %q is not an ISO 8601 instant", &ruleRunError{code: errRuleInputInvalid}, asOf)
	}
	return instant.UnixMilli(), nil
}

// errRuleInputInvalid marks a frozen input the rule runtime cannot present.
const errRuleInputInvalid = "rule_input_invalid"
