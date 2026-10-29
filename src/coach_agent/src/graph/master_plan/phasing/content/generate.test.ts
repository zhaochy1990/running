import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentGeneratorInput, ContentWeekRow } from "./doctrine.js";
import { templateFallback } from "./fallback.js";
import { type ContentDraft, ContentDraftSchema, generateWeekContent } from "./generate.js";

/**
 * 生成编排单测（devops#811）：fake model 三路径——首过 / 违规重试后过 /
 * 重试耗尽落兜底（兜底产物必须自身全绿）。真模型回放见 tests/contentReplay.ts。
 */

const ZONES = { easy: [288, 336], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] } as const;
const ROWS: ContentWeekRow[] = [
  { week: 1, phase: "final_quality", role: "progress", totalKm: 60, longRunKm: 21, qualitySessions: 1, qualityFamily: "M 配速比赛专项", zones: ZONES },
  // 赛周行取 L3 契约形（≥42.2+激活带、q=2 比赛课+M 激活，#825）——模板 M 激活课（≈9km）在 45.3 旧骨架下 C1 数学无解
  { week: 2, phase: "final_quality", role: "race", totalKm: 52.2, longRunKm: null, qualitySessions: 2, qualityFamily: "M 配速比赛专项", zones: ZONES },
];
const INPUT: ContentGeneratorInput = {
  rows: ROWS,
  athlete: { weeklyRunDaysMax: 6, weekKm: 60, fitness: { ctl: 60, atl: 55, form: 5 } },
  race: { name: "上海马拉松", date: "2026-11-01", targetTime: "2:50:00", goalPaceSKm: 10200 / 42.195 },
  planStartMonday: "2026-10-19",
};

/** 兜底产物 → draft 形态（date 反解 weekday）：合法输出的机械来源；dropWeeks 砍尾周制造违规。 */
function fallbackAsDraft(input: ContentGeneratorInput, dropWeeks = 0): ContentDraft {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
  const weeks = templateFallback(input).slice(0, input.rows.length - dropWeeks);
  return ContentDraftSchema.parse({
    weeks: weeks.map(({ week, sessions }) => ({
      week_no: week,
      sessions: sessions.map((w) => ({
        day: days[(new Date(`${w.date}T00:00:00Z`).getUTCDay() + 6) % 7],
        name: w.name,
        type: w.type,
        purpose: w.purpose,
        note: w.note,
        blocks: w.blocks,
      })),
    })),
  });
}

test("首过：draft 归一后 C1-C9 全绿 → source=llm attempts=1 attemptsDetail=空", async () => {
  const model = { invoke: async () => fallbackAsDraft(INPUT) };
  const outcome = await generateWeekContent(INPUT, model);
  assert.equal(outcome.source, "llm");
  assert.equal(outcome.attempts, 1);
  assert.deepEqual(outcome.attemptsDetail, []);
  assert.equal(outcome.weeks.length, 2);
  for (const weekChecks of outcome.checks) for (const c of weekChecks) assert.equal(c.pass, true, `${c.id}: ${c.detail}`);
});

test("违规重试：首版缺周 → 带违规清单重试 → 第二版通过（attempts=2）", async () => {
  const calls: unknown[] = [];
  const model = {
    invoke: async (_input: unknown, retry?: { violations: string[] }) => {
      calls.push(retry);
      return retry == null ? fallbackAsDraft(INPUT, 1) : fallbackAsDraft(INPUT);
    },
  };
  const outcome = await generateWeekContent(INPUT, model);
  assert.equal(outcome.source, "llm");
  assert.equal(outcome.attempts, 2);
  assert.equal(calls.length, 2);
  assert.match((calls[1] as { violations: string[] }).violations.join(";"), /第2周缺失/);
  // attemptsDetail 逐失败尝试一条，与传给模型的重试违规清单一致
  assert.equal(outcome.attemptsDetail.length, 1);
  assert.deepEqual(outcome.attemptsDetail[0]!.violations, (calls[1] as { violations: string[] }).violations);
  assert.equal(outcome.attemptsDetail[0]!.parseError, undefined);
});

test("解析失败重试：首版抛错 → parseError 入列 → 第二版通过（attempts=2）", async () => {
  const model = {
    invoke: async (_input: unknown, retry?: { violations: string[] }) => (retry == null ? Promise.reject(new Error("JSON 截断")) : fallbackAsDraft(INPUT)),
  };
  const outcome = await generateWeekContent(INPUT, model);
  assert.equal(outcome.source, "llm");
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.attemptsDetail.length, 1);
  assert.deepEqual(outcome.attemptsDetail[0]!.violations, []);
  assert.match(outcome.attemptsDetail[0]!.parseError ?? "", /JSON 截断/);
});

test("重试耗尽：模型始终抛错 → 模板兜底、兜底产物全绿；attemptsDetail 3 条全 parseError", async () => {
  const model = {
    invoke: async () => {
      throw new Error("boom");
    },
  };
  const outcome = await generateWeekContent(INPUT, model);
  assert.equal(outcome.source, "fallback");
  assert.equal(outcome.attempts, 3);
  assert.equal(outcome.weeks.length, 2);
  assert.equal(outcome.attemptsDetail.length, 3);
  for (const detail of outcome.attemptsDetail) {
    assert.deepEqual(detail.violations, []);
    assert.match(detail.parseError ?? "", /^boom$/);
  }
  for (const weekChecks of outcome.checks) for (const c of weekChecks) assert.equal(c.pass, true, `${c.id}: ${c.detail}`);
});

test("重试耗尽：始终违规（非异常）→ 兜底；比赛课配速锚 goal_pace；attemptsDetail 3 条全违规", async () => {
  const bad = fallbackAsDraft(INPUT);
  for (const week of bad.weeks) for (const session of week.sessions) session.purpose = "";
  const model = { invoke: async () => bad };
  const outcome = await generateWeekContent(INPUT, model);
  assert.equal(outcome.source, "fallback");
  assert.equal(outcome.attemptsDetail.length, 3);
  for (const detail of outcome.attemptsDetail) {
    assert.ok(detail.violations.length > 0, "每次尝试都有违规");
    assert.equal(detail.parseError, undefined);
  }
  const race = outcome.weeks[1]!.sessions.find((w) => w.date === INPUT.race.date)!;
  assert.ok(race, "比赛课在场");
  const main = race.blocks[0]!.steps[0]!;
  assert.equal(main.target.kind, "pace_s_km");
  assert.ok(Math.abs((main.target.low + main.target.high) / 2 - INPUT.race.goalPaceSKm) <= 5, `goal ${main.target.low}-${main.target.high}`);
});

test("入口断言：空 rows / 带缺失 / 非赛周 lr=null / q>2 / 比赛日网格错位 / 比赛日周一二 早失败", async () => {
  const model = { invoke: async () => fallbackAsDraft(INPUT) };
  await assert.rejects(() => generateWeekContent({ ...INPUT, rows: [] }, model), /rows 为空/);
  await assert.rejects(
    () => generateWeekContent({ ...INPUT, rows: INPUT.rows.map((r) => ({ ...r, zones: { ...r.zones, easy: null } })) }, model),
    /easy\/m 投影带缺失/,
  );
  await assert.rejects(() => generateWeekContent({ ...INPUT, rows: [{ ...ROWS[0]!, longRunKm: null }, ROWS[1]!] }, model), /非赛周但 lr=null/);
  await assert.rejects(() => generateWeekContent({ ...INPUT, rows: [{ ...ROWS[0]!, qualitySessions: 3 }, ROWS[1]!] }, model), /超域/);
  await assert.rejects(() => generateWeekContent({ ...INPUT, race: { ...INPUT.race, date: "2026-10-24" } }, model), /不落在赛周/);
  // #825：周一/周二比赛——M 激活窗（赛前 2-3 天）跨周不可表达，门口拒绝（C3 不再结构性无解）
  await assert.rejects(() => generateWeekContent({ ...INPUT, race: { ...INPUT.race, date: "2026-10-26" } }, model), /周一\/周二/);
  await assert.rejects(() => generateWeekContent({ ...INPUT, race: { ...INPUT.race, date: "2026-10-27" } }, model), /周一\/周二/);
});
