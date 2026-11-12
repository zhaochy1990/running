// 「我的训练计划」页 —— #436。展示当前启用中的 master plan（原型定稿方案
// B「备赛旅程」，对齐 Web /plan SeasonOverview 的信息架构）。
// 数据来自 GET /api/users/{user}/master-plan/current（services/master-plan.ts
// 的 getCurrentMasterPlan，404 → 空态）；视图模型沿原型
// prototype/mp-profile-training-plan 的 buildViewModels/buildChart 逻辑换
// 真实数据源：日期、倒计时、当前周、阶段状态均由 today + plan 派生。
// v1（markdown）计划不做渲染，只提示去网页查看。

import { getCurrentMasterPlan } from '../../services/master-plan';
import {
  dismissAdjustment,
  getPendingAdjustment,
} from '../../services/plan-adjustment';
import {
  answerInjuryDoctor,
  checkinInjury,
  enterInjury,
  getInjuryState,
} from '../../services/plan-injury';
import { getWeeklyPlan } from '../../services/plan';
import { STORAGE_KEYS } from '../../constants/config';
import { theme } from '../../utils/theme';
import type {
  MasterPlanMilestone,
  MasterPlanPhase,
  MasterPlanWeek,
  SeasonPlanContent,
} from '../../services/master-plan';
import type { PlannedSession, WeeklyPlanContentStructured } from '../../types/plan';
import type { PlanAdjustment, PlanInjuryState } from '../../types/adjustment';
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import {
  epochToShanghaiYmd,
  shanghaiToday,
  shanghaiWeekdayLabel,
  shanghaiYmdToEpoch,
  weekFolderName,
} from '../../utils/date';
import {
  checkinResultText,
  doctorResultText,
  enterResultText,
  injuryBannerText,
  raceClosingWithinWeeks,
} from '../../utils/injuryFlow';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

interface PhaseMilestoneVM {
  key: string;
  dateLabel: string;
  typeLabel: string;
  valueText: string;
  done: boolean;
  isNext: boolean;
  daysUntilLabel: string;
}

interface PhaseVM {
  key: string;
  name: string;
  typeLabel: string;
  color: string;
  weeksLabel: string;
  weekCount: number;
  dateRange: string;
  kmRange: string;
  focus: string;
  rhythm?: string;
  keyWorkouts?: string;
  triggers: string[];
  keySessionTypes: string[];
  summaryLine?: string;
  hrZoneLine?: string;
  coachNote?: string;
  milestones: PhaseMilestoneVM[];
  state: 'done' | 'current' | 'future';
}

interface WeekRowVM {
  key: string;
  phaseKey: string;
  weekIndex: number;
  dateRange: string;
  /** 周一 YYYY-MM-DD（无 weekly 行的缺口周为空串，「每日安排」入口随之隐藏）。 */
  weekStart: string;
  planKm: string;
  actualKm?: string;
  actualSub?: string;
  tag: string;
  state: 'done' | 'current' | 'future';
}

/** 本周关键课（周行展开时跟随当前周渲染）。 */
interface SessionVM {
  key: string;
  iconPath: string;
  title: string;
  meta: string;
  km: string;
}

/** 「每日安排」折叠区的单日行（weekly 行 sessions 投影，#858 PR-E）。 */
interface DayPlanVM {
  key: string;
  dateLabel: string;
  summary: string;
  iconPath: string;
  km: string;
  isRest: boolean;
}

interface ChartBarVM {
  key: string;
  week: number;
  state: 'done' | 'current' | 'future';
  fillH: number;
  bandH: number;
  tickBottom: number;
  barColor: string;
  bandColor: string;
  opacity: number;
  label: string;
}

interface ChartSpanVM {
  key: string;
  label: string;
  weeks: number;
  color: string;
}

interface TimelineItemVM {
  key: string;
  kind: 'phase' | 'week';
  state: 'done' | 'current' | 'future';
  phase?: PhaseVM;
  week?: WeekRowVM;
}

interface TrainingPlanPageData {
  statusBarHeight: number;
  /** 栈深>1 顶栏显示返回箭头；=1（冷开分享卡直达）显示回主页的小房子 */
  canBack: boolean;
  contentPaddingTop: number;
  /** loading：请求中；ready：v2 内容；empty：无启用计划；v1：旧版计划；error：请求失败 */
  loadState: 'loading' | 'ready' | 'empty' | 'v1' | 'error';
  errorText: string;
  // #858 PR-E 顶部提示条：pending 调整优先，伤病激活次之
  bannerKind: 'none' | 'adjust' | 'injury';
  bannerText: string;
  // 目标条
  eyebrowStatus: string;
  raceName: string;
  raceDistanceLabel: string;
  raceDateLabel: string;
  targetTime: string;
  targetPace: string;
  countdownDays: number;
  ledeText: string;
  // 训练周期图
  chartMetric: 'km' | 'dose';
  chartBars: ChartBarVM[];
  chartSpans: ChartSpanVM[];
  chartDetail: string;
  chartSelectedWeek: number;
  weekNow: number;
  weekTotal: number;
  // 旅程时间轴
  timeline: TimelineItemVM[];
  /** 各阶段周次是否展开（key = p0..pN）；默认全部收起 */
  expandedPhases: Record<string, boolean>;
  /** 各周「每日安排」是否展开（key = w1..wN）。 */
  expandedWeekDays: Record<string, boolean>;
  /** 各周「每日安排」行（key = w1..wN → DayPlanVM[]，懒加载后填充）。 */
  weekDayPlans: Record<string, DayPlanVM[]>;
  // 本周关键课（当前周行展开时渲染）
  currentSessions: SessionVM[];
  // 训练原则（常展开编号列表）
  principles: Array<{ key: string; no: string; text: string }>;
  // —— #858 PR-E 弹层状态 ——
  uid: string;
  adjustDialogVisible: boolean;
  pendingAdjustment: PlanAdjustment | null;
  injuryDialogVisible: boolean;
  injuryDialogMode: 'enter' | 'ask';
  injuryState: PlanInjuryState | null;
  injuryResultText: string;
  raceClosingSoon: boolean;
}

interface AdjustDialogEvent {
  detail: { adjustmentId: string };
}

interface InjuryEnteredEvent {
  detail: { detail: string; verdict: 'continue' | 'reduced' | 'rest' | 'undecided' };
}

interface InjuryCheckedEvent {
  detail: { answer: 'better' | 'same' | 'worse' | 'recovered' };
}

interface InjuryDoctoredEvent {
  detail: { verdict: 'continue' | 'reduced' | 'rest' };
}

interface TrainingPlanPageHandlers {
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent;
  onShareTimeline(): WechatMiniprogram.Page.ICustomTimelineContent;
  onBackTap(): void;
  onRetryTap(): void;
  onCoachTap(): void;
  onAdjustTap(): void;
  onBannerTap(): void;
  onBarTap(e: WechatMiniprogram.TouchEvent): void;
  onMetricToggle(e: WechatMiniprogram.TouchEvent): void;
  onTogglePhaseWeeks(e: WechatMiniprogram.TouchEvent): void;
  onToggleWeekDays(e: WechatMiniprogram.TouchEvent): void;
  loadPlan(): Promise<void>;
  loadStatusFlags(): Promise<void>;
  openInjuryAsk(): void;
  applyPlan(plan: SeasonPlanContent): void;
  refreshWeekDays(key: string, weekStart: string): Promise<void>;
  onAdjustClosed(): void;
  onAdjustAccepted(): void;
  onAdjustDismissed(): void;
  onAdjustInjury(e: AdjustDialogEvent): void;
  onInjuryClosed(): void;
  onInjuryEntered(e: InjuryEnteredEvent): Promise<void>;
  onInjuryChecked(e: InjuryCheckedEvent): Promise<void>;
  onInjuryDoctored(e: InjuryDoctoredEvent): Promise<void>;
  onInjuryCoach(): void;
  /** buildViewModels 的派生上下文，指标切换/点柱详情时复用（存实例避免模块级串扰）。 */
  _planCtx: PlanContext | null;
}

// 阶段配色沿用 Web PHASE_VISUALS 语义降饱和以贴深色主题（原型定稿）；
// 「当前/你在这里」的注意力色仍是主题粉 #ff6363。
const PHASE_TYPE_META: Record<string, { label: string; color: string }> = {
  base: { label: '基础', color: '#7ac9a3' },
  speed: { label: '速度', color: '#6db3cf' },
  build: { label: '专项', color: '#6db3cf' },
  peak: { label: '峰值', color: '#d9a45f' },
  taper: { label: '减量', color: '#b395d6' },
  race: { label: '比赛', color: '#ff6363' },
  recovery: { label: '恢复', color: '#6b7280' },
};

const PHASE_ORDER = ['base', 'speed', 'build', 'peak', 'taper', 'race', 'recovery'];

const SESSION_TYPE_META: Record<string, { label: string; iconPath: string }> = {
  long_run: { label: '长距离跑', iconPath: '/assets/icons/directions_run.svg' },
  threshold: { label: '阈值跑', iconPath: '/assets/icons/fitness_center.svg' },
  tempo: { label: '节奏跑', iconPath: '/assets/icons/fitness_center.svg' },
  interval: { label: '间歇跑', iconPath: '/assets/icons/sprint.svg' },
  vo2max: { label: '间歇跑', iconPath: '/assets/icons/sprint.svg' },
  hill: { label: '坡度跑', iconPath: '/assets/icons/trend_up.svg' },
  race_pace: { label: '配速跑', iconPath: '/assets/icons/flag.svg' },
  time_trial: { label: '测验', iconPath: '/assets/icons/flag.svg' },
  tune_up_race: { label: '热身赛', iconPath: '/assets/icons/flag.svg' },
  race: { label: '比赛', iconPath: '/assets/icons/flag.svg' },
  strength_key: { label: '力量课', iconPath: '/assets/icons/fitness_center.svg' },
};

const DISTANCE_LABELS: Record<string, string> = {
  '5K': '5K',
  '10K': '10K',
  HM: '半马',
  FM: '全马',
};

/** 里程碑 type 枚举（coach_contract MilestoneSchema）的中文标签。 */
const MILESTONE_TYPE_LABELS: Record<string, string> = {
  race: '比赛',
  test_run: '测验',
  long_run: '长距离',
  strength_test: '力量测验',
  body_composition: '体测',
};

// ---------- 工具（沿用原型 / Web 端格式化习惯；日历算术全部走上海时区，见 utils/date.ts） ----------

const DAY_MS = 24 * 60 * 60 * 1000;

/** 计划日期（YYYY-MM-DD 或 ISO 时间戳）→ 上海日历日 00:00 的 epoch ms；非法返回 null。 */
function ymdToEpoch(value: string): number | null {
  const epoch = shanghaiYmdToEpoch(value.split('T')[0]);
  return Number.isNaN(epoch) ? null : epoch;
}

/** 上海日历日 epoch → Web 端 formatShort 习惯的 M/D（无前导零）。 */
function fmtShort(epoch: number): string {
  const [, m, d] = epochToShanghaiYmd(epoch).split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 上海日历日的整天差。 */
function daysBetween(fromEpoch: number, toEpoch: number): number {
  return Math.round((toEpoch - fromEpoch) / DAY_MS);
}

/** Web 端 padWeek 习惯：W01-W18。 */
function padWeek(w: number): string {
  return `W${String(w).padStart(2, '0')}`;
}

/** Web 端 formatKm 习惯：整数无小数、否则 1 位小数。 */
function fmtKm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function distanceLabel(value: string): string {
  return DISTANCE_LABELS[value] || value;
}

/** 目标配速 = 目标成绩 ÷ 项距离；仅接受 H:MM:SS（后端约定格式），无法换算时返回空串。 */
function targetPaceOf(distance: string | undefined, targetTime: string | undefined): string {
  const dist = distance === 'FM' ? 42.195 : distance === 'HM' ? 21.0975 : distance === '10K' ? 10 : distance === '5K' ? 5 : 0;
  if (!dist || !targetTime) return '';
  const parts = targetTime.split(':').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n) || n < 0)) return '';
  const sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (sec <= 0) return '';
  const pace = Math.round(sec / dist);
  return `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}/km`;
}

function phaseKind(phase: MasterPlanPhase, index: number): string {
  if (phase.phase_type && PHASE_TYPE_META[phase.phase_type]) return phase.phase_type;
  const name = phase.name;
  if (/基础|Base/i.test(name)) return 'base';
  if (/速度|Speed/i.test(name)) return 'speed';
  if (/峰值|Peak/i.test(name)) return 'peak';
  if (/专项|Build/i.test(name)) return 'build';
  if (/减量|Taper/i.test(name)) return 'taper';
  if (/比赛|Race/i.test(name)) return 'race';
  if (/恢复|Recovery/i.test(name)) return 'recovery';
  return PHASE_ORDER[index % PHASE_ORDER.length];
}

/** 每个阶段覆盖的周区间（from/to，含端点）。weeks[] 不全覆盖时（老计划：后端只为
 * 已开始的周合成周行），缺口阶段按日期推周区间，保证每个阶段都有 span。
 * #858 滚动合并兼容：快照外新增周（weekly 行 append）可能落在所有阶段日期之外
 * （phase_id 解析不到）——这类孤周挂到最后一个阶段，避免从时间轴上消失。 */
function phaseWeekSpans(plan: SeasonPlanContent): Map<string, { from: number; to: number }> {
  const out = new Map<string, { from: number; to: number }>();
  const covered = new Map<number, string>(); // week_index → phase_id（日期推算的区间也算覆盖）
  for (const w of plan.weeks) {
    const span = out.get(w.phase_id) || { from: w.week_index, to: w.week_index };
    span.from = Math.min(span.from, w.week_index);
    span.to = Math.max(span.to, w.week_index);
    out.set(w.phase_id, span);
    covered.set(w.week_index, w.phase_id);
  }
  const planStart = plan.start_date ? ymdToEpoch(plan.start_date) : null;
  for (let i = 0; i < plan.phases.length; i += 1) {
    const p = plan.phases[i];
    if (out.has(p.id)) continue;
    const s = ymdToEpoch(p.start_date);
    const e = ymdToEpoch(p.end_date);
    if (s != null && planStart != null) {
      const from = Math.floor((s - planStart) / (7 * DAY_MS)) + 1;
      const to = e != null ? from + Math.max(1, Math.ceil((e - s + DAY_MS) / (7 * DAY_MS))) - 1 : from;
      out.set(p.id, { from, to });
      for (let w = from; w <= to; w += 1) covered.set(w, p.id);
    } else {
      const prev = i > 0 ? out.get(plan.phases[i - 1].id) : undefined;
      out.set(p.id, { from: prev ? prev.to + 1 : 1, to: prev ? prev.to + 1 : 1});
    }
  }
  // 孤周（无 phase_id 的 week 行）挂最后一个阶段：区间末尾延伸到最大周号。
  const lastPhase = plan.phases[plan.phases.length - 1];
  if (lastPhase) {
    const span = out.get(lastPhase.id);
    let extended = span ? span.to : 0;
    let hasOrphan = false;
    for (const w of plan.weeks) {
      if (covered.get(w.week_index)) continue;
      extended = Math.max(extended, w.week_index);
      hasOrphan = true;
    }
    if (hasOrphan && span) span.to = extended;
  }
  return out;
}

/** 当前周：优先后端派生的 current_week_number，缺了再按 start_date 推。 */
function resolveWeekNow(plan: SeasonPlanContent, todayEpoch: number): number {
  const total = plan.total_weeks || plan.phases.length;
  if (plan.current_week_number && plan.current_week_number >= 1) {
    return Math.min(plan.current_week_number, total);
  }
  const start = ymdToEpoch(plan.start_date);
  if (start == null) return 1;
  const raw = Math.floor((todayEpoch - start) / (7 * DAY_MS)) + 1;
  return Math.max(1, Math.min(total || raw, raw));
}

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function contentPaddingTopRpx(): number {
  let statusPx = 0;
  let width = 375;
  try {
    const win = wx.getWindowInfo();
    statusPx = win.statusBarHeight;
    width = win.windowWidth || 375;
  } catch {
    const sys = wx.getSystemInfoSync();
    statusPx = sys.statusBarHeight || 0;
    width = sys.windowWidth || 375;
  }
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

// ---------- 视图模型 ----------

/** buildViewModels 的派生上下文：chart 详情行复用，不用模块级缓存。 */
interface PlanContext {
  plan: SeasonPlanContent;
  weeksByIndex: Map<number, MasterPlanWeek>;
  spans: Map<string, { from: number; to: number }>;
  phaseById: Map<string, MasterPlanPhase>;
  /** 今天（上海日历日 00:00 的 epoch ms）。 */
  today: number;
  weekNow: number;
  weekTotal: number;
  currentPhaseId: string;
}

function phaseOf(ctx: PlanContext, week: number): MasterPlanPhase {
  const w = ctx.weeksByIndex.get(week);
  if (w) {
    const byId = ctx.phaseById.get(w.phase_id);
    if (byId) return byId;
  }
  for (const [id, span] of ctx.spans) {
    if (span.from <= week && week <= span.to) {
      const byId = ctx.phaseById.get(id);
      if (byId) return byId;
    }
  }
  return ctx.plan.phases[ctx.plan.phases.length - 1];
}

function plannedKmText(week: MasterPlanWeek | undefined, phase: MasterPlanPhase): string {
  if (week && week.target_weekly_km_low != null && week.target_weekly_km_high != null) {
    return `${fmtKm(week.target_weekly_km_low)}-${fmtKm(week.target_weekly_km_high)} km`;
  }
  return `${fmtKm(phase.weekly_distance_km_low)}-${fmtKm(phase.weekly_distance_km_high)} km`;
}

function weekStart(plan: SeasonPlanContent, weekIndex: number): number | null {
  const row = plan.weeks.find((w) => w.week_index === weekIndex);
  if (row) return ymdToEpoch(row.week_start);
  const start = ymdToEpoch(plan.start_date);
  if (start == null) return null;
  return start + (weekIndex - 1) * 7 * DAY_MS;
}

// 负荷近似系数（原型定稿的启发式）：计划 dose ≈ 周跑量 × 6.6-7.6，
// 实际 dose ≈ 实际跑量 × 7.1。仅在后端没写显式 dose 字段时兜底。
const DOSE_PER_KM_PLANNED_LOW = 6.6;
const DOSE_PER_KM_PLANNED_HIGH = 7.6;
const DOSE_PER_KM_ACTUAL = 7.1;

/** 计划负荷区间：target_training_dose 缺失时按周跑量兜底估算（唯一来源，柱图带与详情行共用）。 */
function plannedDoseRange(week: MasterPlanWeek | undefined, phase: MasterPlanPhase): { low: number; high: number } {
  const lowKm = week?.target_weekly_km_low ?? phase.weekly_distance_km_low;
  const highKm = week?.target_weekly_km_high ?? phase.weekly_distance_km_high;
  return {
    low: week?.target_training_dose_low ?? Math.round(lowKm * DOSE_PER_KM_PLANNED_LOW),
    high: week?.target_training_dose_high ?? Math.round(highKm * DOSE_PER_KM_PLANNED_HIGH),
  };
}

/** 实际负荷：actual_training_dose 优先，缺失时按实际跑量估算；无实际数据返回 null。 */
function actualDose(week: MasterPlanWeek | undefined): number | null {
  if (!week) return null;
  if (week.actual_training_dose != null) return week.actual_training_dose;
  return week.actual_distance_km != null ? week.actual_distance_km * DOSE_PER_KM_ACTUAL : null;
}

/** 训练周期图（Web MileageCycleCard 的移动端转译，原型 buildChart 移植）。 */
function buildChart(ctx: PlanContext, metric: 'km' | 'dose'): { bars: ChartBarVM[]; spans: ChartSpanVM[] } {
  const CHART_AREA_RPX = 150;

  let maxKm = 0;
  let maxDose = 0;
  for (let w = 1; w <= ctx.weekTotal; w += 1) {
    const week = ctx.weeksByIndex.get(w);
    const phase = phaseOf(ctx, w);
    const high = week?.target_weekly_km_high ?? phase.weekly_distance_km_high;
    maxKm = Math.max(maxKm, high, week?.actual_distance_km ?? 0);
    maxDose = Math.max(maxDose, plannedDoseRange(week, phase).high, actualDose(week) ?? 0);
  }
  if (maxKm <= 0) maxKm = 1;
  if (maxDose <= 0) maxDose = 1;

  const bars: ChartBarVM[] = [];
  for (let w = 1; w <= ctx.weekTotal; w += 1) {
    const week = ctx.weeksByIndex.get(w);
    const phase = phaseOf(ctx, w);
    const meta = PHASE_TYPE_META[phaseKind(phase, ctx.plan.phases.indexOf(phase))];
    const state: ChartBarVM['state'] = w < ctx.weekNow ? 'done' : w === ctx.weekNow ? 'current' : 'future';
    const plannedLow = week?.target_weekly_km_low ?? phase.weekly_distance_km_low;
    const plannedHigh = week?.target_weekly_km_high ?? phase.weekly_distance_km_high;
    const plannedMid = week?.planned_distance_km ?? (plannedLow + plannedHigh) / 2;
    const actual = week?.actual_distance_km ?? undefined;

    let fillH = 0;
    let bandH = 0;
    let tickBottom = 0;
    if (metric === 'km') {
      fillH = Math.round(((actual ?? plannedMid) / maxKm) * CHART_AREA_RPX);
      tickBottom = Math.round((plannedMid / maxKm) * CHART_AREA_RPX);
    } else {
      const range = plannedDoseRange(week, phase);
      bandH = Math.round((Math.max(range.high, range.low) / maxDose) * CHART_AREA_RPX);
      const ad = actualDose(week);
      if (ad != null) {
        fillH = Math.round((ad / maxDose) * CHART_AREA_RPX);
      }
    }
    bars.push({
      key: `b${w}`,
      week: w,
      state,
      fillH,
      bandH,
      tickBottom,
      barColor: state === 'current' ? theme.accent : meta.color,
      bandColor: meta.color,
      opacity: state === 'future' ? 0.18 : state === 'done' ? 0.85 : 1,
      label: state === 'current' ? '当前' : '',
    });
  }

  const spans: ChartSpanVM[] = ctx.plan.phases.map((p, i) => {
    const meta = PHASE_TYPE_META[phaseKind(p, i)];
    const span = ctx.spans.get(p.id);
    return {
      key: `sp${i}`,
      label: meta.label,
      weeks: span ? span.to - span.from + 1 : 1,
      color: meta.color,
    };
  });
  return { bars, spans };
}

/** 点柱后的详情行 ≈ Web 的 hover tooltip（原型 buildChartDetail 移植）。 */
function buildChartDetail(ctx: PlanContext, weekIndex: number, metric: 'km' | 'dose'): string {
  const phase = phaseOf(ctx, weekIndex);
  const week = ctx.weeksByIndex.get(weekIndex);
  const parts: string[] = [padWeek(weekIndex)];
  const ws = weekStart(ctx.plan, weekIndex);
  if (ws != null) {
    parts.push(`${fmtShort(ws)} – ${fmtShort(ws + 6 * DAY_MS)}`);
  }
  const state: 'done' | 'current' | 'future' =
    weekIndex < ctx.weekNow ? 'done' : weekIndex === ctx.weekNow ? 'current' : 'future';

  const actualKm = week?.actual_distance_km;
  if (metric === 'km') {
    parts.push(`计划 ${plannedKmText(week, phase).replace(' km', '')} km`);
    if (actualKm != null) {
      parts.push(`实际 ${fmtKm(actualKm)} km${state === 'current' ? '（截至目前）' : ''}`);
      const sub: string[] = [];
      if (week?.actual_avg_pace_fmt) sub.push(`${week.actual_avg_pace_fmt}/km`);
      if (week?.actual_avg_hr) sub.push(`${week.actual_avg_hr} bpm`);
      if (sub.length) parts.push(sub.join(' · '));
    } else if (state !== 'future') {
      parts.push('未完成');
    }
  } else {
    const range = plannedDoseRange(week, phase);
    parts.push(`计划负荷 ${fmtKm(range.low)}-${fmtKm(range.high)} dose`);
    const ad = actualDose(week);
    if (ad != null && ad > 0) {
      parts.push(`实际负荷 ${fmtKm(ad)} dose${state === 'current' ? '（截至目前）' : ''}`);
    }
  }
  return parts.join(' · ');
}

function buildViewModels(plan: SeasonPlanContent, todayEpoch: number) {
  // #858 滚动合并兼容：快照外 append 的周行 week_index 可能超过 total_weeks
  // （批次边界推进后），柱图/周号上限取两者最大，避免新周没有柱、时间轴截断。
  const maxWeekIndex = plan.weeks.reduce((m, w) => Math.max(m, w.week_index), 0);
  const totalWeeks = Math.max(plan.total_weeks || plan.weeks.length || plan.phases.length, maxWeekIndex);
  const weekNow = resolveWeekNow(plan, todayEpoch);
  const spans = phaseWeekSpans(plan);
  const weeksByIndex = new Map<number, MasterPlanWeek>();
  for (const w of plan.weeks) weeksByIndex.set(w.week_index, w);
  const phaseById = new Map<string, MasterPlanPhase>();
  for (const p of plan.phases) phaseById.set(p.id, p);

  let currentPhaseId = plan.current_phase_id || '';
  if (!currentPhaseId || !phaseById.has(currentPhaseId)) {
    for (const [id, span] of spans) {
      if (span.from <= weekNow && weekNow <= span.to) {
        currentPhaseId = id;
        break;
      }
    }
  }

  const ctx: PlanContext = {
    plan,
    weeksByIndex,
    spans,
    phaseById,
    today: todayEpoch,
    weekNow,
    weekTotal: totalWeeks,
    currentPhaseId,
  };

  const goal = plan.goal;
  const raceDate = ymdToEpoch(goal.race_date || plan.end_date);
  const countdownDays = raceDate != null ? Math.max(0, daysBetween(todayEpoch, raceDate)) : 0;
  const currentPhase = phaseById.get(currentPhaseId) || plan.phases[plan.phases.length - 1];
  const startDate = ymdToEpoch(plan.start_date);

  const ledeParts: string[] = [];
  if (startDate && raceDate) ledeParts.push(`${fmtShort(startDate)} – ${fmtShort(raceDate)}`);
  ledeParts.push(`共 ${totalWeeks} 周`);
  ledeParts.push(`当前第 ${weekNow} 周`);
  if (currentPhase) ledeParts.push(`${currentPhase.name}，重点是「${currentPhase.focus}」`);
  const ledeText = ledeParts.join(' · ');

  const nextMilestoneId = plan.next_milestone?.id || '';

  const phaseVMs: PhaseVM[] = plan.phases.map((p, idx) => {
    const meta = PHASE_TYPE_META[phaseKind(p, idx)];
    const span = spans.get(p.id) || { from: 1, to: 1 };
    const state: PhaseVM['state'] = p.is_completed
      ? 'done'
      : p.id === currentPhaseId
        ? 'current'
        : span.to < weekNow
          ? 'done'
          : 'future';
    const ps = ymdToEpoch(p.start_date);
    const pe = ymdToEpoch(p.end_date);

    let summaryLine: string | undefined;
    let hrZoneLine: string | undefined;
    if (state === 'done' && p.summary) {
      const s = p.summary;
      const bits: string[] = [`${fmtKm(Math.round(s.total_distance_km * 10) / 10)} km`, `${s.run_count} 次`];
      if (s.avg_pace_fmt) bits.push(`均配 ${s.avg_pace_fmt}/km`);
      if (s.avg_hr) bits.push(`${s.avg_hr} bpm`);
      summaryLine = `阶段小结：${bits.join(' · ')}`;
      if (s.hr_zone_distribution && s.hr_zone_distribution.length) {
        hrZoneLine = s.hr_zone_distribution
          .map((z) => `Z${z.zone_index} ${Math.round(z.percent)}%`)
          .join(' · ');
      }
    }

    // 关键里程碑按 phase_id 归入所属阶段块（Web PhaseDetail 侧栏）
    const milestones: PhaseMilestoneVM[] = plan.milestones
      .filter((m: MasterPlanMilestone) => m.phase_id === p.id)
      .map((m) => {
        const md = ymdToEpoch(m.date);
        // 「下一个」只标还没过期、且后端 next_milestone 指向的那枚；
        // 已完成阶段里遗留未完成的过期里程碑不标（days_until 会是负数）。
        const daysUntil = plan.next_milestone?.id === m.id ? plan.next_milestone.days_until : md != null ? daysBetween(todayEpoch, md) : 0;
        const isNext = m.id === nextMilestoneId && !m.completed_actual && daysUntil >= 0;
        return {
          key: m.id,
          dateLabel: md != null ? fmtShort(md) : m.date,
          typeLabel: MILESTONE_TYPE_LABELS[m.type] || m.type,
          valueText: m.completed_actual ? `实测 ${m.completed_actual}（目标 ${m.target}）` : `目标 ${m.target}`,
          done: Boolean(m.completed_actual),
          isNext,
          daysUntilLabel: `${Math.max(0, daysUntil)} 天后`,
        };
      });

    return {
      key: `p${idx}`,
      name: p.name,
      typeLabel: meta.label,
      color: meta.color,
      weeksLabel: `${padWeek(span.from)}-${padWeek(span.to)}`,
      weekCount: span.to - span.from + 1,
      dateRange: ps && pe ? `${fmtShort(ps)} – ${fmtShort(pe)}` : '',
      kmRange: `${fmtKm(p.weekly_distance_km_low)}-${fmtKm(p.weekly_distance_km_high)} km/w`,
      focus: p.focus,
      rhythm: p.rhythm,
      keyWorkouts: p.key_workouts,
      triggers: p.monitoring_triggers || [],
      // 原型定稿是中文 chips；后端是枚举值，经 SESSION_TYPE_META 映射，未知值兜底原样
      keySessionTypes: (p.key_session_types || []).map((t) => SESSION_TYPE_META[t]?.label || t),
      summaryLine,
      hrZoneLine,
      coachNote: state === 'current' ? p.coach_note : undefined,
      milestones,
      state,
    };
  });

  // 旅程时间轴：阶段块 → 周行（周行由 expandedPhases 控制渲染）
  const timeline: TimelineItemVM[] = [];
  phaseVMs.forEach((pvm, idx) => {
    timeline.push({ key: `tl-p${idx}`, kind: 'phase', state: pvm.state, phase: pvm });
    const phase = plan.phases[idx];
    const span = spans.get(phase.id);
    if (!span) return;
    for (let w = span.from; w <= span.to; w += 1) {
      const week = weeksByIndex.get(w);
      const phaseOfW = phaseOf(ctx, w);
      const st: WeekRowVM['state'] = w < weekNow ? 'done' : w === weekNow ? 'current' : 'future';
      const ws = weekStart(plan, w);
      let dateRange = '';
      if (ws != null) {
        dateRange = `${fmtShort(ws)} – ${fmtShort(ws + 6 * DAY_MS)}`;
      }
      const hasActual = week?.actual_distance_km != null;
      const actualSub: string[] = [];
      if (week?.actual_avg_pace_fmt) actualSub.push(`${week.actual_avg_pace_fmt}/km`);
      if (week?.actual_avg_hr) actualSub.push(`${week.actual_avg_hr} bpm`);
      let tag = '';
      if (w === totalWeeks) tag = '比赛周';
      else if (week?.is_taper_week) tag = '减量周';
      else if (week?.is_recovery_week) tag = '调整周';
      timeline.push({
        key: `tl-w${w}`,
        kind: 'week',
        state: st,
        week: {
          key: `w${w}`,
          phaseKey: pvm.key,
          weekIndex: w,
          dateRange,
          weekStart: week?.week_start || '',
          planKm: plannedKmText(week, phaseOfW),
          actualKm: hasActual ? `${fmtKm(week!.actual_distance_km!)} km` : undefined,
          actualSub: actualSub.length ? actualSub.join(' · ') : undefined,
          tag,
          state: st,
        },
      });
    }
  });

  // 本周关键课（当前周行展开时渲染）
  const currentWeek = weeksByIndex.get(weekNow);
  const currentSessions: SessionVM[] = (currentWeek?.key_sessions || []).map((s, i) => {
    const meta = SESSION_TYPE_META[s.type] || { label: s.type, iconPath: '/assets/icons/directions_run.svg' };
    const km = s.distance_km != null ? `${fmtKm(s.distance_km)} km` : s.duration_min != null ? `${Math.round(s.duration_min)} 分钟` : '';
    return {
      key: `sess${i}`,
      iconPath: meta.iconPath,
      title: meta.label,
      meta: s.purpose || s.intensity || '',
      km,
    };
  });

  const chart = buildChart(ctx, 'km');

  return {
    ctx,
    goal,
    countdownDays,
    weekNow,
    weekTotal: totalWeeks,
    ledeText,
    phaseVMs,
    timeline,
    currentSessions,
    chart,
  };
}

// ---------- 「每日安排」折叠区（#858 PR-E） ----------
// 数据源：weekly 行 sessions（GET /api/:user/plan/weeks/:weekName 的结构化
// content，services/plan.getWeeklyPlan）。关键课摘要（currentSessions）只覆盖
// 当前周且无日期，这里逐周懒加载完整日课（date/summary/kind 图标）。

function dayPlanIcon(kind: string): string {
  if (kind === 'run') return '/assets/icons/directions_run.svg';
  if (kind === 'strength') return '/assets/icons/fitness_center.svg';
  return '/assets/icons/schedule.svg';
}

/** weekly sessions → 每日安排行（按日期分组，同日按 session_index 排序）。 */
function buildDayPlans(sessions: PlannedSession[]): DayPlanVM[] {
  const byDate = new Map<string, PlannedSession[]>();
  for (const s of sessions) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }
  const dates = [...byDate.keys()].sort();
  return dates.map((date, i) => {
    const day = (byDate.get(date) ?? []).slice().sort((a, b) => a.session_index - b.session_index);
    const meaningful = day.filter((s) => s.kind !== 'rest' && s.kind !== 'note');
    if (meaningful.length === 0) {
      return {
        key: `dp${i}`,
        dateLabel: `${shanghaiWeekdayLabel(date)} ${Number(date.slice(8))}`,
        summary: '休息',
        iconPath: dayPlanIcon('rest'),
        km: '',
        isRest: true,
      };
    }
    const parts = meaningful.map((s) => {
      if (s.kind === 'strength') return '力量';
      if (s.kind === 'cross') return '交叉';
      return s.total_distance_m != null ? `${fmtKm(s.total_distance_m / 1000)}km` : s.summary || s.kind;
    });
    return {
      key: `dp${i}`,
      dateLabel: `${shanghaiWeekdayLabel(date)} ${Number(date.slice(8))}`,
      summary: meaningful.map((s) => s.spec && 'name' in s.spec && s.spec.name ? s.spec.name : s.summary).join(' · '),
      iconPath: dayPlanIcon(meaningful[0].kind),
      km: parts.join(' · '),
      isRest: false,
    };
  });
}

Page<TrainingPlanPageData, TrainingPlanPageHandlers>({
  onShareAppMessage: defaultShareAppMessage,
  onShareTimeline: defaultShareTimeline,
  data: {
    statusBarHeight: 0,
    canBack: false,
    contentPaddingTop: 232,
    loadState: 'loading',
    errorText: '',
    bannerKind: 'none',
    bannerText: '',
    eyebrowStatus: '已启用',
    raceName: '',
    raceDistanceLabel: '',
    raceDateLabel: '',
    targetTime: '',
    targetPace: '',
    countdownDays: 0,
    ledeText: '',
    chartMetric: 'km',
    chartBars: [],
    chartSpans: [],
    chartDetail: '',
    chartSelectedWeek: 1,
    weekNow: 1,
    weekTotal: 1,
    timeline: [],
    expandedPhases: {},
    expandedWeekDays: {},
    weekDayPlans: {},
    currentSessions: [],
    principles: [],
    uid: '',
    adjustDialogVisible: false,
    pendingAdjustment: null,
    injuryDialogVisible: false,
    injuryDialogMode: 'ask',
    injuryState: null,
    injuryResultText: '',
    raceClosingSoon: false,
  },

  /** buildViewModels 的派生结果存实例上，指标切换/点柱时复用。 */
  _planCtx: null as PlanContext | null,

  onLoad() {
    this._planCtx = null;
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
      contentPaddingTop: contentPaddingTopRpx(),
    });
    // 先等认证流程 settle 再拉数据，避免会话恢复期间误入「请先登录」误导已登录用户
    // （同 pages/training-status 的先认证后取数）。
    userStore.waitForAuth().then(() => {
      const { isAuthenticated, user } = userStore.getState();
      if (!isAuthenticated || !user) {
        // 游客/会话失效兜底：可返回的登录引导（登录页可跳过，审核合规）。
        openLogin(currentRouteForRedirect());
        return;
      }
      this.setData({ uid: user.id });
      void this.loadPlan();
      void this.loadStatusFlags();
    });
  },

  async loadPlan() {
    this.setData({ loadState: 'loading', errorText: '' });
    const userId = userStore.getState().user?.id;
    if (!userId) {
      this.setData({ loadState: 'error', errorText: '请先登录后查看训练计划' });
      return;
    }
    try {
      const envelope = await getCurrentMasterPlan(userId);
      if (!envelope) {
        this.setData({ loadState: 'empty' });
        return;
      }
      if (envelope.content_version !== 2) {
        // v1 正文是 markdown，小程序端先不做渲染
        this.setData({ loadState: 'v1' });
        return;
      }
      this.applyPlan(envelope.plan);
    } catch (err) {
      // 后端 detail 可能是英文 jargon，不上屏；完整错误体 request 层已打日志
      console.error('[training-plan] 加载失败', err);
      this.setData({ loadState: 'error', errorText: '加载失败，请稍后重试' });
    }
  },

  /**
   * #858 PR-E 状态条数据：并发拉 pending 调整 + 伤病状态（静默失败）。
   * pending 优先（有调整建议时提示条指它），伤病激活次之（维持/停训说明）。
   */
  async loadStatusFlags() {
    const userId = userStore.getState().user?.id;
    if (!userId) return;
    const [pending, injury] = await Promise.all([
      getPendingAdjustment(userId).catch((err) => {
        console.warn('[training-plan] 拉 pending 调整失败', err);
        return null;
      }),
      getInjuryState(userId).catch((err) => {
        console.warn('[training-plan] 拉伤病状态失败', err);
        return null;
      }),
    ]);
    // 等待期间用户可能已离开本页，丢弃过期结果。
    const pages = getCurrentPages();
    const current = pages[pages.length - 1];
    if (!current || current.route !== 'pages/training-plan/training-plan') return;

    if (pending) {
      this.setData({
        bannerKind: 'adjust',
        bannerText: '上周完成情况有调整建议 — 点此确认',
        pendingAdjustment: pending,
        injuryState: injury,
      });
      return;
    }
    if (injury) {
      this.setData({
        bannerKind: 'injury',
        bannerText: injuryBannerText(injury.mode),
        pendingAdjustment: null,
        injuryState: injury,
      });
      return;
    }
    this.setData({ bannerKind: 'none', bannerText: '', pendingAdjustment: null, injuryState: null });
  },

  /** 提示条点击：pending 调整 → 弹追问弹窗（不受每天一次限制）；伤病 → 当日轻问。 */
  onBannerTap() {
    if (this.data.bannerKind === 'adjust' && this.data.pendingAdjustment) {
      this.setData({ adjustDialogVisible: true });
      return;
    }
    if (this.data.bannerKind === 'injury') this.openInjuryAsk();
  },

  /** 打开当日轻问（伤病提示条入口）：rest + 比赛临近附「按现状重排」行。 */
  openInjuryAsk() {
    const injury = this.data.injuryState;
    if (!injury) return;
    if (injury.mode === 'rest') {
      void (async () => {
        let closing = false;
        try {
          const envelope = await getCurrentMasterPlan(this.data.uid);
          closing =
            envelope != null &&
            envelope.content_version === 2 &&
            raceClosingWithinWeeks(envelope.plan.goal.race_date, shanghaiToday());
        } catch (err) {
          console.warn('[training-plan] 拉当前计划算比赛临近失败', err);
        }
        this.setData({
          injuryDialogVisible: true,
          injuryDialogMode: 'ask',
          injuryResultText: '',
          raceClosingSoon: closing,
        });
      })();
      return;
    }
    this.setData({ injuryDialogVisible: true, injuryDialogMode: 'ask', injuryResultText: '' });
  },

  applyPlan(plan: SeasonPlanContent) {
    if (!plan.phases.length) {
      // Go 校验只保证 phases 是数组；空数组按内容错误走错误态而不是让它抛 TypeError
      this.setData({ loadState: 'error', errorText: '计划内容为空' });
      return;
    }
    const vm = buildViewModels(plan, shanghaiYmdToEpoch(shanghaiToday()));
    this._planCtx = vm.ctx;
    const goal = vm.goal;
    const expandedPhases: Record<string, boolean> = {};
    for (const p of vm.phaseVMs) expandedPhases[p.key] = false;
    this.setData({
      loadState: 'ready',
      raceName: goal.race_name || '赛季训练计划',
      raceDistanceLabel: distanceLabel(goal.distance || ''),
      raceDateLabel: (goal.race_date || plan.end_date || '').split('T')[0].replace(/-/g, '.'),
      targetTime: goal.target_time || '',
      targetPace: targetPaceOf(goal.distance, goal.target_time),
      countdownDays: vm.countdownDays,
      ledeText: vm.ledeText,
      weekNow: vm.weekNow,
      weekTotal: vm.weekTotal,
      chartMetric: 'km',
      chartBars: vm.chart.bars,
      chartSpans: vm.chart.spans,
      chartDetail: buildChartDetail(vm.ctx, vm.weekNow, 'km'),
      chartSelectedWeek: vm.weekNow,
      timeline: vm.timeline,
      expandedPhases,
      currentSessions: vm.currentSessions,
      principles: (plan.training_principles || []).map((t, i) => ({
        key: `tp${i}`,
        no: String(i + 1).padStart(2, '0'),
        text: t,
      })),
    });
  },

  onBackTap() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/coach/coach' }) });
  },

  onRetryTap() {
    void this.loadPlan();
  },

  /** 空态 CTA 与「调整计划」都先落到教练 tab；真实流向依赖 #429 落库/启用流程。 */
  onCoachTap() {
    wx.switchTab({ url: '/pages/coach/coach' });
  },

  onAdjustTap() {
    wx.switchTab({ url: '/pages/coach/coach' });
  },

  onBarTap(e: WechatMiniprogram.TouchEvent) {
    const week = Number(e.currentTarget.dataset.week);
    if (!this._planCtx) return;
    this.setData({
      chartSelectedWeek: week,
      chartDetail: buildChartDetail(this._planCtx, week, this.data.chartMetric),
    });
  },

  onMetricToggle(e: WechatMiniprogram.TouchEvent) {
    const metric = e.currentTarget.dataset.metric === 'dose' ? 'dose' : 'km';
    if (metric === this.data.chartMetric || !this._planCtx) return;
    const chart = buildChart(this._planCtx, metric);
    this.setData({
      chartMetric: metric,
      chartBars: chart.bars,
      chartSpans: chart.spans,
      chartDetail: buildChartDetail(this._planCtx, this.data.chartSelectedWeek, metric),
    });
  },

  onTogglePhaseWeeks(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key);
    this.setData({
      [`expandedPhases.${key}`]: !this.data.expandedPhases[key],
    });
  },

  // 「每日安排」折叠（#858 PR-E）：首次展开懒加载该周 weekly 行 sessions 并缓存。
  onToggleWeekDays(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key);
    const weekStart = String(e.currentTarget.dataset.weekStart || '');
    const next = !this.data.expandedWeekDays[key];
    this.setData({ [`expandedWeekDays.${key}`]: next });
    if (next && weekStart && !this.data.weekDayPlans[key]) {
      void this.refreshWeekDays(key, weekStart);
    }
  },

  async refreshWeekDays(key: string, weekStart: string) {
    if (!this.data.uid) return;
    try {
      const detail = await getWeeklyPlan(this.data.uid, weekFolderName(weekStart));
      const content =
        detail && typeof detail.content === 'object' && detail.content !== null
          ? (detail.content as WeeklyPlanContentStructured)
          : null;
      const plans = buildDayPlans(content?.sessions ?? []);
      this.setData({ [`weekDayPlans.${key}`]: plans });
    } catch (err) {
      // 404（该周无 weekly 行）或网络失败：给一行占位，避免展开空白。
      console.warn('[training-plan] 拉周每日安排失败', err);
      this.setData({ [`weekDayPlans.${key}`]: [] });
    }
  },

  // --- #858 PR-E：调整追问弹窗事件（提示条入口，不受每天一次限制） ---

  onAdjustClosed() {
    this.setData({ adjustDialogVisible: false });
  },

  // 同意应用成功：toast 已由组件出；重拉计划（accept 覆盖当前+未来周）与状态条。
  onAdjustAccepted() {
    this.setData({ adjustDialogVisible: false });
    void this.loadPlan();
    void this.loadStatusFlags();
  },

  onAdjustDismissed() {
    this.setData({ adjustDialogVisible: false });
    void this.loadStatusFlags();
  },

  // 受伤路径：转伤病登记弹层；登记成功后 dismiss 该调整行（受伤接管）。
  // pendingAdjustment 保持不变（onInjuryEntered 按它 dismiss；adjustmentId
  // 事件值与它是同一行）。
  onAdjustInjury(e: AdjustDialogEvent) {
    if (!e.detail.adjustmentId) return;
    this.setData({
      adjustDialogVisible: false,
      injuryDialogVisible: true,
      injuryDialogMode: 'enter',
      injuryResultText: '',
    });
  },

  // --- #858 PR-E：伤病弹层事件 ---

  onInjuryClosed() {
    this.setData({ injuryDialogVisible: false, injuryResultText: '' });
  },

  async onInjuryEntered(e: InjuryEnteredEvent) {
    const userId = this.data.uid;
    if (!userId) return;
    const { detail, verdict } = e.detail;
    try {
      const res = await enterInjury(userId, detail, verdict);
      // 登记完成即算当天问过（后续每日轻问从明天开始）。
      wx.setStorageSync(STORAGE_KEYS.LAST_INJURY_ASK_DAY, shanghaiToday());
      // 受伤接管：dismiss 关联的 pending 调整行（best-effort）。
      const takenOver = this.data.pendingAdjustment;
      if (takenOver) {
        dismissAdjustment(userId, takenOver.id).catch((err) => {
          console.warn('[training-plan] 受伤接管 dismiss 调整行失败', err);
        });
      }
      this.setData({
        injuryResultText: enterResultText(verdict, res.closed),
        pendingAdjustment: null,
      });
      void this.loadStatusFlags();
      void this.loadPlan();
    } catch (err) {
      console.error('[training-plan] 伤病登记失败', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      this.setData({ injuryDialogVisible: false });
    }
  },

  async onInjuryChecked(e: InjuryCheckedEvent) {
    const userId = this.data.uid;
    if (!userId) return;
    try {
      const res = await checkinInjury(userId, e.detail.answer);
      this.setData({
        injuryResultText: checkinResultText(e.detail.answer, res.closed ? null : res.injury),
      });
      void this.loadStatusFlags();
    } catch (err) {
      console.error('[training-plan] 伤病轻问提交失败', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      this.setData({ injuryDialogVisible: false });
    }
  },

  async onInjuryDoctored(e: InjuryDoctoredEvent) {
    const userId = this.data.uid;
    if (!userId) return;
    try {
      const res = await answerInjuryDoctor(userId, e.detail.verdict);
      this.setData({ injuryResultText: doctorResultText(e.detail.verdict, res.closed) });
      void this.loadStatusFlags();
    } catch (err) {
      console.error('[training-plan] 医生结论提交失败', err);
      wx.showToast({ title: '提交失败，请重试', icon: 'none' });
      this.setData({ injuryDialogVisible: false });
    }
  },

  onInjuryCoach() {
    this.setData({ injuryDialogVisible: false, injuryResultText: '' });
    wx.switchTab({ url: '/pages/coach/coach' });
  },
});
