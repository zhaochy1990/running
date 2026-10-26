import assert from "node:assert/strict";
import { test } from "node:test";
import { tableFallback } from "./fallback.js";
import { validatePhaseIntent } from "./gates.js";
import { makeEvidence } from "./testSupport.js";

/**
 * T 兜底性质测试（devops#782 验收：T 兜底可在 LLM 失败时产出合法意图）：
 * N=1..26 × {常态, 伤后, 赛后14天内} 全部通过 IntentSchema + 11 条结构门。
 */

const scenarios = {
  base: () => makeEvidence(),
  /** 评审 B1 三区间：零史（帽触 30 下限）、低量赛后、精英量（120 帽）。 */
  zeroHistory: () => makeEvidence({ recent_volume: { avg_8wk_km: 0, avg_4wk_km: 0, recent_peak_week_km: 0, longest_run_8wk_km: 0, gap_weeks_last16: 8 } }),
  lowVolumeRaced: () =>
    makeEvidence({
      recent_volume: { avg_8wk_km: 9, avg_4wk_km: 10, recent_peak_week_km: 12, longest_run_8wk_km: 8, gap_weeks_last16: 0 },
      last_race: { date: "2026-10-24", distance_km: 21, days_ago: 2 },
    }),
  elite: () => makeEvidence({ recent_volume: { avg_8wk_km: 100, avg_4wk_km: 110, recent_peak_week_km: 130, longest_run_8wk_km: 35, gap_weeks_last16: 0 } }),
  eliteRaced: () =>
    makeEvidence({
      recent_volume: { avg_8wk_km: 100, avg_4wk_km: 110, recent_peak_week_km: 130, longest_run_8wk_km: 35, gap_weeks_last16: 0 },
      last_race: { date: "2026-10-24", distance_km: 42, days_ago: 2 },
    }),
  injured: () =>
    makeEvidence({
      injury_return: { pre_injury_peak_week_km: 80, weeks_out: 3 },
      injuries: [{ body_area: "膝", status: "recovering" }],
      recent_volume: { avg_8wk_km: 35, avg_4wk_km: 30, recent_peak_week_km: 45, longest_run_8wk_km: 16, gap_weeks_last16: 3 },
    }),
  raced: () => makeEvidence({ last_race: { date: "2026-10-24", distance_km: 42, days_ago: 2 } }),
} as const;

test("N=1..26 × 三场景：兜底意图全部通过 IntentSchema 与 11 条结构门", () => {
  const failures: string[] = [];
  for (const [scenario, make] of Object.entries(scenarios)) {
    for (let N = 1; N <= 26; N++) {
      const evidence = make();
      const intent = tableFallback(evidence, N);
      const checks = validatePhaseIntent(intent, N, evidence);
      const failed = checks.filter((c) => !c.pass).map((c) => `${c.id}:${c.detail}`);
      if (failed.length > 0) failures.push(`${scenario}/N=${N} → ${failed.join("; ")}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("赛后 14 天内 → 首阶段 recovery；常态无 recovery 前置", () => {
  const raced = scenarios.raced();
  assert.equal(tableFallback(raced, 22).phases[0]?.canonical, "recovery");
  assert.notEqual(tableFallback(scenarios.base(), 22).phases[0]?.canonical, "recovery");
});

test("≤6 周 final-only 形态：只允许 recovery/final_quality", () => {
  for (let N = 1; N <= 6; N++) {
    for (const make of [scenarios.base, scenarios.raced]) {
      const intent = tableFallback(make(), N);
      for (const p of intent.phases) assert.ok(p.canonical === "recovery" || p.canonical === "final_quality", `N=${N} 出现 ${p.canonical}`);
    }
  }
});

test("7-9 周：≤4 阶段且无 early_quality（坍缩阶梯：先砍 early）", () => {
  for (let N = 7; N <= 9; N++) {
    const intent = tableFallback(scenarios.base(), N);
    assert.ok(intent.phases.length <= 4, `N=${N} 阶段数 ${intent.phases.length}`);
    assert.ok(!intent.phases.some((p) => p.canonical === "early_quality"), `N=${N} 不应有 early_quality`);
  }
});

test("有氧学分充分 → foundation 砍半并把周数让渡给 final_quality", () => {
  const aerobic = makeEvidence({
    phase_credit: {
      sustained_volume_months_ge40wk: 5,
      e_share_months_ge85: 4,
      months_with_long_run_ge25: 4,
      months_with_ge4_quality: 2,
      marathons_since_april: 1,
    },
  });
  const normal = tableFallback(scenarios.base(), 23);
  const credited = tableFallback(aerobic, 23);
  const weeksOf = (intent: ReturnType<typeof tableFallback>, c: string) => {
    const p = intent.phases.find((x) => x.canonical === c);
    return p ? p.end_week - p.start_week + 1 : 0;
  };
  assert.ok(weeksOf(credited, "foundation") < weeksOf(normal, "foundation"), "foundation 应压缩");
  assert.ok(weeksOf(credited, "final_quality") > weeksOf(normal, "final_quality"), "final_quality 应获让渡");
});

test("伤退 → foundation 拉长（相对常态 ≥+1 周）且其体量带 ≤ 伤前峰值 70%", () => {
  const layout = tableFallback(scenarios.injured(), 23);
  const normal = tableFallback(scenarios.base(), 23);
  const weeksOf = (intent: ReturnType<typeof tableFallback>, c: string) => {
    const p = intent.phases.find((x) => x.canonical === c);
    return p ? p.end_week - p.start_week + 1 : 0;
  };
  assert.ok(weeksOf(layout, "foundation") >= weeksOf(normal, "foundation") + 1);
  const band = layout.volume_bands.find((b) => b.phase === "foundation");
  assert.ok(band);
  assert.ok(band.weekly_km_max <= 80 * 0.7 + 0.5, `伤后 foundation 带 ${band.weekly_km_max} 应 ≤ 56`);
});

test("recovery 体量带 ≤ 近期峰值 55%；全表峰值带 ≤ 帽", () => {
  const evidence = scenarios.raced();
  const intent = tableFallback(evidence, 22);
  const recoveryBand = intent.volume_bands.find((b) => b.phase === "recovery");
  assert.ok(recoveryBand && recoveryBand.weekly_km_max <= 80 * 0.55 + 0.01);
  const maxBand = Math.max(...intent.volume_bands.map((b) => b.weekly_km_max));
  assert.ok(maxBand <= Math.min(120, Math.max(60 * 1.6, 80 * 1.3)) + 0.01);
});

test("raced N=7..9：recovery 前置不挤掉 foundation≥2 底线（坍缩让渡 transition）", () => {
  for (let N = 7; N <= 9; N++) {
    const intent = tableFallback(scenarios.raced(), N);
    const foundation = intent.phases.find((p) => p.canonical === "foundation");
    const fw = foundation ? foundation.end_week - foundation.start_week + 1 : 0;
    assert.ok(fw >= 2, `raced N=${N} foundation=${fw}w 应 ≥2（layout ${intent.phases.map((p) => p.canonical).join("→")}）`);
  }
});

test("taper 属性：1-3 周且 ≤ final_quality 周数（全跑道扫描）", () => {
  for (let N = 3; N <= 26; N++) {
    for (const make of [scenarios.base, scenarios.raced]) {
      const intent = tableFallback(make(), N);
      const fq = intent.phases.find((p) => p.canonical === "final_quality");
      assert.ok(fq, `N=${N} 缺 final_quality`);
      assert.ok(intent.taper_weeks >= 1 && intent.taper_weeks <= 3);
      assert.ok(intent.taper_weeks <= (fq ? fq.end_week - fq.start_week + 1 : 0));
    }
  }
});
