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

/** 绿色周（⑨量纲）：E 60min（time 处方）+ M 课 10km（热身/主体/放松）+ LR 15km（E 主体 + M 尾段 + 放松）。 */
function greenSessions(): SessionUnderTest[] {
  return [
    {
      workout: W({
        name: "E 60min",
        date: "2026-11-02",
        type: "E",
        blocks: [{ repeat: 1, steps: [s("work", { kind: "time_s", value: 3600 }, EASY)] }],
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
    // E 60min@E 带中点 312s/km 派生 11.5km + M 课 10km + LR 15km
    row: { total_km: 36.5, long_run_km: 15, quality_sessions: 2 },
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

test("绿色基线：一致性 + C1-C9 全过（E time 处方派生里程参与 C1）", () => {
  const checks = validateWeekContent(weekInput(greenSessions()));
  assert.equal(checks.length, 11);
  for (const c of checks) assert.equal(c.pass, true, `${c.id}: ${c.detail}`);
});

test("C1 周量守恒：Σ超 ±max(3km,3%) 挂、time+open 步里程不可知挂", () => {
  const drifted = greenSessions();
  drifted[1] = {
    workout: { ...drifted[1]!.workout, blocks: [{ repeat: 1, steps: [s("warmup", km(2), EASY), s("work", km(11), M_PACE), s("cooldown", km(2), EASY)] }] },
  };
  assert.equal(byId(validateWeekContent(weekInput(drifted)), "C1 周量守恒").pass, false);

  const unknown = greenSessions();
  unknown[0] = { workout: { ...unknown[0]!.workout, blocks: [{ repeat: 1, steps: [s("work", { kind: "time_s", value: 3600 }, OPEN)] }] } };
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

test("C8 展开守恒：repeat 展开与期望里程对不上挂、一致过（E 派生口径）、无锚跳过", () => {
  // E 60min time 处方按 E 带中点派生 11.5km（⑨：派生 km 参与）
  const anchored = greenSessions().map((x, i) => ({ ...x, expectedKm: [11.5, 10, 15][i]! }));
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

test("一致性 type罩主段：比赛课豁免（规则⑤处方锚 goal_pace，不罩投影带）", () => {
  // 激进目标：goal 242s/km 快于投影 M 带快端 249——罩带会误挂，但 date=raceDate 豁免
  const race: SessionUnderTest = {
    workout: W({
      name: "上海马拉松 42.2km",
      date: "2026-11-08",
      type: "M",
      purpose: "比赛课",
      note: "按计划补给",
      blocks: [{ repeat: 1, steps: [s("work", km(42.2), { kind: "pace_s_km", low: 237, high: 247 })] }],
    }),
  };
  const single = weekInput([race], { row: { total_km: 42.2, long_run_km: null, quality_sessions: 1 }, raceDate: "2026-11-08" });
  assert.equal(byId(validateWeekContent(single), "一致性 type罩主段").pass, true);
  // 同一节去掉比赛日身份 → 罩带挂（M 带 249-288 罩不住 237-247）
  const notRace = weekInput([race]);
  assert.equal(byId(validateWeekContent(notRace), "一致性 type罩主段").pass, false);
});

test("C9 E课时长分层：间隔日 30-60、普通日 60-90、duration 必填（distance 步挂）、strides 豁免", () => {
  const eOf = (name: string, date: string, duration: WorkoutStep["duration"], extra: WorkoutStep[] = []): SessionUnderTest => ({
    workout: W({ name, date, type: "E", blocks: [{ repeat: 1, steps: [s("work", duration, EASY), ...extra] }] }),
  });
  const m = greenSessions()[1]!;
  const lr = greenSessions()[2]!;
  // 周二 M（质量）+ 周四 M?——用 Tue M + Sat M 制造 Wed 间隔日；Mon/Thu=普通日
  const m2: SessionUnderTest = {
    workout: {
      ...m.workout,
      name: "M 5km",
      date: "2026-11-07",
      blocks: [{ repeat: 1, steps: [s("warmup", km(2), EASY), s("work", km(5), M_PACE), s("cooldown", km(2), EASY)] }],
    },
  };
  const base: SessionUnderTest[] = [
    eOf("E 周一 60min", "2026-11-02", { kind: "time_s", value: 3600 }),
    m,
    eOf("E 周三 45min", "2026-11-04", { kind: "time_s", value: 2700 }),
    m2,
    lr,
  ];
  // 周一普通日 60min ✓、周三间隔日（周二 M/周六 M/周日 LR 尾段三节质量课之间）45min ✓
  const row = { total_km: 54.2, long_run_km: 15, quality_sessions: 3 };
  const ok = validateWeekContent(weekInput(base, { row }));
  assert.equal(byId(ok, "C9 E课时长分层").pass, true, byId(ok, "C9 E课时长分层").detail);

  // 普通日落短带（30min）挂
  const tooShort = [...base];
  tooShort[0] = eOf("E 周一 30min", "2026-11-02", { kind: "time_s", value: 1800 });
  assert.equal(byId(validateWeekContent(weekInput(tooShort, { row })), "C9 E课时长分层").pass, false);

  // 间隔日落长带（90min）挂
  const tooLong = [...base];
  tooLong[2] = eOf("E 周三 90min", "2026-11-04", { kind: "time_s", value: 5400 });
  assert.equal(byId(validateWeekContent(weekInput(tooLong, { row })), "C9 E课时长分层").pass, false);

  // duration 必填：E 主体 distance 步挂（⑨ 量纲=时间）
  const distanceE = [...base];
  distanceE[0] = eOf("E 周一 11.5km", "2026-11-02", km(11.5));
  const g9 = byId(validateWeekContent(weekInput(distanceE, { row })), "C9 E课时长分层");
  assert.equal(g9.pass, false);
  assert.match(g9.detail, /duration缺失/);

  // strides（open 短 work 步）不计时长也不算缺失
  const withStrides = [...base];
  withStrides[0] = eOf("E 周一 60min", "2026-11-02", { kind: "time_s", value: 3600 }, [s("work", { kind: "distance_m", value: 100 }, OPEN)]);
  assert.equal(byId(validateWeekContent(weekInput(withStrides, { row })), "C9 E课时长分层").pass, true);
});

test("C9 赛周激活课豁免：比赛日前 1-3 天短 E 不受下限约束；赛前 4+ 天仍按带", () => {
  const race: SessionUnderTest = {
    workout: W({
      name: "上海马拉松 42.2km",
      date: "2026-11-08",
      type: "M",
      purpose: "比赛课",
      note: null,
      blocks: [{ repeat: 1, steps: [s("work", km(42.2), M_PACE)] }],
    }),
  };
  const shake = (date: string, minutes: number): SessionUnderTest => ({
    workout: W({ name: `赛前激活 ${minutes}min`, date, type: "E", blocks: [{ repeat: 1, steps: [s("work", { kind: "time_s", value: minutes * 60 }, EASY)] }] }),
  });
  const row = { total_km: 52, long_run_km: null, quality_sessions: 1 };
  // 周日比赛：周五（前 2 天）20min 激活 ✓
  const ok = weekInput([race, shake("2026-11-06", 20)], { row, raceDate: "2026-11-08" });
  assert.equal(byId(validateWeekContent(ok), "C9 E课时长分层").pass, true, byId(validateWeekContent(ok), "C9 E课时长分层").detail);
  // 周一（前 6 天）20min → 普通日下限挂
  const far = weekInput([race, shake("2026-11-02", 20)], { row, raceDate: "2026-11-08" });
  assert.equal(byId(validateWeekContent(far), "C9 E课时长分层").pass, false);
  // 窗内豁免只放开下限：80min「激活」不是短 E，挂（①「短」语义）
  const tooLongShake = weekInput([race, shake("2026-11-06", 80)], { row, raceDate: "2026-11-08" });
  const g9s = byId(validateWeekContent(tooLongShake), "C9 E课时长分层");
  assert.equal(g9s.pass, false);
  assert.match(g9s.detail, /超短带上限/);
});

test("C1 赛周托底：骨架低于 42.195 时目标=比赛里程，detail 打有效目标（重试可对齐）", () => {
  const race: SessionUnderTest = {
    workout: W({
      name: "测试马拉松 42.2km",
      date: "2026-11-08",
      type: "M",
      purpose: "比赛课",
      note: null,
      blocks: [{ repeat: 1, steps: [s("work", km(42.2), M_PACE)] }],
    }),
  };
  // pan 型低平台赛周：骨架 37.8 < 42.195——按托底目标 42.195 判（Σ=42.2 过）
  const floor = weekInput([race], { row: { total_km: 37.8, long_run_km: null, quality_sessions: 1 }, raceDate: "2026-11-08" });
  const g1 = byId(validateWeekContent(floor), "C1 周量守恒");
  assert.equal(g1.pass, true, g1.detail);
  assert.match(g1.detail, /赛周托底42\.2/);
  // 非赛周不托底：骨架 36.5 vs Σ36.5 照常
  assert.match(byId(validateWeekContent(weekInput(greenSessions())), "C1 周量守恒").detail, /vs 骨架36\.5/);
});

test("C9 LR 前日轻量（#825）：E ≤8km 或休、时长下限豁免；超帽挂（按日合计里程判）", () => {
  const eOf = (name: string, date: string, minutes: number): SessionUnderTest => ({
    workout: W({ name, date, type: "E", blocks: [{ repeat: 1, steps: [s("work", { kind: "time_s", value: minutes * 60 }, EASY)] }] }),
  });
  const lr = greenSessions()[2]!; // LR 周日 2026-11-08 → 前日=周六 11-07
  const row = { total_km: 30, long_run_km: 15, quality_sessions: 1 };
  // 周六 40min（E 带中点 312s/km 折算 7.7km ≤8）✓——短于普通日 60min 下限也过（下限豁免）
  const ok = weekInput([eOf("E 周六 40min", "2026-11-07", 40), lr], { row });
  assert.equal(byId(validateWeekContent(ok), "C9 E课时长分层").pass, true, byId(validateWeekContent(ok), "C9 E课时长分层").detail);
  // 周六 75min（≈14.4km >8km）挂——普通日带内也过不了 8km 帽
  const over = weekInput([eOf("E 周六 75min", "2026-11-07", 75), lr], { row });
  const g9 = byId(validateWeekContent(over), "C9 E课时长分层");
  assert.equal(g9.pass, false);
  assert.match(g9.detail, /LR前日.*轻量帽/);
  // 按日合计判：两节各 40min（各 ≈7.7km 单课合法、合计 ≈15.4km >8km）挂——帽管日不管课
  const split = weekInput([eOf("E 周六 40min 早", "2026-11-07", 40), eOf("E 周六 40min 晚", "2026-11-07", 40), lr], { row });
  const g9s = byId(validateWeekContent(split), "C9 E课时长分层");
  assert.equal(g9s.pass, false);
  assert.match(g9s.detail, /LR前日.*合计.*轻量帽/);
  // 无 LR 的周没有「前日」语义：周六 E 按普通日带 60-90 正常判
  const noLr = weekInput([eOf("E 周六 75min", "2026-11-07", 75)], { row: { total_km: 20, long_run_km: null, quality_sessions: 0 } });
  assert.equal(byId(validateWeekContent(noLr), "C9 E课时长分层").pass, true, byId(validateWeekContent(noLr), "C9 E课时长分层").detail);
});

test("C9 再生周（recovery）短带 + legacy 豁免", () => {
  const e = (minutes: number): SessionUnderTest => ({
    workout: W({
      name: `E ${minutes}min`,
      date: "2026-11-02",
      type: "E",
      blocks: [{ repeat: 1, steps: [s("work", { kind: "time_s", value: minutes * 60 }, EASY)] }],
    }),
  });
  const lr: SessionUnderTest = {
    workout: W({ name: "长跑 4.5km", date: "2026-11-08", type: "LR", note: "轻松跑", blocks: [{ repeat: 1, steps: [s("work", km(4.5), EASY)] }] }),
  };
  const row = { total_km: 15, long_run_km: 4.5, quality_sessions: 0 };
  // 再生周：40min 短带合法；非再生周（普通日）40min 挂
  assert.equal(byId(validateWeekContent(weekInput([e(40), lr], { row, regeneration: true })), "C9 E课时长分层").pass, true);
  assert.equal(byId(validateWeekContent(weekInput([e(40), lr], { row })), "C9 E课时长分层").pass, false);
  // legacy（⑨ 前样本）整条豁免
  const legacy = validateWeekContent(weekInput([e(20), lr], { row, legacyEDuration: true }));
  assert.equal(byId(legacy, "C9 E课时长分层").pass, true);
  assert.equal(byId(legacy, "C9 E课时长分层").detail, "legacy豁免");
});
