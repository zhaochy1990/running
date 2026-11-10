import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ModelConfig } from "../config/config.js";
import type { DataProvider } from "../data/dataProvider.js";
import { CoachContext } from "./coachAgent.js";
import { getMasterPlanGeneratorParts, getMasterPlanSubagent } from "./master_plan/agent.js";
import { createPlanPassthroughMiddleware, getMasterPlanTaskResult } from "./masterPlanPassthrough.js";
import { MASTER_PLAN_PROMPT, WeeklyPlanPrompt } from "./prompts.js";
import { getQaTools } from "./qa/agent.js";
import { getCoachSubagent } from "./weekly_plan/agent.js";

const TEST_API_KEY_ENV = "COACH_AGENT_TEST_API_KEY";
const previousTestApiKey = process.env[TEST_API_KEY_ENV];
process.env[TEST_API_KEY_ENV] = "test-key";
after(() => {
  if (previousTestApiKey === undefined) delete process.env[TEST_API_KEY_ENV];
  else process.env[TEST_API_KEY_ENV] = previousTestApiKey;
});

const modelConfig: ModelConfig = {
  name: "test",
  model: "test-model",
  endpoint: "http://127.0.0.1:1",
  api_kind: "responses",
  api_key_env: TEST_API_KEY_ENV,
  max_tokens: 100,
  timeout_s: 1,
};

test("master-plan skills are present in the compiled virtual filesystem root", async () => {
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
  await Promise.all([access(join(skillsDir, "analyze-race", "SKILL.md")), access(join(skillsDir, "generate-master-plan", "SKILL.md"))]);
});

test("master-plan prompt gates athlete data behind a complete race goal", () => {
  assert.match(MASTER_PLAN_PROMPT, /先调用一次 get_master_plan_context/);
  assert.match(MASTER_PLAN_PROMPT, /race_target 为 null/);
  assert.match(MASTER_PLAN_PROMPT, /不要生成计划/);
});

test("coach context requires a strict Shanghai asof day", () => {
  assert.deepEqual(CoachContext.parse({ userId: "athlete", asof: "2026-05-01" }), {
    userId: "athlete",
    asof: "2026-05-01",
  });
  assert.throws(() => CoachContext.parse({ userId: "athlete" }));
  assert.throws(() => CoachContext.parse({ userId: "athlete", asof: "2026-05-01T00:00:00Z" }));
  assert.throws(() => CoachContext.parse({ userId: "athlete", asof: "2026-02-30" }));
});

test("master-plan generator inlines the skill and skips the deterministic gate", () => {
  assert.match(MASTER_PLAN_PROMPT, /结构化输出/);
  const store = {} as DataProvider;
  const parts = getMasterPlanGeneratorParts(store);
  const reader = getMasterPlanSubagent(store, modelConfig);
  const toolNames = parts.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("get_master_plan"));
  assert.ok(toolNames.includes("get_master_plan_context"));
  assert.ok(!toolNames.includes("get_current_time"));
  // 追问走普通文本：内层 agent 无 checkpointer，interrupt 不成立
  assert.ok(!toolNames.includes("ask_user_question"));
  // 技能文档（丹尼尔斯体系）内联进系统提示——deepagents FilesystemBackend 已不存在
  assert.match(parts.systemPrompt, /丹尼尔斯/);
  // 确定性校验中间件停用（临时）：宽松 schema 信封 + 不挂 MasterPlanValidationMiddleware
  assert.ok(parts.middleware.every((middleware) => middleware.name !== "MasterPlanValidationMiddleware"));
  assert.ok(reader.tools.length > 0, "只读视图保留自己的工具面");
});

// #858 PR-F：聊天侧周课生成路径（generate_weekly_plan subagent + 直出
// responseFormat + /generate-weekly-plan/ skill）退役——周课统一由 master 首批
// 物化 + 滚动投影产出，weekly_plan 只剩读/讲解 subagent（工具集不动）。
test("weekly-plan subagent is read-only with the rolling-guidance prompt", () => {
  const store = {} as DataProvider;
  const reader = getCoachSubagent(store, modelConfig);
  const names = reader.tools.map((tool) => tool.name);
  assert.ok(names.includes("get_weekly_plan_context"));
  assert.ok(names.includes("get_weekly_plan"));
  assert.ok(!names.includes("get_current_time"));
  assert.ok(!reader.tools.some((tool) => tool.name === "simulate_weekly_plan_load"));
  assert.equal(reader.name, "weekly_plan");
  assert.ok(!("responseFormat" in reader), "读 subagent 不再挂直出 responseFormat");
  assert.ok(reader.middleware.every((middleware) => middleware.name !== "WeeklyPlanLoadSimulationMiddleware"));
  // 新提示：读周行讲解 + 无计划引导建赛季计划（滚动机制说明）
  assert.match(WeeklyPlanPrompt, /get_weekly_plan/);
  assert.match(WeeklyPlanPrompt, /coach_notes/);
  assert.match(WeeklyPlanPrompt, /phase_goal/);
  assert.match(WeeklyPlanPrompt, /先建赛季训练计划/);
  assert.match(WeeklyPlanPrompt, /自动生成下一块/);
  assert.doesNotMatch(WeeklyPlanPrompt, /generate-weekly-plan/);
});

const masterPlan = {
  status: "draft" as const,
  goal: {
    race_name: "测试马拉松",
    distance: "FM" as const,
    race_date: "2026-10-18",
    target_time: "2:50:00",
    timezone: "Asia/Shanghai" as const,
    location: "西安",
  },
  start_date: "2026-08-10",
  end_date: "2026-10-18",
  total_weeks: 1,
  phases: [
    {
      name: "base" as const,
      start_date: "2026-08-10",
      end_date: "2026-10-18",
      focus: "基础",
      weekly_distance_km_low: 70,
      weekly_distance_km_high: 80,
      key_session_types: ["长跑"],
      milestones: [],
      key_workouts: "长跑",
      monitoring_triggers: ["疼痛"],
      coach_note: "注意恢复",
      strength: { sessions_per_week: 2, focus: "核心", timing: "轻松跑后" },
      recovery: {
        focus: "睡眠和补给",
        sleep_target_hours: "7-9",
        adjustment_trigger: "疼痛降量",
      },
      is_completed: false,
      summary: null,
    },
  ],
  weeks: [
    {
      week_index: 1,
      week_start: "2026-08-10",
      phase_name: "base" as const,
      target_weekly_km_low: 70,
      target_weekly_km_high: 80,
      key_sessions: [],
      is_recovery_week: false,
    },
  ],
  training_principles: ["循序渐进"],
  generated_by: "coach_agent" as const,
  version: 1 as const,
  created_at: "2026-08-09T00:00:00Z",
  updated_at: "2026-08-09T00:00:00Z",
};

const weeklyPlan = {
  schema: "weekly-plan/v1" as const,
  week_name: "2026-06-15_06-21",
  sessions: [],
  nutrition: [],
  notes_md: null,
  coach_notes: null,
};

function directResponse(content: unknown): string {
  return JSON.stringify({ disposition: "return_direct", content });
}

test("orchestrator extracts a validated master plan from its direct envelope", () => {
  const content = JSON.stringify(masterPlan);
  const result = getMasterPlanTaskResult([
    {
      type: "ai",
      tool_calls: [
        {
          id: "task-1",
          name: "task",
          args: { subagent_type: "generate_master_plan" },
        },
      ],
    },
    {
      type: "tool",
      name: "task",
      tool_call_id: "task-1",
      content: directResponse(masterPlan),
    },
  ]);

  assert.equal(result, content);
});

// #858 PR-F：generate_weekly_plan 直出信封分支已退役——退役后该 subagent 的
// task 结果不再被 passthrough 识别，必须回落模型（不能凭周课信封直出）。
test("orchestrator does not bypass the model for a retired weekly-plan task result", () => {
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [{ id: "task-1", name: "task", args: { subagent_type: "generate_weekly_plan" } }],
      },
      {
        type: "tool",
        name: "task",
        tool_call_id: "task-1",
        content: directResponse(weeklyPlan),
      },
    ]),
    undefined,
  );
});

test("passthrough middleware skips the model only for a direct envelope", async () => {
  const middleware = createPlanPassthroughMiddleware();
  const wrapModelCall = middleware.wrapModelCall;
  assert.ok(wrapModelCall);

  let handlerCalls = 0;
  const fallback = new AIMessage("fallback");
  const handler = async () => {
    handlerCalls += 1;
    return fallback;
  };
  const taskCall = new AIMessage({
    content: "",
    tool_calls: [
      {
        id: "task-1",
        name: "task",
        args: { subagent_type: "generate_master_plan" },
        type: "tool_call",
      },
    ],
  });
  const runtime = { context: { asof: "2026-06-10" } } as never;
  const direct = await wrapModelCall(
    {
      messages: [
        taskCall,
        new ToolMessage({
          content: directResponse(masterPlan),
          tool_call_id: "task-1",
        }),
      ],
      runtime,
    } as never,
    handler,
  );
  assert.equal(handlerCalls, 0);
  assert.ok(AIMessage.isInstance(direct));
  assert.equal(direct.content, JSON.stringify(masterPlan));

  // 退役后的 generate_weekly_plan task 结果不再直出，回落模型（#858 PR-F）
  const retiredWeeklyCall = new AIMessage({
    content: "",
    tool_calls: [
      {
        id: "weekly-task",
        name: "task",
        args: { subagent_type: "generate_weekly_plan" },
        type: "tool_call",
      },
    ],
  });
  const retiredResult = await wrapModelCall(
    {
      messages: [
        retiredWeeklyCall,
        new ToolMessage({
          content: directResponse(weeklyPlan),
          tool_call_id: "weekly-task",
        }),
      ],
      runtime,
    } as never,
    handler,
  );
  assert.equal(handlerCalls, 1);
  assert.equal(retiredResult, fallback);

  const readerTaskCall = new AIMessage({
    content: "",
    tool_calls: [
      {
        id: "reader-task",
        name: "task",
        args: { subagent_type: "weekly_plan" },
        type: "tool_call",
      },
    ],
  });
  const readerResult = await wrapModelCall(
    {
      messages: [
        readerTaskCall,
        new ToolMessage({
          content: directResponse(weeklyPlan),
          tool_call_id: "reader-task",
        }),
      ],
      runtime,
    } as never,
    handler,
  );
  assert.equal(handlerCalls, 2);
  assert.equal(readerResult, fallback);

  const delegated = await wrapModelCall(
    {
      messages: [
        taskCall,
        new ToolMessage({
          content: JSON.stringify({ disposition: "continue" }),
          tool_call_id: "task-1",
        }),
      ],
      runtime,
    } as never,
    handler,
  );
  assert.equal(handlerCalls, 3);
  assert.equal(delegated, fallback);
});

test("orchestrator forwards the runtime task result when ToolMessage omits name", () => {
  const content = JSON.stringify(masterPlan);
  const result = getMasterPlanTaskResult([
    new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "task-1",
          name: "task",
          args: { subagent_type: "generate_master_plan" },
          type: "tool_call",
        },
      ],
    }),
    new ToolMessage({
      content: directResponse(masterPlan),
      tool_call_id: "task-1",
    }),
  ]);

  assert.equal(result, content);
});

test("orchestrator forwards the envelope content without revalidating it", () => {
  const plan = { ...masterPlan, total_weeks: 2 };
  const content = JSON.stringify(plan);
  const result = getMasterPlanTaskResult([
    {
      type: "ai",
      tool_calls: [
        {
          id: "task-1",
          name: "task",
          args: { subagent_type: "generate_master_plan" },
        },
      ],
    },
    {
      type: "tool",
      tool_call_id: "task-1",
      content: directResponse(plan),
    },
  ]);

  assert.equal(result, content);
});

test("orchestrator does not bypass the model for unrelated or invalid task results", () => {
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [{ id: "task-1", name: "task", args: { subagent_type: "qa" } }],
      },
      {
        type: "tool",
        name: "task",
        tool_call_id: "task-1",
        content: directResponse(masterPlan),
      },
    ]),
    undefined,
  );
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "generate_master_plan" },
          },
        ],
      },
      {
        type: "tool",
        name: "task",
        tool_call_id: "task-1",
        content: "not JSON",
      },
    ]),
    undefined,
  );
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "generate_master_plan" },
          },
        ],
      },
      {
        type: "tool",
        tool_call_id: "task-1",
        content: JSON.stringify({
          disposition: "continue",
          content: masterPlan,
        }),
      },
    ]),
    undefined,
  );
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "generate_master_plan" },
          },
        ],
      },
      {
        type: "tool",
        status: "error",
        tool_call_id: "task-1",
        content: directResponse(masterPlan),
      },
    ]),
    undefined,
  );
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "generate_master_plan" },
          },
        ],
      },
      {
        type: "tool",
        tool_call_id: "task-1",
        content: '{"error":"generation_failed"}',
      },
    ]),
    undefined,
  );
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "generate_master_plan" },
          },
        ],
      },
      {
        type: "tool",
        tool_call_id: "task-1",
        content: JSON.stringify({ disposition: "return_direct" }),
      },
    ]),
    undefined,
  );
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [
          {
            id: "task-1",
            name: "task",
            args: { subagent_type: "generate_master_plan" },
          },
        ],
      },
      {
        type: "tool",
        tool_call_id: "task-1",
        content: JSON.stringify({
          disposition: "return_direct",
          content: [],
        }),
      },
    ]),
    undefined,
  );
});

test("orchestrator only forwards an immediately preceding generator task result", () => {
  const content = JSON.stringify(masterPlan);
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [
          {
            id: "old-task",
            name: "task",
            args: { subagent_type: "generate_master_plan" },
          },
        ],
      },
      { type: "tool", name: "task", tool_call_id: "old-task", content },
      { type: "human", content: "解释一下这个计划" },
    ]),
    undefined,
  );
});

test("orchestrator does not replay a generator result after a later tool call", () => {
  const content = JSON.stringify(masterPlan);
  assert.equal(
    getMasterPlanTaskResult([
      {
        type: "ai",
        tool_calls: [
          {
            id: "generator-task",
            name: "task",
            args: { subagent_type: "generate_master_plan" },
          },
        ],
      },
      { type: "tool", name: "task", tool_call_id: "generator-task", content },
      {
        type: "ai",
        tool_calls: [{ id: "memory", name: "remember_athlete_fact", args: {} }],
      },
      {
        type: "tool",
        name: "remember_athlete_fact",
        tool_call_id: "memory",
        content: "已记住",
      },
    ]),
    undefined,
  );
});

test("all athlete-facing agents expose PB and running-calibration tools", () => {
  const store = {} as DataProvider;
  const coachSubagent = getCoachSubagent(store, modelConfig);
  const masterSubagent = getMasterPlanSubagent(store, modelConfig);
  const toolSets = [
    { name: "qa", tools: getQaTools(store) },
    { name: coachSubagent.name, tools: coachSubagent.tools },
    { name: masterSubagent.name, tools: masterSubagent.tools },
  ];

  for (const { name, tools } of toolSets) {
    const toolNames = tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("get_personal_bests"), `${name} lacks PB tool`);
    assert.ok(toolNames.includes("get_running_calibration"), `${name} lacks calibration tool`);
  }
});
