/**
 * 训练状态页的纯函数层：指标 / Form zone / readiness 分类、uCharts 折线图与柱状图
 * 配置、16 周训练热力图、8 周周剂量聚合、每日活动摘要文案。
 *
 * 与 Web 端 `frontend/src/pages/TrainingStatusPage.tsx` + `lib/weeklyLoad.ts` 保持
 * 同一套阈值与配色口径。本模块不碰 canvas / 小程序运行时（渲染交给 uCharts，
 * 见 `vendor/ucharts/`），node 可跑自检（`utils/trainingStatus.check.mts`）。
 */
import {
  epochToShanghaiYmd,
  shanghaiToday,
  shanghaiWeekStart,
  shanghaiYmdToEpoch,
} from './date';
import type { StrideTrainingLoadRecord } from '../types/health';

// ---------------------------------------------------------------------------
// Form zone —— 阈值按当日慢性负荷 (CTL) 比例划分（与 Web 相同）
// ---------------------------------------------------------------------------

export type FormZone = 'over_taper' | 'race_ready' | 'transition' | 'productive' | 'overload';

export const FORM_ZONE_COLOR: Record<FormZone, string> = {
  over_taper: '#ffab00',
  race_ready: '#0097a7',
  transition: '#8888a0',
  productive: '#00a85a',
  overload: '#d32f2f',
};

export const FORM_ZONE_LABEL: Record<FormZone, string> = {
  over_taper: '减量过多',
  race_ready: '比赛就绪',
  transition: '维持期',
  productive: '提升期',
  overload: '过度负荷',
};

export function classifyForm(
  form: number | null | undefined,
  chronic: number | null | undefined,
): FormZone | null {
  if (form == null || chronic == null || chronic <= 0) return null;
  const r = form / chronic;
  if (r > 0.25) return 'over_taper';
  if (r >= 0.1) return 'race_ready';
  if (r >= -0.1) return 'transition';
  if (r >= -0.25) return 'productive';
  return 'overload';
}

export function formColor(
  form: number | null | undefined,
  chronic: number | null | undefined,
): string {
  const zone = classifyForm(form, chronic);
  return zone ? FORM_ZONE_COLOR[zone] : '#8888a0';
}

// ---------------------------------------------------------------------------
// readiness gate（green / yellow / red）—— 与 Web 相同
// ---------------------------------------------------------------------------

const READINESS_COLOR: Record<string, string> = {
  green: '#00a85a',
  yellow: '#e68a00',
  red: '#d32f2f',
};

const READINESS_LABEL: Record<string, string> = {
  green: '可进行强度训练',
  yellow: '注意，建议减量',
  red: '建议停训恢复',
};

const READINESS_GATE_LABEL: Record<string, string> = {
  green: '绿灯',
  yellow: '黄灯',
  red: '红灯',
};

/** readiness 主色；未知 gate 归中性灰，避免异常值看起来像 STOP 信号。 */
export function readinessColor(gate: string | null): string {
  return gate ? (READINESS_COLOR[gate] ?? '#8888a0') : '#8888a0';
}

export function readinessLabel(gate: string | null): string {
  return gate ? (READINESS_LABEL[gate] ?? gate) : '—';
}

export function readinessGateLabel(gate: string | null): string {
  return gate ? (READINESS_GATE_LABEL[gate] ?? gate) : '—';
}

/** 由负荷比（ACWR）衍生的训练状态分类。 */
export function loadStateLabel(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  if (ratio < 0.8) return '恢复期';
  if (ratio < 1.0) return '维持期';
  if (ratio < 1.3) return '提升期';
  return '过度负荷';
}

// ---------------------------------------------------------------------------
// 16 周训练热力图
// ---------------------------------------------------------------------------

/** 剂量分桶（与 Web heatmapBucket 一致）：0 空/休息，1–4 递增。 */
export function heatmapBucket(dose: number | null): 0 | 1 | 2 | 3 | 4 {
  if (dose == null || dose <= 0) return 0;
  if (dose <= 40) return 1;
  if (dose <= 80) return 2;
  if (dose <= 120) return 3;
  return 4;
}

/** 深色主题适配的橙色渐变（0 = 休息中性底，1–4 = 强度递增）。 */
export const HEATMAP_COLORS = [
  'rgba(255, 255, 255, 0.07)', // 0 = 有记录但零剂量 / 休息
  'rgba(255, 143, 60, 0.25)', // 1 = 轻（1–40）
  'rgba(255, 143, 60, 0.5)', // 2 = 中（41–80）
  'rgba(255, 143, 60, 0.75)', // 3 = 重（81–120）
  '#ff8f3c', // 4 = 最重（>120）
] as const;

export type HeatDayState = 'active' | 'rest' | 'unknown' | 'absent' | 'future';

export interface HeatCell {
  date: string; // 上海 YYYY-MM-DD
  weekIdx: number; // 0..weeks-1
  dayIdx: number; // 0=Mon .. 6=Sun
  dose: number | null;
  state: HeatDayState;
  isToday: boolean;
  /** active 单元格的配色类名（heatmap__cell--b1..b4）；其它状态为空串，用 state 类名表达 */
  tone: string;
}

function addDays(ymd: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  return epochToShanghaiYmd(shanghaiYmdToEpoch(ymd) + days * 86400000);
}

export function buildHeatCells(
  series: readonly StrideTrainingLoadRecord[],
  weeks = 16,
  today: string = shanghaiToday(),
): HeatCell[] {
  const seriesByDate = new Map(series.map((r) => [r.date, r]));
  const thisMonday = shanghaiWeekStart(today);
  const firstMonday = addDays(thisMonday, -(weeks - 1) * 7);
  const out: HeatCell[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = addDays(firstMonday, w * 7 + d);
      const row = seriesByDate.get(date);
      const isFuture = date > today;

      let state: HeatDayState;
      let dose: number | null;
      if (isFuture) {
        state = 'future';
        dose = null;
      } else if (!row) {
        state = 'absent';
        dose = null;
      } else if (row.coverage_status === 'unknown') {
        state = 'unknown';
        dose = null;
      } else {
        dose = row.training_dose ?? null;
        state = dose != null && dose > 0 ? 'active' : 'rest';
      }

      const tone =
        state === 'active' ? `heatmap__cell--b${heatmapBucket(dose)}` : '';
      out.push({ date, weekIdx: w, dayIdx: d, dose, state, isToday: date === today, tone });
    }
  }
  return out;
}

/** 按列（周）重排热力图单元格，并在「周一首列跨月」时挂月份标签。
 *  列数由单元格实际 weekIdx 推导，与 buildHeatCells 的 weeks 参数解耦。 */
export function buildHeatWeeks(
  cells: readonly HeatCell[],
): Array<{ weekIdx: number; month: string; cells: HeatCell[] }> {
  const out: Array<{ weekIdx: number; month: string; cells: HeatCell[] }> = [];
  let lastMonth = '';
  const weekIndexes = Array.from(new Set(cells.map((c) => c.weekIdx))).sort((a, b) => a - b);
  for (const w of weekIndexes) {
    const weekCells = cells.filter((c) => c.weekIdx === w);
    const month = weekCells[0] ? weekCells[0].date.slice(5, 7) : '';
    out.push({ weekIdx: w, month: month !== lastMonth ? `${parseInt(month, 10)}月` : '', cells: weekCells });
    if (month) lastMonth = month;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8 周周剂量聚合 —— 与 Web lib/weeklyLoad.ts 的 aggregateWeeklyDose 一致
// ---------------------------------------------------------------------------

export interface DailyDoseRow {
  date: string;
  training_dose: number | null;
  coverage_status?: string;
}

export interface WeeklyDoseBucket {
  weekStart: string;
  weekLabel: string;
  totalDose: number | null;
  activeDays: number;
}

const WEEKS = 8;

export function aggregateWeeklyDose(
  records: readonly DailyDoseRow[],
  today: string = shanghaiToday(),
): WeeklyDoseBucket[] {
  const currentWeekStart = shanghaiWeekStart(today);
  if (!currentWeekStart) return [];

  const anchor = shanghaiYmdToEpoch(currentWeekStart);
  const buckets = new Map<string, WeeklyDoseBucket>();
  const unknownWeeks = new Set<string>();
  const orderedStarts: string[] = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const start = epochToShanghaiYmd(anchor - i * 7 * 86400000);
    orderedStarts.push(start);
    buckets.set(start, {
      weekStart: start,
      weekLabel: `${parseInt(start.slice(5, 7), 10)}/${parseInt(start.slice(8, 10), 10)}`,
      totalDose: null,
      activeDays: 0,
    });
  }

  for (const r of records) {
    const weekStart = shanghaiWeekStart(r.date);
    const bucket = buckets.get(weekStart);
    if (!bucket) continue;
    if (r.coverage_status === 'unknown') {
      unknownWeeks.add(weekStart);
      continue;
    }
    if (r.training_dose == null) continue;
    bucket.totalDose = (bucket.totalDose ?? 0) + r.training_dose;
    if (r.training_dose > 0) bucket.activeDays += 1;
  }

  return orderedStarts.map((k) => {
    const bucket = buckets.get(k)!;
    return unknownWeeks.has(k) ? { ...bucket, totalDose: null } : bucket;
  });
}

// ---------------------------------------------------------------------------
// 每日活动摘要（热力图详情卡 / 工具提示复用 Web DailyDoseTooltip 的文案口径）
// ---------------------------------------------------------------------------

const SPORT_NAME_CN: Array<[RegExp, string]> = [
  [/run|treadmill/i, '跑步'],
  [/strength|gym/i, '力量训练'],
  [/bike|cycling/i, '骑行'],
  [/swim/i, '游泳'],
  [/walk/i, '步行'],
  [/hike/i, '徒步'],
  [/ski|snowboard/i, '滑雪'],
  [/hiit/i, 'HIIT'],
  [/row/i, '划船'],
  [/jump rope/i, '跳绳'],
  [/cardio/i, '有氧'],
];

export function chineseSportName(name: string | null | undefined): string {
  const s = name ?? '';
  for (const [re, cn] of SPORT_NAME_CN) {
    if (re.test(s)) return cn;
  }
  return s || '训练';
}

/** 距离类运动展示「距离 + 配速 + 心率」；力量/HIIT 等只展示时长 + 心率。 */
export function isDistanceSport(name: string | null | undefined): boolean {
  return /run|bike|cycling|swim|walk|hike|treadmill|row/i.test(name ?? '');
}

/** 秒 → `1h43min` / `43min` / `8h`（与 Web 端工具提示一致）。 */
export function formatDurationHuman(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h${m}min`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

// ---------------------------------------------------------------------------
// 图表配置（uCharts）—— 坐标都按设备像素给（uCharts 不做 ctx.scale）
// ---------------------------------------------------------------------------

const CHART_PADDING: [number, number, number, number] = [10, 6, 0, 0];
const CHART_GRID_COLOR = 'rgba(255, 255, 255, 0.08)';
const CHART_FONT_COLOR = '#9c9c9d';
const CHART_FONT_SIZE = 10;

export interface ChartSeries {
  name: string;
  data: Array<number | null>;
  color: string;
}

export interface ChartBounds {
  min: number;
  max: number;
}

/** 数值边界外扩 pad（相等时也保证高度）。 */
export function padBounds(min: number, max: number, pad: number): ChartBounds {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - pad, max: max + pad };
  return { min: min - pad, max: max + pad };
}

function baseChartOptions(params: {
  type: 'line' | 'column';
  width: number;
  height: number;
  dpr: number;
  categories: string[];
}): Record<string, unknown> {
  return {
    type: params.type,
    width: params.width * params.dpr,
    height: params.height * params.dpr,
    pixelRatio: params.dpr,
    background: 'rgba(0,0,0,0)',
    animation: false,
    dataLabel: false,
    dataPointShape: false,
    fontSize: CHART_FONT_SIZE,
    fontColor: CHART_FONT_COLOR,
    padding: CHART_PADDING,
    legend: { show: false },
    xAxis: {
      disableGrid: true,
      axisLine: false,
      fontSize: CHART_FONT_SIZE,
      fontColor: CHART_FONT_COLOR,
      labelCount: 3,
    },
    yAxis: {
      gridType: 'dash',
      dashLength: 4,
      gridColor: CHART_GRID_COLOR,
      splitNumber: 4,
      fontSize: CHART_FONT_SIZE,
      fontColor: CHART_FONT_COLOR,
    },
    categories: params.categories,
  };
}

export function buildLineChartOptions(params: {
  categories: string[];
  series: ChartSeries[];
  bounds: ChartBounds;
  width: number;
  height: number;
  dpr: number;
}): Record<string, unknown> {
  return {
    ...baseChartOptions({ type: 'line', width: params.width, height: params.height, dpr: params.dpr, categories: params.categories }),
    yAxis: {
      gridType: 'dash',
      dashLength: 4,
      gridColor: CHART_GRID_COLOR,
      splitNumber: 4,
      fontSize: CHART_FONT_SIZE,
      fontColor: CHART_FONT_COLOR,
      data: [{ min: params.bounds.min, max: params.bounds.max, axisLine: false }],
    },
    extra: {
      line: { type: 'straight', width: 2 },
      tooltip: { showBox: true, bgColor: '#101111', fontColor: '#e3e2e5', gridType: 'dash' },
    },
    series: params.series.map((s) => ({ name: s.name, data: s.data, color: s.color })),
  };
}

/** 柱状图数据项：number 或 null（缺口）或 { value, color }（逐点配色，如 Form）。 */
export type ColumnDatum = number | null | { value: number | null; color: string };

export function buildColumnChartOptions(params: {
  categories: string[];
  data: ColumnDatum[];
  color: string;
  bounds: ChartBounds;
  width: number;
  height: number;
  dpr: number;
}): Record<string, unknown> {
  return {
    ...baseChartOptions({ type: 'column', width: params.width, height: params.height, dpr: params.dpr, categories: params.categories }),
    yAxis: {
      gridType: 'dash',
      dashLength: 4,
      gridColor: CHART_GRID_COLOR,
      splitNumber: 4,
      fontSize: CHART_FONT_SIZE,
      fontColor: CHART_FONT_COLOR,
      data: [{ min: params.bounds.min, max: params.bounds.max, axisLine: false }],
    },
    extra: {
      column: { type: 'group', width: 10 },
      tooltip: { showBox: true, bgColor: '#101111', fontColor: '#e3e2e5', gridType: 'dash' },
    },
    series: [{ name: '', color: params.color, data: params.data }],
  };
}

/** 上海日期 → `M/D` 短标签（兼容 YYYYMMDD）。 */
export function formatDateShort(ymd: string): string {
  const d = ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ymd;
  return `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)}`;
}
