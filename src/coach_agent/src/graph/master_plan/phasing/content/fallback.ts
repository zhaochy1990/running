import { normalizeRunWorkout, type RunWorkout } from "@stride/contract";
import { allocateRaceWeek, allocateWeek } from "./allocate.js";
import { type ContentGeneratorInput, type ContentWeekRow, fmtPace } from "./doctrine.js";

/**
 * 简版模板兜底（devops#811，daniels-l4-content.md §5）：重试耗尽/调用失败时的
 * 确定性直出——M 课（热身/主体/放松）+ LR（纯 E 主体）+ E 时长填充的最小合法周。
 * 量账=allocate.ts 的可行解分配（C1×C9 联立带内构造，38 案例全量验证）；
 * 构造保证过全部校验（兜底永远合法）；#798 课表库落地后替换为库直出
 * （本模块即替换点，generate.ts 的接入面不变）。
 */

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Day = (typeof DAY_LABELS)[number];
const DAY_INDEX: Record<Day, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const dateOf = (planStartMonday: string, week: number, weekday: number): string => {
  const d = new Date(`${planStartMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (week - 1) * 7 + weekday);
  return d.toISOString().slice(0, 10);
};

const easyBand = (row: ContentWeekRow): [number, number] => {
  const [lo, hi] = row.zones.easy ?? [null, null];
  if (lo == null || hi == null) throw new Error(`templateFallback: 第${row.week}周 easy 带缺失`);
  return [lo, hi];
};
const mBand = (row: ContentWeekRow): [number, number] => {
  const [lo, hi] = row.zones.m ?? [null, null];
  if (lo == null || hi == null) throw new Error(`templateFallback: 第${row.week}周 m 带缺失`);
  return [lo, hi];
};

const step = (
  stepKind: RunWorkout["blocks"][number]["steps"][number]["step_kind"],
  duration: RunWorkout["blocks"][number]["steps"][number]["duration"],
  target: RunWorkout["blocks"][number]["steps"][number]["target"],
) => ({ step_kind: stepKind, duration, target, note: null, hr_cap_bpm: null });
const pace = (band: readonly [number, number]) => ({ kind: "pace_s_km" as const, low: band[0], high: band[1] });
const r1 = (x: number) => Math.round(x * 10) / 10;

function workout(
  name: string,
  date: string,
  type: RunWorkout["type"],
  purpose: string,
  note: string | null,
  steps: RunWorkout["blocks"][number]["steps"],
): RunWorkout {
  return normalizeRunWorkout({ name, date, type, purpose, note, blocks: [{ repeat: 1, steps }] });
}

/** 比赛周：比赛课（锚 goal_pace）+ 赛前 1-3 天短 E 激活（C9 豁免窗内）。 */
function raceWeekSessions(row: ContentWeekRow, input: ContentGeneratorInput): RunWorkout[] {
  const race = input.race;
  const goal = race.goalPaceSKm;
  const goalBand: [number, number] = [Math.max(1, Math.round(goal - 5)), Math.round(goal + 5)];
  const alloc = allocateRaceWeek(row, race);
  const sessions: RunWorkout[] = [
    workout(
      `${race.name} 42.2km`,
      race.date,
      "M",
      `比赛课：${race.name}按目标 ${race.targetTime}（配速 ${fmtPace(goal)}/km）执行，前半程克制兴奋按计划补给，后半程专注动作放松。`,
      "起跑不冲，按配速带下沿跟进；补给按赛前演练节奏执行。",
      [step("work", { kind: "distance_m", value: 42195 }, pace(goalBand))],
    ),
  ];
  for (const shake of alloc.shakes) {
    sessions.push(
      workout(
        `赛前激活 ${Math.round(shake.minutes)}min`,
        dateOf(input.planStartMonday, row.week, shake.weekday),
        "E",
        `赛前激活：短 E 慢跑保持腿部活性与血流量，为${race.name}减量到位，不追强度。`,
        null,
        [step("work", { kind: "time_s", value: Math.round(shake.minutes * 60) }, pace(easyBand(row)))],
      ),
    );
  }
  return sessions;
}

/** 常规周：LR（周日）+ q 节 M 课（周二/周五）+ E 时长填充（分配器出可行解，模板直出）。 */
function normalWeekSessions(row: ContentWeekRow, input: ContentGeneratorInput, regeneration: boolean): RunWorkout[] {
  const eBand = easyBand(row);
  const alloc = allocateWeek(row, input.athlete.weeklyRunDaysMax, regeneration);
  const sessions: RunWorkout[] = [];
  sessions.push(
    workout(
      `长跑 ${r1(alloc.lr)}km`,
      dateOf(input.planStartMonday, row.week, 6),
      "LR",
      `长跑课：${r1(alloc.lr)}km E 配速积累耐力，全程可交谈配速，注意补给节奏。`,
      "每 5km 少量补水；后半程配速不快于 E 带上沿。",
      [step("work", { kind: "distance_m", value: Math.round(alloc.lr * 1000) }, pace(eBand))],
    ),
  );
  const qualityWds = alloc.qualityWeekdays;
  for (const wd of qualityWds) {
    const m = mBand(row);
    sessions.push(
      workout(
        `M ${r1(alloc.mBodyKm)}km`,
        dateOf(input.planStartMonday, row.week, wd),
        "M",
        `马配专项课：M 配速主体 ${r1(alloc.mBodyKm)}km 演练比赛节奏${row.role === "taper" ? "，减量期保持强度触感（维持原则）" : "，专项耐力核心刺激"}。`,
        "主体按 M 带执行，心率漂移超上限即放 5s/km。",
        [
          step("warmup", { kind: "time_s", value: (alloc.warmupMin + alloc.warmupCooldownExtraMin / 2) * 60 }, pace(eBand)),
          step("work", { kind: "distance_m", value: Math.round(alloc.mBodyKm * 1000) }, pace(m)),
          step("cooldown", { kind: "time_s", value: (alloc.cooldownMin + alloc.warmupCooldownExtraMin / 2) * 60 }, pace(eBand)),
        ],
      ),
    );
  }
  for (const e of alloc.eSessions) {
    sessions.push(
      workout(
        `E ${Math.round(e.minutes)}min`,
        dateOf(input.planStartMonday, row.week, e.weekday),
        "E",
        regeneration
          ? `恢复周轻松课：${Math.round(e.minutes)} 分钟 E 配速促进恢复，保持腿部活性，不追强度。`
          : `有氧轻松课：${Math.round(e.minutes)} 分钟 E 配速巩固有氧地基，全程可交谈。`,
        null,
        [step("work", { kind: "time_s", value: Math.round((e.minutes * 60) / 30) * 30 }, pace(eBand))],
      ),
    );
  }
  return sessions;
}

export interface WeekContentResult {
  week: number;
  sessions: RunWorkout[];
}

/** 兜底入口：逐周确定性构造（L3 行 → 最小合法课表）。 */
export function templateFallback(input: ContentGeneratorInput): WeekContentResult[] {
  return input.rows.map((row) => ({
    week: row.week,
    sessions: row.role === "race" ? raceWeekSessions(row, input) : normalWeekSessions(row, input, row.phase === "recovery"),
  }));
}
