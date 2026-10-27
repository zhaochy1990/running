import assert from "node:assert/strict";
import { test } from "node:test";
import { tableFallback } from "./fallback.js";
import { peakVolumeCapKm, validatePhaseIntent } from "./gates.js";
import { makeEvidence } from "./testSupport.js";

/**
 * T 兜底性质测试（devops#782 验收：T 兜底可在 LLM 失败时产出合法意图）：
 * N=1..26 × {常态, 伤后, 赛后14天内} 全部通过 IntentSchema + 11 条结构门。
 */

const scenarios = {
  base: () => makeEvidence(),
  /** 评审 B1 三区间：零史（帽触 30 下限）、低量赛后、精英量（120 帽）。habitual 与 recent_volume 同口径（I12 消费）。 */
  zeroHistory: () =>
    makeEvidence({
      recent_volume: { avg_8wk_km: 0, avg_4wk_km: 0, recent_peak_week_km: 0, longest_run_8wk_km: 0, gap_weeks_last16: 8 },
      habitual: { week_km: 10, level: "fallback_recent4", scenario: "fallback_avg4", avg4_km: 0, decay_factor: 0.65, acwr_applicable: false, pre_peak_km: 0 },
    }),
  lowVolumeRaced: () =>
    makeEvidence({
      recent_volume: { avg_8wk_km: 9, avg_4wk_km: 10, recent_peak_week_km: 12, longest_run_8wk_km: 8, gap_weeks_last16: 0 },
      habitual: { week_km: 10, level: "fallback_recent4", scenario: "detrain_return", avg4_km: 10, decay_factor: 1, acwr_applicable: false, pre_peak_km: 12 },
      last_race: { date: "2026-10-24", distance_km: 21, days_ago: 2 },
    }),
  elite: () =>
    makeEvidence({
      recent_volume: { avg_8wk_km: 100, avg_4wk_km: 110, recent_peak_week_km: 130, longest_run_8wk_km: 35, gap_weeks_last16: 0 },
      habitual: { week_km: 99, level: "median@12w", scenario: "normal", avg4_km: 110, decay_factor: 1, acwr_applicable: true, pre_peak_km: 130 },
    }),
  eliteRaced: () =>
    makeEvidence({
      recent_volume: { avg_8wk_km: 100, avg_4wk_km: 110, recent_peak_week_km: 130, longest_run_8wk_km: 35, gap_weeks_last16: 0 },
      habitual: { week_km: 79, level: "median@12w", scenario: "post_race", avg4_km: 110, decay_factor: 1, acwr_applicable: true, pre_peak_km: 130 },
      last_race: { date: "2026-10-24", distance_km: 42, days_ago: 2 },
    }),
  injured: () =>
    makeEvidence({
      injury_return: { pre_injury_peak_week_km: 80, weeks_out: 3 },
      injuries: [{ body_area: "膝", status: "recovering" }],
      recent_volume: { avg_8wk_km: 35, avg_4wk_km: 30, recent_peak_week_km: 45, longest_run_8wk_km: 16, gap_weeks_last16: 3 },
      habitual: { week_km: 18, level: "median@16w", scenario: "detrain_return", avg4_km: 30, decay_factor: 1, acwr_applicable: false, pre_peak_km: 45 },
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

test("#810 峰值带=保守锚不坐顶帽：常态锚 75/91/93 < 帽 104；锚驱动坐帽（elite）", () => {
  for (const [N, expected] of [
    [5, 75],
    [9, 91],
    [22, 93],
  ] as const) {
    const finalBand = tableFallback(scenarios.base(), N).volume_bands.find((b) => b.phase === "final_quality");
    assert.equal(finalBand?.weekly_km_max, expected, `N=${N}`);
  }
  // 帽 104（avg8=60/peak=80）≫ 锚——兜底不再把合法上限当缺省值
  const base22 = tableFallback(scenarios.base(), 22).volume_bands.find((b) => b.phase === "final_quality");
  assert.ok(base22 && base22.weekly_km_max < peakVolumeCapKm(scenarios.base()));
  // 锚被帽夹持时（elite avg8=100）：坐帽但由锚驱动（帽=上限语义不变）
  const elite = tableFallback(scenarios.elite(), 22).volume_bands.find((b) => b.phase === "final_quality");
  assert.equal(elite?.weekly_km_max, 120);
});

test("#810 零史/低量跑者：锚骑帽 30 护栏（计划永远给，峰值不塌到 habitual×1.25）", () => {
  for (const make of [scenarios.zeroHistory, scenarios.lowVolumeRaced]) {
    const evidence = make();
    const finalBand = tableFallback(evidence, 22).volume_bands.find((b) => b.phase === "final_quality");
    assert.equal(finalBand?.weekly_km_max, 30);
  }
});

test("#810 伤退：锚夹伤前峰值 75%（低温判断层把伤后 60-70% 读进峰值）", () => {
  // avg8=50 → 无夹持锚 77.5，被伤前 80×0.75=60 压制（夹持生效形态）
  const injured = makeEvidence({
    injury_return: { pre_injury_peak_week_km: 80, weeks_out: 3 },
    injuries: [{ body_area: "膝", status: "recovering" }],
    recent_volume: { avg_8wk_km: 50, avg_4wk_km: 30, recent_peak_week_km: 45, longest_run_8wk_km: 16, gap_weeks_last16: 3 },
    habitual: { week_km: 18, level: "median@16w", scenario: "detrain_return", avg4_km: 30, decay_factor: 1, acwr_applicable: false, pre_peak_km: 45 },
  });
  const finalBand = tableFallback(injured, 23).volume_bands.find((b) => b.phase === "final_quality");
  assert.equal(finalBand?.weekly_km_max, 60);
});

test("#810 阶段带保守阶梯：hi 不降、全表 ≤ 计划峰值锚（常态/伤退在跑/近量尖峰三形态）", () => {
  // 伤退在跑（在册 active 伤、量仍在）：伤前 60 的 75% 夹持不得被中段带越过
  const injuredActive = makeEvidence({
    injuries: [{ body_area: "膝", status: "active; restriction=partial" }],
    injury_return: { pre_injury_peak_week_km: 60, weeks_out: 2 },
    recent_volume: { avg_8wk_km: 55, avg_4wk_km: 52, recent_peak_week_km: 58, longest_run_8wk_km: 22, gap_weeks_last16: 0 },
    habitual: { week_km: 44, level: "median@12w", scenario: "normal", avg4_km: 52, decay_factor: 1, acwr_applicable: true, pre_peak_km: 58 },
  });
  // 近量尖峰（avg4 ≈ 1.55×avg8）：证据下限只抬 hi 不越锚、不倒置阶梯
  const midBuild = makeEvidence({
    recent_volume: { avg_8wk_km: 40, avg_4wk_km: 62, recent_peak_week_km: 50, longest_run_8wk_km: 20, gap_weeks_last16: 0 },
    habitual: { week_km: 45, level: "median@12w", scenario: "normal", avg4_km: 62, decay_factor: 1, acwr_applicable: true, pre_peak_km: 50 },
  });
  for (const evidence of [scenarios.base(), injuredActive, midBuild]) {
    const intent = tableFallback(evidence, 22);
    const anchor = intent.volume_bands.find((b) => b.phase === "final_quality")?.weekly_km_max ?? 0;
    let prev = 0;
    for (const phase of ["foundation", "early_quality", "transition_quality", "final_quality"]) {
      const hi = intent.volume_bands.find((b) => b.phase === phase)?.weekly_km_max ?? 0;
      assert.ok(hi >= prev, `${phase} hi=${hi} < 前段 ${prev}`);
      assert.ok(hi <= anchor, `${phase} hi=${hi} 越过计划峰值锚 ${anchor}`);
      prev = hi;
    }
  }
});

test("#810 实测形态（chaoyi E2E 第二轮证据）：N=6 兜底峰值 92 而非坐顶 120", () => {
  const chaoyi = makeEvidence({
    habitual: { week_km: 70.3, level: "median@12w", scenario: "normal", avg4_km: 85, decay_factor: 1, acwr_applicable: true, pre_peak_km: 104.7 },
    recent_volume: { avg_8wk_km: 74.1, avg_4wk_km: 85.9, recent_peak_week_km: 106, longest_run_8wk_km: 35, gap_weeks_last16: 0 },
  });
  const intent = tableFallback(chaoyi, 6);
  const finalBand = intent.volume_bands.find((b) => b.phase === "final_quality");
  assert.equal(finalBand?.weekly_km_max, 92);
  assert.deepEqual(
    validatePhaseIntent(intent, 6, chaoyi)
      .filter((c) => !c.pass)
      .map((c) => c.id),
    [],
  );
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
