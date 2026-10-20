import assert from "node:assert/strict";
import test from "node:test";
import { ORCHESTRATOR_INTENT_PROMPT } from "../orchestrator.js";

/**
 * 意图边界路由样本锁定（devops#587 验收）：分类是 LLM 行为，单测能钉住的是
 * 提示里的类别定义与正反例样本——尤其 custom_workout 与 training_question /
 * weekly_plan 的边界（"明天跑什么"仍走问答，调整周计划仍走 weekly_plan）。
 */
test("orchestrator prompt carries the custom_workout category and its boundary samples", () => {
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"custom_workout"：创建一次具体的训练课'));

  // 例句本身 → custom_workout。
  assert.ok(
    ORCHESTRATOR_INTENT_PROMPT.includes(
      '"我明天想跑3组4km，每个4k配速350-400，组间休息3分钟，第三个4k跑完接着跑6个400m，配速325-335，组间休息90秒" → custom_workout',
    ),
  );

  // 无结构的建课意图与追问短答也是 custom_workout（10-20 生产误路由实证：
  // 「帮我生成单次训练课程」「配速430」曾掉进 qa 出纯文本课表）。
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"帮我生成单次训练课程" → custom_workout'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"配速430" → custom_workout'));

  // 误路由守卫：提问仍是问答，调整周计划仍是 weekly_plan，都不是 custom_workout。
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"明天跑什么？" → training_question'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"下周计划调整一下，周三改成休息" → weekly_plan'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes("调整周计划里的某一天仍是 weekly_plan"));
});
