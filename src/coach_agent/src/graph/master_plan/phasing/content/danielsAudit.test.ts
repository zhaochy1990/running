import assert from "node:assert/strict";
import { test } from "node:test";
import { danielsAudit } from "./danielsAudit.js";
import type { ContentGeneratorInput, ContentWeekRow } from "./doctrine.js";
import type { ScheduledOutcome } from "./generate.js";

const row = (week: number, role: ContentWeekRow["role"], totalKm: number): ContentWeekRow => ({
  week,
  phase: "final_quality",
  role,
  totalKm,
  longRunKm: role === "race" ? null : 20,
  qualitySessions: 2,
  qualityFamily: "M 配速比赛专项",
  zones: { easy: [288, 336], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] },
});
const inputOf = (rows: ContentWeekRow[]): ContentGeneratorInput => ({
  rows,
  athlete: { weeklyRunDaysMax: 6, weekKm: 80, fitness: { ctl: 60, atl: 55, form: 5 } },
  race: { name: "审计测试马拉松", date: "2026-11-01", targetTime: "2:50:00", goalPaceSKm: 10200 / 42.195 },
  planStartMonday: "2026-06-29",
});
const emptyScheduled = (): ScheduledOutcome => ({
  weeks: [],
  calendar: [],
  loadSeries: [],
  checks: [],
  scheduleChecks: [],
  repairs: [],
  source: "llm",
  attempts: 1,
  attemptsDetail: [],
  loadMeta: { model: "exp-pmc-7-42", seed: { acute: 55, chronic: 60, source: "test" }, coefficient_version: "lsq-20261029" },
});

test("W13–18 部分批次：W16→W17 减量审计返回真实周量、维持 0.5km 容差与不递减 warning", () => {
  for (const [km, verdict] of [
    [65, "pass"],
    [70.5, "pass"],
    [70.6, "warn"],
  ] as const) {
    const rows = [
      row(13, "progress", 90),
      row(14, "progress", 100),
      row(15, "progress", 90),
      row(16, "taper", 70),
      row(17, "taper", km),
      row(18, "race", 62.195),
    ];
    const arc = danielsAudit(emptyScheduled(), inputOf(rows)).filter((item) => item.item.includes("周量弧"));
    assert.deepEqual(arc, [{ item: "W17 周量弧", verdict, expectation: "taper 段逐周递减（原书最后 1-3 周减量）", actual: `W16 70km → W17 ${km}km` }]);
  }
});

test("W1 首批按实际行比较；无 taper / 单 taper 不声称做了跨周比较", () => {
  const items = danielsAudit(emptyScheduled(), inputOf([row(1, "taper", 70), row(2, "taper", 65), row(3, "race", 62.195)]));
  assert.equal(items.find((item) => item.item === "W2 周量弧")?.verdict, "pass");
  for (const rows of [[row(1, "progress", 80)], [row(17, "taper", 65), row(18, "race", 62.195)], [row(18, "race", 62.195)]]) {
    const audit = danielsAudit(emptyScheduled(), inputOf(rows));
    assert.equal(audit.filter((item) => item.item.includes("周量弧")).length, 0);
    if (rows.some((r) => r.role === "race")) {
      const daily = audit.find((item) => item.item === "赛周日常量");
      assert.equal(daily?.verdict, "warn");
      assert.match(daily?.actual ?? "", /无 progress 周.*未覆盖/);
      assert.doesNotMatch(daily?.actual ?? "", /Infinity|NaN/);
    }
  }
});

test("不连续窗口不误报逐周递减通过；乱序按周号定位且不改输入", () => {
  const gap = danielsAudit(emptyScheduled(), inputOf([row(15, "taper", 70), row(17, "taper", 60)]));
  assert.equal(gap.find((item) => item.item === "W17 周量弧")?.verdict, "warn");
  assert.match(gap.find((item) => item.item === "W17 周量弧")?.actual ?? "", /不连续.*未比较/);
  const rows = [row(18, "race", 62.195), row(17, "taper", 65), row(13, "progress", 100), row(16, "taper", 70)];
  const before = structuredClone(rows);
  const items = danielsAudit(emptyScheduled(), inputOf(rows));
  assert.equal(items.find((item) => item.item === "W17 周量弧")?.actual, "W16 70km → W17 65km");
  assert.equal(items.find((item) => item.item === "赛周日常量")?.verdict, "pass");
  assert.match(items.find((item) => item.item === "赛周日常量")?.actual ?? "", /本批 progress 峰值 100km 的 20%/);
  assert.deepEqual(rows, before);
});

test("赛前 shakeout 只审比赛周；前一周周五 E 课不能冒充赛前触感", () => {
  const scheduled = emptyScheduled();
  const easy = { schema: "run-workout/v1" as const, name: "E", date: "2026-10-23", type: "E" as const, purpose: null, note: null, blocks: [] };
  scheduled.weeks = [
    { week: 17, sessions: [easy] },
    { week: 18, sessions: [] },
  ];
  const input = inputOf([row(17, "taper", 65), row(18, "race", 62.195)]);
  assert.equal(danielsAudit(scheduled, input).find((item) => item.item === "赛前 shakeout")?.verdict, "warn");
  assert.ok(scheduled.weeks[1]);
  scheduled.weeks[1].sessions.push({ ...easy, date: "2026-10-30" });
  assert.equal(danielsAudit(scheduled, input).find((item) => item.item === "赛前 shakeout")?.verdict, "pass");
});

test("部分阶段仍引用 C/P 硬门失败、保留 Q 配额/训练频率 warning", () => {
  const scheduled = emptyScheduled();
  scheduled.checks = [[{ id: "C16_spectrum", pass: false, detail: "T 段过短" }]];
  scheduled.scheduleChecks = [[{ id: "P1_spacing", pass: false, detail: "质量课相邻" }]];
  const items = danielsAudit(scheduled, inputOf([row(13, "progress", 80)]));
  assert.equal(items.find((item) => item.item === "硬校验门")?.verdict, "fail");
  assert.match(items.find((item) => item.item === "硬校验门")?.actual ?? "", /C16_spectrum;P1_spacing/);
  assert.equal(items.find((item) => item.item === "段长谱")?.verdict, "fail");
  assert.equal(items.find((item) => item.item === "W13 Q 配额")?.verdict, "warn");
  assert.equal(items.find((item) => item.item === "W13 训练频率")?.verdict, "warn");
});
