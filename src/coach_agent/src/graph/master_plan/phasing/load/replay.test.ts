import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLoadPlan } from "./expand.js";
import { buildCaseContext, listLoadCases } from "./fixtureLoader.js";

/**
 * 38 案例 fixture 回放（devops#793 G 节验收）：三运动员 × 12 跑道
 * （短 5-9 周 / 中 10-16 / 长 22-26，含伤退/改期），冻结 L2 真实产出 +
 * 展开器期望周骨架（golden）。层间解耦：L2 改动不惊动本层回放；
 * 六条验收门全绿 + 周骨架逐字段精确一致（确定性构造，无容差）。
 */
test("38 案例 fixture 回放：六门全绿 + golden 精确一致", async () => {
  const cases = await listLoadCases();
  assert.equal(cases.length, 38, `案例数 ${cases.length}`);
  const perAthlete = new Map<string, number>();
  for (const c of cases) {
    const ctx = await buildCaseContext(c.athlete, c.injury);
    const plan = buildLoadPlan({ intent: c.intent, runwayWeeks: c.runwayWeeks, baseline: ctx.baseline, recentWeeksKm: ctx.recentWeeksKm });
    const failed = plan.checks.filter((x) => !x.pass).map((x) => `${x.id}:${x.detail}`);
    assert.deepEqual(failed, [], `${c.athlete}/${c.scenario} 门挂`);
    assert.deepEqual(plan.weeks, c.expected, `${c.athlete}/${c.scenario} golden 漂移`);
    assert.equal(plan.weeks.length, c.runwayWeeks);
    perAthlete.set(c.athlete, (perAthlete.get(c.athlete) ?? 0) + 1);
  }
  // chaoyi 14（含 ext26 改期 + injury 伤退）、dingchentao 12、pan 12
  assert.deepEqual([...perAthlete.entries()].sort(), [
    ["chaoyi", 14],
    ["dingchentao", 12],
    ["pan", 12],
  ]);
});

test("政策面产出物常量在位：回补三场景 + 力量/强度家族五阶段 + 里程碑对齐", async () => {
  const cases = await listLoadCases();
  const c = cases.find((x) => x.athlete === "chaoyi" && x.scenario === "24")!;
  const ctx = await buildCaseContext(c.athlete, c.injury);
  const plan = buildLoadPlan({ intent: c.intent, runwayWeeks: c.runwayWeeks, baseline: ctx.baseline, recentWeeksKm: ctx.recentWeeksKm });
  assert.deepEqual(
    plan.recovery_policy.map((s) => s.id),
    ["normal", "fatigue", "overshoot"],
  );
  assert.equal(plan.strength_policy.length, 5);
  assert.ok(plan.milestones.length >= 1 && plan.milestones.every((m) => m.week >= 1 && m.week <= c.runwayWeeks));
});
