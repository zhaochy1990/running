import assert from "node:assert/strict";
import test from "node:test";
import type { RunWorkout, WorkoutStep } from "@stride/contract";
import type { PaceZones } from "./derive.js";
import { type SessionUnderTest, validateWeekContent, type WeekContentInput } from "./validators.js";

const ZONES: PaceZones = { easy: [288, 336], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] };
const EASY = { kind: "pace_s_km" as const, low: 288, high: 336 };
const M_PACE = { kind: "pace_s_km" as const, low: 249, high: 288 };
const T_PACE = { kind: "pace_s_km" as const, low: 235, high: 249 };
const OPEN = { kind: "open" as const, low: null, high: null };

const s = (step_kind: WorkoutStep["step_kind"], duration: WorkoutStep["duration"], target: WorkoutStep["target"]): WorkoutStep => ({
  step_kind,
  duration,
  target,
  note: null,
  hr_cap_bpm: null,
});
const km = (value: number) => ({ kind: "distance_m" as const, value: value * 1000 });

const W = (over: Partial<RunWorkout> & Pick<RunWorkout, "name" | "date" | "blocks">): RunWorkout =>
  ({
    schema: "run-workout/v1",
    note: null,
    type: null,
    purpose: "测试课说明",
    ...over,
  }) as RunWorkout;

/** 绿色周：E 6km + M 课 10km（热身/主体/放松）+ LR 15km（E 主体 + M 尾段 + 放松）。 */
function greenSessions(): SessionUnderTest[] {
  return [
    {
      workout: W({
        name: "E 6km",
        date: "2026-11-02",
        type: "E",
        blocks: [{ repeat: 1, steps: [s("work", km(6), EASY)] }],
      }),
    },
    {
      workout: W({
        name: "M 6km",
        date: "2026-11-03",
        type: "M",
        note: "起跑别冲",
        blocks: [{ repeat: 1, steps: [s("warmup", km(2), EASY), s("work", km(6), M_PACE), s("cooldown", km(2), EASY)] }],
      }),
    },
    {
      workout: W({
        name: "长跑 15km 含 3km M",
        date: "2026-11-08",
        type: "LR",
        note: "尾段补给要点",
        blocks: [{ repeat: 1, steps: [s("work", km(11), EASY), s("work", km(3), M_PACE), s("cooldown", km(1), EASY)] }],
      }),
    },
  ];
}

function weekInput(sessions: SessionUnderTest[], over: Partial<WeekContentInput> = {}): WeekContentInput {
  return {
    sessions,
    row: { total_km: 31, long_run_km: 15, quality_sessions: 2 },
    zones: ZONES,
    maxTrainingDays: 6,
    ...over,
  };
}

const byId = (checks: ReturnType<typeof validateWeekContent>, id: string) => {
  const hit = checks.find((c) => c.id === id);
  assert.ok(hit != null, `check ${id} missing`);
  return hit;
};

test("绿色基线：一致性 + C1-C8 全过", () => {
  const checks = validateWeekContent(weekInput(greenSessions()));
  assert.equal(checks.length, 10);
  for (const c of checks) assert.equal(c.pass, true, `${c.id}: ${c.detail}`);
});

test("C1 周量守恒：Σ超 ±max(3km,3%) 挂、totals 不可知挂", () => {
  const drifted = greenSessions();
  drifted[0] = { workout: { ...drifted[0]!.workout, blocks: [{ repeat: 1, steps: [s("work", km(11), EASY)] }] } };
  assert.equal(byId(validateWeekContent(weekInput(drifted)), "C1 周量守恒").pass, false);

  const unknown = greenSessions();
  unknown[0] = { workout: { ...unknown[0]!.workout, blocks: [{ repeat: 1, steps: [s("work", { kind: "time_s", value: 2400 }, EASY)] }] } };
  const g1 = byId(validateWeekContent(weekInput(unknown)), "C1 周量守恒");
  assert.equal(g1.pass, false);
  assert.match(g1.detail, /不可知/);
});

test("C2 长跑唯一：双 LR 挂、里程偏差 >1.5km 挂、赛周 lr=null 要求 0 节", () => {
  const two = greenSessions();
  two[0] = { workout: { ...two[0]!.workout, type: "LR" } };
  assert.equal(byId(validateWeekContent(weekInput(two)), "C2 长跑唯一").pass, false);

  const off = greenSessions();
  off[2] = { workout: { ...off[2]!.workout, blocks: [{ repeat: 1, steps: [s("work", km(13), EASY), s("work", km(3), M_PACE), s("cooldown", km(1), EASY)] }] } };
  assert.equal(byId(validateWeekContent(weekInput(off)), "C2 长跑唯一").pass, false);

  const raceWeek = weekInput(greenSessions(), { row: { total_km: 45, long_run_km: null, quality_sessions: 1 } });
  assert.equal(byId(validateWeekContent(raceWeek), "C2 长跑唯一").pass, false);
  const noLr = greenSessions().filter((x) => x.workout.type !== "LR");
  const raceWeekOk = weekInput(noLr, { row: { total_km: 16, long_run_km: null, quality_sessions: 1 } });
  assert.equal(byId(validateWeekContent(raceWeekOk), "C2 长跑唯一").pass, true);
});

test("C3 Q配额：质量课数对不上挂（去掉 LR 尾段）", () => {
  const pure = greenSessions();
  pure[2] = { workout: { ...pure[2]!.workout, name: "长跑 15km", blocks: [{ repeat: 1, steps: [s("work", km(14), EASY), s("cooldown", km(1), EASY)] }] } };
  const g3 = byId(validateWeekContent(weekInput(pure)), "C3 Q配额");
  assert.equal(g3.pass, false);
  assert.match(g3.detail, /1 节质量课 vs 配额2/);
});

test("C4 训练日：按 date 去重后超上限挂", () => {
  const seven: SessionUnderTest[] = Array.from({ length: 7 }, (_, i) => ({
    workout: W({ name: `E ${i + 1}`, date: `2026-11-0${i + 1}`, type: "E", blocks: [{ repeat: 1, steps: [s("work", km(3), EASY)] }] }),
  }));
  const g4 = byId(validateWeekContent(weekInput(seven, { row: { total_km: 21, long_run_km: 3, quality_sessions: 0 } })), "C4 训练日");
  assert.equal(g4.pass, false);
  assert.match(g4.detail, /7 天 vs ≤6/);
});

test("C5 配速谱内：谱外慢配速挂、recovery 步带配速处方挂、hr 处方跳过、warmup/cooldown 快配速挂（M2）", () => {
  const tooSlow = greenSessions();
  tooSlow[0] = { workout: { ...tooSlow[0]!.workout, blocks: [{ repeat: 1, steps: [s("work", km(6), { kind: "pace_s_km", low: 320, high: 380 })] }] } };
  const g5a = byId(validateWeekContent(weekInput(tooSlow)), "C5 配速谱内");
  assert.equal(g5a.pass, false);
  assert.match(g5a.detail, /∉谱∪E带/);

  const pacedRecovery = greenSessions();
  pacedRecovery[1] = {
    workout: {
      ...pacedRecovery[1]!.workout,
      blocks: [{ repeat: 1, steps: [s("warmup", km(2), EASY), s("work", km(6), M_PACE), s("recovery", km(1), EASY), s("cooldown", km(2), EASY)] }],
    },
  };
  const g5b = byId(validateWeekContent(weekInput(pacedRecovery)), "C5 配速谱内");
  assert.equal(g5b.pass, false);
  assert.match(g5b.detail, /recovery步带配速处方/);

  // warmup/cooldown 是有氧步：T 配速虽落质量谱，仍只认 E 带 ±10（谱内不豁免）
  const fastCooldown = greenSessions();
  fastCooldown[1] = {
    workout: {
      ...fastCooldown[1]!.workout,
      blocks: [{ repeat: 1, steps: [s("warmup", km(2), EASY), s("work", km(6), M_PACE), s("cooldown", km(2), T_PACE)] }],
    },
  };
  const g5c = byId(validateWeekContent(weekInput(fastCooldown)), "C5 配速谱内");
  assert.equal(g5c.pass, false);
  assert.match(g5c.detail, /cooldown@235-249∉E带/);

  const hr = greenSessions();
  hr[0] = { workout: { ...hr[0]!.workout, blocks: [{ repeat: 1, steps: [s("work", km(6), { kind: "hr_bpm", low: 140, high: 155 })] }] } };
  assert.equal(byId(validateWeekContent(weekInput(hr)), "C5 配速谱内").pass, true);
});

test("C6 note语义：纯有氧课 note 应 null；有 strides 或 LR 合法", () => {
  const chatty = greenSessions();
  chatty[0] = { workout: { ...chatty[0]!.workout, note: "放松跑" } };
  const g6 = byId(validateWeekContent(weekInput(chatty)), "C6 note语义");
  assert.equal(g6.pass, false);
  assert.match(g6.detail, /note应null/);

  const withStrides = greenSessions();
  withStrides[0] = {
    workout: {
      ...withStrides[0]!.workout,
      note: "快步跑保持触感",
      blocks: [{ repeat: 1, steps: [s("work", km(6), EASY), s("work", { kind: "distance_m", value: 100 }, OPEN)] }],
    },
  };
  assert.equal(byId(validateWeekContent(weekInput(withStrides)), "C6 note语义").pass, true);
});

test("C7 热身放松在场：缺挂；比赛课与 LR 位型课豁免", () => {
  const noCooldown = greenSessions();
  noCooldown[1] = {
    workout: { ...noCooldown[1]!.workout, blocks: [{ repeat: 1, steps: [s("warmup", km(2), EASY), s("work", km(8), M_PACE)] }] },
  };
  const g7 = byId(validateWeekContent(weekInput(noCooldown)), "C7 热身放松在场");
  assert.equal(g7.pass, false);
  assert.match(g7.detail, /M 6km/);

  // 同样的课=比赛课（date=raceDate）→ 豁免
  const raceDate = noCooldown[1]!.workout.date;
  assert.equal(byId(validateWeekContent(weekInput(noCooldown, { raceDate })), "C7 热身放松在场").pass, true);

  // LR 无独立热身（E 主体即热身）→ 豁免
  const lrNoWarmup = greenSessions();
  lrNoWarmup[2] = {
    workout: { ...lrNoWarmup[2]!.workout, blocks: [{ repeat: 1, steps: [s("work", km(11), EASY), s("work", km(4), M_PACE)] }] },
  };
  assert.equal(byId(validateWeekContent(weekInput(lrNoWarmup)), "C7 热身放松在场").pass, true);
});

test("C8 展开守恒：repeat 展开与期望里程对不上挂、一致过、无锚跳过", () => {
  const anchored = greenSessions().map((x, i) => ({ ...x, expectedKm: [6, 10, 15][i]! }));
  assert.equal(byId(validateWeekContent(weekInput(anchored)), "C8 展开守恒").pass, true);

  // 3×(2km T + 400m recovery) 的课：期望 10.4km，blocks 只展开 7.2km → 挂（组数×步距算术错）
  const arithmetic: SessionUnderTest = {
    expectedKm: 10.4,
    workout: W({
      name: "T 3×2km",
      date: "2026-11-03",
      type: "T",
      blocks: [{ repeat: 3, steps: [s("work", km(2), T_PACE), s("recovery", { kind: "distance_m", value: 400 }, OPEN)] }],
    }),
  };
  const single = weekInput([arithmetic], { row: { total_km: 7.2, long_run_km: null, quality_sessions: 1 } });
  const g8 = byId(validateWeekContent(single), "C8 展开守恒");
  assert.equal(g8.pass, false);
  assert.match(g8.detail, /7.2vs10.4/);

  assert.equal(byId(validateWeekContent(weekInput(greenSessions())), "C8 展开守恒").detail, "无期望锚，跳过");
});

test("一致性 type罩主段：声明与主段带不符挂；LR 内嵌合法；type null/无主段跳过", () => {
  const mismatch = greenSessions();
  mismatch[1] = {
    workout: {
      ...mismatch[1]!.workout,
      type: "T",
      blocks: [{ repeat: 1, steps: [s("warmup", km(2), EASY), s("work", km(6), M_PACE), s("cooldown", km(2), EASY)] }],
    },
  };
  const c1 = byId(validateWeekContent(weekInput(mismatch)), "一致性 type罩主段");
  assert.equal(c1.pass, false);
  assert.match(c1.detail, /声明T主段@249-288/);

  // 跨带（MP-10s 落 T+M 交界）声明 M 仍罩住（±10s 容差）
  const cross = greenSessions();
  cross[1] = {
    workout: {
      ...cross[1]!.workout,
      blocks: [{ repeat: 1, steps: [s("warmup", km(2), EASY), s("work", km(6), { kind: "pace_s_km", low: 239, high: 279 }), s("cooldown", km(2), EASY)] }],
    },
  };
  assert.equal(byId(validateWeekContent(weekInput(cross)), "一致性 type罩主段").pass, true);

  // 声明 E 却有 T 主段 → 挂
  const fakeE = greenSessions();
  fakeE[0] = { workout: { ...fakeE[0]!.workout, blocks: [{ repeat: 1, steps: [s("work", km(6), T_PACE)] }] } };
  assert.equal(byId(validateWeekContent(weekInput(fakeE)), "一致性 type罩主段").pass, false);
});

test("一致性 type罩主段：R 带快端开放按开放界处理（M1）——type=R 不误报带缺失", () => {
  // chaoyi 校准带 r=[null,218]：R 带无快端下限，罩带只比较有值一侧（慢端）
  const rSession: SessionUnderTest = {
    workout: W({
      name: "R 400m×5",
      date: "2026-11-03",
      type: "R",
      blocks: [
        {
          repeat: 5,
          steps: [
            s("work", { kind: "distance_m", value: 400 }, { kind: "pace_s_km", low: 180, high: 200 }),
            s("recovery", { kind: "distance_m", value: 400 }, OPEN),
          ],
        },
      ],
    }),
  };
  const single = weekInput([rSession], { row: { total_km: 4, long_run_km: null, quality_sessions: 1 } });
  const c1 = byId(validateWeekContent(single), "一致性 type罩主段");
  assert.equal(c1.pass, true, c1.detail);

  // 有值一侧仍须罩住：声明 R 但主段落在 M 带 → 挂
  const misplaced = {
    workout: { ...rSession.workout, blocks: [{ repeat: 5, steps: [s("work", km(1), M_PACE), s("recovery", { kind: "distance_m", value: 400 }, OPEN)] }] },
  };
  const bad = byId(validateWeekContent(weekInput([misplaced], { row: { total_km: 7, long_run_km: null, quality_sessions: 1 } })), "一致性 type罩主段");
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /声明R主段@249-288/);
});

test("一致性 purpose必填：新生成课缺 purpose 挂；legacy 豁免", () => {
  const missing = greenSessions();
  missing[0] = { workout: { ...missing[0]!.workout, purpose: null } };
  assert.equal(byId(validateWeekContent(weekInput(missing)), "一致性 purpose必填").pass, false);

  const legacy = validateWeekContent(weekInput(missing, { requirePurpose: false }));
  assert.equal(byId(legacy, "一致性 purpose必填").pass, true);
  assert.equal(byId(legacy, "一致性 purpose必填").detail, "legacy豁免");
});
