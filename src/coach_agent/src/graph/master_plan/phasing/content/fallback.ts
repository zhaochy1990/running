import { allocateRaceWeek, allocateWeek } from "./allocate.js";
import { type ContentGeneratorInput, type ContentWeekRow, fmtPace } from "./doctrine.js";
import type { ESlotCourse, StructuredCourse, WeekBag } from "./schedule/scheduler.js";
import { M_GOAL_TOL_S } from "./validators.js";

/**
 * 简版模板兜底（devops#811，#799 改课包形态）：重试耗尽/调用失败时的确定性
 * 直出——M 课（热身/主体/放松）+ LR（纯 E 主体）+ E 槽位（interval/normal），
 * 无日期（落位归 L4b）；赛周=比赛课 + M 配速激活短课（#825 简版：主体 3-5km+
 * strides，赛前 2-3 天）+ 赛前短 E 激活槽位。量账=allocate.ts 的可行解分配
 * （C1×C9 联立带内构造，38 案例全量验证）；构造保证过课包校验+排位（兜底永远
 * 合法）；#798 课表库落地后替换为库直出（本模块即替换点，generate.ts 接入面不变）。
 */

type V1Step = StructuredCourse["blocks"][number]["steps"][number];
type V1Block = StructuredCourse["blocks"][number];

const step = (stepKind: V1Step["step_kind"], duration: V1Step["duration"], target: V1Step["target"]): V1Step => ({
  step_kind: stepKind,
  duration,
  target,
  note: null,
  hr_cap_bpm: null,
});
const pace = (band: readonly [number, number]): V1Step["target"] => ({ kind: "pace_s_km", low: band[0], high: band[1] });
const r1 = (x: number) => Math.round(x * 10) / 10;

const easyBand = (row: ContentWeekRow): [number, number] => {
  const [lo, hi] = row.zones.easy ?? [null, null];
  if (lo == null || hi == null) throw new Error(`templateFallback: 第${row.week}周 easy 带缺失`);
  return [lo, hi];
};
/**
 * M 主体窄带（#824/C12 宽度 + #837 分段专项锚，与教义/校验同口径）：
 * 爬坡期（非 final_quality）=max(M 带快端, goal_pace)±5s；final_quality 期
 * =goal_pace±5s（专项期收敛完成，撞帽计划也锚 goal）。兜底构造保证永远合法
 * （三重防护）：锚上夹 M 带慢端（维持路径 goal 慢于带时不产谱外处方，C5）；
 * 取整后复核 mid（round 可使 mid 漂 +0.5s——超 C13 容差时整体下调 1s）。
 */
const mNarrow = (row: ContentWeekRow, goalPaceSKm: number): [number, number] => {
  const [mFast, mSlow] = row.zones.m ?? [null, null];
  if (mFast == null || mSlow == null) throw new Error(`templateFallback: 第${row.week}周 m 带缺失`);
  let anchor = row.phase === "final_quality" ? goalPaceSKm : Math.max(mFast, goalPaceSKm);
  anchor = Math.min(anchor, mSlow);
  let band: [number, number] = [Math.round(anchor - 5), Math.round(anchor + 5)];
  if ((band[0] + band[1]) / 2 > goalPaceSKm + M_GOAL_TOL_S) band = [band[0] - 1, band[1] - 1];
  return band;
};

const course = (name: string, type: StructuredCourse["type"], purpose: string, note: string | null, blocks: V1Block[]): StructuredCourse => ({
  kind: "course",
  name,
  type,
  purpose,
  note,
  blocks,
});

/** 比赛周课包：比赛课（锚 goal_pace）+ 赛前 2-3 天 M 配速激活短课（#825 简版）+ 赛前 1-3 天短 E 激活槽位。 */
function raceWeekCourses(row: ContentWeekRow, input: ContentGeneratorInput): WeekBag["courses"] {
  const race = input.race;
  const goal = race.goalPaceSKm;
  const goalBand: [number, number] = [Math.max(1, Math.round(goal - 5)), Math.round(goal + 5)];
  const alloc = allocateRaceWeek(row, race);
  const courses: WeekBag["courses"] = [
    course(
      `${race.name} 42.2km`,
      "M",
      `比赛课：${race.name}按目标 ${race.targetTime}（配速 ${fmtPace(goal)}/km）执行，前半程克制兴奋按计划补给，后半程专注动作放松。`,
      "起跑不冲，按配速带下沿跟进；补给按赛前演练节奏执行。",
      [{ repeat: 1, steps: [step("work", { kind: "distance_m", value: 42195 }, pace(goalBand))] }],
    ),
  ];
  if (alloc.activation != null) {
    // 三块结构（主体/strides×4/放松）——C7 看首末块，strides 走 repeat 块展开
    courses.push(
      course(
        `赛前激活 M ${r1(alloc.activation.bodyKm)}km+strides`,
        "M",
        `赛前激活：M 配速主体 ${r1(alloc.activation.bodyKm)}km 保持比赛节奏触感（减量期保强度即可维持），加 4×100m strides 唤醒神经肌肉，为${race.name}保持兴奋性。`,
        "主体按 M 带执行不追强度；每组 strides 后充分恢复再起下一组。",
        [
          {
            repeat: 1,
            steps: [
              step("warmup", { kind: "time_s", value: 15 * 60 }, pace(easyBand(row))),
              step("work", { kind: "distance_m", value: Math.round(alloc.activation.bodyKm * 1000) }, pace(mNarrow(row, race.goalPaceSKm))),
            ],
          },
          { repeat: 4, steps: [step("work", { kind: "distance_m", value: 100 }, { kind: "open", low: null, high: null })] },
          { repeat: 1, steps: [step("cooldown", { kind: "time_s", value: 10 * 60 }, pace(easyBand(row)))] },
        ],
      ),
    );
  }
  const slots: ESlotCourse[] = alloc.shakes.map(() => ({ kind: "e-slot", band: "interval", strides: false, purpose: null }));
  return [...courses, ...slots];
}

/** 常规周课包：LR + q 节 M 课 + E 槽位（分配器出可行解：槽数与带型，分钟归 L4b）。 */
function normalWeekCourses(row: ContentWeekRow, input: ContentGeneratorInput, regeneration: boolean): WeekBag["courses"] {
  const eBand = easyBand(row);
  const alloc = allocateWeek(row, input.athlete.weeklyRunDaysMax, regeneration);
  const courses: WeekBag["courses"] = [
    course(
      `长跑 ${r1(alloc.lr)}km`,
      "LR",
      `长跑课：${r1(alloc.lr)}km E 配速积累耐力，全程可交谈配速，注意补给节奏。`,
      "每 5km 少量补水；后半程配速不快于 E 带上沿。",
      [{ repeat: 1, steps: [step("work", { kind: "distance_m", value: Math.round(alloc.lr * 1000) }, pace(eBand))] }],
    ),
  ];
  for (let i = 0; i < alloc.qualitySessions; i++) {
    const m = mNarrow(row, input.race.goalPaceSKm);
    courses.push(
      course(
        `M ${r1(alloc.mBodyKm)}km`,
        "M",
        `马配专项课：M 配速主体 ${r1(alloc.mBodyKm)}km 演练比赛节奏${row.role === "taper" ? "，减量期保持强度触感（维持原则）" : "，专项耐力核心刺激"}。`,
        "主体按 M 带执行，心率漂移超上限即放 5s/km。",
        [
          {
            repeat: 1,
            steps: [
              step("warmup", { kind: "time_s", value: (alloc.warmupMin + alloc.warmupCooldownExtraMin / 2) * 60 }, pace(eBand)),
              step("work", { kind: "distance_m", value: Math.round(alloc.mBodyKm * 1000) }, pace(m)),
              step("cooldown", { kind: "time_s", value: (alloc.cooldownMin + alloc.warmupCooldownExtraMin / 2) * 60 }, pace(eBand)),
            ],
          },
        ],
      ),
    );
  }
  for (const e of alloc.eSessions) {
    // purpose 一律 null（#824 拍板）：说明由 L4b ePurpose 按实际落位生成——构造
    // 侧的 lrEve/regeneration 提示与排位结果可能错位，不自写
    courses.push({
      kind: "e-slot",
      band: e.intervalDay || e.lrEve || regeneration ? "interval" : "normal",
      strides: false,
      purpose: null,
    });
  }
  return courses;
}

/** 兜底入口：逐周确定性构造课包（L3 行 → 最小合法课包，落位归 L4b）。 */
export function templateFallback(input: ContentGeneratorInput): WeekBag[] {
  return input.rows.map((row) => ({
    week: row.week,
    courses: row.role === "race" ? raceWeekCourses(row, input) : normalWeekCourses(row, input, row.phase === "recovery"),
  }));
}
