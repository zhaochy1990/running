// 「赛季训练计划」页 —— #1024 详情页设计稿（training-plan-prototype
// wuxi-plan-detail）的小程序实现。双视图：计划概览（目标评估/训练节奏图/
// 阶段 tabs+阶段面板/总体训练原则）与 每周安排（按阶段分组的周列表，已物化
// 周懒加载每日课表，未生成周展示骨架目标）。
// 数据来自 GET /api/users/{user}/master-plan/current（v2 + #859 富字段
// policy/skeleton/anchor/audit，全部可选判空降级）；每日课表懒加载走
// GET /plan/weeks/:week（weekly 行投影，#858 PR-E）。预览模式（options.preview=1
// + payload）来自聊天结果卡，footer 出「调整计划/启用计划」走 apply-from-content。
// v1（markdown）计划不渲染，只提示去网页查看。

import {
  applyMasterPlanFromContent,
  getCurrentMasterPlan,
  markMasterPlanApplied,
  takePendingPlanPreview,
  type SeasonPlanContent,
  type MasterPlanPhase,
  type MasterPlanWeek,
} from '../../services/master-plan';
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
import { buildExerciseLines } from '../../utils/workoutSegments';
import { STORAGE_KEYS } from '../../constants/config';
import type {
  NormalizedRunWorkout,
  NormalizedStrengthWorkout,
  PlannedSession,
  WeeklyPlanContentStructured,
  WorkoutStep,
} from '../../types/plan';
import type { PlanAdjustment, PlanInjuryState } from '../../types/adjustment';
import { userStore } from '../../store/index';
import { currentRouteForRedirect, openLogin } from '../../utils/authGate';
import { shanghaiWeekdayLabel, shanghaiToday, weekFolderName } from '../../utils/date';
import {
  checkinResultText,
  doctorResultText,
  enterResultText,
  injuryBannerText,
  raceClosingWithinWeeks,
} from '../../utils/injuryFlow';
import { defaultShareAppMessage, defaultShareTimeline } from '../../utils/share';

// ---------- 设计稿 token（training-plan-prototype） ----------

/** 阶段五色（概览 tab 圆点/节奏柱/每周分组色条共用，第六色兜底恢复期）。 */
const PHASE_COLORS = ['#397650', '#2e8581', '#ad8427', '#c16b3c', '#587eab', '#7f7895'];
const PHASE_LABELS: Record<string, string> = {
  base: '基础期',
  build: '提升期',
  speed: '专项速度',
  marathon: '马拉松专项',
  taper: '赛前减量',
  recovery: '赛后恢复',
};
const ROLE_LABELS: Record<string, string> = {
  progress: '递进周',
  absorb: '吸收周',
  taper: '减量周',
  race: '比赛周',
};

// ---------- 视图模型 ----------

interface AssessmentTargetVM {
  key: string;
  label: string;
  time: string;
  conditionsText: string;
}

interface AssessmentVM {
  levelLabel: string;
  summary: string;
  abcTargets: AssessmentTargetVM[];
}

interface RhythmBarVM {
  key: string;
  week: number;
  value: number;
  heightPct: number;
  color: string;
  selected: boolean;
  label: string;
}

interface PhaseTabVM {
  key: string;
  index: number;
  label: string;
  weekCount: number;
  color: string;
}

interface StageMilestoneVM {
  key: string;
  label: string;
  criterion: string;
}

interface StageVM {
  key: string;
  label: string;
  color: string;
  weekRangeLabel: string;
  dateRangeLabel: string;
  focusBrief: string;
  focusFull: string;
  hasFull: boolean;
  focusExpanded: boolean;
  milestones: StageMilestoneVM[];
  milestoneScope: string;
  strengthPerWeek: string;
  strengthFocus: string;
  recoveryText: string;
}

interface PrincipleVM {
  key: string;
  text: string;
}

/** 每周安排的单日行（weekly 行投影懒加载；有课可展开看目的/结构/提醒）。 */
interface ReviewDayVM {
  key: string;
  weekday: string;
  dateNum: string;
  isRest: boolean;
  isQuality: boolean;
  summary: string;
  distLabel: string;
  /** 展开体：目的/结构/提醒；rest 行为空不可展开。 */
  purpose: string;
  structureLines: string[];
  note: string;
  expanded: boolean;
}

interface ReviewWeekVM {
  key: string;
  weekIndex: number;
  roleLabel: string;
  dateRange: string;
  kmLabel: string;
  /** #222 本周排入的力量课节数（周文档加载后回填；无力量为空串）。 */
  strengthLabel: string;
  hasDoc: boolean;
  days: ReviewDayVM[];
  /** 未物化周的骨架目标（skeleton.weeks 的 lr/q）。 */
  futureLr: string;
  futureQ: string;
  expanded: boolean;
  loadingDoc: boolean;
}

interface ReviewGroupVM {
  key: string;
  label: string;
  color: string;
  weekCount: number;
  weeks: ReviewWeekVM[];
}

interface PlanPayload {
  apply_token?: string;
  content?: Record<string, unknown>;
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
  // 双视图（设计稿 view-nav）
  planView: 'overview' | 'calendar';
  // 预览模式（聊天结果卡带入，footer 出调整/启用）
  isPreview: boolean;
  previewApplied: boolean;
  planTitle: string;
  planSubtitle: string;
  assessment: AssessmentVM | null;
  assessExpanded: boolean;
  // 节奏图
  chartMetric: 'km' | 'lr';
  chartHasLr: boolean;
  chartAxis: number;
  chartPeakLabel: string;
  rhythmBars: RhythmBarVM[];
  selectedWeek: number;
  // 阶段 tabs + 面板
  phaseTabs: PhaseTabVM[];
  chosenPhase: number;
  stage: StageVM | null;
  principles: PrincipleVM[];
  // 每周安排
  calendarGroups: ReviewGroupVM[];
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
  onBannerTap(): void;
  onSwitchView(e: WechatMiniprogram.TouchEvent): void;
  onMetricToggle(e: WechatMiniprogram.TouchEvent): void;
  onBarTap(e: WechatMiniprogram.TouchEvent): void;
  onPhaseTap(e: WechatMiniprogram.TouchEvent): void;
  onToggleFullFocus(): void;
  onToggleAssess(): void;
  onWeekExpand(e: WechatMiniprogram.TouchEvent): void;
  onDayExpand(e: WechatMiniprogram.TouchEvent): void;
  loadPlan(): Promise<void>;
  loadStatusFlags(): Promise<void>;
  openInjuryAsk(): void;
  applyPlan(plan: SeasonPlanContent): void;
  _weekStartOf(plan: SeasonPlanContent, weekIndex: number): string;
  loadWeekDoc(key: string, weekStart: string): Promise<void>;
  patchWeek(key: string, patch: Partial<ReviewWeekVM>): void;
  onAdjustClosed(): void;
  onAdjustAccepted(): void;
  onAdjustDismissed(): void;
  onAdjustInjury(e: AdjustDialogEvent): void;
  onInjuryClosed(): void;
  onInjuryEntered(e: InjuryEnteredEvent): Promise<void>;
  onInjuryChecked(e: InjuryCheckedEvent): Promise<void>;
  onInjuryDoctored(e: InjuryDoctoredEvent): Promise<void>;
  onInjuryCoach(): void;
  onAdjustTap(): void;
  onApplyTap(): Promise<void>;
  /** 派生上下文（视图切换/指标切换复用），存实例避免模块级串扰。 */
  _plan: SeasonPlanContent | null;
  _previewPayload: PlanPayload | null;
}

// ---------- 工具 ----------

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
    statusPx = sys.statusBarHeight;
    width = sys.windowWidth || 375;
  }
  return Math.round((statusPx * 750) / width) + 128 + 24;
}

/** 计划名（设计稿 titleReal）：无锡马拉松250突破计划 / 完赛计划。 */
function planTitleOf(plan: SeasonPlanContent): string {
  const race = plan.goal.race_name || '训练计划';
  const t = plan.goal.target_time;
  if (!t) return `${race}完赛计划`;
  const [h, m, sec] = t.split(':').map(Number);
  let goal: string;
  if (!m && !sec) goal = `破${h}`;
  else if (!sec && m === 30) goal = `破${h}30`;
  else if (!sec && m === 45) goal = `破${h}45`;
  else goal = `${h}${String(m).padStart(2, '0')}${sec ? String(sec).padStart(2, '0') : ''}突破`;
  return `${race}${goal}计划`;
}

const shortDate = (d: string): string => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '—');

function datePlus(d: string, n: number): string {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

const fmtNum = (n: number): string => (Number.isFinite(n) ? String(Number(n.toFixed(1))) : '—');

const kmRange = (lo: number | null | undefined, hi: number | null | undefined): string => {
  if (lo == null && hi == null) return '—';
  if (lo === hi) return `${fmtNum(Number(lo))} km`;
  const l = lo != null ? fmtNum(Number(lo)) : '?';
  const h = hi != null ? fmtNum(Number(hi)) : '?';
  return `${l}–${h} km`;
};

/** 阶段 focus 的用户可读首句（证据括号截断 + 分号取首段；P1 文案票再细修）。 */
function briefFocus(focus: string): string {
  return focus
    .replace(/（(?:比赛|速度|短板|目标|量|结构|学分|体能)证据：[\s\S]*$/, '')
    .split('；')[0]
    .replace(/；$/, '')
    .trim();
}

function phaseLabelOf(name: string): string {
  return PHASE_LABELS[name] || name;
}

/** 里程碑 signal → 展示名（设计稿映射）。 */
function milestoneSignalLabel(signal: string): string {
  if (signal === 'weekly_km') return '周跑量与轻松跑结构';
  if (signal === 'long_run_km') return '长距离耐力';
  if (signal === '质量课计数') return '速度训练完成度';
  if (signal === 'CTL') return '体能与稳定跑量';
  return signal;
}

/** 周行所属阶段下标：phase_id（旧 v2）→ phase_name（v3 canonical）→ 日期区间兜底，孤周挂最后。 */
function phaseIndexOfWeek(
  plan: SeasonPlanContent,
  w: MasterPlanWeek,
  phaseById: Map<string, number>,
  phaseByName: Map<string, number>,
): number {
  if (w.phase_id) {
    const byId = phaseById.get(w.phase_id);
    if (byId !== undefined) return byId;
  }
  if (w.phase_name) {
    const byName = phaseByName.get(w.phase_name);
    if (byName !== undefined) return byName;
  }
  for (let i = 0; i < plan.phases.length; i += 1) {
    const p = plan.phases[i];
    if (w.week_start >= p.start_date && (!p.end_date || w.week_start <= p.end_date)) return i;
  }
  return plan.phases.length - 1;
}

function skeletonWeekOf(plan: SeasonPlanContent, weekIndex: number) {
  return plan.skeleton?.weeks?.find((s) => s.week === weekIndex) || null;
}

/** 目标值 → 展示（配速 s/km、心率、功率、步频；open=自由强度）。 */
function targetText(step: WorkoutStep): string {
  const t = step.target;
  if (!t || t.kind === 'open') return '自由强度';
  const pace = (v: number | null): string => {
    if (v == null) return '?';
    const s = Math.round(v);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  if (t.kind === 'pace_s_km') {
    const lo = pace(t.low);
    const hi = pace(t.high);
    return lo === hi ? `${lo}/km` : `${lo}–${hi}/km`;
  }
  const unit = t.kind === 'hr_bpm' ? 'bpm' : t.kind === 'power_w' ? 'W' : '步/分';
  const lo = t.low != null ? String(Math.round(t.low)) : '?';
  const hi = t.high != null ? String(Math.round(t.high)) : '?';
  return lo === hi ? `${lo} ${unit}` : `${lo}–${hi} ${unit}`;
}

function durationText(step: WorkoutStep): string {
  const d = step.duration;
  if (d == null || d.value == null) return '—';
  if (d.kind === 'distance_m') return `${fmtNum(d.value / 1000)} km`;
  if (d.kind === 'time_s') return `${fmtNum(d.value / 60)} 分钟`;
  return '自由时长';
}

const STEP_KIND_LABELS: Record<string, string> = {
  warmup: '热身',
  work: '主训练',
  recovery: '组间恢复',
  cooldown: '放松',
  rest: '休息',
};

/**
 * 训练结构 → 折叠体行数组：run=blocks×steps（严格按设计稿的块/步中文化）；
 * #222 strength=动作行（buildExerciseLines，与单课详情 buildExerciseRows 同口径）。
 */
function structureLines(spec: NormalizedRunWorkout | NormalizedStrengthWorkout | { name?: string } | null): string[] {
  const strength = spec as NormalizedStrengthWorkout | null;
  if (strength?.exercises?.length) return buildExerciseLines(strength);
  const run = spec as NormalizedRunWorkout | null;
  if (!run?.blocks?.length) return [];
  const lines: string[] = [];
  for (const block of run.blocks) {
    for (const step of block.steps) {
      const kind = STEP_KIND_LABELS[step.step_kind] || step.step_kind;
      const repeatTag = block.repeat > 1 ? '×' + block.repeat : '';
      const rest = step.rest
        ? step.rest.kind === 'time_s'
          ? ` 步后休${step.rest.value ?? ''}秒`
          : step.rest.kind === 'hr_bpm'
            ? ` 步后心率降至${step.rest.value ?? ''}以下`
            : ' 步后手动结束'
        : '';
      lines.push(`${kind}${repeatTag} ${durationText(step)} · ${targetText(step)}${rest}`);
    }
  }
  return lines;
}

/** weekly sessions → 每周安排的日行（设计稿 session 行：圆点/摘要/距离/展开体）。 */
function buildReviewDays(sessions: PlannedSession[]): ReviewDayVM[] {
  const byDate = new Map<string, PlannedSession[]>();
  for (const s of sessions) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }
  const dates = [...byDate.keys()].sort();
  const out: ReviewDayVM[] = [];
  dates.forEach((date, i) => {
    const day = (byDate.get(date) ?? []).slice().sort((a, b) => a.session_index - b.session_index);
    const meaningful = day.filter((s) => s.kind !== 'rest' && s.kind !== 'note');
    const dt = new Date(`${date}T12:00:00Z`);
    const weekday = `周${'日一二三四五六'[dt.getUTCDay()]}`;
    const dateNum = String(Number(date.slice(8)));
    if (meaningful.length === 0) {
      out.push({
        key: `d${i}`,
        weekday,
        dateNum,
        isRest: true,
        isQuality: false,
        summary: '休息',
        distLabel: '—',
        purpose: '',
        structureLines: [],
        note: '',
        expanded: false,
      });
      return;
    }
    const first = meaningful[0];
    const spec = (first.spec || null) as NormalizedRunWorkout | null;
    const dist = first.total_distance_m != null ? `${fmtNum(first.total_distance_m / 1000)} km` : first.total_duration_s != null ? `${fmtNum(first.total_duration_s / 60)} 分钟` : '';
    const purpose = meaningful
      .map((s) => (s.spec && 'purpose' in s.spec ? String((s.spec as { purpose?: string }).purpose || '') : ''))
      .filter(Boolean)
      .join(' ');
    const structureLinesAll = meaningful.flatMap((s) => structureLines((s.spec || null) as NormalizedRunWorkout | null));
    const note = meaningful
      .map((s) => String((s.spec && 'note' in s.spec ? s.spec.note : '') || s.notes_md || ''))
      .filter(Boolean)
      .join(' ');
    out.push({
      key: `d${i}`,
      weekday,
      dateNum,
      isRest: false,
      isQuality: spec?.type === 'T',
      summary: meaningful.map((s) => (s.spec && 'name' in s.spec && s.spec.name ? s.spec.name : s.summary)).join(' · '),
      distLabel: dist,
      purpose,
      structureLines: structureLinesAll,
      note,
      expanded: false,
    });
  });
  return out;
}

/** goal_assessment.level → 用户向中文（P1 文案票可再打磨）。 */
const ASSESSMENT_LEVEL_LABELS: Record<string, string> = {
  supported: '有支撑，具备冲击条件',
  aggressive_but_plausible: '有挑战，具备冲击基础',
  conditional: '有条件达成，需满足检查点',
  multi_cycle_required: '建议分多个周期备战',
  unsafe_or_incompatible: '暂不建议按此目标执行',
};

function buildAssessment(plan: SeasonPlanContent): AssessmentVM | null {
  const a = (
    plan as SeasonPlanContent & {
      goal_assessment?: {
        level?: string;
        summary?: string;
        abc_gates?: Record<
          string,
          {
            target?: { kind?: string; time_seconds?: number | null; label?: string };
            conditions?: Array<{ criterion?: string }>;
          }
        >;
      } | null;
    }
  ).goal_assessment;
  if (!a?.abc_gates) return null;
  const fmt = (sec: number | null | undefined): string => {
    if (sec == null) return '完赛';
    return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  };
  const abcTargets = ['A', 'B', 'C'].map((key) => {
    const gate = a.abc_gates?.[key];
    const t = gate?.target;
    const conditionsText = (gate?.conditions ?? [])
      .map((c) => String(c.criterion || ''))
      .filter(Boolean)
      .join('；');
    return {
      key,
      label: `${key}目标`,
      time: t?.kind === 'finish' ? '完赛' : fmt(t?.time_seconds),
      conditionsText,
    };
  });
  return {
    levelLabel: ASSESSMENT_LEVEL_LABELS[a.level || ''] || '目标评估',
    summary: a.summary || '',
    abcTargets,
  };
}

// ---------- 视图模型构建 ----------

interface PlanVMs {
  planTitle: string;
  planSubtitle: string;
  assessment: AssessmentVM | null;
  chartHasLr: boolean;
  chartAxis: number;
  chartPeakLabel: string;
  rhythmBars: RhythmBarVM[];
  phaseTabs: PhaseTabVM[];
  stage: StageVM | null;
  principles: PrincipleVM[];
  calendarGroups: ReviewGroupVM[];
}

function buildVMs(plan: SeasonPlanContent, chartMetric: 'km' | 'lr', chosenPhase: number, selectedWeek: number): PlanVMs {
  const phaseById = new Map<string, number>();
  const phaseByName = new Map<string, number>();
  plan.phases.forEach((p, i) => {
    if (p.id) phaseById.set(p.id, i);
    if (p.name && !phaseByName.has(p.name)) phaseByName.set(p.name, i);
  });

  // —— 标题/副标题
  const planTitle = planTitleOf(plan);
  const planSubtitle = `全程马拉松 · 备赛 ${plan.start_date.split('-').join('/')}—${plan.end_date.split('-').join('/')}`;

  // —— 评估（current 读暂无此字段 → null 隐藏）
  const assessment = buildAssessment(plan);

  // —— 节奏图（周跑量 = target_high；长距离 = skeleton.lr）
  const skeletonByWeek = new Map<number, { lr: number | null; q: number; role: string }>();
  for (const s of plan.skeleton?.weeks ?? []) skeletonByWeek.set(s.week, { lr: s.lr, q: s.q, role: s.role });
  const chartHasLr = plan.weeks.some((w) => {
    const sk = skeletonByWeek.get(w.week_index);
    return sk != null && sk.lr != null;
  });
  const values = plan.weeks.map((w) => {
    if (chartMetric === 'lr') return skeletonByWeek.get(w.week_index)?.lr ?? 0;
    return w.target_weekly_km_high ?? w.planned_distance_km ?? 0;
  });
  const peak = Math.max(...values, 1);
  const axis = Math.ceil(peak / 20) * 20;
  const rhythmBars: RhythmBarVM[] = plan.weeks.map((w, i) => {
    const phaseIdx = phaseIndexOfWeek(plan, w, phaseById, phaseByName);
    const value = values[i];
    return {
      key: `b${w.week_index}`,
      week: w.week_index,
      value: Number(fmtNum(value)),
      heightPct: Math.round((value / axis) * 1000) / 10,
      color: PHASE_COLORS[phaseIdx % PHASE_COLORS.length],
      selected: w.week_index === selectedWeek,
      label: w.week_index === 1 || w.week_index % 4 === 0 || w.week_index === plan.total_weeks ? String(w.week_index) : '',
    };
  });

  // —— 阶段 tabs
  const phaseTabs: PhaseTabVM[] = plan.phases.map((p, i) => {
    const weekCount = plan.weeks.filter((w) => phaseIndexOfWeek(plan, w, phaseById, phaseByName) === i).length;
    return {
      key: `p${i}`,
      index: i,
      label: phaseLabelOf(p.name),
      weekCount,
      color: PHASE_COLORS[i % PHASE_COLORS.length],
    };
  });

  // —— 阶段面板（里程碑取 policy：策略阶段按周区间覆盖本展示阶段）
  const policyPhases = plan.policy?.phases ?? [];
  const chosen = plan.phases[Math.min(chosenPhase, plan.phases.length - 1)];
  let stage: StageVM | null = null;
  if (chosen) {
    const weeksInPhase = plan.weeks.filter((w) => phaseIndexOfWeek(plan, w, phaseById, phaseByName) === Math.min(chosenPhase, plan.phases.length - 1));
    const firstWeek = weeksInPhase[0]?.week_index;
    const policyPhase =
      policyPhases.find((pp) => firstWeek != null && pp.start_week <= firstWeek && firstWeek <= pp.end_week) || null;
    const milestones = policyPhase
      ? (plan.policy?.milestones ?? []).filter((m) => policyPhase.name.startsWith(m.phase))
      : [];
    stage = {
      key: `stage${chosenPhase}`,
      label: phaseLabelOf(chosen.name),
      color: PHASE_COLORS[Math.min(chosenPhase, plan.phases.length - 1) % PHASE_COLORS.length],
      weekRangeLabel: weeksInPhase.length
        ? `第${weeksInPhase[0].week_index}–${weeksInPhase[weeksInPhase.length - 1].week_index}周`
        : chosen.phase_type || '',
      dateRangeLabel: `${shortDate(chosen.start_date)}—${shortDate(chosen.end_date)}`,
      focusBrief: briefFocus(chosen.focus || ''),
      focusFull: chosen.focus || '',
      hasFull: (chosen.focus || '').length > briefFocus(chosen.focus || '').length,
      focusExpanded: false,
      milestones: milestones.map((m, i) => ({
        key: `m${i}`,
        label: milestoneSignalLabel(m.signal),
        criterion: m.criterion,
      })),
      milestoneScope: policyPhase?.canonical === 'final_quality' ? '马拉松专项与赛前减量的共同检查点' : '',
      strengthPerWeek: chosen.strength?.sessions_per_week != null ? `${chosen.strength.sessions_per_week} 次/周` : '',
      strengthFocus: chosen.strength?.focus || '',
      recoveryText: chosen.recovery?.sleep_target_hours ? `睡眠目标 ${chosen.recovery.sleep_target_hours} 小时` : chosen.recovery?.focus || '',
    };
  }

  const principles = (plan.training_principles ?? []).map((t, i) => ({ key: `pr${i}`, text: t }));

  // —— 每周安排（按阶段分组；days 由懒加载填充）
  const calendarGroups: ReviewGroupVM[] = plan.phases.map((p, i) => {
    const weeks = plan.weeks.filter((w) => phaseIndexOfWeek(plan, w, phaseById, phaseByName) === i);
    return {
      key: `g${i}`,
      label: phaseLabelOf(p.name),
      color: PHASE_COLORS[i % PHASE_COLORS.length],
      weekCount: weeks.length,
      weeks: weeks.map((w) => {
        const sk = skeletonByWeek.get(w.week_index);
        return {
          key: `w${w.week_index}`,
          weekIndex: w.week_index,
          roleLabel: ROLE_LABELS[sk?.role ?? ''] || '',
          dateRange: `${shortDate(w.week_start)}—${shortDate(datePlus(w.week_start, 6))}`,
          kmLabel: kmRange(w.target_weekly_km_low, w.target_weekly_km_high),
          strengthLabel: '',
          hasDoc: false,
          days: [],
          futureLr: sk?.lr != null ? `${fmtNum(sk.lr)} km` : '未提供',
          futureQ: sk ? `${sk.q} 次` : '未提供',
          expanded: w.week_index === 1,
          loadingDoc: false,
        };
      }),
    };
  });

  return { planTitle, planSubtitle, assessment, chartHasLr, chartAxis: axis, chartPeakLabel: `${fmtNum(peak)} km`, rhythmBars, phaseTabs, stage, principles, calendarGroups };
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
    planView: 'overview',
    isPreview: false,
    previewApplied: false,
    planTitle: '',
    planSubtitle: '',
    assessment: null,
    assessExpanded: false,
    chartMetric: 'km',
    chartHasLr: false,
    chartAxis: 100,
    chartPeakLabel: '',
    rhythmBars: [],
    selectedWeek: 1,
    phaseTabs: [],
    chosenPhase: 0,
    stage: null,
    principles: [],
    calendarGroups: [],
    uid: '',
    adjustDialogVisible: false,
    pendingAdjustment: null,
    injuryDialogVisible: false,
    injuryDialogMode: 'ask',
    injuryState: null,
    injuryResultText: '',
    raceClosingSoon: false,
  },

  _plan: null as SeasonPlanContent | null,
  _previewPayload: null as PlanPayload | null,

  onLoad(options: Record<string, string | undefined>) {
    this.setData({
      statusBarHeight: statusBarHeight(),
      canBack: getCurrentPages().length > 1,
      contentPaddingTop: contentPaddingTopRpx(),
    });
    // 预览模式（聊天结果卡 → 查看完整计划）：候选 content 约 100KB，超过
    // navigateTo URL 的现实上限，coach 页经 storage 交接（?preview=1 无
    // payload）；保留 options.payload 解析兼容旧入口/手动跳转。
    if (options?.preview === '1') {
      let payload: PlanPayload | null = null;
      if (options.payload) {
        try {
          payload = JSON.parse(decodeURIComponent(options.payload)) as PlanPayload;
        } catch (err) {
          console.warn('[training-plan] 预览 payload 解析失败', err);
        }
      }
      if (!payload) payload = takePendingPlanPreview();
      if (payload?.content) {
        this._previewPayload = payload;
        this.setData({ isPreview: true });
      }
    }
    userStore.waitForAuth().then(() => {
      const { isAuthenticated, user } = userStore.getState();
      if (!isAuthenticated || !user) {
        openLogin(currentRouteForRedirect());
        return;
      }
      this.setData({ uid: user.id });
      if (this._previewPayload?.content) {
        // 预览：直接用卡片带的候选内容渲染，不走 current
        this.applyPlan(this._previewPayload.content as unknown as SeasonPlanContent);
      } else {
        void this.loadPlan();
      }
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

  applyPlan(plan: SeasonPlanContent) {
    if (!plan.phases.length) {
      // Go 校验只保证 phases 是数组；空数组按内容错误走错误态而不是让它抛 TypeError
      this.setData({ loadState: 'error', errorText: '计划内容为空' });
      return;
    }
    this._plan = plan;
    const vms = buildVMs(plan, this.data.chartMetric, this.data.chosenPhase, this.data.selectedWeek);
    this.setData({ loadState: 'ready', ...vms });
    // 默认展开第 1 周并预取其每日课表（设计稿首周 open）
    const firstWeek = vms.calendarGroups[0]?.weeks[0];
    if (firstWeek?.expanded) {
      void this.loadWeekDoc(firstWeek.key, this._weekStartOf(plan, 1));
    }
  },

  /** week_index → week_start（每周安排懒加载用）。 */
  _weekStartOf(plan: SeasonPlanContent, weekIndex: number): string {
    return plan.weeks.find((w) => w.week_index === weekIndex)?.week_start || '';
  },

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

  // ---------- 双视图 / 图表 / 阶段 ----------

  onSwitchView(e: WechatMiniprogram.TouchEvent) {
    const view = String(e.currentTarget.dataset.view) as 'overview' | 'calendar';
    if (view === this.data.planView) return;
    this.setData({ planView: view });
  },

  onMetricToggle(e: WechatMiniprogram.TouchEvent) {
    const metric = String(e.currentTarget.dataset.metric) as 'km' | 'lr';
    if (metric === this.data.chartMetric || !this.data.chartHasLr) return;
    if (!this._plan) return;
    const vms = buildVMs(this._plan, metric, this.data.chosenPhase, this.data.selectedWeek);
    this.setData({
      chartMetric: metric,
      rhythmBars: vms.rhythmBars,
      chartAxis: vms.chartAxis,
      chartPeakLabel: vms.chartPeakLabel,
    });
  },

  onBarTap(e: WechatMiniprogram.TouchEvent) {
    const week = Number(e.currentTarget.dataset.week);
    const bars = this.data.rhythmBars.map((b) => ({ ...b, selected: b.week === week }));
    this.setData({ rhythmBars: bars, selectedWeek: week });
  },

  onPhaseTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index);
    if (!this._plan || index === this.data.chosenPhase) return;
    const vms = buildVMs(this._plan, this.data.chartMetric, index, this.data.selectedWeek);
    this.setData({ chosenPhase: index, stage: vms.stage });
  },

  onToggleFullFocus() {
    const stage = this.data.stage;
    if (!stage || !stage.hasFull) return;
    this.setData({ stage: { ...stage, focusExpanded: !stage.focusExpanded } });
  },

  onToggleAssess() {
    this.setData({ assessExpanded: !this.data.assessExpanded });
  },

  // ---------- 每周安排（懒加载每日课表，#858 PR-E 同源） ----------

  onWeekExpand(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key);
    const weekIndex = Number(e.currentTarget.dataset.week);
    const weekStart = this._plan ? this._weekStartOf(this._plan, weekIndex) : '';
    const before = this.data.calendarGroups.flatMap((g) => g.weeks).find((w) => w.key === key);
    if (!before) return;
    const expanding = !before.expanded;
    this.patchWeek(key, { expanded: expanding });
    if (expanding && weekStart && !before.hasDoc) void this.loadWeekDoc(key, weekStart);
  },

  async loadWeekDoc(key: string, weekStart: string) {
    if (!this.data.uid || !weekStart) return;
    this.patchWeek(key, { loadingDoc: true });
    try {
      const detail = await getWeeklyPlan(this.data.uid, weekFolderName(weekStart));
      const content =
        detail && typeof detail.content === 'object' && detail.content !== null
          ? (detail.content as WeeklyPlanContentStructured)
          : null;
      // #222 周课表展示本周排入力量节数（独立统计，不进跑量口径）
      const strengthCount = (content?.sessions ?? []).filter((s) => s.kind === 'strength').length;
      this.patchWeek(key, {
        loadingDoc: false,
        hasDoc: !!content?.sessions?.length,
        strengthLabel: strengthCount > 0 ? `力量 ${strengthCount} 节` : '',
        days: buildReviewDays(content?.sessions ?? []),
      });
    } catch (err) {
      // 404（该周无 weekly 行）= 尚未生成，走 future 展示；其余失败同样降级
      console.warn('[training-plan] 拉周每日课表失败', err);
      this.patchWeek(key, { loadingDoc: false, hasDoc: false, strengthLabel: '', days: [] });
    }
  },

  patchWeek(key: string, patch: Partial<ReviewWeekVM>) {
    const groups = this.data.calendarGroups.map((g) => ({
      ...g,
      weeks: g.weeks.map((w) => (w.key === key ? { ...w, ...patch } : w)),
    }));
    this.setData({ calendarGroups: groups });
  },

  onDayExpand(e: WechatMiniprogram.TouchEvent) {
    const weekKey = String(e.currentTarget.dataset.weekKey);
    const dayKey = String(e.currentTarget.dataset.key);
    const groups = this.data.calendarGroups.map((g) => ({
      ...g,
      weeks: g.weeks.map((w) =>
        w.key === weekKey
          ? { ...w, days: w.days.map((d) => (d.key === dayKey && !d.isRest ? { ...d, expanded: !d.expanded } : d)) }
          : w,
      ),
    }));
    this.setData({ calendarGroups: groups });
  },

  // ---------- 预览 footer（聊天结果卡 → 调整/启用） ----------

  /** 调整计划：回教练聊天说调整需求（预览态；衔接调整/重新生成线）。 */
  onAdjustTap() {
    wx.switchTab({ url: '/pages/coach/coach' });
  },

  /** 启用计划（apply-from-content）：有 active 先弹替换确认，409/422 复查提示。 */
  async onApplyTap() {
    const payload = this._previewPayload;
    if (!payload?.apply_token || !payload.content || this.data.previewApplied) return;
    const userId = this.data.uid;
    if (!userId) return;
    let expectation: { expected_active_plan_id: string; expected_active_revision: number } | undefined;
    try {
      const envelope = await getCurrentMasterPlan(userId);
      if (envelope && envelope.content_version === 2) {
        const ok = await new Promise<boolean>((resolve) => {
          wx.showModal({
            title: '启用新计划',
            content: `将替换当前启用中的训练计划（${envelope.plan.goal.race_name || '当前计划'}）`,
            confirmText: '启用',
            cancelText: '暂不',
            success: (res) => resolve(res.confirm),
            fail: () => resolve(false),
          });
        });
        if (!ok) return;
        expectation = {
          expected_active_plan_id: envelope.plan_id,
          expected_active_revision: envelope.revision ?? 0,
        };
      }
    } catch (err) {
      console.warn('[training-plan] 预检当前计划失败', err);
    }
    wx.showLoading({ title: '正在启用…', mask: true });
    try {
      await applyMasterPlanFromContent(payload.apply_token, payload.content, expectation);
      // 聊天结果卡回写「已启用」：apply_token 即产生该候选的 plan job id。
      markMasterPlanApplied(payload.apply_token);
      wx.hideLoading();
      this.setData({ previewApplied: true });
      wx.showToast({ title: '已启用', icon: 'success' });
      // 启用成功后回到正式视图（重拉 current）
      this._previewPayload = null;
      this.setData({ isPreview: false });
      void this.loadPlan();
    } catch (err) {
      wx.hideLoading();
      console.error('[training-plan] 启用失败', err);
      wx.showToast({ title: '启用失败，请重试', icon: 'none' });
    }
  },

  onBackTap() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    // 冷开直达兜底：回主页（pages[0]，与全 app 顶栏约定一致）
    wx.switchTab({ url: '/pages/index/index' });
  },

  onRetryTap() {
    if (this.data.isPreview && this._previewPayload?.content) {
      this.applyPlan(this._previewPayload.content as unknown as SeasonPlanContent);
      return;
    }
    void this.loadPlan();
  },

  onCoachTap() {
    wx.switchTab({ url: '/pages/coach/coach' });
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
    }
  },

  onInjuryCoach() {
    this.setData({ injuryDialogVisible: false });
    wx.switchTab({ url: '/pages/coach/coach' });
  },
});
