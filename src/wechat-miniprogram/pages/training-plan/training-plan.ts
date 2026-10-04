// 「我的训练计划」页 —— #436。展示当前启用中的 master plan（原型定稿方案
// B「备赛旅程」，对齐 Web /plan SeasonOverview 的信息架构）。
// 数据来自 GET /api/users/{user}/master-plan/current（services/master-plan.ts
// 的 getCurrentMasterPlan，404 → 空态）；视图模型沿原型
// prototype/mp-profile-training-plan 的 buildViewModels/buildChart 逻辑换
// 真实数据源：日期、倒计时、当前周、阶段状态均由 today + plan 派生。
// v1（markdown）计划不做渲染，只提示去网页查看。

import { getCurrentMasterPlan } from '../../services/master-plan';
import type {
  CurrentSeasonPlan,
  MasterPlanMilestone,
  MasterPlanPhase,
  MasterPlanWeek,
  SeasonPlanContent,
} from '../../services/master-plan';
import { ApiError } from '../../services/request';
import { userStore } from '../../store/index';

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
  contentPaddingTop: number;
  /** loading：请求中；ready：v2 内容；empty：无启用计划；v1：旧版计划；error：请求失败 */
  loadState: 'loading' | 'ready' | 'empty' | 'v1' | 'error';
  errorText: string;
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
  // 本周关键课（当前周行展开时渲染）
  currentSessions: SessionVM[];
  // 训练原则（常展开编号列表）
  principles: Array<{ key: string; no: string; text: string }>;
}

interface TrainingPlanPageHandlers {
  onBackTap(): void;
  onRetryTap(): void;
  onCoachTap(): void;
  onAdjustTap(): void;
  onBarTap(e: WechatMiniprogram.TouchEvent): void;
  onMetricToggle(e: WechatMiniprogram.TouchEvent): void;
  onTogglePhaseWeeks(e: WechatMiniprogram.TouchEvent): void;
  loadPlan(): Promise<void>;
  applyPlan(plan: SeasonPlanContent): void;
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
  recovery: { label: '恢复', color: '#9c9c9d' },
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

// ---------- 工具（沿用原型 / Web 端格式化习惯） ----------

/** 兼容 YYYY-MM-DD 与 ISO 时间戳。 */
function parseDateOnly(value: string): Date | null {
  const [y, m, d] = value.split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Web 端 formatShort 习惯：M/D 无前导零。 */
function fmtShort(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86400000);
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

/** 目标配速 = 目标成绩 ÷ 项距离；无法换算时返回空串。 */
function targetPaceOf(distance: string | undefined, targetTime: string | undefined): string {
  const dist = distance === 'FM' ? 42.195 : distance === 'HM' ? 21.0975 : distance === '10K' ? 10 : distance === '5K' ? 5 : 0;
  if (!dist || !targetTime) return '';
  const parts = targetTime.split(':').map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return '';
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
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

/** 每个阶段覆盖的周区间（from/to，含端点）；老 plan 无 weeks[] 时按日期推。 */
function phaseWeekSpans(plan: SeasonPlanContent): Map<string, { from: number; to: number }> {
  const out = new Map<string, { from: number; to: number }>();
  for (const w of plan.weeks) {
    const span = out.get(w.phase_id) || { from: w.week_index, to: w.week_index };
    span.from = Math.min(span.from, w.week_index);
    span.to = Math.max(span.to, w.week_index);
    out.set(w.phase_id, span);
  }
  if (out.size === 0) {
    let cursor = 1;
    for (const p of plan.phases) {
      const s = parseDateOnly(p.start_date);
      const e = parseDateOnly(p.end_date);
      const count = s && e ? Math.max(1, Math.ceil((e.getTime() - s.getTime() + 1) / 604800000)) : 1;
      out.set(p.id, { from: cursor, to: cursor + count - 1 });
      cursor += count;
    }
  }
  return out;
}

/** 当前周：优先后端派生的 current_week_number，缺了再按 start_date 推。 */
function resolveWeekNow(plan: SeasonPlanContent, today: Date): number {
  const total = plan.total_weeks || plan.phases.length;
  if (plan.current_week_number && plan.current_week_number >= 1) {
    return Math.min(plan.current_week_number, total);
  }
  const start = parseDateOnly(plan.start_date);
  if (!start) return 1;
  const raw = Math.floor((startOfDay(today).getTime() - start.getTime()) / 604800000) + 1;
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
  today: Date;
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

function weekStart(plan: SeasonPlanContent, weekIndex: number): Date | null {
  const row = plan.weeks.find((w) => w.week_index === weekIndex);
  if (row) return parseDateOnly(row.week_start);
  const start = parseDateOnly(plan.start_date);
  if (!start) return null;
  start.setDate(start.getDate() + (weekIndex - 1) * 7);
  return start;
}

/** 训练周期图（Web MileageCycleCard 的移动端转译，原型 buildChart 移植）。 */
function buildChart(ctx: PlanContext, metric: 'km' | 'dose'): { bars: ChartBarVM[]; spans: ChartSpanVM[] } {
  const CHART_AREA_RPX = 150;
  const FALLBACK_DOSE_PER_KM = 7.1; // 老数据没有 dose 字段时由跑量近似（原型同款系数）

  let maxKm = 0;
  let maxDose = 0;
  for (let w = 1; w <= ctx.weekTotal; w += 1) {
    const week = ctx.weeksByIndex.get(w);
    const phase = phaseOf(ctx, w);
    const high = week?.target_weekly_km_high ?? phase.weekly_distance_km_high;
    maxKm = Math.max(maxKm, high, week?.actual_distance_km ?? 0);
    const doseHigh = week?.target_training_dose_high ?? ((week?.target_weekly_km_low ?? phase.weekly_distance_km_low) + high) / 2 * FALLBACK_DOSE_PER_KM;
    maxDose = Math.max(maxDose, doseHigh, week?.actual_training_dose ?? 0);
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
      const doseHigh = week?.target_training_dose_high ?? (plannedMid * FALLBACK_DOSE_PER_KM);
      const doseLow = week?.target_training_dose_low ?? (plannedLow * FALLBACK_DOSE_PER_KM);
      bandH = Math.round((Math.max(doseHigh, doseLow) / maxDose) * CHART_AREA_RPX);
      if (week?.actual_training_dose != null) {
        fillH = Math.round((week.actual_training_dose / maxDose) * CHART_AREA_RPX);
      }
    }
    bars.push({
      key: `b${w}`,
      week: w,
      state,
      fillH,
      bandH,
      tickBottom,
      barColor: state === 'current' ? '#ff6363' : meta.color,
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
  const ws = weekStart(ctx.plan, weekIndex);
  const parts: string[] = [padWeek(weekIndex)];
  if (ws) {
    const we = new Date(ws);
    we.setDate(we.getDate() + 6);
    parts.push(`${fmtShort(ws)} – ${fmtShort(we)}`);
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
    const plannedMid = ((week?.target_weekly_km_low ?? phase.weekly_distance_km_low) +
      (week?.target_weekly_km_high ?? phase.weekly_distance_km_high)) / 2;
    const doseLow = week?.target_training_dose_low ?? Math.round(plannedMid * 6.6);
    const doseHigh = week?.target_training_dose_high ?? Math.round(plannedMid * 7.6);
    parts.push(`计划负荷 ${fmtKm(doseLow)}-${fmtKm(doseHigh)} dose`);
    if (week?.actual_training_dose != null && week.actual_training_dose > 0) {
      parts.push(`实际负荷 ${fmtKm(week.actual_training_dose)} dose${state === 'current' ? '（截至目前）' : ''}`);
    }
  }
  return parts.join(' · ');
}

function buildViewModels(plan: SeasonPlanContent, today: Date) {
  const totalWeeks = plan.total_weeks || plan.weeks.length || plan.phases.length;
  const weekNow = resolveWeekNow(plan, today);
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
    today,
    weekNow,
    weekTotal: totalWeeks,
    currentPhaseId,
  };

  const goal = plan.goal;
  const raceDate = parseDateOnly(goal.race_date || plan.end_date);
  const countdownDays = raceDate ? Math.max(0, daysBetween(today, raceDate)) : 0;
  const currentPhase = phaseById.get(currentPhaseId) || plan.phases[plan.phases.length - 1];
  const startDate = parseDateOnly(plan.start_date);

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
    const ps = parseDateOnly(p.start_date);
    const pe = parseDateOnly(p.end_date);

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
        const md = parseDateOnly(m.date);
        // 「下一个」只标还没过期、且后端 next_milestone 指向的那枚；
        // 已完成阶段里遗留未完成的过期里程碑不标（days_until 会是负数）。
        const daysUntil = plan.next_milestone?.id === m.id ? plan.next_milestone.days_until : md ? daysBetween(today, md) : 0;
        const isNext = m.id === nextMilestoneId && !m.completed_actual && daysUntil >= 0;
        return {
          key: m.id,
          dateLabel: md ? fmtShort(md) : m.date,
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
      if (ws) {
        const we = new Date(ws);
        we.setDate(we.getDate() + 6);
        dateRange = `${fmtShort(ws)} – ${fmtShort(we)}`;
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

Page<TrainingPlanPageData, TrainingPlanPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loadState: 'loading',
    errorText: '',
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
    currentSessions: [],
    principles: [],
  },

  /** buildViewModels 的派生结果存实例上，指标切换/点柱时复用。 */
  _planCtx: null as PlanContext | null,

  onLoad() {
    this._planCtx = null;
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });
    void this.loadPlan();
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
      const msg = err instanceof ApiError && err.detail ? err.detail : '加载失败，请稍后重试';
      this.setData({ loadState: 'error', errorText: msg });
    }
  },

  applyPlan(plan: SeasonPlanContent) {
    const vm = buildViewModels(plan, new Date());
    this._planCtx = vm.ctx;
    const goal = vm.goal;
    const expandedPhases: Record<string, boolean> = {};
    for (const p of vm.phaseVMs) expandedPhases[p.key] = false;
    this.setData({
      loadState: 'ready',
      raceName: goal.race_name || '赛季训练计划',
      raceDistanceLabel: distanceLabel(goal.distance || ''),
      raceDateLabel: (goal.race_date || '').split('T')[0].replace(/-/g, '.'),
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
    wx.navigateBack({
      fail: () => {
        wx.switchTab({ url: '/pages/profile/profile' });
      },
    });
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
});
