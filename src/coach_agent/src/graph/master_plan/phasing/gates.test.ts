import assert from "node:assert/strict";
import { test } from "node:test";
import { peakVolumeCapKm, validatePhaseIntent } from "./gates.js";
import { allPass, failing, makeEvidence, makeIntent, phase } from "./testSupport.js";

test("I1 闭合：基底 22 周跑道全绿；挖洞则挂", () => {
  const evidence = makeEvidence();
  assert.ok(allPass(validatePhaseIntent(makeIntent({}), 22, evidence)));
  const holed = makeIntent({
    phases: [
      phase("recovery", 1, 2),
      phase("foundation", 3, 8),
      phase("early_quality", 9, 10),
      phase("transition_quality", 11, 14), // 15 周丢失
      phase("final_quality", 16, 22),
    ],
  });
  const check = failing(validatePhaseIntent(holed, 22, evidence), "I1");
  assert.ok(check && !check.pass);
});

test("I1 闭合：阶段超跑道边界挂", () => {
  const evidence = makeEvidence();
  const overrun = makeIntent({
    phases: [
      phase("recovery", 1, 2),
      phase("foundation", 3, 8),
      phase("early_quality", 9, 10),
      phase("transition_quality", 11, 15),
      phase("final_quality", 16, 23), // 超出 N=22
    ],
  });
  assert.ok(!failing(validatePhaseIntent(overrun, 22, evidence), "I1")?.pass);
});

test("I2 顺序律：倒置挂（final 后再 foundation 不可能，验 transition 早于 early）", () => {
  const evidence = makeEvidence();
  const inverted = makeIntent({
    phases: [
      phase("recovery", 1, 2),
      phase("foundation", 3, 8),
      phase("transition_quality", 9, 13), // transition 跑到 early 前
      phase("early_quality", 14, 15),
      phase("final_quality", 16, 22),
    ],
  });
  const check = failing(validatePhaseIntent(inverted, 22, evidence), "I2");
  assert.ok(check && !check.pass);
});

test("I2 顺序律：canonical 重复挂", () => {
  const evidence = makeEvidence();
  const dup = makeIntent({
    phases: [phase("recovery", 1, 2), phase("foundation", 3, 8), phase("foundation", 9, 15), phase("final_quality", 16, 22)],
  });
  assert.ok(!failing(validatePhaseIntent(dup, 22, evidence), "I2")?.pass);
});

test("I2 顺序律：坍缩合法（跳过 early/transition 不违规）", () => {
  const evidence = makeEvidence();
  const collapsed = makeIntent({
    phases: [phase("recovery", 1, 2), phase("foundation", 3, 12), phase("final_quality", 13, 22)],
    taperWeeks: 3,
    milestones: [
      { phase: "recovery", signal: "HRV", criterion: "回基线" },
      { phase: "foundation", signal: "long_run_km", criterion: "25km 两周" },
    ],
    volumeBands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 44 },
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "final_quality", weekly_km_min: 60, weekly_km_max: 100 },
    ],
  });
  assert.ok(failing(validatePhaseIntent(collapsed, 22, evidence), "I2")?.pass);
});

test("I3 赛后先恢复：14 天内完赛而首阶段非 recovery 挂；首阶段 recovery 过", () => {
  const raced = makeEvidence({ last_race: { date: "2026-10-24", distance_km: 42, days_ago: 2 } });
  const noRecovery = makeIntent({
    phases: [phase("foundation", 1, 12), phase("early_quality", 13, 14), phase("transition_quality", 15, 19), phase("final_quality", 20, 22)],
    taperWeeks: 2,
    milestones: [{ phase: "foundation", signal: "long_run_km", criterion: "25km" }],
    volumeBands: [
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "early_quality", weekly_km_min: 50, weekly_km_max: 90 },
      { phase: "transition_quality", weekly_km_min: 55, weekly_km_max: 95 },
      { phase: "final_quality", weekly_km_min: 60, weekly_km_max: 100 },
    ],
  });
  const checks = validatePhaseIntent(noRecovery, 22, raced);
  assert.equal(failing(checks, "I3")?.pass, false);
  // 同跑道加 recovery 前置则过 I3（其余门不论）
  const withRecovery = makeIntent({
    phases: [phase("recovery", 1, 2), ...noRecovery.phases.map((p) => ({ ...p, start_week: p.start_week + 2, end_week: p.end_week + 2 }))]
      .slice(0, 4)
      .concat([phase("final_quality", 21, 24)]),
  });
  assert.equal(failing(validatePhaseIntent(withRecovery, 24, raced), "I3")?.pass, true);
});

test("I4 专项在场：N=16 需 final≥4 周；N=15 时 3 周即可", () => {
  const evidence = makeEvidence();
  const short = makeIntent({
    phases: [
      phase("recovery", 1, 2),
      phase("foundation", 3, 8),
      phase("early_quality", 9, 10),
      phase("transition_quality", 11, 13),
      phase("final_quality", 14, 16),
    ],
    taperWeeks: 2,
  });
  assert.equal(failing(validatePhaseIntent(short, 16, evidence), "I4")?.pass, false);
  assert.equal(failing(validatePhaseIntent(short, 15, evidence), "I4")?.pass, true);
});

test("I5 taper 属性：taper 超过 final_quality 周数挂", () => {
  const evidence = makeEvidence();
  const shortFinal = makeIntent({
    phases: [phase("recovery", 1, 2), phase("foundation", 3, 12), phase("final_quality", 13, 22)],
    taperWeeks: 3,
    milestones: [{ phase: "foundation", signal: "long_run_km", criterion: "25km" }],
    volumeBands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 44 },
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "final_quality", weekly_km_min: 60, weekly_km_max: 100 },
    ],
  });
  assert.equal(failing(validatePhaseIntent(shortFinal, 22, evidence), "I5")?.pass, true); // final 10w taper3 ✓
  const tiny = makeIntent({
    phases: [phase("final_quality", 1, 2)],
    taperWeeks: 2,
    milestones: [{ phase: "final_quality", signal: "M 配速课", criterion: "彩排完成" }],
    gates: [
      { phase: "final_quality", signal: "weekly_km", criterion: "达下限", action_if_missed: "下调块位" },
      { phase: "final_quality", signal: "体感 RPE", criterion: "≤6", action_if_missed: "延长减量" },
    ],
    volumeBands: [{ phase: "final_quality", weekly_km_min: 20, weekly_km_max: 100 }],
  });
  assert.equal(failing(validatePhaseIntent(tiny, 2, makeEvidence({ last_race: { date: "2026-10-24", distance_km: 42, days_ago: 30 } })), "I5")?.pass, true); // taper2=fq2 ✓
});

test("I5 taper 属性：taper 超过 final_quality 周数挂（taper3 > fq2）", () => {
  const evidence = makeEvidence();
  const overTaper = makeIntent({
    taperWeeks: 3,
    phases: [phase("recovery", 1, 2), phase("foundation", 3, 12), phase("transition_quality", 13, 20), phase("final_quality", 21, 22)],
    milestones: [
      { phase: "recovery", signal: "HRV", criterion: "回基线" },
      { phase: "transition_quality", signal: "T 配速课完成度", criterion: "2 节完成" },
    ],
    volumeBands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 44 },
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "transition_quality", weekly_km_min: 55, weekly_km_max: 95 },
      { phase: "final_quality", weekly_km_min: 60, weekly_km_max: 100 },
    ],
  });
  const check = failing(validatePhaseIntent(overTaper, 22, evidence), "I5");
  assert.ok(check && !check.pass);
});

test("I4 专项在场：缺 final_quality 挂", () => {
  const evidence = makeEvidence();
  const noFinal = makeIntent({
    phases: [phase("recovery", 1, 2), phase("foundation", 3, 12), phase("transition_quality", 13, 22)],
    milestones: [
      { phase: "recovery", signal: "HRV", criterion: "回基线" },
      { phase: "transition_quality", signal: "T 配速课完成度", criterion: "2 节完成" },
    ],
    volumeBands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 44 },
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "transition_quality", weekly_km_min: 55, weekly_km_max: 95 },
    ],
  });
  const check = failing(validatePhaseIntent(noFinal, 22, evidence), "I4");
  assert.ok(check && !check.pass && check.detail === "缺失");
});

test("I8 体量带：min>max 挂；某阶段缺体量带挂", () => {
  const evidence = makeEvidence();
  const inverted = makeIntent({
    volumeBands: makeIntent({}).volume_bands.map((b) => (b.phase === "early_quality" ? { ...b, weekly_km_min: 95, weekly_km_max: 50 } : b)),
  });
  const invertedCheck = failing(validatePhaseIntent(inverted, 22, evidence), "I8");
  assert.ok(invertedCheck && !invertedCheck.pass && invertedCheck.detail.includes("min>max"));
  const missingBand = makeIntent({
    volumeBands: makeIntent({}).volume_bands.filter((b) => b.phase !== "early_quality"),
  });
  const missingCheck = failing(validatePhaseIntent(missingBand, 22, evidence), "I8");
  assert.ok(missingCheck && !missingCheck.pass && missingCheck.detail.includes("early_quality 缺体量带"));
});

test("I6 里程碑：缺 transition_quality 出口里程碑挂；signal 无可观察词挂", () => {
  const evidence = makeEvidence();
  const missing = makeIntent({ milestones: makeIntent({}).milestones.filter((m) => m.phase !== "transition_quality") });
  assert.equal(failing(validatePhaseIntent(missing, 22, evidence), "I6")?.pass, false);
  const vague = makeIntent({
    milestones: [...makeIntent({}).milestones.filter((m) => m.phase !== "foundation"), { phase: "foundation", signal: "自我评估满意", criterion: "状态还行" }],
  });
  assert.equal(failing(validatePhaseIntent(vague, 22, evidence), "I6")?.pass, false);
});

test("I7 阶段 gate：action_if_missed 过短挂（gates 数量下限由 IntentSchema min(2) 契约层保证）", () => {
  const evidence = makeEvidence();
  const terse = makeIntent({
    gates: [
      { phase: "foundation", signal: "weekly_km", criterion: "达下限", action_if_missed: "停" },
      { phase: "transition_quality", signal: "体感 RPE", criterion: "≤6", action_if_missed: "重复块位" },
    ],
  });
  assert.equal(failing(validatePhaseIntent(terse, 22, evidence), "I7")?.pass, false);
});

test("I8 体量带：峰值带超帽挂（帽=min(120,max(60×1.6,80×1.3))=104）", () => {
  const evidence = makeEvidence();
  assert.equal(peakVolumeCapKm(evidence), 104);
  const overPeak = makeIntent({
    volumeBands: makeIntent({}).volume_bands.map((b) => (b.phase === "final_quality" ? { ...b, weekly_km_max: 110 } : b)),
  });
  const check = failing(validatePhaseIntent(overPeak, 22, evidence), "I8");
  assert.ok(check && !check.pass && check.detail.includes("峰值带110"));
});

test("I8 体量带：recovery 带超近期峰值 60% 挂（帽 80×0.6=48）", () => {
  const evidence = makeEvidence();
  const overRecovery = makeIntent({
    volumeBands: makeIntent({}).volume_bands.map((b) => (b.phase === "recovery" ? { ...b, weekly_km_max: 55 } : b)),
  });
  assert.ok(!failing(validatePhaseIntent(overRecovery, 22, evidence), "I8")?.pass);
});

test("I8 体量带：伤后 foundation 带超伤前峰值 78% 挂（pre=80 → 帽 62.9）", () => {
  const evidence = makeEvidence({ injury_return: { pre_injury_peak_week_km: 80, weeks_out: 3 } });
  const overPostInjury = makeIntent({
    volumeBands: makeIntent({}).volume_bands.map((b) => (b.phase === "foundation" ? { ...b, weekly_km_max: 75 } : b)),
  });
  const check = failing(validatePhaseIntent(overPostInjury, 22, evidence), "I8");
  assert.ok(check && !check.pass && check.detail.includes("伤后foundation"));
});

test("I8 体量带：band 无法对应阶段挂", () => {
  const evidence = makeEvidence();
  const orphan = makeIntent({
    volumeBands: [...makeIntent({}).volume_bands, { phase: "神秘阶段", weekly_km_min: 10, weekly_km_max: 30 }],
  });
  assert.ok(!failing(validatePhaseIntent(orphan, 22, evidence), "I8")?.pass);
});

test("I9 块模式：foundation 用 plateau 挂", () => {
  const evidence = makeEvidence();
  const wrongMode = makeIntent({
    phases: makeIntent({}).phases.map((p) => (p.canonical === "foundation" ? { ...p, block_mode: "plateau" as const } : p)),
  });
  assert.ok(!failing(validatePhaseIntent(wrongMode, 22, evidence), "I9")?.pass);
});

test("I10 rationale 引证：无证据字段引用挂", () => {
  const evidence = makeEvidence();
  const noCite = makeIntent({
    phases: makeIntent({}).phases.map((p) => (p.canonical === "foundation" ? { ...p, rationale: "按经验安排" } : p)),
  });
  assert.ok(!failing(validatePhaseIntent(noCite, 22, evidence), "I10")?.pass);
});

test("I11 最小周期：N≥7 时 foundation 1 周挂", () => {
  const evidence = makeEvidence();
  const tooShort = makeIntent({
    phases: [phase("recovery", 1, 2), phase("foundation", 3, 3), phase("transition_quality", 4, 15), phase("final_quality", 16, 22)],
    milestones: [
      { phase: "recovery", signal: "HRV", criterion: "回基线" },
      { phase: "transition_quality", signal: "T 配速课完成度", criterion: "2 节完成" },
    ],
    volumeBands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 44 },
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "transition_quality", weekly_km_min: 55, weekly_km_max: 95 },
      { phase: "final_quality", weekly_km_min: 60, weekly_km_max: 100 },
    ],
  });
  const check = failing(validatePhaseIntent(tooShort, 22, evidence), "I11");
  assert.ok(check && !check.pass);
});

test("I11 final-only 形态门：N≤6 出现 foundation 挂；recovery+final 合法", () => {
  const raced = makeEvidence({ last_race: { date: "2026-10-24", distance_km: 42, days_ago: 2 } });
  const badShape = makeIntent({
    phases: [phase("recovery", 1, 1), phase("foundation", 2, 3), phase("final_quality", 4, 6)],
    taperWeeks: 2,
    milestones: [
      { phase: "recovery", signal: "HRV", criterion: "回基线" },
      { phase: "foundation", signal: "long_run_km", criterion: "20km" },
    ],
    volumeBands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 44 },
      { phase: "foundation", weekly_km_min: 30, weekly_km_max: 50 },
      { phase: "final_quality", weekly_km_min: 50, weekly_km_max: 100 },
    ],
  });
  const check = failing(validatePhaseIntent(badShape, 6, raced), "I11");
  assert.ok(check && !check.pass && check.id === "I11 final-only形态");
  const goodShape = makeIntent({
    phases: [phase("recovery", 1, 1), phase("final_quality", 2, 6)],
    taperWeeks: 2,
    milestones: [
      { phase: "recovery", signal: "HRV", criterion: "回基线" },
      { phase: "final_quality", signal: "M 配速课", criterion: "彩排完成" },
    ],
    volumeBands: [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 44 },
      { phase: "final_quality", weekly_km_min: 50, weekly_km_max: 100 },
    ],
  });
  assert.ok(failing(validatePhaseIntent(goodShape, 6, raced), "I11")?.pass);
});
