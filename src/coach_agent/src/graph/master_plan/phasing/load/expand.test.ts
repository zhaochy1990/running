import assert from "node:assert/strict";
import { test } from "node:test";
import type { PhaseDivisionIntent } from "../intent.js";
import { phase } from "../testSupport.js";
import type { HabitualBaseline } from "./baseline.js";
import { buildLoadPlan, expandLoad } from "./expand.js";

/** 展开器结构性质（devops#793 B/C/D 节）。 */

const baseline: HabitualBaseline = {
  week_km: 55,
  level: "median@12w",
  scenario: "normal",
  avg4_km: 60,
  decay_factor: 1,
  acwr_applicable: true,
  pre_peak_km: 65,
};

/** N=16 基底：rec1 + F6 + early2 + trans3 + fq4（taper2）；可整体覆盖。 */
function makeIntent(overrides: Partial<PhaseDivisionIntent> = {}): PhaseDivisionIntent {
  return {
    phases: [
      phase("recovery", 1, 1),
      phase("foundation", 2, 7),
      phase("early_quality", 8, 9),
      phase("transition_quality", 10, 12),
      phase("final_quality", 13, 16),
    ],
    taper_weeks: 2,
    milestones: [
      { phase: "recovery", signal: "HRV", criterion: "回基线" },
      { phase: "foundation", signal: "long_run_km", criterion: "25km" },
      { phase: "early_quality", signal: "质量课计数", criterion: "R 课" },
      { phase: "transition_quality", signal: "T 配速课完成度", criterion: "2 节" },
      { phase: "final_quality", signal: "M 配速课", criterion: "彩排" },
    ],
    gates: [
      { phase: "foundation", signal: "weekly_km", criterion: "达下限", action_if_missed: "延长一周" },
      { phase: "final_quality", signal: "体感 RPE", criterion: "≤6", action_if_missed: "下调块位" },
    ],
    volume_bands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 40 },
      { phase: "foundation", weekly_km_min: 45, weekly_km_max: 75 },
      { phase: "early_quality", weekly_km_min: 55, weekly_km_max: 85 },
      { phase: "transition_quality", weekly_km_min: 60, weekly_km_max: 90 },
      { phase: "final_quality", weekly_km_min: 65, weekly_km_max: 95 },
    ],
    ...overrides,
  };
}

const run = (intent = makeIntent(), N = 16, base = baseline) => expandLoad({ intent, runwayWeeks: N, baseline: base, recentWeeksKm: [58, 62, 55, 60] });

test("recovery 周：低量平 min(lo, max(15, 起点×0.7))，Q=0，LR=min(14, km×0.3)", () => {
  const { weeks } = run();
  const rec = weeks[0]!;
  assert.equal(rec.canonical, "recovery");
  assert.ok(Math.abs(rec.km - Math.min(20, Math.max(15, 55 * 0.7))) < 0.1, `km=${rec.km}`);
  assert.equal(rec.q, 0);
  assert.ok(Math.abs((rec.lr ?? 0) - Math.min(14, rec.km * 0.3)) < 0.1);
});

test("吸收周：全局建设周计数每第 4 周（计数含吸收周自身——死循环陷阱；跨阶段不重置）", () => {
  // 建设计数 1..12（w2-7 六个 + w8-9 两个 + w10-12 三个 + w13）：
  // 第 4 位=w5、第 8 位=w9、第 12 位=w13（恰逢 final_quality 首周，跨阶段不重置）
  const { weeks } = run();
  const absorbs = weeks.filter((w) => w.role === "absorb").map((w) => w.week);
  assert.deepEqual(absorbs, [5, 9, 13]);
  const absorb = weeks.find((w) => w.role === "absorb")!;
  assert.ok(absorb.km <= 0.76 * 90); // ×0.75 后不会高于带内常规位
});

test("块内微阶梯：≥3 个建设周的块呈非平台直排（0.97/1/1.03）", () => {
  const { weeks } = run();
  const fWeeks = weeks.filter((w) => w.canonical === "foundation" && w.role === "progress").map((w) => w.km);
  assert.ok(fWeeks.length >= 3);
  assert.ok(Math.max(...fWeeks) - Math.min(...fWeeks) >= 0.5, `foundation kms=${fWeeks}`);
});

test("taper：段内递减、赛周=比赛+激活（字面 52-57 且落在削减深度门带内）、LR null、Q=1", () => {
  const { weeks } = run();
  const taper = weeks.filter((w) => w.role === "taper").map((w) => w.km);
  const race = weeks.at(-1)!;
  assert.equal(race.role, "race");
  assert.equal(race.lr, null);
  assert.equal(race.q, 2); // 赛周=比赛课+M 激活（#825）
  assert.ok(
    taper.every((x, i) => i === 0 || x <= taper[i - 1]! + 0.5),
    `taper=${taper}`,
  );
  // 性质断言（不复制实现公式）：高平台走丹尼尔斯字面账 52-57（含比赛里程），
  // 且始终在削减深度门带 [0.5, 0.7]×平台参照内（构造与门不自挂）
  assert.ok(race.km >= 52 && race.km <= 57, `race=${race.km} 不在 52-57 带内`);
  const ref = Math.max(...weeks.filter((w) => w.canonical === "final_quality" && w.role !== "race").map((w) => w.km));
  assert.ok(race.km >= ref * 0.5 - 0.6 && race.km <= ref * 0.7 + 0.6, `race=${race.km} ref=${ref}`);
});

test("赛周低量档字面最小值优先（#809）：0.7×平台上限不得把赛周压到比赛里程之下", () => {
  const base: HabitualBaseline = {
    week_km: 10,
    level: "fallback_recent4",
    scenario: "fallback_avg4",
    avg4_km: 0,
    decay_factor: 0.65,
    acwr_applicable: false,
    pre_peak_km: 12,
  };
  const intent = makeIntent({
    phases: [phase("final_quality", 1, 6)],
    taper_weeks: 1,
    volume_bands: [{ phase: "final_quality", weekly_km_min: 12, weekly_km_max: 30 }],
  });
  const { weeks } = expandLoad({ intent, runwayWeeks: 6, baseline: base, recentWeeksKm: [0, 0, 0, 0] });
  const plateau = weeks.filter((w) => w.role === "progress").at(-1)!.km;
  const race = weeks.at(-1)!;
  // 赛周含 FM 本身：总里程 ≥42.2+激活下限 10（字面最小值 52.2 反超 0.7×平台上限——
  // 旧双侧夹取会产出 37.8<42.2 的物理不可能赛周）
  assert.ok(plateau * 0.7 < 52.2, `plateau=${plateau}（用例未进入低量域）`);
  assert.ok(Math.abs(race.km - 52.2) < 0.1, `race=${race.km}`);
});

test("赛周高平台分支（#809）：回归纯字面账 ≤57.2，不再被 0.5×ref 下界抬升", () => {
  // 高量档（band 100-120）：平台爬到 115+ 后旧公式赛周=0.5×平台（60+）——激活
  // 原教义上限 15km，字面账封顶 57.2；量值合法性由 L4 门左支/激活量右支兜底
  const high: HabitualBaseline = { ...baseline, week_km: 105, avg4_km: 105, pre_peak_km: 118 };
  const plan = buildLoadPlan({
    intent: makeIntent({
      phases: [phase("final_quality", 1, 8)],
      taper_weeks: 2,
      volume_bands: [{ phase: "final_quality", weekly_km_min: 105, weekly_km_max: 125 }],
    }),
    runwayWeeks: 8,
    baseline: high,
    recentWeeksKm: [100, 105, 102, 108],
  });
  const race = plan.weeks.at(-1)!;
  const ref = Math.max(...plan.weeks.filter((w) => w.role !== "race").map((w) => w.km));
  assert.ok(ref > 114, `ref=${ref}（用例未进入高平台域）`);
  assert.ok(Math.abs(race.km - 57.2) < 0.1, `race=${race.km}`);
  assert.ok(race.km < ref * 0.5, `race=${race.km} ref=${ref}（旧 0.5×ref 下界已随 #809 双侧夹取移除）`);
  assert.ok(plan.checks.find((c) => c.id.startsWith("L4"))!.pass, plan.checks.find((c) => c.id.startsWith("L4"))!.detail);
});

test("吸收放位（#806）：距赛周 < taper+1 不落吸收；≤8 周短跑道禁用；峰后弧单调", () => {
  const mk = (n: number) =>
    makeIntent({
      phases: [phase("recovery", 1, 1), phase("foundation", 2, n - 4), phase("final_quality", n - 3, n)],
      taper_weeks: 2,
      volume_bands: [
        { phase: "recovery", weekly_km_min: 20, weekly_km_max: 40 },
        { phase: "foundation", weekly_km_min: 70, weekly_km_max: 90 },
        { phase: "final_quality", weekly_km_min: 75, weekly_km_max: 95 },
      ],
    });
  const seed = [58, 62, 55, 60];
  // N=7：E2E 锯齿案（w4 峰 82.5 → 旧代码 w5 吸收 63.8 → w6 taper 70.1 反超）——
  // 现无吸收（该候选同时被距赛与短跑道两规则压制，距赛规则的独立效应见 z11）
  const z7 = expandLoad({ intent: mk(7), runwayWeeks: 7, baseline, recentWeeksKm: seed });
  assert.deepEqual(
    z7.weeks.filter((w) => w.role === "absorb"),
    [],
  );
  // N=8：w5 候选距赛 3 = taper+1 放位合法，但短跑道 ≤8 整体禁用全局吸收计数
  const z8 = expandLoad({ intent: mk(8), runwayWeeks: 8, baseline, recentWeeksKm: seed });
  assert.deepEqual(
    z8.weeks.filter((w) => w.role === "absorb"),
    [],
  );
  // N=9：w5 候选距赛 4 ≥3 且非短跑道 → 吸收保留（3+1 节奏合法形态）
  const z9 = expandLoad({ intent: mk(9), runwayWeeks: 9, baseline, recentWeeksKm: seed });
  assert.deepEqual(
    z9.weeks.filter((w) => w.role === "absorb").map((w) => w.week),
    [5],
  );
  // N=11（非短跑道）：w9 候选距赛 2 <3 → 放位规则独立压制（短禁用不参与），
  // 该周按常规建设周计、计数顺延
  const z11 = expandLoad({ intent: mk(11), runwayWeeks: 11, baseline, recentWeeksKm: seed });
  assert.deepEqual(
    z11.weeks.filter((w) => w.role === "absorb").map((w) => w.week),
    [5],
  );
  assert.equal(z11.weeks.find((w) => w.week === 9)!.role, "progress");
  // 峰后弧单调：末平台顶（最后一个 final_quality progress 周）起至赛周不升
  for (const z of [z7, z8, z9, z11]) {
    const arcStart = z.weeks.findLastIndex((w) => w.canonical === "final_quality" && w.role === "progress");
    const arc = z.weeks.slice(arcStart).map((w) => w.km);
    assert.ok(
      arc.every((x, i) => i === 0 || x <= arc[i - 1]! + 0.5),
      `arc=${arc}`,
    );
  }
});

test("Q 配额：foundation km<60→0 / km≥60→1；其余建设 km≥70→2 否则 1", () => {
  const { weeks } = run();
  for (const w of weeks) {
    if (w.canonical === "recovery") assert.equal(w.q, 0);
    else if (w.canonical === "foundation") assert.equal(w.q, w.km >= 60 ? 1 : 0);
    else if (w.role === "progress") assert.equal(w.q, w.km >= 70 ? 2 : 1);
  }
});

test("块结构标记：相位首周开 phase_start 块，吸收周开 absorb_cut 块", () => {
  const { blocks } = run();
  const phaseStarts = blocks.filter((b) => b.boundary === "phase_start");
  assert.equal(phaseStarts.length, 5); // 五个相位各一块（w13 既是相位首周又是吸收周，记 phase_start）
  const absorbCuts = blocks.filter((b) => b.boundary === "absorb_cut");
  assert.deepEqual(
    absorbCuts.map((b) => b.start_week),
    [5, 9],
  );
  for (const b of absorbCuts) assert.deepEqual(b.absorb_weeks, [b.start_week]);
});

test("里程碑对齐：L2 出口里程碑落到对应阶段 end_week", () => {
  const { milestones } = run();
  const bySignal = new Map(milestones.map((m) => [m.signal, m.week]));
  assert.equal(bySignal.get("HRV"), 1);
  assert.equal(bySignal.get("long_run_km"), 7);
  assert.equal(bySignal.get("T 配速课完成度"), 12);
  assert.equal(bySignal.get("M 配速课"), 16);
});

test("ACWR 不适用（断练/零史）：滚动均值以起点构造位播种，不出 0km 周", () => {
  const base: HabitualBaseline = { ...baseline, week_km: 12, scenario: "detrain_return", acwr_applicable: false };
  const { weeks } = run(makeIntent(), 16, base);
  assert.ok(
    weeks.every((w) => w.km >= 5),
    `min km=${Math.min(...weeks.map((w) => w.km))}`,
  );
});

test("LR 份额：低量周放宽 42%，常规 36%；LR ≥12 下限", () => {
  const { weeks } = run();
  for (const w of weeks) {
    if (w.lr == null || w.canonical === "recovery") continue;
    const cap = w.km < 60 ? 0.42 : 0.36;
    assert.ok((w.lr ?? 0) <= w.km * cap + 0.6, `W${w.week} lr=${w.lr} km=${w.km}`);
    assert.ok((w.lr ?? 0) >= 12);
  }
});

test("低量/断练播种自洽（评审回归 + #809 语义更新）：建设周不被误伤；FM 赛周字面尖峰被硬门诚实标记", () => {
  // 零史用户（recentWeeksKm 全 0、起点 10km）：展开器播种 0.7×起点，验收门
  // 用同一 rollingSeed——建设周（W1-W5）不被 H1/H2/L1 误伤（原回归目的）。
  // #809：赛周=FM 字面账 52.2（比赛就在那周，物理不可再低）——从 ~15km 平台
  // 跳到 52.2 是真实尖峰，H1/H2 诚实报红、L3 LR 峰值参照被赛周抬高——构造
  // 不再用 #806 夹持「赛周 10km 却含全马」的谎言讨好门；这类目标应由 L2/判断层拒收
  const base: HabitualBaseline = {
    week_km: 10,
    level: "fallback_recent4",
    scenario: "fallback_avg4",
    avg4_km: 0,
    decay_factor: 0.65,
    acwr_applicable: false,
    pre_peak_km: 12,
  };
  const intent = makeIntent({
    phases: [phase("final_quality", 1, 6)],
    taper_weeks: 1,
    volume_bands: [{ phase: "final_quality", weekly_km_min: 12, weekly_km_max: 30 }],
  });
  const plan = buildLoadPlan({ intent, runwayWeeks: 6, baseline: base, recentWeeksKm: [0, 0, 0, 0] });
  const failed = plan.checks.filter((c) => !c.pass);
  assert.deepEqual(
    failed.map((c) => c.id),
    ["H1 ACWR≤1.3", "H2 单周尖峰≤1.5×滚动均值", "L3 LR曲线"],
    `failed=${failed.map((c) => `${c.id}:${c.detail}`)}`,
  );
  // 误伤回归本体：H1/H2 尖峰只报赛周 W6（播种建设周干净）；L3 为 LR 峰值参照被赛周抬高（无周号）
  assert.deepEqual(
    failed.filter((c) => c.id.startsWith("H")).map((c) => c.detail),
    ["W6 超限", "W6 超限"],
  );
  assert.ok(
    plan.weeks.every((w) => w.km > 0),
    `weeks=${plan.weeks.map((w) => w.km)}`,
  );
  assert.ok(Math.abs(plan.weeks.at(-1)!.km - 52.2) < 0.1);
  // LR 下限让位份额：低量周 lr ≤ km×cap+0.5（不硬顶 12）
  for (const w of plan.weeks) {
    if (w.lr == null) continue;
    const cap = w.km < 60 ? 0.42 : 0.36;
    assert.ok((w.lr ?? 0) <= w.km * cap + 0.6, `W${w.week} lr=${w.lr} km=${w.km}`);
  }
});

test("taper 周 LR 削减（#809）：常规目标被 25→20 随深度递减的带上限修剪；赛周 null 不变", () => {
  // 高量档让常规 LR 目标顶到 32（LR_MAX_KM）：taper 削减带独立可见
  const high: HabitualBaseline = { ...baseline, week_km: 100, avg4_km: 100, pre_peak_km: 110 };
  const { weeks } = expandLoad({
    intent: makeIntent({
      phases: [phase("foundation", 1, 8), phase("final_quality", 9, 14)],
      taper_weeks: 3,
      volume_bands: [
        { phase: "foundation", weekly_km_min: 90, weekly_km_max: 110 },
        { phase: "final_quality", weekly_km_min: 100, weekly_km_max: 120 },
      ],
    }),
    runwayWeeks: 14,
    baseline: high,
    recentWeeksKm: [95, 100, 98, 102],
  });
  const tapers = weeks.filter((w) => w.role === "taper");
  assert.equal(tapers.length, 2);
  // tIdx 1→25、2→20（每深一周 −5，带 [20,25]；常规目标 32 被修剪）
  assert.deepEqual(
    tapers.map((w) => w.lr),
    [25, 20],
  );
  assert.equal(weeks.at(-1)!.lr, null);
  // 反向参照：同级常规建设周不被 taper 带修剪（顶格 32）
  assert.ok(weeks.some((w) => w.role === "progress" && w.canonical !== "recovery" && (w.lr ?? 0) > 25));
});
