import type { RunWorkout, WorkoutStep } from "@stride/contract";

/**
 * L4 内容层判定表（devops#807，#796 grilling 三轮拍板）：全部读 run-workout/v1
 * 字段派生，不依赖生成侧自报标签——合法性=谱内校验，类型（type）只是意图声明。
 *
 * step_kind 语义统一（2026-10-27 用户拍板，全管道教义）：
 * - recovery = 组间慢跑恢复：以恢复为目的、无配速处方（target=open）的短慢跑
 *   （I 1km 组间 400m jog / 90s-3min 慢跑），从属服务于下一组刺激；
 * - rest = 不在跑（站定/走动）：唯一写法=独立 rest step（生成侧不再使用
 *   step.rest 步后字段——Garmin 物化降级为 recovery、hr_bpm/manual 被静默丢弃，
 *   见 garmin/translate.go restFollowupStep；字段仅 legacy 读侧兼容）；
 * - 变速课的慢段不是 recovery：「(2k快+2k慢)×4」的 2k 慢段有配速处方（自身
 *   有氧配速）=训练内容本身 → work 步 + easy target（判定为有氧段）；
 * - work 涵盖一切有配速处方的跑步主体（含 E 课主体，v1 代码注释惯例
 *   "easy run body"）。
 */

/** 配速带（s/km，[快端, 慢端]，开放端 null；与 evidence.current_capability.pace_zones 同构）。 */
type PaceBand = readonly [number | null, number | null];
export interface PaceZones {
  easy: PaceBand | null;
  m: PaceBand | null;
  t: PaceBand | null;
  i: PaceBand | null;
  r: PaceBand | null;
}

/** E 带中点（s/km）：duration↔km 折算锚（easy 缺失返回 null——折算不可知）。 */
export function easyMidOfZones(zones: PaceZones): number | null {
  const [lo, hi] = zones.easy ?? [null, null];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}

/**
 * 步里程（km）：distance 步直读；time 步按配速区间中点派生（⑨量纲：E/REC 处方
 * duration 为主、距离=时长×带配速派生）。recovery 步（组间慢跑）的 time+open
 * 处方按 E 带中点折算计入（#824 拍板：组间慢跑计有氧公里——量纲与分段核算
 * 一致；eMid 缺失返回 null）。其余 open duration / time+open → null（不可知不猜）。
 * validators.sessionKm 与 schedule/dose.courseDose 共用本判定（单一折算口径源）。
 */
export function stepKmOf(step: WorkoutStep, eMidSPerKm?: number | null): number | null {
  if (step.duration.kind === "distance_m") return step.duration.value / 1000;
  if (step.duration.kind === "time_s" && step.target.kind === "pace_s_km") return step.duration.value / ((step.target.low + step.target.high) / 2);
  if (step.step_kind === "recovery" && step.duration.kind === "time_s" && eMidSPerKm != null && eMidSPerKm > 0) return step.duration.value / eMidSPerKm;
  return null;
}

/** 质量谱慢端容差（s/km）：M 带上沿 +10（判定表拍板锚点）。 */
const QUALITY_SLOW_TOL_S = 10;
/** 有氧步 E 带容差（s/km）：±10。 */
const AEROBIC_TOL_S = 10;
/** 质量段时间门槛：折算 ≥30s（<30s 加速跑不算刺激）。 */
const MIN_STIMULUS_S = 30;
/** 质量段距离门槛：>100m（100m strides 不算、不占 Q）。 */
const MIN_STIMULUS_M = 100;

/** 质量谱：快端=R 带下限（开放端则无界），慢端=M 带上沿 +10s/km 容差；m/r 带缺失返回 null（不猜）。 */
interface QualitySpectrum {
  fast: number | null;
  slow: number;
}
export function qualitySpectrum(zones: PaceZones): QualitySpectrum | null {
  if (zones.m == null || zones.r == null || zones.m[1] == null) return null;
  return { fast: zones.r[0], slow: zones.m[1] + QUALITY_SLOW_TOL_S };
}

/** 区间下限+容差内（band=[快,慢]；band 缺失=false）。 */
function inPaceBand(lo: number, hi: number, band: PaceBand | null, tol: number): boolean {
  if (band == null || band[0] == null || band[1] == null) return false;
  return lo >= band[0] - tol && hi <= band[1] + tol;
}

/**
 * 步时长下界（s）：time 步直读；distance 步按处方快端折算（跑得最快也至少这么久，
 * 最不利端保证「≥30s」判定在处方区间内恒成立）；open/非配速处方 → null（不可估）。
 */
function stepTimeFloorS(step: WorkoutStep): number | null {
  if (step.duration.kind === "time_s") return step.duration.value;
  if (step.duration.kind !== "distance_m" || step.target.kind !== "pace_s_km") return null;
  return (step.duration.value / 1000) * step.target.low;
}

/**
 * 步距离下界（m）：distance 步直读；time 步按处方慢端折算（跑得最慢也至少这么远，
 * 最不利端保证「>100m」恒成立）；open/非配速处方 → null（不可估）。
 */
function stepDistanceFloorM(step: WorkoutStep): number | null {
  if (step.duration.kind === "distance_m") return step.duration.value;
  if (step.duration.kind !== "time_s" || step.target.kind !== "pace_s_km") return null;
  return (step.duration.value / step.target.high) * 1000;
}

/**
 * 质量段（刺激）：step_kind=work 且 target.kind=pace_s_km 且 low/high 落质量谱
 * （不要求单带归属——教练 MP-10s 处方天然跨带合法）且时长 ≥30s 且距离 >100m。
 * recovery/rest 步天然排除；hr_bpm/power_w/cadence_spm 处方不在配速谱上、无法
 * 判质量（显式规则：非配速处方不构成质量段，也不计入 Q 配额）；open 处方
 * （组间慢跑/strides）排除。
 */
export function isQualityStep(step: WorkoutStep, zones: PaceZones): boolean {
  if (step.step_kind !== "work" || step.target.kind !== "pace_s_km") return false;
  const spectrum = qualitySpectrum(zones);
  if (spectrum == null) return false;
  if (step.target.high > spectrum.slow) return false;
  if (spectrum.fast != null && step.target.low < spectrum.fast) return false;
  const timeS = stepTimeFloorS(step);
  const distM = stepDistanceFloorM(step);
  return timeS != null && timeS >= MIN_STIMULUS_S && distM != null && distM > MIN_STIMULUS_M;
}

/**
 * 有氧段：work/warmup/cooldown 步且 target 在 E 带容差内或 open。有配速处方的
 * 变速课慢段（work@easy）在此判定为有氧段；非配速处方（hr/power/cadence）不在
 * 配速谱上判定。
 */
export function isAerobicStep(step: WorkoutStep, zones: PaceZones): boolean {
  if (step.step_kind !== "work" && step.step_kind !== "warmup" && step.step_kind !== "cooldown") return false;
  if (step.target.kind === "open") return true;
  if (step.target.kind !== "pace_s_km") return false;
  return inPaceBand(step.target.low, step.target.high, zones.easy, AEROBIC_TOL_S);
}

/**
 * 短加速步（strides 触感）：open 处方的短 work 步（≤100m 或 <30s）——不算质量段、
 * 不占 Q 配额；并入 E 课、允许 note 要点。
 */
export function isStrideStep(step: WorkoutStep): boolean {
  if (step.step_kind !== "work" || step.target.kind !== "open") return false;
  if (step.duration.kind === "distance_m") return step.duration.value <= MIN_STIMULUS_M;
  if (step.duration.kind === "time_s") return step.duration.value < MIN_STIMULUS_S;
  return false;
}

/** 该课含 ≥1 质量段（Q 配额按课计；LR 内嵌 work 尾段也算一节质量课）。 */
export function hasQualitySegment(workout: RunWorkout, zones: PaceZones): boolean {
  return workout.blocks.some((block) => block.steps.some((step) => isQualityStep(step, zones)));
}

/** 该课含 ≥1 短加速步。 */
export function hasStrideStep(workout: RunWorkout): boolean {
  return workout.blocks.some((block) => block.steps.some(isStrideStep));
}

/** 首块存在 warmup 步（判定表：热身在场；周历日期/里程差判的备选路径不做）。 */
export function hasWarmup(workout: RunWorkout): boolean {
  return workout.blocks[0]!.steps.some((s) => s.step_kind === "warmup");
}

/** 末块存在 cooldown 步（判定表：放松在场）。 */
export function hasCooldown(workout: RunWorkout): boolean {
  return workout.blocks.at(-1)!.steps.some((s) => s.step_kind === "cooldown");
}

interface MainQualitySegment {
  step: WorkoutStep;
  /** 展开总距离（m）：repeat × 步距离；time 步按配速区间中点折算（中点口径只用于排序，不作合法性判定）。 */
  distanceM: number;
}

/**
 * 主质量段：全部质量步中展开距离最长者（同一处方的 repeat 聚合；组合课以此定
 * 主段，副段只需谱内合法）。无质量段返回 null。
 */
export function mainQualitySegment(workout: RunWorkout, zones: PaceZones): MainQualitySegment | null {
  let best: MainQualitySegment | null = null;
  workout.blocks.forEach((block) => {
    block.steps.forEach((step) => {
      if (!isQualityStep(step, zones)) return;
      let distM: number | null = null;
      if (step.duration.kind === "distance_m") distM = step.duration.value;
      else if (step.duration.kind === "time_s" && step.target.kind === "pace_s_km")
        distM = (step.duration.value / ((step.target.low + step.target.high) / 2)) * 1000;
      if (distM == null) return;
      const expanded = block.repeat * distM;
      if (best == null || expanded > best.distanceM) best = { step, distanceM: expanded };
    });
  });
  return best;
}
