import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunWorkout } from "@stride/contract";
import type { ContentWeekRow } from "../doctrine.js";
import { LR_EVE_MAX_KM, sessionKm } from "../validators.js";
import { DEFAULT_DOSE_COEFFICIENTS } from "./dose.js";
import { type ESlotCourse, type StructuredCourse, scheduleOnly, scheduleWeeks, type WeekBag, type WeekSchedule } from "./scheduler.js";

/**
 * 波浪调度器单测（devops#799 验收）：POC（wave-poc.mjs）行为复现——chaoyi 六周
 * 锯齿显形（峰 1.1-1.2/谷 ~1.0）、教练语法涌现（Q 隔日/LR 周日/周六轻量/短课
 * 消化）、C1 全周命中（POC 丢课 bug 修复：谷阈值动态化+强制窗口含周五）、
 * load_series 契约、scheduleOnly R0 入口、无解上浮路径。
 */

const ZONES = { easy: [296, 346], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] } as const;

/** chaoyi 投影带形态的六周骨架（e2e2-shanghai 的 L3 行：84.9→54.9km）。 */
const ROWS: ContentWeekRow[] = [
  { week: 1, phase: "final_quality", role: "progress", totalKm: 84.9, longRunKm: 30.6, qualitySessions: 2, qualityFamily: "M 配速比赛专项", zones: ZONES },
  { week: 2, phase: "final_quality", role: "progress", totalKm: 87.5, longRunKm: 31.5, qualitySessions: 2, qualityFamily: "M 配速比赛专项", zones: ZONES },
  { week: 3, phase: "final_quality", role: "absorb", totalKm: 65.6, longRunKm: 24, qualitySessions: 1, qualityFamily: "M 配速比赛专项", zones: ZONES },
  { week: 4, phase: "final_quality", role: "progress", totalKm: 84.9, longRunKm: 30.6, qualitySessions: 2, qualityFamily: "M 配速比赛专项", zones: ZONES },
  { week: 5, phase: "final_quality", role: "taper", totalKm: 72.2, longRunKm: 25, qualitySessions: 1, qualityFamily: "M 配速比赛专项", zones: ZONES },
  { week: 6, phase: "final_quality", role: "race", totalKm: 54.9, longRunKm: null, qualitySessions: 2, qualityFamily: "M 配速比赛专项", zones: ZONES },
];

type TestStep = StructuredCourse["blocks"][number]["steps"][number];
const step = (kind: TestStep["step_kind"], duration: TestStep["duration"], target: TestStep["target"]): TestStep => ({
  step_kind: kind,
  duration,
  target,
  note: null,
  hr_cap_bpm: null,
});
const easy = { kind: "pace_s_km", low: ZONES.easy[0], high: ZONES.easy[1] } as const;
const mPace = { kind: "pace_s_km", low: ZONES.m[0], high: ZONES.m[1] } as const;

const lrCourse = (km: number): StructuredCourse => ({
  kind: "course",
  name: `长跑 ${km}km`,
  type: "LR",
  purpose: "长跑课：E 配速积累耐力。",
  note: "每 5km 少量补水。",
  blocks: [{ repeat: 1, steps: [step("work", { kind: "distance_m", value: Math.round(km * 1000) }, easy)] }],
});

const mCourse = (km: number): StructuredCourse => ({
  kind: "course",
  name: `M ${km}km`,
  type: "M",
  purpose: "马配专项课：M 配速主体演练比赛节奏。",
  note: "主体按 M 带执行。",
  blocks: [
    {
      repeat: 1,
      steps: [
        step("warmup", { kind: "time_s", value: 15 * 60 }, easy),
        step("work", { kind: "distance_m", value: Math.round(km * 1000) }, mPace),
        step("cooldown", { kind: "time_s", value: 10 * 60 }, easy),
      ],
    },
  ],
});

const raceCourse = (): StructuredCourse => ({
  kind: "course",
  name: "上海马拉松 42.2km",
  type: "M",
  purpose: "比赛课：按目标配速执行。",
  note: null,
  blocks: [{ repeat: 1, steps: [step("work", { kind: "distance_m", value: 42195 }, { kind: "pace_s_km", low: 237, high: 247 })] }],
});

const eSlot = (band: "normal" | "interval" = "normal"): ESlotCourse => ({ kind: "e-slot", band, strides: false, purpose: null });

/** 常规周课包：LR + q 节 M 课 + 3 E 槽位（POC e2e2 同构）。 */
const normalBag = (row: ContentWeekRow): WeekBag => ({
  week: row.week,
  courses: [lrCourse(row.longRunKm!), ...Array.from({ length: row.qualitySessions }, () => mCourse(7)), eSlot("normal"), eSlot("interval"), eSlot("normal")],
});

const raceBag = (): WeekBag => ({ week: 6, courses: [raceCourse(), mCourse(4), eSlot("interval"), eSlot("interval")] });

const PLAN_START_MONDAY = "2026-10-19";
const RACE_DATE = "2026-11-29"; // 第 6 周周日

const CTX = {
  rows: ROWS,
  planStartMonday: PLAN_START_MONDAY,
  race: { name: "上海马拉松", date: RACE_DATE, targetTime: "2:50:00", goalPaceSKm: 242 },
  athlete: { weeklyRunDaysMax: 6 },
  // chaoyi 建设期种子：CTL≈38/ATL≈33（剂量单位；计划 84.9-87.5km 周 ≈45-47/日
  // 高于体能均衡点 → 爬坡期比值攀峰 1.1-1.2、吸收周回落——POC 波形复现的前提）
  pmcSeed: { acute: 33, chronic: 38 },
};

function scheduleAll(): { result: ReturnType<typeof scheduleWeeks>; weeks: WeekSchedule[] } {
  const bags = ROWS.map((row) => (row.role === "race" ? raceBag() : normalBag(row)));
  const result = scheduleWeeks(bags, CTX);
  return { result, weeks: result.weeks };
}

test("六周全链：P 门全绿 + C1 全周命中 + LR 周日 + 周六轻量 + Q 隔日（POC 行为复现）", () => {
  const { result, weeks } = scheduleAll();
  assert.ok(result.ok, `排位无解：${result.failures.join(";")}`);
  assert.equal(weeks.length, 6);
  for (const week of weeks) {
    // C1 周量守恒（±max(3km,3%)）——POC 丢课 bug 修复的验收锚点
    const row = ROWS[week.week - 1]!;
    const target = row.role === "race" ? Math.max(row.totalKm, 42.195) : row.totalKm;
    const sum = week.sessions.reduce((s, w) => s + (sessionKm(w) ?? 0), 0);
    const tol = Math.max(3, target * 0.03);
    assert.ok(Math.abs(sum - target) <= tol, `W${week.week} Σ${sum.toFixed(1)} vs ${target}（±${tol.toFixed(1)}）`);
    // P 门全绿
    for (const c of week.checks) assert.equal(c.pass, true, `W${week.week} ${c.id}: ${c.detail}`);
    // 教练语法：LR 周日 + 周六 E≤8km 或休
    if (row.role !== "race") {
      const lr = week.sessions.find((w) => w.type === "LR")!;
      assert.equal((new Date(`${lr.date}T00:00:00Z`).getUTCDay() + 6) % 7, 6, `W${week.week} LR 非周日`);
      const satKm = week.calendar[5]!.sessions.reduce((s, w) => s + (sessionKm(w) ?? 0), 0);
      assert.ok(
        week.calendar[5]!.sessions.every((w) => w.type === "E") && (week.calendar[5]!.sessions.length === 0 || satKm <= LR_EVE_MAX_KM + 0.1),
        `W${week.week} 周六非轻量`,
      );
    } else {
      // 赛周：比赛课钉比赛日（P4）、该周无 LR、激活课距赛 2-3 天
      assert.equal(
        week.sessions.some((w) => w.type === "LR"),
        false,
      );
      const race = week.sessions.find((w) => w.date === RACE_DATE)!;
      assert.ok(race, "比赛课钉比赛日");
      const act = week.sessions.find((w) => w.date !== RACE_DATE && w.type === "M")!;
      const gap = (new Date(`${RACE_DATE}T00:00:00Z`).getTime() - new Date(`${act.date}T00:00:00Z`).getTime()) / 86400_000;
      assert.ok(gap === 2 || gap === 3, `激活课距赛 ${gap} 天`);
    }
    // Q 隔日（不相邻）
    const qWds = week.calendar
      .filter((d) => d.sessions.some((s) => s.type === "M" || s.type === "T" || s.type === "I" || s.type === "R" || s.type === "LR"))
      .map((d) => (new Date(`${d.date}T00:00:00Z`).getUTCDay() + 6) % 7)
      .sort((a, b) => a - b);
    for (let i = 1; i < qWds.length; i++) assert.ok(qWds[i]! - qWds[i - 1]! >= 2, `W${week.week} Q 相邻 ${qWds.join(",")}`);
  }
  // load_series：42 点连续、比值在场、meta 契约（exp-pmc-7-42 + 系数版本 + 种子）
  assert.equal(
    result.weeks.reduce((s, w) => s + w.loadSeries.length, 0),
    42,
  );
  assert.equal(result.loadMeta.model, "exp-pmc-7-42");
  assert.equal(result.loadMeta.coefficient_version, "lsq-20261029");
  assert.equal(result.loadMeta.seed.acute, 33);
  for (const p of weeks[0]!.loadSeries) {
    assert.ok(p.ratio != null && p.atl > 0);
    assert.ok(Array.isArray(p.sessions));
  }
});

test("波浪显形：建设周峰谷差 ≥0.04（锯齿）、峰值 ≤cap 1.3、吸收周谷位回落", () => {
  const { result } = scheduleAll();
  assert.ok(result.ok, result.failures.join(";"));
  const ratiosOf = (w: number) => result.weeks[w - 1]!.loadSeries.map((p) => p.ratio ?? 0);
  for (const w of [1, 2, 4]) {
    const rs = ratiosOf(w);
    const peak = Math.max(...rs);
    const valley = Math.min(...rs);
    assert.ok(peak - valley >= 0.04, `W${w} 峰谷差 ${(peak - valley).toFixed(3)} 无锯齿`);
    assert.ok(peak <= 1.31, `W${w} 峰值 ${peak} 超 cap`);
  }
  // 吸收周（W3）回落：周均值低于前一建设周（剂量低→均值必低，物理稳健；
  // 峰对峰对比受跨周进位与 LR 日形状影响不稳定——周尾/周首负荷排布使峰位漂移）
  const avg = (rs: number[]) => rs.reduce((a, b) => a + b, 0) / rs.length;
  assert.ok(avg(ratiosOf(3)) < avg(ratiosOf(2)), "吸收周均值未回落");
});

test("E 实例化：间隔日短带、普通日长带、周六 km 帽、water-fill 后 C1 命中", () => {
  const { result } = scheduleAll();
  assert.ok(result.ok, result.failures.join(";"));
  const w1 = result.weeks[0]!;
  const eMinutes = (s: RunWorkout) =>
    s.blocks.reduce(
      (t, b) => t + b.repeat * b.steps.reduce((t2, st) => t2 + (st.step_kind === "work" && st.duration.kind === "time_s" ? st.duration.value / 60 : 0), 0),
      0,
    );
  for (const day of w1.calendar) {
    for (const s of day.sessions.filter((x) => x.type === "E")) {
      const min = eMinutes(s);
      const isSat = day.day === "Sat";
      assert.ok(min >= 29.4 && min <= 90.6, `${day.day} E ${min.toFixed(0)}min 出分层带`);
      if (isSat) assert.ok((sessionKm(s) ?? 0) <= LR_EVE_MAX_KM + 0.1, `周六 E ${sessionKm(s)?.toFixed(1)}km 超轻量帽`);
    }
  }
});

test("scheduleOnly（R0 微调）：单周重排不碰 LLM、同一 PMC 快照可复现", () => {
  const row = ROWS[0]!;
  const ctx = { weekMonday: PLAN_START_MONDAY, race: CTX.race, athlete: CTX.athlete, coefficients: DEFAULT_DOSE_COEFFICIENTS };
  const a = scheduleOnly(normalBag(row), row, ctx, CTX.pmcSeed);
  const b = scheduleOnly(normalBag(row), row, ctx, CTX.pmcSeed);
  assert.ok("calendar" in a && "calendar" in b);
  assert.deepEqual(
    (a as WeekSchedule).calendar.map((d) => d.sessions.map((s) => s.name)),
    (b as WeekSchedule).calendar.map((d) => d.sessions.map((s) => s.name)),
  );
  assert.equal((a as WeekSchedule).loadSeries.length, 7);
});

test("无解上浮：E 带满仍缺量 → failures 带原因（不抛、不静默剪结构课）", () => {
  // 结构课 30.6+2×11.7≈54km + 3 槽容量上限 ≈98.8km，目标 105km 带外（缺 6km 无处可放）
  const row: ContentWeekRow = { ...ROWS[0]!, totalKm: 105 };
  const result = scheduleWeeks([normalBag(row)], { ...CTX, rows: [row] });
  assert.ok(!result.ok);
  assert.match(result.failures.join(";"), /C1 周量/);
  assert.match(result.failures.join(";"), /课包结构课里程或槽数需调整/);
});

test("P5 双练准入：周量 ≤110km 槽位溢出 → 剪不加双练日；>110km → 双练日准入", () => {
  // 轻量周（62km ≤110）：5 天帽 + LR+Q+4 槽=6 课 → P1 剪周六槽位，不双练
  const lightRow: ContentWeekRow = { ...ROWS[0]!, totalKm: 62, longRunKm: 22, qualitySessions: 1 };
  const lightBag: WeekBag = { week: 1, courses: [lrCourse(22), mCourse(6), eSlot("interval"), eSlot("interval"), eSlot("normal"), eSlot("interval")] };
  const light = scheduleWeeks([lightBag], { ...CTX, rows: [lightRow], athlete: { weeklyRunDaysMax: 5 } });
  assert.ok(light.ok, light.failures.join(";"));
  assert.ok(!light.weeks[0]!.calendar.some((d) => d.sessions.length > 1), "≤110km 不应双练");
  assert.ok(
    light.weeks[0]!.repairs.some((r) => r.includes("剪除")),
    "溢出槽位应剪除留痕",
  );
  // 高量周（118km >110）：5 天帽 + LR+2Q+4 槽=7 课 → 双练日准入（P5）
  const heavyRow: ContentWeekRow = { ...ROWS[0]!, totalKm: 118, longRunKm: 32, qualitySessions: 2 };
  const heavyBag: WeekBag = { week: 1, courses: [lrCourse(32), mCourse(12), mCourse(12), eSlot(), eSlot(), eSlot("interval"), eSlot("interval")] };
  const heavy = scheduleWeeks([heavyBag], { ...CTX, rows: [heavyRow], athlete: { weeklyRunDaysMax: 5 } });
  assert.ok(heavy.ok, heavy.failures.join(";"));
  assert.ok(
    heavy.weeks[0]!.calendar.some((d) => d.sessions.length > 1),
    ">110km 应双练",
  );
  assert.ok(heavy.weeks[0]!.checks.find((c) => c.id.startsWith("P5"))!.pass);
});
