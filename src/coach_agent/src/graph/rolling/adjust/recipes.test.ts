import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskReason } from "../detect/detector.js";
import { recipeFor } from "./recipes.js";

/**
 * 配方引擎表驱动单测（#858 PR-C）：五条 supported 原因的投影参数与 guidance
 * 语义（票面定稿逐字落），injured unsupported → 抛错给调用方。
 */

test("recipeFor：五条 supported 配方表（参数 + guidance 逐字）", () => {
  assert.deepEqual(pick(recipeFor("pace_unmet")), {
    reason: "pace_unmet",
    vdotShift: -1,
    guidance: "配速按最新状态放缓一档；强度课降档：I 课改 T 或缩组；量不变；动作重复不进阶",
  });
  assert.deepEqual(pick(recipeFor("volume_unmet")), {
    reason: "volume_unmet",
    guidance: "量回退到实际承受位；质量课保 2 节但内容减一档（组数-1）；长跑回退",
  });
  assert.deepEqual(pick(recipeFor("no_time")), {
    reason: "no_time",
    qualityCap: 1,
    guidance: "保 1 节质量课+长跑；E 量先砍；坚决不追补落下的公里数",
  });
  assert.deepEqual(pick(recipeFor("ran_other")), {
    reason: "ran_other",
    guidance: "用户自行完成的训练（比赛/团练/自练间歇）当作已完成的训练吸收，不补课不叠加；后续绕开；大课后加恢复偏置",
  });
  assert.deepEqual(pick(recipeFor("over_delivered")), {
    reason: "over_delivered",
    kmDerateFirstWeek: 0.75,
    guidance: "下周降载消化（×0.75），质量课量减半恢复",
  });
});

test("recipeFor：每条配方 guidance 非空且参数取值域合法", () => {
  const reasons: AskReason[] = ["pace_unmet", "volume_unmet", "no_time", "ran_other", "over_delivered"];
  for (const reason of reasons) {
    const recipe = recipeFor(reason);
    assert.equal(recipe.reason, reason);
    assert.ok(recipe.guidance.length >= 10, `${reason} guidance 要写实配方语义`);
    if (recipe.vdotShift !== undefined) assert.ok(recipe.vdotShift < 0, `${reason} vdotShift 只允许放缓（负值）`);
    if (recipe.qualityCap !== undefined) assert.ok(recipe.qualityCap === 1 || recipe.qualityCap === 2);
    if (recipe.kmDerateFirstWeek !== undefined) assert.ok(recipe.kmDerateFirstWeek > 0 && recipe.kmDerateFirstWeek < 1);
  }
});

test("recipeFor：injured unsupported → 抛错（PR-D 伤病模式接管，不静默）", () => {
  assert.throws(() => recipeFor("injured"), /injured/);
});

/** 表断言用：保留声明的键（undefined 的可选键剥掉，deepEqual 严格比）。 */
function pick(recipe: ReturnType<typeof recipeFor>) {
  const { reason, guidance, ...numeric } = recipe;
  const trimmed: Record<string, unknown> = { reason, guidance };
  for (const [key, value] of Object.entries(numeric)) if (value !== undefined) trimmed[key] = value;
  return trimmed;
}
