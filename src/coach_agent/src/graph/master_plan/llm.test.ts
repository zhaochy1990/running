import assert from "node:assert/strict";
import test from "node:test";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { sanitizeJsonSchema } from "@stride/common";
import { MasterPlanLenientSchema } from "@stride/contract";
import type { ModelConfig } from "../../config/config.js";
import { createMasterPlanLlmModels } from "./llm/models.js";
import { goalAssessmentPrompt, reviewPrompt, skeletonPrompt, strategyPrompt } from "./llm/prompts.js";

/** 收集「anyOf 的分支本身是裸 anyOf（无 type）」的路径 —— DeepSeek 400
 * missing field type 的触发形状（#614 现场复现判据）。 */
function nestedAnyOfPaths(node: unknown, path = "$", found: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((item, index) => nestedAnyOfPaths(item, `${path}[${index}]`, found));
  } else if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.anyOf)) {
      record.anyOf.forEach((branch, index) => {
        if (branch && typeof branch === "object" && !Array.isArray(branch) && !("type" in branch) && Array.isArray((branch as Record<string, unknown>).anyOf))
          found.push(`${path}.anyOf[${index}]`);
        nestedAnyOfPaths(branch, `${path}.anyOf[${index}]`, found);
      });
    }
    for (const [key, value] of Object.entries(record)) if (key !== "anyOf") nestedAnyOfPaths(value, `${path}.${key}`, found);
  }
  return found;
}

/** 展开 "a.b" 形式的属性路径（数组下标也是路径段；$ 代表根）。 */
function digPath(node: unknown, path: string): unknown {
  return path
    .replace(/^\$\.?/, "")
    .split(".")
    .reduce((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), node);
}

const WORKOUT_STRUCTURE_PATH = "$.properties.weeks.items.properties.key_sessions.items.properties.workout_structure";
const REST_PATH = `${WORKOUT_STRUCTURE_PATH}.anyOf.0.properties.blocks.items.properties.steps.items.properties.rest`;

// #614：expandSkeleton 的 MasterPlanLenientSchema 发线后被 DeepSeek 400 拒——
// zod 对 union 再套 nullish 的属性（steps.rest 等）产出 anyOf 内嵌 anyOf。
// 现场复现：真实 schema 过真实净化管线，锁定嵌套位置与拍平后的等价形状。
test("master lenient wire schema carries no anyOf branch that is itself an anyOf (#614)", () => {
  const raw = { ...toJsonSchema(MasterPlanLenientSchema) } as Record<string, unknown>;
  delete raw["~standard"];

  // 发线前（#614 现场）：zod 对 union 再套 nullish 的属性产出裸 oneOf 节点作 anyOf 分支
  // （steps.rest 即此形状；workout_structure 子树共 8 处这类属性级包裹），旧管线
  // renameOneOf 把它转成 anyOf 后即 anyOf 内嵌 anyOf —— DeepSeek 400 missing field type。
  const rawRest = digPath(raw, REST_PATH) as { anyOf: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(rawRest.anyOf));
  const rawInner = rawRest.anyOf[0];
  assert.ok(
    rawInner && !("type" in rawInner) && Array.isArray(rawInner.oneOf),
    "expected the bare oneOf branch that the old sanitizer turned into nested anyOf",
  );

  const wire = sanitizeJsonSchema(raw) as Record<string, unknown>;
  assert.deepEqual(nestedAnyOfPaths(wire), [], "sanitized wire schema must not nest anyOf inside anyOf");

  // 拍平是等价改写：rest 仍是同一组 StepRest 分支 + null（time_s/hr_bpm、manual、null），
  // 属性级 anyOf 包裹（DeepSeek 已接受，goal assessment 阶段线上验证过）不受影响。
  const rest = digPath(wire, REST_PATH) as { anyOf: Array<Record<string, unknown>> };
  const kindOf = (branch: Record<string, unknown>): unknown => {
    if (branch.type === "null") return "null";
    const kind = (branch.properties as Record<string, unknown> | undefined)?.kind as Record<string, unknown> | undefined;
    return kind?.enum ?? kind?.const;
  };
  assert.deepEqual(rest.anyOf.map(kindOf), [["time_s", "hr_bpm"], "manual", "null"]);
});

const MODEL: ModelConfig = {
  name: "test-responses",
  model: "test-model",
  endpoint: "http://127.0.0.1:1/v1",
  api_kind: "responses",
  api_key_env: "COACH_AGENT_TEST_API_KEY",
  max_tokens: 1024,
  timeout_s: 1,
};

test("createMasterPlanLlmModels loads every graph model without invoking an LLM", async () => {
  const models = await createMasterPlanLlmModels({
    masterPlanModel: MODEL,
    reviewerModel: MODEL,
  });

  assert.deepEqual(Object.keys(models).sort(), ["goalAssessmentModel", "judgmentModel", "reviewModel", "skeletonModel", "strategyModel"]);
  for (const model of Object.values(models)) {
    assert.equal(typeof model.invoke, "function");
  }
});

test("prompt builders keep runtime data in user messages", () => {
  const input = {
    request: { id: "request" },
    facts: { id: "facts" },
    snapshot: { id: "snapshot" },
  };
  const goalMessages = goalAssessmentPrompt(input);

  assert.equal(goalMessages[0]?.[0], "system");
  assert.deepEqual(JSON.parse(goalMessages[1]?.[1] ?? ""), {
    task: "Assess the confirmed race goal against the athlete capability facts",
    request: input.request,
    assessment_facts: input.facts,
    snapshot: input.snapshot,
  });
});

test("prompt builders append doctrine and review rubrics to system messages", () => {
  const input = { id: "input" };
  const strategyMessages = strategyPrompt(input, "DOCTRINE");
  const reviewMessages = reviewPrompt(input, "RUBRIC");

  assert.match(strategyMessages[0]?.[1] ?? "", /\n\nDOCTRINE$/);
  assert.match(reviewMessages[0]?.[1] ?? "", /\n\nRUBRIC$/);
  assert.equal(strategyMessages[1]?.[1], JSON.stringify(input));
  assert.equal(reviewMessages[1]?.[1], JSON.stringify(input));
});

test("skeleton prompt encodes step_kind doctrine (#808): no per-step rest field, paced slow segments are work", () => {
  const [system] = skeletonPrompt({ id: "input" }, "");
  const text = String(system?.[1]);
  assert.ok(text.includes("never use the per-step rest field"));
  assert.ok(text.includes("is a work step at easy pace, not recovery"));
});
