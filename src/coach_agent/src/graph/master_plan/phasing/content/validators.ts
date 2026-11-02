import type { RunWorkout, RunWorkoutType } from "@stride/contract";
import { goalMPaceBand } from "./project.js";
import {
  easyMidOfZones,
  hasCooldown,
  hasQualitySegment,
  hasStrideStep,
  hasWarmup,
  isAerobicStep,
  isQualityStep,
  isStrideStep,
  mainQualitySegment,
  type PaceZones,
  qualitySpectrum,
  stepKmOf,
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
  row: { total_km: number; long_run_km: number | null; quality_sessions: number; role?: string };
  zones: PaceZones;
  /** 运动员每周跑步日上限（C4 按 date 去重）。 */
  maxTrainingDays: number;
  /** 比赛日（ISO date）：该日课=比赛课——C7 热身/放松豁免、罩带豁免（规则⑤处方锚 goal_pace），且本身按一节质量课计。 */
  raceDate?: string;
  /** 模板兜底路径（C14 豁免——模板永远合法是底线，专项化归 LLM 路径）。 */
  templatePath?: boolean;
  /** 新生成的课必填 purpose（默认 true）；存量回放传 false 视为 legacy。 */
  requirePurpose?: boolean;
  /** C9 开关（默认 true=按⑨量纲校验 E 课时长分层）；⑨ 之前的存量样本（spike 迁移）传 true 豁免。 */
  legacyEDuration?: boolean;
  /** C11/C12 开关（默认 true=按 #824 校验分段梯度与配速宽度）；#824 之前的存量样本（spike 迁移=真实教练基线全带处方）传 true 豁免。 */
  legacyQualityPace?: boolean;
  /** 再生周（L3 canonical=recovery）：周内无质量课，E 全走间隔日短带（⑦恢复端）——低量恢复周与 C1 的可行性调和（injury 周可低至 10km）。 */
  regeneration?: boolean;
  /** 目标配速（s/km，#837）：M 课专项锚=C13 与 type=M 罩带豁免的依据；缺省跳过（存量回放）。 */
  goalPaceSKm?: number;
  /** final_quality 期标志（#837）：C13 只在该期生效（M 课早期周照投影带爬坡、后期收敛 goal）。 */
  finalQuality?: boolean;
  /**
   * 课包阶段（devops#799 L4a→L4b 交接）：sessions 只含结构课（E 走槽位不进
   * sessions）；C4/C9 按日判定不可用——跳过并标注归排位段（P1/实例化定带）；
   * C1 改 E 带区间可行性（eSlotKmRanges=每槽 [loKm,hiKm]，目标±容差与
   * Σ区间相交即过——终值由 L4b water-fill 收敛后另跑全量校验）。
   */
  bagStage?: { eSlotKmRanges: Array<[number, number]> };
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

/** 轻量 M 段课（2026-11-02 拍板「E 压缩与 M 段铺开」）：E 槽升级形态=热身/放松 E
 * + 单段 3.2-6.5km@goal 的 M 段、课总里程 ≤16km——作为第三质量位合法（C3 的
 * q+1 位、C16 段长谱豁免），段长按能力映射见 prompt 规则②。 */
export const isLightMSegmentCourse = (workout: RunWorkout): boolean => {
  if (workout.type !== "M") return false;
  const mSegs: number[] = [];
  for (const b of workout.blocks) for (let r = 0; r < b.repeat; r++) for (const st of b.steps) {
    if (st.step_kind === "work" && st.target.kind === "pace_s_km" && st.duration.kind === "distance_m" && st.duration.value != null && st.duration.value >= 1000) mSegs.push(st.duration.value);
  }
  if (mSegs.length === 0) return false;
  const totalM = mSegs.reduce((a, b) => a + b, 0);
  const total = workout.blocks.reduce((t, b) => t + b.repeat * b.steps.reduce((u, st) => u + (st.duration.kind === "distance_m" ? (st.duration.value ?? 0) : 0), 0), 0);
  return totalM >= 3200 - 1e-6 && totalM <= 6500 + 1e-6 && Math.max(...mSegs) <= 6500 + 1e-6 && total <= 16000 + 1e-6;
};

/** LR 前日轻量帽（#825，#814 附带修复拍板）：长跑前一日的 E 课 ≤8km 或休——按课实际里程判（V1 事实），不设时长下限。 */
export const LR_EVE_MAX_KM = 8;
/** LR 前日里程帽容差（km）：30s 时长取整粒度折算 ≈0.05km，留 0.1。 */
const LR_EVE_KM_TOL = 0.1;
/** 赛周激活课豁免窗：比赛日前 1-3 天（①唯一例外；weekday 差 ≤3 且不跨周）——窗内豁免下限（短激活可 <30min）但仍受短带上限 60min 约束（①原文=「短」E 激活）。 */
const RACE_WEEK_ACTIVATION_DAYS = 4; // 赛周每日 shake 窗（2026-11-01 原书校准：赛前 1-4 天每天短 E）
/** C12 质量段配速处方宽度上限（s/km，#824）：带中位 ±3~5s 的窄带——整条投影带复制（15s+）会让慢端刺激滑到下一带。 */
const QUALITY_PRECISION_S = 10;
/** C11 分段梯度判据（s/km，#824）：不同时长质量段的配速中位差 ≤此值视为「全同配速」（等长刺激=形状像但梯度缺位）。 */
const LADDER_PACE_EPS_S = 2;
/** C13 M 课锚定目标容差（s/km，#837）：final_quality 期 M 课主段 mid 不得比 goal_pace 慢超过此值（兜底 mNarrow 同源 import）。 */
export const M_GOAL_TOL_S = 8;

/**
 * 课里程（km）：repeat 展开 Σ步里程（折算口径单源=derive.stepKmOf：distance
 * 直读 + time×配速中点派生 + recovery time 处方按 E 带中点折算，#824）。
 * 任一步不可知（open 等）→ 整课 null（不可知不猜）。
 */
export function sessionKm(workout: RunWorkout, eMidSPerKm?: number | null): number | null {
  let km: number | null = 0;
  for (const block of workout.blocks) {
    for (let rep = 0; rep < block.repeat; rep++) {
      for (const step of block.steps) {
        if (step.step_kind === "rest") continue;
        const stepKm = stepKmOf(step, eMidSPerKm);
        if (stepKm == null) return null;
        km += stepKm;
      }
    }
  }
  return km;
}

/** date（ISO）→ 周内位（周一=0…周日=6，UTC 口径）。 */
export const weekdayOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

/** 步量标签（违规明细/重试清单用）：<1km 用 m、≥1km 用 km；<60s 用 s、≥60s 用 min。 */
function fmtStepAmount(value: number, kind: "distance_m" | "time_s"): string {
  if (kind === "distance_m") return value < 1000 ? `${Math.round(value)}m` : `${Math.round(value / 100) / 10}km`;
  return value < 60 ? `${Math.round(value)}s` : `${Math.round(value / 6) / 10}min`;
}

export function validateWeekContent(input: WeekContentInput): ContentValidation[] {
  const { sessions, row, zones, maxTrainingDays, raceDate } = input;
  const requirePurpose = input.requirePurpose ?? true;
  const checks: ContentValidation[] = [];
  const spectrum = qualitySpectrum(zones);
  const isRace = (w: RunWorkout) => raceDate != null && w.date === raceDate;
  // E 带中点（s/km）：recovery 步 time 处方折算锚（sessionKm 同源）
  const eMid = easyMidOfZones(zones);

  // 一致性：声明 type 的带须罩住主质量段（按距离最长的质量段 ±10s/km）。
  // 声明 T 但主段在 E 带=违规；组合课副段只需谱内（C5）；LR 内嵌 M/T 尾段合法、
  // type 仍 LR（位型课不罩带）；E/M/T/I/R 无主质量段时无罩带义务（纯有氧课）；
  // 比赛课豁免（规则⑤，devops#811）：处方锚 goal_pace 而非当周投影带——目标
  // 激进时 goal 快于投影 M 带快端是「逼近不抵达」的设计事实，不是违规。
  // type=M 同理（#837 专项性拍板）：M 课锚=max(M 带快端, goal_pace)±5s——
  // 罩带判据放宽为 M 带 ∪ goal±5 的包络。
  // 带边界 null=开放界（如 r 快端），只比较有值一侧——与 qualitySpectrum 语义对齐。
  const coverBad: string[] = [];
  for (const { workout } of sessions) {
    const type = workout.type ?? null;
    if (type == null || type === "LR" || isRace(workout)) continue;
    const main = mainQualitySegment(workout, zones);
    if (main == null) continue;
    const band = zones[TYPE_BAND[type]];
    const goalBand = type === "M" && input.goalPaceSKm != null ? goalMPaceBand(input.goalPaceSKm) : null;
    const los = [band?.[0], goalBand?.[0]].filter((x): x is number => x != null);
    const his = [band?.[1], goalBand?.[1]].filter((x): x is number => x != null);
    if (los.length === 0 && his.length === 0) {
      coverBad.push(`${workout.name} ${type}带缺失`);
      continue;
    }
    const covered =
      main.step.target.kind === "pace_s_km" &&
      (los.length === 0 || main.step.target.low >= Math.min(...los) - TYPE_COVER_TOL_S) &&
      (his.length === 0 || main.step.target.high <= Math.max(...his) + TYPE_COVER_TOL_S);
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
  // 守恒目标取 max(骨架, FM 里程)。课包阶段（bagStage）：E 槽位以 km 区间
  // 参与可行性（终值由 L4b 实例化后另跑全量）。
  const c1Target = raceDate != null && row.long_run_km == null ? Math.max(row.total_km, 42.195) : row.total_km;
  const unknown = sessions.filter((s) => sessionKm(s.workout, eMid) == null).map((s) => s.workout.name);
  const sumKm = unknown.length === 0 ? sessions.reduce((sum, s) => sum + (sessionKm(s.workout, eMid) ?? 0), 0) : null;
  const tol = Math.max(WEEK_KM_ABS_TOL, c1Target * WEEK_KM_REL_TOL);
  // detail 打有效目标（托底时附骨架原值）——重试违规清单据此引导，模型须能对齐
  const c1Label = c1Target === row.total_km ? `骨架${row.total_km}` : `赛周托底${c1Target.toFixed(1)}（骨架${row.total_km}）`;
  if (input.bagStage != null) {
    const loKm = input.bagStage.eSlotKmRanges.reduce((s, r) => s + r[0], 0);
    const hiKm = input.bagStage.eSlotKmRanges.reduce((s, r) => s + r[1], 0);
    const structured = sumKm ?? 0;
    const feasible = sumKm != null && c1Target - tol <= structured + hiKm && c1Target + tol >= structured + loKm;
    checks.push({
      id: "C1 周量守恒",
      pass: feasible,
      detail: unknown.length
        ? `里程不可知:${unknown.join(",")}`
        : `结构${structured.toFixed(1)}+E带[${(structured + loKm).toFixed(1)},${(structured + hiKm).toFixed(1)}] vs ${c1Label}（±${tol.toFixed(1)}）`,
    });
  } else {
    checks.push({
      id: "C1 周量守恒",
      pass: sumKm != null && Math.abs(sumKm - c1Target) <= tol,
      detail: unknown.length ? `里程不可知:${unknown.join(",")}` : sumKm != null ? `Σ${sumKm.toFixed(1)} vs ${c1Label}（±${tol.toFixed(1)}）` : "",
    });
  }

  // C2 长跑唯一且合值：lr≠null 时 type=LR 恰一节 ±1.5km；赛周 lr=null 豁免为 0 节。
  const lrs = sessions.filter((s) => s.workout.type === "LR");
  let lrOk: boolean;
  let lrDetail: string;
  if (row.long_run_km == null) {
    lrOk = lrs.length === 0;
    lrDetail = `赛周 lr=null，${lrs.length} 节 LR`;
  } else {
    const lrKm = lrs.length === 1 ? sessionKm(lrs[0]!.workout, eMid) : null;
    lrOk = lrs.length === 1 && lrKm != null && Math.abs(lrKm - row.long_run_km) <= LR_KM_TOL;
    lrDetail = lrs.length === 1 ? `${lrKm ?? "?"} vs ${row.long_run_km}（±${LR_KM_TOL}）` : `${lrs.length} 节 LR`;
  }
  checks.push({ id: "C2 长跑唯一", pass: lrOk, detail: lrDetail });

  // C3 Q 配额：含 ≥1 质量段的课数 vs 配额；比赛课本身按一节质量课计。
  // C3 Q配额：含 ≥1 质量段的课数 vs 配额。LR 不算——长跑是位型课（C2 独立守恒），
  // 内嵌 work 尾段是长跑的专项化（#837 拍板），不占独立质量课配额（教练 2Q+1L=Q 归 Q、L 归 L）。
  const quality = sessions.filter((s) => s.workout.type !== "LR" && (hasQualitySegment(s.workout, zones) || isRace(s.workout)));
  // q+1 位=轻量 M 段课（2026-11-02「E 压缩与 M 段铺开」：E 槽升级的第三质量位，
  // 每周至多一节且必须为轻量形态）；其余超额照挂
  const extra = quality.filter((s) => !isRace(s.workout) && isLightMSegmentCourse(s.workout));
  const qOk =
    quality.length === row.quality_sessions ||
    (quality.length === row.quality_sessions + 1 && extra.length === 1 && quality.length - extra.length >= row.quality_sessions - 1);
  checks.push({ id: "C3 Q配额", pass: qOk, detail: `${quality.length} 节质量课 vs 配额${row.quality_sessions}${extra.length ? `（+${extra.length} 轻量 M 段位）` : ""}` });

  // C4 训练日 ≤上限（按 date 去重）；课包阶段不查——落位归 L4b（P1 同判据）。
  if (input.bagStage == null) {
    const days = new Set(sessions.map((s) => s.workout.date));
    checks.push({ id: "C4 训练日", pass: days.size <= maxTrainingDays, detail: `${days.size} 天 vs ≤${maxTrainingDays}` });
  }

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

  // C6 note 语义：无质量段且无短加速步的课 note=null（strides 要点/LR 补给要点合法；
  // 赛周豁免——E 槽位课包本就不收 note，赛周 E 的 note 只可能来自 L4b 的通勤
  // 调整说明（2026-11-01 拍板），拦它=拦自己人）。
  const noteBad = sessions
    .filter(
      (s) =>
        raceDate == null &&
        !hasQualitySegment(s.workout, zones) &&
        !hasStrideStep(s.workout) &&
        s.workout.type !== "LR" &&
        s.workout.note != null,
    )
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
      const km = sessionKm(s.workout, eMid);
      return km == null || Math.abs(km - (s.expectedKm ?? 0)) > EXPAND_KM_TOL;
    })
    .map((s) => `${s.workout.name} ${(sessionKm(s.workout, eMid) ?? 0).toFixed(1)}vs${s.expectedKm}`);
  const expandDetail = expandBad.length > 0 ? expandBad.join(";") : anchored.length > 0 ? `全过(${anchored.length}锚)` : "无期望锚，跳过";
  checks.push({ id: "C8 展开守恒", pass: expandBad.length === 0, detail: expandDetail });

  // C11 分段配速梯度（#824 用户审发现②）：阶梯/金字塔/变速等多段结构课，不同
  // 时长的质量段不得全同配速（形状像阶梯、刺激=等长间歇——梯度缺位）。等长间歇
  // （单一时长组，如 8×800）豁免；E/LR/比赛课不在范围（E 无质量段带、LR 内嵌
  // 尾段自由形态、比赛课锚 goal_pace）。legacyQualityPace=存量迁移样本豁免。
  // C12 质量段配速宽度（#824 用户审发现③）：质量段处方=带中位 ±3~5s 窄带，
  // 整条投影带逐秒复制（宽 15s+）会让运动员跑慢端时刺激实际落到下一带。E/LR
  // 主体（E 全带）与比赛课（goal±5s）不在范围；变速课 work@easy 慢段不是
  // 质量段、不受限。
  const paceWidthBad: string[] = [];
  const ladderBad: string[] = [];
  const legacyPace = input.legacyQualityPace === true;
  if (!legacyPace && spectrum == null) paceWidthBad.push("配速带缺失（m/r），无法判分段配速");
  if (!legacyPace && spectrum != null) {
    for (const { workout } of sessions) {
      if (workout.type === "E" || workout.type === "LR" || isRace(workout)) continue;
      const labels = new Map<string, string>();
      const mids: number[] = [];
      for (const block of workout.blocks) {
        for (const step of block.steps) {
          if (!isQualityStep(step, zones) || step.target.kind !== "pace_s_km" || (step.duration.kind !== "distance_m" && step.duration.kind !== "time_s"))
            continue;
          const width = step.target.high - step.target.low;
          if (width > QUALITY_PRECISION_S + 1e-6) paceWidthBad.push(`${workout.name} work段@${step.target.low}-${step.target.high} 宽${Math.round(width)}s`);
          const key = `${step.duration.kind}:${step.duration.value}`;
          if (!labels.has(key))
            labels.set(key, `${fmtStepAmount(step.duration.value, step.duration.kind)}@${Math.round((step.target.low + step.target.high) / 2)}`);
          mids.push((step.target.low + step.target.high) / 2);
        }
      }
      if (labels.size >= 2 && Math.max(...mids) - Math.min(...mids) <= LADDER_PACE_EPS_S)
        ladderBad.push(`${workout.name} ${labels.size}段不同时长全同配速（${[...labels.values()].join("+")}）`);
    }
  }
  checks.push({ id: "C11 分段配速梯度", pass: ladderBad.length === 0, detail: legacyPace ? "legacy豁免" : ladderBad.slice(0, 3).join(";") || "全过" });
  checks.push({ id: "C12 质量段配速宽度", pass: paceWidthBad.length === 0, detail: legacyPace ? "legacy豁免" : paceWidthBad.slice(0, 3).join(";") || "全过" });

  // C13 M 课锚定目标（#837 用户审 254 计划发现）：final_quality 期 M 课主段
  // 配速 mid 不得比 goal_pace 慢 8s+——**单侧判定**（慢侧违规）：M 课=比赛专项，
  // 全程按投影带开离 goal 22-30s 是缺陷；比 goal 快（能力超目标的维持路径照带开）
  // 合法不罚。比赛课豁免（锚 goal 已是定义）；goal 慢于质量谱慢端时跳过（目标
  // 不在专项域——维持路径的极松目标，M 课照带）；goalPaceSKm/finalQuality
  // 缺省跳过（存量回放无 goal 上下文）。
  const mGoalBad: string[] = [];
  if (input.finalQuality === true && input.goalPaceSKm != null) {
    const goalBeyondSpectrum = spectrum != null && input.goalPaceSKm > spectrum.slow - 5;
    for (const { workout } of sessions) {
      if (workout.type !== "M" || isRace(workout)) continue;
      const main = mainQualitySegment(workout, zones);
      if (main == null || main.step.target.kind !== "pace_s_km") continue;
      const mid = (main.step.target.low + main.step.target.high) / 2;
      if (!goalBeyondSpectrum && mid > input.goalPaceSKm + M_GOAL_TOL_S + 1e-6) {
        mGoalBad.push(
          `${workout.name} 主段@${main.step.target.low}-${main.step.target.high} mid ${Math.round(mid)} 比 goal ${Math.round(input.goalPaceSKm)} 慢 ${(mid - input.goalPaceSKm).toFixed(1)}s`,
        );
      }
    }
  }
  checks.push({
    id: "C13 M课锚定目标",
    pass: mGoalBad.length === 0,
    detail:
      input.finalQuality !== true ? "非 final_quality 期，跳过" : input.goalPaceSKm == null ? "无 goal 上下文，跳过" : mGoalBad.slice(0, 3).join(";") || "全过",
  });

  // C14 final_quality 进展周长跑非纯有氧（2026-11-01 专项化周期拍板）：临近比赛
  // 长跑必须含 goal_pace 段（渐加速/全程 MP/MP-10s/变速），纯有氧只留给
  // recovery/absorb/taper 周。依据=教练 8 周基准（W7 渐加速→W4 全程 MP→W5 MP-10s→W3 MP/E 变速）。
  {
    const lrs = sessions.filter((s) => s.workout.type === "LR");
    const pureAerobic = lrs.filter((s) => !hasQualitySegment(s.workout, zones));
    const fq = input.finalQuality === true;
    const isProgress = row.role === "progress";
    const c14Fail = input.bagStage == null && !input.templatePath && fq && isProgress && lrs.length > 0 && pureAerobic.length === lrs.length;
    checks.push({
      id: "C14 长跑专项段",
      pass: !c14Fail,
      detail: input.bagStage != null ? "bag 阶段跳过" : input.templatePath ? "模板兜底豁免" : !fq || !isProgress ? "非 FQ 进展周，跳过" : lrs.length === 0 ? "无 LR" : c14Fail ? "FQ 进展周 LR 纯有氧——须含 goal_pace 段（渐加速/全程 MP/MP-10s/变速）" : "含专项段",
    });
  }

  // C15 taper 周长跑禁提速（2026-11-02 用户拍板）：减量周 LR 的 work 段 mid 不得
  // 比 goal_pace 快——「MP-10s」等提速形态只属于 progress 的调整/吸收周；赛前
  // 一周多的长跑只允许纯有氧或比 goal 慢 10-20s 的渐加速短版（25km 贴 T 带快端
  // =赛前 8 天的半程节奏赛，与减量原则冲突）。
  {
    const lrs = sessions.filter((s) => s.workout.type === "LR");
    const fastBad: string[] = [];
    if (row.role === "taper" && input.goalPaceSKm != null && input.bagStage == null) {
      for (const { workout } of lrs) {
        for (const block of workout.blocks) {
          for (const step of block.steps) {
            if (step.step_kind !== "work" || step.target.kind !== "pace_s_km") continue;
            const mid = (step.target.low + step.target.high) / 2;
            if (mid < input.goalPaceSKm - 1e-6)
              fastBad.push(`${workout.name} 段@${step.target.low}-${step.target.high}（mid ${Math.round(mid)} 比 goal ${Math.round(input.goalPaceSKm)} 快 ${(input.goalPaceSKm - mid).toFixed(1)}s）`);
          }
        }
      }
    }
    checks.push({
      id: "C15 taper长跑禁提速",
      pass: fastBad.length === 0,
      detail: input.bagStage != null ? "bag 阶段跳过" : row.role !== "taper" ? "非 taper 周，跳过" : fastBad.slice(0, 2).join(";") || "全过",
    });
  }


  const workSegsOf = (workout: { blocks: Array<{ repeat: number; steps: Array<{ step_kind: string; target: { kind: string }; duration: { kind: string; value: number | null } }> }> }): number[] => {
    const out: number[] = [];
    for (const b of workout.blocks) for (let r = 0; r < b.repeat; r++) for (const st of b.steps) {
      if (st.step_kind === "work" && st.target.kind === "pace_s_km" && st.duration.kind === "distance_m" && st.duration.value != null && st.duration.value >= 400) out.push(st.duration.value);
    }
    return out;
  };
  // C16 final_quality 段长谱（2026-11-02 原书校准）：Phase 4 的质量课段长下限——
  // T 巡航单段 ≥2km（原书 2-3mi）、独立 M 课 M 段合计 ≥6km 且最长段 ≥3km（原书
  // 3×2mi/2×4mi/连续，短段间歇不是 M 课形态）、I 仅 progress 周且单段 ≥1km（taper/
  // race 周禁 I）。taper 周 T 段豁免下限（质量课缩短不换类型的 taper 语义）。
  {
    const bad: string[] = [];
    const isRaceCtx = row.role === "race";
    if (input.finalQuality === true && input.bagStage == null && !input.templatePath) {
      const isTaper = row.role === "taper";
      const isRace = row.role === "race";
      const iCount = sessions.filter((s) => s.workout.type === "I").length;
      if ((isTaper || isRace) && iCount > 0) bad.push(`taper/赛周出现 I 课 ×${iCount}`);
      if (row.role === "progress" && iCount > 1) bad.push(`I 课 ${iCount} 节 >1/周`);
      for (const { workout } of sessions) {
        if (workout.type === "I" && row.role === "progress") {
          const segs = workSegsOf(workout);
          if (segs.length > 0 && Math.min(...segs) < 950) bad.push(`${workout.name} I 段 <1km`);
        }
        // 赛周激活课豁免段长下限（原书 2×1mi=1.6km 形态；规则⑤ T 触感 2×1-2km 带）
        if (workout.type === "T" && !isTaper && !isRace) {
          const segs = workSegsOf(workout);
          if (segs.length > 0 && Math.min(...segs) < 1950) bad.push(`${workout.name} T 段 <2km`);
        }
        if (workout.type === "M" && !isRace && !isLightMSegmentCourse(workout) && (input.raceDate == null || workout.date !== input.raceDate)) {
          const mSegs = workSegsOf(workout).filter((v) => v >= 1000);
          if (mSegs.length > 0) {
            const totalM = mSegs.reduce((t, v) => t + v, 0) / 1000;
            const longest = Math.max(...mSegs) / 1000;
            if (totalM < 6 - 1e-6) bad.push(`${workout.name} M 段合计 ${totalM.toFixed(1)}km <6km`);
            else if (longest < 3 - 1e-6) bad.push(`${workout.name} M 最长段 ${longest.toFixed(1)}km <3km`);
          }
        }
      }
    }
    checks.push({
      id: "C16 段长谱",
      pass: bad.length === 0,
      detail: input.bagStage != null ? "bag 阶段跳过" : input.templatePath ? "模板豁免" : input.finalQuality !== true ? "非 final_quality，跳过" : isRaceCtx ? "赛周豁免段长（激活课带内即可）" : bad.slice(0, 3).join(";") || "全过",
    });
  }

  // C17 final_quality 有氧份额上限（2026-11-02「E 压缩与 M 段铺开」拍板）：progress
  // 周有氧里程占比 ≤65%——2Q+LR+轻量 M 段位后 E 不得仍占大头（教练基准峰值 MP
  // 周 ~45%，65% 宽带上限给早期周递进留空间）。归课包阶段（LLM 带违规可修），
  // 排位层 P7 只管下限。模板兜底豁免（构造保证底线，mBody 受预算约束）。
  {
    let aero = 0;
    let totalM = 0;
    let unknownShare = false;
    const easyLo = zones.easy?.[0] ?? null;
    const kmOfStep = (st: { step_kind: string; duration: { kind: string; value: number | null }; target: { kind: string; low: number | null; high: number | null } }): number | null => {
      if (st.duration.kind === "distance_m") return st.duration.value ?? 0;
      if (st.duration.kind !== "time_s" || st.duration.value == null) return null;
      const lo = st.target.low;
      const hi = st.target.high ?? lo;
      const paceSec: number = st.target.kind === "pace_s_km" && lo != null && hi != null ? (lo + hi) / 2 : (eMid as number);
      return paceSec > 0 ? st.duration.value / paceSec : null;
    };
    if (input.finalQuality === true && row.role === "progress" && input.bagStage == null && !input.templatePath) {
      for (const { workout } of sessions) {
        for (const b of workout.blocks) {
          for (let r = 0; r < b.repeat; r++) {
            for (const st of b.steps) {
              if (st.step_kind === "rest") continue;
              const km = kmOfStep(st as never);
              if (km == null) { unknownShare = true; break; }
              totalM += km;
              const lo = st.target.low;
              const hi = st.target.high ?? lo;
              const mid = st.target.kind === "pace_s_km" && lo != null && hi != null ? (lo + hi) / 2 : null;
              // 有氧=不快于 E 带慢端（mid ≥ easy 慢端；快于它=质量步。与 courseDose 口径同向）
              const aerobic = mid == null || easyLo == null || mid >= easyLo - 0.5;
              if (aerobic) aero += km;
            }
          }
        }
      }
    }
    const share = totalM > 0 ? aero / totalM : 0;
    const c17Applies = input.finalQuality === true && row.role === "progress" && input.bagStage == null && !input.templatePath && !unknownShare;
    checks.push({
      id: "C17 有氧份额上限",
      pass: !c17Applies || share <= 0.65 + 1e-6,
      detail: input.bagStage != null ? "bag 阶段跳过" : input.templatePath ? "模板豁免" : input.finalQuality !== true || row.role !== "progress" ? "非 FQ progress 周，跳过" : unknownShare ? "里程不可知" : `${(share * 100).toFixed(0)}% vs ≤65%`,
    });
  }

  // C9 E 课时长分层（①⑦⑨，devops#811）：type=E 的课 duration 必填（非 strides
  // 跑步步一律 time_s 处方——⑨ E/REC 量纲=时间）且落带——质量课间隔日 30-60min、
  // 普通日 60-90min。间隔日=周内两节质量课（含比赛课）之间的日子，从 date 周内
  // 位派生；再生周（recovery）无质量课、E 全走短带（低量恢复周与 C1 的可行性
  // 调和，injury 周可低至 10km）。两个例外：赛周激活课（①拍板）=比赛日前 1-3
  // 天的短 E 激活/shakeout；LR 前日轻量（#825 拍板）=长跑前一日 E ≤8km（课实际
  // 里程）或休，时长下限豁免。legacyEDuration=⑨ 之前存量样本整条跳过。
  if (input.bagStage != null) return checks; // C9 归排位段实例化（位置定带），课包阶段不查
  if (input.legacyEDuration) {
    checks.push({ id: "C9 E课时长分层", pass: true, detail: "legacy豁免" });
    return checks;
  }
  const qualityWeekdays = new Set(sessions.filter((s) => hasQualitySegment(s.workout, zones) || isRace(s.workout)).map((s) => weekdayOf(s.workout.date)));
  const isIntervalDay = (wd: number) => [...qualityWeekdays].some((a) => a < wd) && [...qualityWeekdays].some((b) => b > wd);
  const raceWd = raceDate != null ? weekdayOf(raceDate) : null;
  // LR 前日（按周内位 LR−1，不跨周——LR 周一的前日在上周，本层不可判）；赛周无 LR 不适用
  // LR 前日（按 LR 日期−1 天的日期判，LR 周一时前日在上周本层不可判）；帽按日合计
  // 不按单课判（两节各 ≤8km 的 E 合计 16km 同样违规）；里程不可知的 E 挂「不可知」
  const lrEveDate = lrs.length > 0 ? new Date(new Date(`${lrs[0]!.workout.date}T00:00:00Z`).getTime() - 86400_000).toISOString().slice(0, 10) : null;
  let lrEveSumKm = 0;
  let lrEveUnknown = false;
  let lrEveHasE = false;
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
    // LR 前日轻量（#825）：≤8km 或休、时长下限豁免——里程按日累计，循环后统一判日合计
    if (lrEveDate != null && workout.date === lrEveDate) {
      lrEveHasE = true;
      const km = sessionKm(workout, eMid);
      if (km == null) lrEveUnknown = true;
      else lrEveSumKm += km;
      continue;
    }
    // taper 周 E 全短带（2026-11-01 原书校准）：减量从单课体积出、保持频率——多而短
    const taperShort = row.role === "taper";
    const band = isIntervalDay(wd) || input.regeneration || taperShort ? E_DURATION_INTERVAL_BAND : E_DURATION_NORMAL_BAND;
    if (durationMin < band[0] - 1e-6 || durationMin > band[1] + 1e-6) {
      eBad.push(
        `${workout.name} ${durationMin.toFixed(0)}min ∉ ${taperShort && !isIntervalDay(wd) ? "减量周短带" : input.regeneration && !isIntervalDay(wd) ? "再生周" : isIntervalDay(wd) ? "间隔日" : "普通日"}[${band[0]}-${band[1]}]`,
      );
    }
  }
  if (lrEveHasE) {
    if (lrEveUnknown) eBad.push(`LR前日(${lrEveDate}) E 里程不可知（open 处方）——无法判 ≤${LR_EVE_MAX_KM}km 轻量帽`);
    else if (lrEveSumKm > LR_EVE_MAX_KM + LR_EVE_KM_TOL) eBad.push(`LR前日(${lrEveDate}) E 合计 ${lrEveSumKm.toFixed(1)}km 超 ${LR_EVE_MAX_KM}km 轻量帽`);
  }
  checks.push({ id: "C9 E课时长分层", pass: eBad.length === 0, detail: eBad.slice(0, 3).join(";") || "全过" });

  return checks;
}
