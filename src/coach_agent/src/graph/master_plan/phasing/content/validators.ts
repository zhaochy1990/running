import type { RunWorkout, RunWorkoutType } from "@stride/contract";
import {
  hasCooldown,
  hasQualitySegment,
  hasStrideStep,
  hasWarmup,
  isAerobicStep,
  isStrideStep,
  mainQualitySegment,
  type PaceZones,
  qualitySpectrum,
} from "./derive.js";

/**
 * L4 内容层校验（devops#807；叫法拍板 2026-10-27：validation，不用 gate）。
 * 一致性组（type 罩主段/purpose 必填）+ 守恒组（C1-C8）+ C9（E 课时长分层，
 * devops#811 补）全部读 V1 事实（配速/距离/时长/date/type 声明），与判定表
 * （derive.ts）同源。
 */

export interface ContentValidation {
  id: string;
  pass: boolean;
  detail: string;
}

/** 待校验课：V1 文档 + 可选期望里程（C8 展开守恒的外部锚，如迁移样本的原始 km）。 */
export interface SessionUnderTest {
  workout: RunWorkout;
  expectedKm?: number;
}

export interface WeekContentInput {
  sessions: SessionUnderTest[];
  /** L3 周骨架行（load 层 LoadWeek 的 {km, lr, q} 投影）。 */
  row: { total_km: number; long_run_km: number | null; quality_sessions: number };
  zones: PaceZones;
  /** 运动员每周跑步日上限（C4 按 date 去重）。 */
  maxTrainingDays: number;
  /** 比赛日（ISO date）：该日课=比赛课——C7 热身/放松豁免、罩带豁免（规则⑤处方锚 goal_pace），且本身按一节质量课计。 */
  raceDate?: string;
  /** 新生成的课必填 purpose（默认 true）；存量回放传 false 视为 legacy。 */
  requirePurpose?: boolean;
  /** C9 开关（默认 true=按⑨量纲校验 E 课时长分层）；⑨ 之前的存量样本（spike 迁移）传 true 豁免。 */
  legacyEDuration?: boolean;
  /** 再生周（L3 canonical=recovery）：周内无质量课，E 全走间隔日短带（⑦恢复端）——低量恢复周与 C1 的可行性调和（injury 周可低至 10km）。 */
  regeneration?: boolean;
}

/** type → 配速带（一致性：声明 type 的带须罩住主质量段）。LR 为位型课不参与罩带。 */
const TYPE_BAND: Record<Exclude<RunWorkoutType, "LR">, keyof PaceZones> = {
  E: "easy",
  M: "m",
  T: "t",
  I: "i",
  R: "r",
};

/** 主段罩带容差（s/km）。 */
const TYPE_COVER_TOL_S = 10;
/** C1 周量容差：±max(3km, 3%)。 */
const WEEK_KM_ABS_TOL = 3;
const WEEK_KM_REL_TOL = 0.03;
/** C2 长跑里程容差（km）。 */
const LR_KM_TOL = 1.5;
/** C8 展开守恒容差（km）。 */
const EXPAND_KM_TOL = 0.5;
/** C9 E 课时长分层带（min，⑦）：[下限, 上限]；间隔日/再生周=短带。分配器（allocate.ts）同源 import。 */
export const E_DURATION_INTERVAL_BAND: readonly [number, number] = [30, 60];
export const E_DURATION_NORMAL_BAND: readonly [number, number] = [60, 90];
/** 赛周激活课豁免窗：比赛日前 1-3 天（①唯一例外；weekday 差 ≤3 且不跨周）——窗内豁免下限（短激活可 <30min）但仍受短带上限 60min 约束（①原文=「短」E 激活）。 */
const RACE_WEEK_ACTIVATION_DAYS = 3;

/**
 * 课里程（km）：distance 步直读；time 步按配速区间中点派生（⑨量纲：E/REC 处方
 * duration 为主、距离=时长×带配速派生参与 C1）。open duration / time+open /
 * 非配速处方的 time 步 → null（不可知不猜）。
 */
export function sessionKm(workout: RunWorkout): number | null {
  let km: number | null = 0;
  for (const block of workout.blocks) {
    for (let rep = 0; rep < block.repeat; rep++) {
      for (const step of block.steps) {
        if (step.step_kind === "rest") continue;
        if (step.duration.kind === "distance_m") km += step.duration.value / 1000;
        else if (step.duration.kind === "time_s" && step.target.kind === "pace_s_km") km += step.duration.value / ((step.target.low + step.target.high) / 2);
        else return null;
      }
    }
  }
  return km;
}

/** date（ISO）→ 周内位（周一=0…周日=6，UTC 口径）。 */
const weekdayOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

export function validateWeekContent(input: WeekContentInput): ContentValidation[] {
  const { sessions, row, zones, maxTrainingDays, raceDate } = input;
  const requirePurpose = input.requirePurpose ?? true;
  const checks: ContentValidation[] = [];
  const spectrum = qualitySpectrum(zones);
  const isRace = (w: RunWorkout) => raceDate != null && w.date === raceDate;

  // 一致性：声明 type 的带须罩住主质量段（按距离最长的质量段 ±10s/km）。
  // 声明 T 但主段在 E 带=违规；组合课副段只需谱内（C5）；LR 内嵌 M/T 尾段合法、
  // type 仍 LR（位型课不罩带）；E/M/T/I/R 无主质量段时无罩带义务（纯有氧课）；
  // 比赛课豁免（规则⑤，devops#811）：处方锚 goal_pace 而非当周投影带——目标
  // 激进时 goal 快于投影 M 带快端是「逼近不抵达」的设计事实，不是违规。
  // 带边界 null=开放界（如 r 快端），只比较有值一侧——与 qualitySpectrum 语义对齐。
  const coverBad: string[] = [];
  for (const { workout } of sessions) {
    const type = workout.type ?? null;
    if (type == null || type === "LR" || isRace(workout)) continue;
    const main = mainQualitySegment(workout, zones);
    if (main == null) continue;
    const band = zones[TYPE_BAND[type]];
    if (band == null || (band[0] == null && band[1] == null)) {
      coverBad.push(`${workout.name} ${type}带缺失`);
      continue;
    }
    const covered =
      main.step.target.kind === "pace_s_km" &&
      (band[0] == null || main.step.target.low >= band[0] - TYPE_COVER_TOL_S) &&
      (band[1] == null || main.step.target.high <= band[1] + TYPE_COVER_TOL_S);
    if (!covered) {
      const pace = main.step.target.kind === "pace_s_km" ? `@${main.step.target.low}-${main.step.target.high}` : "非配速处方";
      coverBad.push(`${workout.name} 声明${type}主段${pace}`);
    }
  }
  checks.push({ id: "一致性 type罩主段", pass: coverBad.length === 0, detail: coverBad.join(";") || "全过" });

  // purpose 必填：新生成的课必填（存量回放 requirePurpose=false 豁免）。
  const purposeMissing = requirePurpose ? sessions.filter((s) => s.workout.purpose == null || s.workout.purpose.trim() === "").map((s) => s.workout.name) : [];
  checks.push({ id: "一致性 purpose必填", pass: purposeMissing.length === 0, detail: purposeMissing.join(";") || (requirePurpose ? "全过" : "legacy豁免") });

  // C1 周量守恒：Σ课里程（sessionKm 口径：distance 直读 + time×配速中点派生，⑨）
  // vs L3 total_km，±max(3km, 3%)。open/time+open 步里程不可知 → 整周挂「不可知」。
  // 赛周目标由比赛里程托底（devops#811）：L3 的赛周比例削减帽（0.7×平台参照）
  // 对低平台运动员可低于 42.195km 本身，而比赛课处方不可削减（规则⑤）——
  // 守恒目标取 max(骨架, FM 里程)。
  const c1Target = raceDate != null && row.long_run_km == null ? Math.max(row.total_km, 42.195) : row.total_km;
  const unknown = sessions.filter((s) => sessionKm(s.workout) == null).map((s) => s.workout.name);
  const sumKm = unknown.length === 0 ? sessions.reduce((sum, s) => sum + (sessionKm(s.workout) ?? 0), 0) : null;
  const tol = Math.max(WEEK_KM_ABS_TOL, c1Target * WEEK_KM_REL_TOL);
  // detail 打有效目标（托底时附骨架原值）——重试违规清单据此引导，模型须能对齐
  const c1Label = c1Target === row.total_km ? `骨架${row.total_km}` : `赛周托底${c1Target.toFixed(1)}（骨架${row.total_km}）`;
  checks.push({
    id: "C1 周量守恒",
    pass: sumKm != null && Math.abs(sumKm - c1Target) <= tol,
    detail: unknown.length ? `里程不可知:${unknown.join(",")}` : sumKm != null ? `Σ${sumKm.toFixed(1)} vs ${c1Label}（±${tol.toFixed(1)}）` : "",
  });

  // C2 长跑唯一且合值：lr≠null 时 type=LR 恰一节 ±1.5km；赛周 lr=null 豁免为 0 节。
  const lrs = sessions.filter((s) => s.workout.type === "LR");
  let lrOk: boolean;
  let lrDetail: string;
  if (row.long_run_km == null) {
    lrOk = lrs.length === 0;
    lrDetail = `赛周 lr=null，${lrs.length} 节 LR`;
  } else {
    const lrKm = lrs.length === 1 ? sessionKm(lrs[0]!.workout) : null;
    lrOk = lrs.length === 1 && lrKm != null && Math.abs(lrKm - row.long_run_km) <= LR_KM_TOL;
    lrDetail = lrs.length === 1 ? `${lrKm ?? "?"} vs ${row.long_run_km}（±${LR_KM_TOL}）` : `${lrs.length} 节 LR`;
  }
  checks.push({ id: "C2 长跑唯一", pass: lrOk, detail: lrDetail });

  // C3 Q 配额：含 ≥1 质量段的课数 vs 配额；比赛课本身按一节质量课计。
  const quality = sessions.filter((s) => hasQualitySegment(s.workout, zones) || isRace(s.workout));
  checks.push({ id: "C3 Q配额", pass: quality.length === row.quality_sessions, detail: `${quality.length} 节质量课 vs 配额${row.quality_sessions}` });

  // C4 训练日 ≤上限（按 date 去重）。
  const days = new Set(sessions.map((s) => s.workout.date));
  checks.push({ id: "C4 训练日", pass: days.size <= maxTrainingDays, detail: `${days.size} 天 vs ≤${maxTrainingDays}` });

  // C5 配速谱内：work 步须落 质量谱∪E带容差（不要求单带归属，MP-10s 跨带、
  // 变速课 work@easy 慢段均合法）；warmup/cooldown 是有氧步、只认 E 带 ±10
  // （快配速热身/放松是生成错误，谱内不豁免）；rest/recovery 步不得带配速处方
  // （rest 不在跑；有配速处方的慢跑应建模为 work@easy）；hr/power/cadence 处方
  // 不在配速谱上判定（显式跳过）。
  const paceBad: string[] = [];
  if (spectrum == null) {
    paceBad.push("配速带缺失（m/r），无法判谱");
  } else {
    for (const { workout } of sessions) {
      for (const block of workout.blocks) {
        for (const step of block.steps) {
          if (step.target.kind !== "pace_s_km") continue;
          if (step.step_kind === "rest" || step.step_kind === "recovery") {
            paceBad.push(`${workout.name} ${step.step_kind}步带配速处方`);
            continue;
          }
          if (step.step_kind === "warmup" || step.step_kind === "cooldown") {
            if (!isAerobicStep(step, zones)) paceBad.push(`${workout.name} ${step.step_kind}@${step.target.low}-${step.target.high}∉E带`);
            continue;
          }
          const inSpectrum = step.target.high <= spectrum.slow && (spectrum.fast == null || step.target.low >= spectrum.fast);
          if (!inSpectrum && !isAerobicStep(step, zones)) {
            paceBad.push(`${workout.name} ${step.step_kind}@${step.target.low}-${step.target.high}∉谱∪E带`);
          }
        }
      }
    }
  }
  checks.push({ id: "C5 配速谱内", pass: paceBad.length === 0, detail: paceBad.slice(0, 3).join(";") || "全过" });

  // C6 note 语义：无质量段且无短加速步的课 note=null（strides 要点/LR 补给要点合法）。
  const noteBad = sessions
    .filter((s) => !hasQualitySegment(s.workout, zones) && !hasStrideStep(s.workout) && s.workout.type !== "LR" && s.workout.note != null)
    .map((s) => `${s.workout.name} note应null`);
  checks.push({ id: "C6 note语义", pass: noteBad.length === 0, detail: noteBad.join(";") || "全过" });

  // C7 质量课热身/放松在场：首/末块存在 warmup/cooldown 步。比赛课豁免；LR
  // 位型课豁免——E 配速主体即热身（判定表「按里程差判」的松弛路径），其内嵌
  // work 尾段仍计 Q（C3）、仍受谱内校验（C5）。
  const structBad = quality
    .filter((s) => !isRace(s.workout) && s.workout.type !== "LR")
    .filter((s) => !hasWarmup(s.workout) || !hasCooldown(s.workout))
    .map((s) => s.workout.name);
  checks.push({ id: "C7 热身放松在场", pass: structBad.length === 0, detail: structBad.join(";") || "全过" });

  // C8 展开守恒：课总里程（sessionKm=repeat 展开口径）vs 期望里程 ±0.5km——组数×
  // 步距算术错挂门；无期望锚（生产 V1 无 km 字段）时跳过。
  const anchored = sessions.filter((s) => s.expectedKm != null);
  const expandBad = anchored
    .filter((s) => {
      const km = sessionKm(s.workout);
      return km == null || Math.abs(km - (s.expectedKm ?? 0)) > EXPAND_KM_TOL;
    })
    .map((s) => `${s.workout.name} ${(sessionKm(s.workout) ?? 0).toFixed(1)}vs${s.expectedKm}`);
  const expandDetail = expandBad.length > 0 ? expandBad.join(";") : anchored.length > 0 ? `全过(${anchored.length}锚)` : "无期望锚，跳过";
  checks.push({ id: "C8 展开守恒", pass: expandBad.length === 0, detail: expandDetail });

  // C9 E 课时长分层（①⑦⑨，devops#811）：type=E 的课 duration 必填（非 strides
  // 跑步步一律 time_s 处方——⑨ E/REC 量纲=时间）且落带——质量课间隔日 30-60min、
  // 普通日 60-90min。间隔日=周内两节质量课（含比赛课）之间的日子，从 date 周内
  // 位派生；再生周（recovery）无质量课、E 全走短带（低量恢复周与 C1 的可行性
  // 调和，injury 周可低至 10km）。唯一豁免=赛周激活课（①拍板）：比赛日前 1-3
  // 天的短 E 激活/shakeout。legacyEDuration=⑨ 之前存量样本整条跳过。
  if (input.legacyEDuration) {
    checks.push({ id: "C9 E课时长分层", pass: true, detail: "legacy豁免" });
    return checks;
  }
  const qualityWeekdays = new Set(sessions.filter((s) => hasQualitySegment(s.workout, zones) || isRace(s.workout)).map((s) => weekdayOf(s.workout.date)));
  const isIntervalDay = (wd: number) => [...qualityWeekdays].some((a) => a < wd) && [...qualityWeekdays].some((b) => b > wd);
  const raceWd = raceDate != null ? weekdayOf(raceDate) : null;
  const eBad: string[] = [];
  for (const { workout } of sessions) {
    if (workout.type !== "E") continue;
    let durationMin = 0;
    let missingDuration = false;
    for (const block of workout.blocks) {
      for (let rep = 0; rep < block.repeat; rep++) {
        for (const step of block.steps) {
          if (step.step_kind === "rest" || isStrideStep(step)) continue;
          if (step.duration.kind !== "time_s") {
            missingDuration = true;
            continue;
          }
          durationMin += step.duration.value / 60;
        }
      }
    }
    if (missingDuration) {
      eBad.push(`${workout.name} duration缺失(非time步)`);
      continue;
    }
    // 赛周激活课豁免窗：同周内、比赛日前 1-3 天——豁免下限（短激活可 <30min），
    // 仍受短带上限 60min 约束（①拍板语义=「短」E 激活，80min 摇晃腿不是激活课）
    const wd = weekdayOf(workout.date);
    if (raceWd != null && wd < raceWd && raceWd - wd <= RACE_WEEK_ACTIVATION_DAYS) {
      if (durationMin > E_DURATION_INTERVAL_BAND[1] + 1e-6)
        eBad.push(`${workout.name} 赛周激活 ${durationMin.toFixed(0)}min 超短带上限${E_DURATION_INTERVAL_BAND[1]}min`);
      continue;
    }
    const band = isIntervalDay(wd) || input.regeneration ? E_DURATION_INTERVAL_BAND : E_DURATION_NORMAL_BAND;
    if (durationMin < band[0] - 1e-6 || durationMin > band[1] + 1e-6) {
      eBad.push(
        `${workout.name} ${durationMin.toFixed(0)}min ∉ ${input.regeneration && !isIntervalDay(wd) ? "再生周" : isIntervalDay(wd) ? "间隔日" : "普通日"}[${band[0]}-${band[1]}]`,
      );
    }
  }
  checks.push({ id: "C9 E课时长分层", pass: eBad.length === 0, detail: eBad.slice(0, 3).join(";") || "全过" });

  return checks;
}
