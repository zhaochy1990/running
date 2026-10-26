import assert from "node:assert/strict";
import { test } from "node:test";
import type { PhasingIntentInput } from "./doctrine.js";
import { tableFallback } from "./fallback.js";
import { generatePhaseDivisionIntent, type PhasingModel } from "./generate.js";
import { PhaseDivisionIntentSchema } from "./intent.js";
import { makeEvidence, makeIntent } from "./testSupport.js";

function makeInput(runwayWeeks = 22, lastRaceDaysAgo = 36): PhasingIntentInput {
  return {
    evidence: makeEvidence({ last_race: { date: "2026-09-20", distance_km: 35, days_ago: lastRaceDaysAgo } }),
    runwayWeeks,
    raceDate: "2027-03-28",
  };
}

function fakeModel(scripts: Array<(input: PhasingIntentInput, retry?: { violations: string[] }) => unknown>): PhasingModel & { calls: unknown[][] } {
  if (scripts.length === 0) throw new Error("fakeModel requires at least one script");
  const calls: unknown[][] = [];
  let i = 0;
  return {
    calls,
    async invoke(input, retry) {
      calls.push([input.runwayWeeks, retry?.violations ?? null]);
      const script = scripts[Math.min(i, scripts.length - 1)] ?? scripts.at(-1);
      if (!script) throw new Error("fakeModel script missing");
      i++;
      return script(input, retry) as never;
    },
  };
}

test("一次通过：source=llm、attempts=1、终检全绿", async () => {
  const model = fakeModel([() => makeIntent({})]);
  const outcome = await generatePhaseDivisionIntent(makeInput(), model);
  assert.equal(outcome.source, "llm");
  assert.equal(outcome.attempts, 1);
  assert.ok(outcome.checks.every((c) => c.pass));
  assert.equal(model.calls.length, 1);
});

test("首版违规 → 携带违规清单重试 → 二版通过（attempts=2）", async () => {
  const model = fakeModel([
    () => makeIntent({ phases: makeIntent({}).phases.map((p) => (p.canonical === "foundation" ? { ...p, end_week: p.end_week - 2 } : p)) }),
    () => makeIntent({}),
  ]);
  const outcome = await generatePhaseDivisionIntent(makeInput(), model);
  assert.equal(outcome.source, "llm");
  assert.equal(outcome.attempts, 2);
  // 第二次调用收到首版的违规清单（I1 闭合失败）
  const retryViolations = model.calls[1]?.[1] as string[] | null;
  assert.ok(Array.isArray(retryViolations) && retryViolations.some((v) => v.includes("I1")));
});

test("持续违规耗尽重试 → 落 T 兜底且兜底自身全绿", async () => {
  const model = fakeModel([
    () =>
      makeIntent({ taperWeeks: 1, phases: makeIntent({}).phases.map((p) => (p.canonical === "final_quality" ? { ...p, block_mode: "light" as const } : p)) }),
  ]);
  const input = makeInput();
  const outcome = await generatePhaseDivisionIntent(input, model);
  assert.equal(outcome.source, "fallback");
  assert.equal(outcome.attempts, 3); // 1 次首试 + 2 次重试
  assert.ok(outcome.checks.every((c) => c.pass));
  assert.deepEqual(outcome.intent, tableFallback(input.evidence, input.runwayWeeks));
});

test("模型调用抛异常 → 消耗尝试次数 → 兜底", async () => {
  const model = fakeModel([
    () => {
      throw new Error("boom");
    },
  ]);
  const outcome = await generatePhaseDivisionIntent(makeInput(), model);
  assert.equal(outcome.source, "fallback");
  assert.equal(outcome.attempts, 3);
  assert.ok(outcome.checks.every((c) => c.pass));
});

test("重试后仍抛异常 → 兜底（异常与违规共享尝试预算）", async () => {
  let i = 0;
  const model: PhasingModel = {
    async invoke() {
      i++;
      if (i === 1) throw new Error("network");
      return makeIntent({ taperWeeks: 4 as never }); // schema 非法 → parse 抛异常
    },
  };
  const outcome = await generatePhaseDivisionIntent(makeInput(), model);
  assert.equal(outcome.source, "fallback");
});

test("契约层拒绝的输出（schema parse 抛错）同样计入重试预算后兜底", async () => {
  const model = fakeModel([
    () => {
      // PhasingModel 契约=返回已过 IntentSchema 的对象；taper_weeks=4 在 parse 即被拒
      return PhaseDivisionIntentSchema.parse({ ...makeIntent({}), taper_weeks: 4 });
    },
  ]);
  const outcome = await generatePhaseDivisionIntent(makeInput(), model);
  assert.equal(outcome.source, "fallback");
  assert.equal(outcome.attempts, 3);
});
