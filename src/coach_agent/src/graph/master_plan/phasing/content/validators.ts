import { type RunWorkout, type RunWorkoutType, workoutTotals } from "@stride/contract";
import { hasCooldown, hasQualitySegment, hasStrideStep, hasWarmup, isAerobicStep, mainQualitySegment, type PaceZones, qualitySpectrum } from "./derive.js";

/**
 * L4 内容层校验（devops#807；叫法拍板 2026-10-27：validation，不用 gate）。
 * 一致性组（type 罩主段/purpose 必填）+ 守恒组（C1-C8）全部读 V1 事实（配速/距离/时长/date/type 声明），
 * 与判定表（derive.ts）同源。
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
  /** 比赛日（ISO date）：该日课=比赛课——C7 热身/放松豁免，且本身按一节质量课计。 */
  raceDate?: string;
  /** 新生成的课必填 purpose（默认 true）；存量回放传 false 视为 legacy。 */
  requirePurpose?: boolean;
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

const totalsKm = (w: RunWorkout): number | null => {
  const m: number | null = workoutTotals(w).total_distance_m;
  return m == null ? null : m / 1000;
};

export function validateWeekContent(input: WeekContentInput): ContentValidation[] {
  const { sessions, row, zones, maxTrainingDays, raceDate } = input;
  const requirePurpose = input.requirePurpose ?? true;
  const checks: ContentValidation[] = [];
  const spectrum = qualitySpectrum(zones);
  const isRace = (w: RunWorkout) => raceDate != null && w.date === raceDate;

  // 一致性：声明 type 的带须罩住主质量段（按距离最长的质量段 ±10s/km）。
  // 声明 T 但主段在 E 带=违规；组合课副段只需谱内（C5）；LR 内嵌 M/T 尾段合法、
  // type 仍 LR（位型课不罩带）；E/M/T/I/R 无主质量段时无罩带义务（纯有氧课）。
  // 带边界 null=开放界（如 r 快端），只比较有值一侧——与 qualitySpectrum 语义对齐。
  const coverBad: string[] = [];
  for (const { workout } of sessions) {
    const type = workout.type ?? null;
    if (type == null || type === "LR") continue;
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

  // C1 周量守恒：Σ课里程（totals 口径=blocks 展开）vs L3 total_km，±max(3km, 3%)。
  // totals 对混入 time_s/open 步的课返回 null（未知不猜）→ 整周挂「不可知」；
  // 生成侧约束：跑步步用 distance_m 表达（时长可由配速区间派生）。
  const unknown = sessions.filter((s) => totalsKm(s.workout) == null).map((s) => s.workout.name);
  const sumKm = unknown.length === 0 ? sessions.reduce((sum, s) => sum + (totalsKm(s.workout) ?? 0), 0) : null;
  const tol = Math.max(WEEK_KM_ABS_TOL, row.total_km * WEEK_KM_REL_TOL);
  checks.push({
    id: "C1 周量守恒",
    pass: sumKm != null && Math.abs(sumKm - row.total_km) <= tol,
    detail: unknown.length ? `里程不可知:${unknown.join(",")}` : sumKm != null ? `Σ${sumKm.toFixed(1)} vs 骨架${row.total_km}（±${tol.toFixed(1)}）` : "",
  });

  // C2 长跑唯一且合值：lr≠null 时 type=LR 恰一节 ±1.5km；赛周 lr=null 豁免为 0 节。
  const lrs = sessions.filter((s) => s.workout.type === "LR");
  let lrOk: boolean;
  let lrDetail: string;
  if (row.long_run_km == null) {
    lrOk = lrs.length === 0;
    lrDetail = `赛周 lr=null，${lrs.length} 节 LR`;
  } else {
    const lrKm = lrs.length === 1 ? totalsKm(lrs[0]!.workout) : null;
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

  // C8 展开守恒：课总里程（totals=repeat 展开口径）vs 期望里程 ±0.5km——组数×
  // 步距算术错挂门；无期望锚（生产 V1 无 km 字段）时跳过。
  const anchored = sessions.filter((s) => s.expectedKm != null);
  const expandBad = anchored
    .filter((s) => {
      const km = totalsKm(s.workout);
      return km == null || Math.abs(km - (s.expectedKm ?? 0)) > EXPAND_KM_TOL;
    })
    .map((s) => `${s.workout.name} ${totalsKm(s.workout) ?? "?"}vs${s.expectedKm}`);
  const expandDetail = expandBad.length > 0 ? expandBad.join(";") : anchored.length > 0 ? `全过(${anchored.length}锚)` : "无期望锚，跳过";
  checks.push({ id: "C8 展开守恒", pass: expandBad.length === 0, detail: expandDetail });

  return checks;
}
