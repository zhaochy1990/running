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

/**
 * workout_manage 边界样本锁定（devops#697 验收，对齐 #669 验收第 4 条）：删/挪是
 * workout_manage；改内容（含改期+改内容混合）仍归 custom_workout；周计划调整仍走
 * weekly_plan——intent 误路由是本功能第一风险。
 */
test("orchestrator prompt carries the workout_manage category and its boundary samples", () => {
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"workout_manage"：**删除**或**改期**一节已保存的训练课'));

  // 例句本身 → workout_manage。
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"把明天的课删了" → workout_manage'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"今天训练挪到周五" → workout_manage'));

  // 误路由守卫：改内容与混合请求归 custom_workout，周计划调整仍走 weekly_plan。
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"把这节课改成 12 分钟 3 组" → custom_workout（改课表内容，不是 workout_manage）'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"改成后天 12 分钟 3 组" → custom_workout（改期+改内容的混合请求，归 custom_workout）'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"下周计划调整一下，周三改成休息" → weekly_plan'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes("对已保存的课只动存废或日期是 workout_manage"));
});

/**
 * 赛事问答路由边界锁定（devops#812 验收）：QA 拿到赛历检索工具后，事实问
 * （时间/城市/项目/赛道）必须落 training_question 进 qa；只有问执行方案（配速
 * 分段/补给）才是 race_strategy——qa 会话无 race target，误路由到 race_strategy
 * 会被弹回「从赛事详情页发起」，事实问题就答不上来。
 */
test("orchestrator prompt routes race-fact questions to training_question, not race_strategy", () => {
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes("**查询赛事日历信息**"));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes("问赛事事实（时间/城市/项目/赛道/爬升）是 training_question"));

  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"杭州马拉松什么时候开跑？" → training_question'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"11 月有哪些马拉松？" → training_question'));
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"杭马的赛道难不难？" → training_question'));

  // 守卫：策略例句仍锁在 race_strategy，划界句没被顺带改掉。
  assert.ok(ORCHESTRATOR_INTENT_PROMPT.includes('"帮我制定杭马的分段配速和补给策略" → race_strategy'));
});
