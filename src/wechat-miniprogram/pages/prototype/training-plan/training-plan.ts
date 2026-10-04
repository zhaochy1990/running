// ============================================================
// 【原型 · 定稿后丢弃】「我的训练计划」三方案对比页
// 问题：「我」tab → 我的训练计划，当前启用的 master plan 怎么展示？
// 三方案经 ?variant=A|B|C 初始切换，底部悬浮条翻页；空态用悬浮条「空态」钮。
// B 方案已对齐 Web 版 /plan（TrainingPlanPage SeasonOverview）的信息架构：
// hero eyebrow+lede、训练周期柱状图（点柱看周详情 ≈ Web hover tooltip）、
// 阶段关键课型/完成小结/coach note、训练原则、W## 补零与 km/w 等格式化习惯。
// 数据为本地 mock，字段形状对齐 GET /api/users/me/master-plan/current
// 的 v2 信封；真实接入时只换数据源，视图模型可直接复用。
// ============================================================

interface SessionVM {
  key: string;
  iconPath: string;
  dayLabel: string;
  title: string;
  meta: string;
  km: string;
  state: 'done' | 'today' | 'upcoming';
  stateLabel: string;
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

interface PhaseMilestoneVM {
  key: string;
  dateLabel: string;
  typeLabel: string;
  name: string;
  valueText: string;
  done: boolean;
  isNext: boolean;
  daysUntilLabel: string;
}

interface MilestoneVM {
  key: string;
  iconPath: string;
  name: string;
  dateLabel: string;
  detail: string;
  done: boolean;
  isNext: boolean;
  daysUntilLabel: string;
}

interface TimelineItemVM {
  key: string;
  kind: 'phase' | 'week';
  state: 'done' | 'current' | 'future';
  // phase
  phase?: PhaseVM;
  // week（phaseKey 用于折叠：仅所属阶段展开时渲染）
  phaseKey?: string;
  weekIndex?: number;
  dateRange?: string;
  km?: string;
  actualKm?: string;
  actualSub?: string;
  tag?: string;
}

interface StatVM {
  key: string;
  label: string;
  value: string;
  unit: string;
  sub: string;
}

interface PhaseRowVM {
  key: string;
  name: string;
  weeksLabel: string;
  kmRange: string;
  stateLabel: string;
  state: 'done' | 'current' | 'future';
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

interface VMBundle {
  countdownDays: number;
  elapsedDays: number;
  weekNow: number;
  currentPhaseName: string;
  ledeText: string;
  phaseVMs: PhaseVM[];
  stats: StatVM[];
  nextMilestone: MilestoneVM;
  sessions: SessionVM[];
  timeline: TimelineItemVM[];
  weekDots: Array<{ key: string; state: 'done' | 'current' | 'future' }>;
  phaseRows: PhaseRowVM[];
  progressPercent: number;
  weekProgressPercent: number;
  weekGoalText: string;
  weekDoneText: string;
  chart: {
    bars: ChartBarVM[];
    spans: ChartSpanVM[];
    detail: string;
  };
}

interface TrainingPlanPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  variant: 'A' | 'B' | 'C';
  variantName: string;
  empty: boolean;
  // 公共（A hero / B goal-strip / C）
  eyebrowStatus: string;
  raceName: string;
  raceDistanceLabel: string;
  raceDateLabel: string;
  raceLocation: string;
  targetTime: string;
  targetPace: string;
  countdownDays: number;
  elapsedDays: number;
  weekNow: number;
  weekTotal: number;
  currentPhaseName: string;
  progressPercent: number;
  // A · 赛季仪表盘
  phaseChips: PhaseVM[];
  stats: StatVM[];
  nextMilestone: MilestoneVM;
  sessions: SessionVM[];
  // B · 备赛旅程
  ledeText: string;
  chartMetric: 'km' | 'dose';
  chartBars: ChartBarVM[];
  chartSpans: ChartSpanVM[];
  chartDetail: string;
  chartSelectedWeek: number;
  timeline: TimelineItemVM[];
  /** 各阶段周次是否展开（key = p0..p3）；默认全部收起 */
  expandedPhases: Record<string, boolean>;
  principles: Array<{ key: string; no: string; text: string }>;
  // C · 本周优先
  weekDots: Array<{ key: string; state: 'done' | 'current' | 'future' }>;
  phaseRows: PhaseRowVM[];
  weekGoalText: string;
  weekDoneText: string;
  weekProgressPercent: number;
}

interface TrainingPlanPageHandlers {
  onBackTap(): void;
  onPrevVariant(): void;
  onNextVariant(): void;
  onToggleEmpty(): void;
  onStubTap(): void;
  onBarTap(e: WechatMiniprogram.TouchEvent): void;
  onMetricToggle(e: WechatMiniprogram.TouchEvent): void;
  onTogglePhaseWeeks(e: WechatMiniprogram.TouchEvent): void;
}

// ---------- mock 数据（形状 ≈ 后端 v2 plan） ----------

const RACE_NAME = '2026 杭州马拉松';
const RACE_DISTANCE = 'FM';
const RACE_DATE = '2026-11-01';
const START_DATE = '2026-06-29';
const TARGET_TIME = '3:59:30';
const RACE_LOCATION = '杭州';
const TOTAL_WEEKS = 18;
const CUMULATIVE_KM = 686.6;
const WEEK_DONE_KM = 32.6;

// 阶段配色沿用 Web PHASE_VISUALS 语义（base 绿 / build 青 / peak 琥珀 / taper 紫），
// 做了降饱和以贴深色主题；「当前/你在这里」的注意力色仍是主题粉 #ff6363。
const PHASE_TYPE_META: Record<string, { label: string; color: string }> = {
  base: { label: '基础', color: '#7ac9a3' },
  build: { label: '专项', color: '#6db3cf' },
  peak: { label: '峰值', color: '#d9a45f' },
  taper: { label: '减量', color: '#b395d6' },
};

const MOCK_PHASES: Array<{
  name: string;
  type: keyof typeof PHASE_TYPE_META;
  fromWeek: number;
  toWeek: number;
  kmLow: number;
  kmHigh: number;
  focus: string;
  rhythm?: string;
  keyWorkouts?: string;
  triggers: string[];
  keySessionTypes: string[];
  runsPerWeek: number;
  coachNote?: string;
  hrZoneLine?: string;
}> = [
  {
    name: '基础期', type: 'base', fromWeek: 1, toWeek: 6, kmLow: 40, kmHigh: 55,
    focus: '有氧打底 · 跑量渐进',
    rhythm: '周跑 4 次：2 次轻松 + 1 次中等有氧 + 周日长距离',
    keyWorkouts: '周日长距离 16-20 km @ 6:30-6:45/km',
    triggers: ['晨脉连续 3 天高于基线 5 bpm → 次周减量 10%', '跟腱或膝外侧出现疼痛 → 停跑并反馈教练'],
    keySessionTypes: ['轻松跑', '长距离'], runsPerWeek: 4,
    hrZoneLine: 'Z1 8% · Z2 61% · Z3 24% · Z4 6% · Z5 1%',
  },
  {
    name: '专项期', type: 'build', fromWeek: 7, toWeek: 12, kmLow: 50, kmHigh: 65,
    focus: '引入阈值与节奏跑',
    rhythm: '周跑 4 次：2 次质量课（阈值/节奏）间隔至少 48 小时',
    keyWorkouts: '阈值 8 km @ 5:35-5:45/km；长距离拉到 25 km',
    triggers: ['阈值课配速掉出区间 10s 以上 → 结束该组', '周跑量增幅超过 10% → 回到上周水平'],
    keySessionTypes: ['阈值跑', '节奏跑', '长距离'], runsPerWeek: 4,
    hrZoneLine: 'Z1 6% · Z2 52% · Z3 30% · Z4 10% · Z5 2%',
  },
  {
    name: '峰值期', type: 'peak', fromWeek: 13, toWeek: 15, kmLow: 55, kmHigh: 70,
    focus: '最长长距离 · 强度峰值',
    rhythm: '周跑 5 次：质量课 2 次 + 最长长距离 1 次，其余全轻松',
    keyWorkouts: '6 × 1000m 间歇 @ 5:10/km；30 km 长距离',
    triggers: ['睡眠连续两晚不足 6 小时 → 取消当日质量课', 'Form 低于 -30 → 自动降档为轻松跑'],
    keySessionTypes: ['间歇跑', '阈值跑', '长距离'], runsPerWeek: 5,
    coachNote: '周日 30 km 是本周期最长的一课，稳住心率区间跑完即可，不要追配速。',
  },
  {
    name: '减量期', type: 'taper', fromWeek: 16, toWeek: 18, kmLow: 30, kmHigh: 45,
    focus: '削量保强度 · 迎接比赛',
    rhythm: '周跑 4 次逐周 -25% 跑量，保留 1 次短阈值维持强度',
    keyWorkouts: '赛前 3 天 3 km @ 马拉松配速 + 4 组 100m 加速',
    triggers: ['不做任何「补课」性质的加量', '赛中每小时补胶 1 支，赛前演练 2 次'],
    keySessionTypes: ['阈值跑', '轻松跑'], runsPerWeek: 4,
  },
];

// W1-W13 已完成实际跑量，W14 为进行中部分完成。
const WEEK_ACTUAL_KM: Record<number, number> = {
  1: 42.3, 2: 46.8, 3: 51.2, 4: 35.6, 5: 48.9, 6: 53.4, 7: 52.1, 8: 38.2,
  9: 58.7, 10: 61.3, 11: 63.8, 12: 44.5, 13: 57.2, 14: 32.6,
};

// 完成周实际均配 / 均心率（对应 weeks[].actual_avg_pace_fmt / actual_avg_hr）。
const W_PACE = ['6:25', '6:31', '6:18', '6:36', '6:12', '6:05', '6:08', '6:22', '5:58', '5:52', '5:49', '6:03', '5:51', '5:48'];
const W_HR = [145, 147, 146, 144, 148, 150, 149, 147, 152, 154, 155, 151, 154, 156];

const RECOVERY_WEEKS = [4, 8, 12];

const MOCK_MILESTONES: Array<{
  id: string;
  name: string;
  date: string;
  afterWeek: number;
  type: 'test_run' | 'race';
  target: string;
  completedActual?: string;
  done: boolean;
}> = [
  { id: 'm1', name: '5K 基础测验', date: '2026-08-08', afterWeek: 6, type: 'test_run', target: '25:30', completedActual: '25:12', done: true },
  { id: 'm2', name: '半马测验', date: '2026-10-11', afterWeek: 15, type: 'test_run', target: '1:58:00', done: false },
  { id: 'm3', name: '杭州马拉松', date: '2026-11-01', afterWeek: 18, type: 'race', target: '3:59:30', done: false },
];

const TRAINING_PRINCIPLES = [
  '强度日认真练，轻松日真正轻松——80/20 分布优先于日均配速',
  '每 4 周一个减量周，吸收训练成果比堆量更重要',
  '长距离课的目的是时间在腿上，不是配速；后程掉速 10 秒内都算达标',
  '睡眠变差或晨脉升高 5 bpm 以上时，主动把当日课表降一档',
];

const SESSION_ICONS: Record<string, string> = {
  interval: '/assets/icons/sprint.svg',
  threshold: '/assets/icons/fitness_center.svg',
  long_run: '/assets/icons/directions_run.svg',
  race: '/assets/icons/flag.svg',
};

// 本周关键课（跟随当前周动态排日期；周次漂移后内容不变，原型可接受）
const MOCK_SESSIONS: Array<{
  type: keyof typeof SESSION_ICONS;
  title: string;
  meta: string;
  km: string;
  weekdayOffset: number;
}> = [
  { type: 'interval', title: '间歇跑', meta: '6 × 1000m @ 5:10/km · 组间 400m 慢跑', km: '10 km', weekdayOffset: 1 },
  { type: 'threshold', title: '阈值跑', meta: '8 km @ 5:35/km · 热身放松各 15 分钟', km: '11.5 km', weekdayOffset: 3 },
  { type: 'long_run', title: '长距离跑', meta: '30 km @ 6:10-6:20/km', km: '30 km', weekdayOffset: 6 },
];

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const VARIANT_NAMES: Record<TrainingPlanPageData['variant'], string> = {
  A: '赛季仪表盘',
  B: '备赛旅程',
  C: '本周优先',
};

const VARIANT_ORDER: TrainingPlanPageData['variant'][] = ['A', 'B', 'C'];

// ---------- 工具 ----------

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Web 端 formatShort 习惯：M/D 无前导零。 */
function fmtShort(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtFullSlash(d: Date): string {
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}/${mm}/${dd}`;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86400000);
}

function weekStartOf(weekIndex: number): Date {
  const d = parseDate(START_DATE);
  d.setDate(d.getDate() + (weekIndex - 1) * 7);
  return d;
}

/** Web 端 padWeek 习惯：W01-W18。 */
function padWeek(w: number): string {
  return `W${String(w).padStart(2, '0')}`;
}

/** Web 端 formatKm 习惯：整数无小数、否则 1 位小数。 */
function fmtKm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function phaseOf(week: number) {
  return MOCK_PHASES.find((p) => p.fromWeek <= week && week <= p.toWeek) ?? MOCK_PHASES[MOCK_PHASES.length - 1];
}

/** 负荷 mock：由周跑量推导的 STRIDE DOSE 区间（planned）与实际值。 */
function doseOf(kmLow: number, kmHigh: number, actualKm?: number) {
  const mid = (kmLow + kmHigh) / 2;
  return {
    lowD: Math.round((mid * 6.6) / 5) * 5,
    highD: Math.round((mid * 7.6) / 5) * 5,
    actualD: actualKm !== undefined ? Math.round(actualKm * 7.1) : 0,
  };
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

// ---------- 训练周期图（Web MileageCycleCard 的移动端转译） ----------

const CHART_AREA_RPX = 150;

function buildChart(metric: 'km' | 'dose', weekNow: number) {
  const maxKm = 75;
  const maxDose = Math.max(...MOCK_PHASES.map((p) => doseOf(p.kmLow, p.kmHigh).highD));
  const bars: ChartBarVM[] = [];
  for (let w = 1; w <= TOTAL_WEEKS; w += 1) {
    const phase = phaseOf(w);
    const meta = PHASE_TYPE_META[phase.type];
    const state: ChartBarVM['state'] = w < weekNow ? 'done' : w === weekNow ? 'current' : 'future';
    const actual = WEEK_ACTUAL_KM[w];
    const mid = (phase.kmLow + phase.kmHigh) / 2;
    let fillH = 0;
    let bandH = 0;
    let tickBottom = 0;
    if (metric === 'km') {
      fillH = Math.round(((actual ?? mid) / maxKm) * CHART_AREA_RPX);
      tickBottom = Math.round((mid / maxKm) * CHART_AREA_RPX);
    } else {
      const dose = doseOf(phase.kmLow, phase.kmHigh, actual);
      bandH = Math.round((dose.highD / maxDose) * CHART_AREA_RPX);
      fillH = actual !== undefined ? Math.round((dose.actualD / maxDose) * CHART_AREA_RPX) : 0;
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
  const spans: ChartSpanVM[] = MOCK_PHASES.map((p, i) => ({
    key: `sp${i}`,
    label: PHASE_TYPE_META[p.type].label,
    weeks: p.toWeek - p.fromWeek + 1,
    color: PHASE_TYPE_META[p.type].color,
  }));
  return { bars, spans, detail: buildChartDetail(weekNow, metric) };
}

/** 点柱后的详情行 ≈ Web 的 hover tooltip。 */
function buildChartDetail(w: number, metric: 'km' | 'dose'): string {
  const phase = phaseOf(w);
  const actual = WEEK_ACTUAL_KM[w];
  const state = w < vmCache.weekNow ? 'done' : w === vmCache.weekNow ? 'current' : 'future';
  const ws = weekStartOf(w);
  const we = new Date(ws);
  we.setDate(we.getDate() + 6);
  const parts: string[] = [padWeek(w), `${fmtShort(ws)} – ${fmtShort(we)}`];
  if (metric === 'km') {
    parts.push(`计划 ${phase.kmLow}-${phase.kmHigh} km`);
    if (actual !== undefined) {
      parts.push(`实际 ${fmtKm(actual)} km${state === 'current' ? '（截至目前）' : ''}`);
      parts.push(`${W_PACE[w - 1]}/km · ${W_HR[w - 1]} bpm`);
    } else {
      parts.push('未完成');
    }
  } else {
    const dose = doseOf(phase.kmLow, phase.kmHigh, actual);
    parts.push(`计划负荷 ${dose.lowD}-${dose.highD} dose`);
    if (actual !== undefined && dose.actualD > 0) {
      parts.push(`实际负荷 ${dose.actualD} dose${state === 'current' ? '（截至目前）' : ''}`);
    }
  }
  return parts.join(' · ');
}

// ---------- 视图模型 ----------

let vmCache: { weekNow: number };

function buildViewModels(today: Date): VMBundle {
  const raceDate = parseDate(RACE_DATE);
  const startDate = parseDate(START_DATE);
  const countdownDays = Math.max(0, daysBetween(today, raceDate));
  const elapsedDays = Math.max(0, daysBetween(startDate, today));
  const rawWeek = Math.floor(elapsedDays / 7) + 1;
  const weekNow = Math.min(Math.max(rawWeek, 1), TOTAL_WEEKS);
  vmCache = { weekNow };

  const weekState = (i: number): 'done' | 'current' | 'future' =>
    i < weekNow ? 'done' : i === weekNow ? 'current' : 'future';

  const nextMs = MOCK_MILESTONES.find((m) => !m.done) ?? MOCK_MILESTONES[MOCK_MILESTONES.length - 1];
  const nextMsId = nextMs.id;

  const phaseVMs: PhaseVM[] = MOCK_PHASES.map((p, idx) => {
    const meta = PHASE_TYPE_META[p.type];
    const state: PhaseVM['state'] =
      p.toWeek < weekNow ? 'done' : p.fromWeek <= weekNow && weekNow <= p.toWeek ? 'current' : 'future';
    let summaryLine: string | undefined;
    if (state === 'done') {
      const weeks = Array.from({ length: p.toWeek - p.fromWeek + 1 }, (_, k) => p.fromWeek + k);
      const totalKm = weeks.reduce((sum, w) => sum + (WEEK_ACTUAL_KM[w] ?? 0), 0);
      const midW = weeks[Math.floor(weeks.length / 2)];
      summaryLine = `阶段小结：${fmtKm(Math.round(totalKm * 10) / 10)} km · ${weeks.length * p.runsPerWeek} 次 · 均配 ${W_PACE[midW - 1]}/km · ${W_HR[midW - 1]} bpm`;
    }
    // 关键里程碑：按 afterWeek 归入所属阶段（Web PhaseDetail 关键里程碑侧栏）
    const milestones: PhaseMilestoneVM[] = MOCK_MILESTONES.filter(
      (m) => p.fromWeek <= m.afterWeek && m.afterWeek <= p.toWeek,
    ).map((m) => ({
      key: m.id,
      dateLabel: fmtShort(parseDate(m.date)),
      typeLabel: m.type === 'race' ? '比赛' : '测验',
      name: m.name,
      valueText: m.completedActual ? `实测 ${m.completedActual}（目标 ${m.target}）` : `目标 ${m.target}`,
      done: m.done,
      isNext: !m.done && m.id === nextMsId,
      daysUntilLabel: `${Math.max(0, daysBetween(today, parseDate(m.date)))} 天后`,
    }));
    return {
      key: `p${idx}`,
      name: p.name,
      typeLabel: meta.label,
      color: meta.color,
      weeksLabel: `${padWeek(p.fromWeek)}-${padWeek(p.toWeek)}`,
      weekCount: p.toWeek - p.fromWeek + 1,
      dateRange: `${fmtShort(weekStartOf(p.fromWeek))} – ${fmtShort(weekStartOf(p.toWeek + 1))}`,
      kmRange: `${p.kmLow}-${p.kmHigh} km/w`,
      focus: p.focus,
      rhythm: p.rhythm,
      keyWorkouts: p.keyWorkouts,
      triggers: p.triggers,
      keySessionTypes: p.keySessionTypes,
      summaryLine,
      hrZoneLine: state === 'done' ? p.hrZoneLine : undefined,
      coachNote: state === 'current' ? p.coachNote : undefined,
      milestones,
      state,
    };
  });

  const currentPhase = phaseOf(weekNow);
  const ledeText = `${fmtShort(startDate)} – ${fmtShort(raceDate)} · 共 ${TOTAL_WEEKS} 周 · 当前第 ${weekNow} 周 · ${currentPhase.name}，重点是「${currentPhase.focus}」`;

  // A · 指标格
  const stats: StatVM[] = [
    { key: 's1', label: '累计跑量', value: CUMULATIVE_KM.toFixed(1), unit: 'km', sub: `开跑 ${elapsedDays} 天` },
    { key: 's2', label: '本周目标', value: `${currentPhase.kmLow}-${currentPhase.kmHigh}`, unit: 'km', sub: `${currentPhase.name} · 第 ${weekNow} 周` },
    { key: 's3', label: '本周已完成', value: WEEK_DONE_KM.toFixed(1), unit: 'km', sub: '周日还有 30 km 长距离' },
    { key: 's4', label: '剩余', value: String(TOTAL_WEEKS - weekNow + 1), unit: '周', sub: `${countdownDays} 天后比赛` },
  ];

  const nextMilestone: MilestoneVM = {
    key: nextMs.id,
    iconPath: SESSION_ICONS.race,
    name: nextMs.name,
    dateLabel: fmtShort(parseDate(nextMs.date)),
    detail: nextMs.completedActual ? `实测 ${nextMs.completedActual}（目标 ${nextMs.target}）` : `目标 ${nextMs.target}`,
    done: nextMs.done,
    isNext: true,
    daysUntilLabel: `${Math.max(0, daysBetween(today, parseDate(nextMs.date)))} 天后`,
  };

  // 本周关键课（按真实 today 排日期与状态）
  const curWeekStart = weekStartOf(weekNow);
  const sessions: SessionVM[] = MOCK_SESSIONS.map((s, idx) => {
    const d = new Date(curWeekStart);
    d.setDate(d.getDate() + s.weekdayOffset);
    const diff = daysBetween(today, d);
    const state: SessionVM['state'] = diff < 0 ? 'done' : diff === 0 ? 'today' : 'upcoming';
    return {
      key: `sess${idx}`,
      iconPath: SESSION_ICONS[s.type],
      dayLabel: `${WEEKDAY_NAMES[d.getDay()]} ${fmtShort(d)}`,
      title: s.title,
      meta: s.meta,
      km: s.km,
      state,
      stateLabel: state === 'done' ? '已完成' : state === 'today' ? '今日' : '待完成',
    };
  });

  // B · 时间轴：阶段头 → 逐周 → 里程碑节点
  const timeline: TimelineItemVM[] = [];
  MOCK_PHASES.forEach((p, pIdx) => {
    timeline.push({ key: `tl-p${pIdx}`, kind: 'phase', state: phaseVMs[pIdx].state, phase: phaseVMs[pIdx] });
    for (let w = p.fromWeek; w <= p.toWeek; w += 1) {
      const st = weekState(w);
      const ws = weekStartOf(w);
      const we = new Date(ws);
      we.setDate(we.getDate() + 6);
      const tag = w === TOTAL_WEEKS ? '比赛周' : RECOVERY_WEEKS.includes(w) ? '减量周' : '';
      const hasActual = st === 'done' || (st === 'current' && WEEK_ACTUAL_KM[w] !== undefined);
      timeline.push({
        key: `tl-w${w}`,
        kind: 'week',
        state: st,
        phaseKey: `p${pIdx}`,
        weekIndex: w,
        dateRange: `${fmtShort(ws)} – ${fmtShort(we)}`,
        km: `${p.kmLow}-${p.kmHigh} km`,
        actualKm: hasActual ? `${fmtKm(WEEK_ACTUAL_KM[w])} km` : undefined,
        actualSub: hasActual ? `${W_PACE[w - 1]}/km · ${W_HR[w - 1]} bpm` : undefined,
        tag,
      });
    }
  });

  // C · 周点阵 + 阶段行
  const weekDots = Array.from({ length: TOTAL_WEEKS }, (_, i) => ({
    key: `d${i + 1}`,
    state: weekState(i + 1),
  }));
  const phaseRows: PhaseRowVM[] = MOCK_PHASES.map((p, idx) => ({
    key: `pr${idx}`,
    name: p.name,
    weeksLabel: `${padWeek(p.fromWeek)}-${padWeek(p.toWeek)}`,
    kmRange: `${p.kmLow}-${p.kmHigh} km/w`,
    state: phaseVMs[idx].state,
    stateLabel: phaseVMs[idx].state === 'done' ? '已完成' : phaseVMs[idx].state === 'current' ? '进行中' : '未开始',
  }));

  return {
    countdownDays,
    elapsedDays,
    weekNow,
    currentPhaseName: currentPhase.name,
    ledeText,
    phaseVMs,
    stats,
    nextMilestone,
    sessions,
    timeline,
    weekDots,
    phaseRows,
    progressPercent: Math.round((weekNow / TOTAL_WEEKS) * 100),
    weekProgressPercent: Math.round((WEEK_DONE_KM / currentPhase.kmHigh) * 100),
    weekGoalText: `${currentPhase.kmLow}-${currentPhase.kmHigh} km`,
    weekDoneText: `${WEEK_DONE_KM.toFixed(1)} / ${currentPhase.kmHigh} km`,
    chart: buildChart('km', weekNow),
  };
}

Page<TrainingPlanPageData, TrainingPlanPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    variant: 'A',
    variantName: VARIANT_NAMES.A,
    empty: false,
    eyebrowStatus: '已启用',
    raceName: RACE_NAME,
    raceDistanceLabel: RACE_DISTANCE === 'FM' ? '全马' : '半马',
    raceDateLabel: '2026.11.01',
    raceLocation: RACE_LOCATION,
    targetTime: TARGET_TIME,
    targetPace: '5:40/km',
    countdownDays: 28,
    elapsedDays: 97,
    weekNow: 14,
    weekTotal: TOTAL_WEEKS,
    currentPhaseName: '峰值期',
    progressPercent: 78,
    phaseChips: [],
    stats: [],
    nextMilestone: {
      key: 'm2', iconPath: SESSION_ICONS.race, name: '半马测验', dateLabel: '10/11', detail: '目标 1:58:00', done: false, isNext: true, daysUntilLabel: '7 天后',
    },
    sessions: [],
    ledeText: '',
    chartMetric: 'km',
    chartBars: [],
    chartSpans: [],
    chartDetail: '',
    chartSelectedWeek: 14,
    timeline: [],
    expandedPhases: {},
    principles: TRAINING_PRINCIPLES.map((t, i) => ({ key: `tp${i}`, no: String(i + 1).padStart(2, '0'), text: t })),
    weekDots: [],
    phaseRows: [],
    weekGoalText: '55-70 km',
    weekDoneText: '32.6 / 70 km',
    weekProgressPercent: 47,
  },

  onLoad(options: Record<string, string | undefined>) {
    const variant = (options.variant || 'A').toUpperCase();
    const v: TrainingPlanPageData['variant'] =
      variant === 'B' || variant === 'C' ? variant : 'A';
    const vm = buildViewModels(new Date());
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
      variant: v,
      variantName: VARIANT_NAMES[v],
      empty: options.empty === '1',
      countdownDays: vm.countdownDays,
      elapsedDays: vm.elapsedDays,
      weekNow: vm.weekNow,
      currentPhaseName: vm.currentPhaseName,
      progressPercent: vm.progressPercent,
      phaseChips: vm.phaseVMs,
      stats: vm.stats,
      nextMilestone: vm.nextMilestone,
      sessions: vm.sessions,
      ledeText: vm.ledeText,
      chartMetric: 'km',
      chartBars: vm.chart.bars,
      chartSpans: vm.chart.spans,
      chartDetail: vm.chart.detail,
      chartSelectedWeek: vm.weekNow,
      timeline: vm.timeline,
      weekDots: vm.weekDots,
      phaseRows: vm.phaseRows,
      weekGoalText: vm.weekGoalText,
      weekDoneText: vm.weekDoneText,
      weekProgressPercent: vm.weekProgressPercent,
    });
  },

  onBackTap() {
    wx.navigateBack({
      fail: () => {
        wx.switchTab({ url: '/pages/profile/profile' });
      },
    });
  },

  onPrevVariant() {
    const idx = VARIANT_ORDER.indexOf(this.data.variant);
    const next = VARIANT_ORDER[(idx - 1 + VARIANT_ORDER.length) % VARIANT_ORDER.length];
    this.setData({ variant: next, variantName: VARIANT_NAMES[next] });
  },

  onNextVariant() {
    const idx = VARIANT_ORDER.indexOf(this.data.variant);
    const next = VARIANT_ORDER[(idx + 1) % VARIANT_ORDER.length];
    this.setData({ variant: next, variantName: VARIANT_NAMES[next] });
  },

  onToggleEmpty() {
    this.setData({ empty: !this.data.empty });
  },

  onStubTap() {
    wx.showToast({ title: '原型占位 · 定稿后接入', icon: 'none' });
  },

  onBarTap(e: WechatMiniprogram.TouchEvent) {
    const week = Number(e.currentTarget.dataset.week);
    this.setData({
      chartSelectedWeek: week,
      chartDetail: buildChartDetail(week, this.data.chartMetric),
    });
  },

  onMetricToggle(e: WechatMiniprogram.TouchEvent) {
    const metric = e.currentTarget.dataset.metric === 'dose' ? 'dose' : 'km';
    if (metric === this.data.chartMetric) return;
    const chart = buildChart(metric, vmCache.weekNow);
    this.setData({
      chartMetric: metric,
      chartBars: chart.bars,
      chartSpans: chart.spans,
      chartDetail: buildChartDetail(this.data.chartSelectedWeek, metric),
    });
  },

  onTogglePhaseWeeks(e: WechatMiniprogram.TouchEvent) {
    const key = String(e.currentTarget.dataset.key);
    this.setData({
      [`expandedPhases.${key}`]: !this.data.expandedPhases[key],
    });
  },
});
