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
import { theme } from './theme';
import { fmtShanghaiMdHm } from './format';

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
// 网格线用 bgDim（浅色下比发丝线更淡一档，devops#819）；发丝线留给卡片描边。
const CHART_GRID_COLOR = theme.bgDim;
const CHART_FONT_COLOR = theme.textSecondary;
// 浅色 tooltip：白卡 + 发丝线描边 + 主文字色（devops#819 图表规格），折线/柱状共用。
const CHART_TOOLTIP = {
  showBox: true,
  bgColor: theme.card,
  borderColor: theme.hairline,
  borderWidth: 1,
  fontColor: theme.textPrimary,
  gridType: 'dash',
};
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
      tooltip: CHART_TOOLTIP,
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
  // uCharts 的 fixColumeData 会把 extra.column.width 乘上 dpr：固定 10 在 2x 屏是 20 物理
  // px，比 30 天窗口的格距（≈20）还宽，柱子完全贴死。改用 categoryGap 按格距比例留缝，
  // 柱宽 = 格距 − 2×categoryGap×dpr，14/30/60/90d 各窗口自适应。
  const slot = params.width / params.categories.length;
  const categoryGap = Math.min(3, Math.max(1, slot * 0.2));
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
      column: { type: 'group', categoryGap },
      tooltip: CHART_TOOLTIP,
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

/** Display only: consumes canonical integer seconds/km; never re-estimates speed. */
function calibrationPace(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isInteger(seconds) || seconds <= 0) return '—';
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface CalibrationMetricDisplay {
  value: string;
  range: string | null;
  evidenceDay: string | null;
  label: string;
  support: string;
  lines: string[];
  help: string[];
}

const CALIBRATION_WORDS: Record<string, string> = {
  high: '高', medium: '中', low: '低', none: '不足', unknown: '未知',
  protocol_quality_gate_passed: '通过协议质量门槛',
  confirmed_maximal: '已确认全力', probable_maximal: '可能全力', submaximal: '非全力',
  direct_hour_anchor: '约一小时直接锚点', direct_60min_maximal: '约一小时全力直接锚点', speed_duration_inference: '跨时长模型推断',
  constraints_only: '仅有约束，尚无中心估计', insufficient_maximal_support: '全力证据不足',
  lab_lthr_report_v1: '实验室乳酸阈值报告',
  field_test_protocol: '场地测试协议', field_30min_last20_v1: '场地测试协议（30分钟测试的后20分钟）', legacy_v3: '旧版训练估计', legacy_v3_training_estimate: '旧版训练估计（非独立检测）',
  no_independent_maximal_anchors: '缺少独立近全力证据',
  hour_extrapolation_not_identified_by_independent_recent_anchors: '近期独立锚点不足无法推断一小时能力',
  conflicting_root_activity_days_excluded: '已排除日期冲突的重复活动',
  binding_original_duration_constraints_model_inference: '原时长约束限制了模型推断',
  conflicting_evidence_robust_fit_low_support: '证据冲突，模型支持降低',
  root_HR_alias_conflict: '同一活动的心率证据存在冲突',
  independent_HR_protocols_disagree_over_6_bpm: '独立心率测试结果不一致',
  independent_HR_protocol_support: '存在独立心率协议支持',
  HR_abrupt_spike_or_recovery: '心率存在突变或恢复，协议未采用',
  HR_sustained_recovery_drop_over_10_bpm: '心率存在持续恢复下降，协议未采用',
  HR_range_suggests_recovery_or_artifact: '心率范围提示恢复或测量异常，协议未采用',
  stale_HR_support: '心率支持证据陈旧', stale_speed_support: '配速支持证据陈旧',
  stale_evidence: '支持证据陈旧', evidence_stale: '支持证据陈旧',
  no_independent_HR_protocol_support: '缺少独立心率测试协议支持',
  research_parameters_not_independently_calibrated: '研究参数尚未经过独立校准',
  HR_research_quality_parameters_uncalibrated: '心率研究参数尚未经过独立校准',
  environment_not_corrected: '未校正环境影响',
  range_is_sensitivity_not_95_percent_ci: '范围表示支持或敏感性，不是概率区间',
  power_law_valid_only_180_to_7200s: '跨时长模型仅适用其限定时长',
  long_duration_uses_monotone_envelope_not_precise_extrapolation: '长时长证据仅提供单调约束',
  endurance_exponent_unidentified_research_midpoint: '耐力参数尚未被充分识别',
  field_proxy_is_not_physiological_LTHR: '场地代理不等于生理乳酸阈值',
  missing_cadence_cannot_exclude_cadence_lock: '缺少步频，无法排除心率与步频锁定',
  // 演进 v4（#993）估计方法与原因，与 Web/iOS 共用同一组大白话文案。
  robust_map_effort_margin_fit: '普通训练模型推断',
  aged_prior_only: '研究先验（随时间老化）', aged_prior_only_HR: '研究先验（随时间老化）',
  measured_reference_median: '实测参考中位数（已核验协议）',
  joint_map_hr_dynamic_fit: '配速与心率联合模型推断',
  prior_predict_only: '先验预测（窗口内无新增可比证据）',
  unavailable: '无法估计',
  no_valid_running_input: '窗口内没有有效跑步输入',
  no_HR_series_or_qualified_physiological_prior: '没有心率序列，也没有可用的静息心率先验',
  inputs_physically_invalid: '输入超出物理合理范围',
  current_window_empty_prior_only_aged: '当前窗口无新证据，仅按先验老化更新',
  identifiability_limited_prior_dominated: '证据不足以区分能力与余量，先验主导',
  single_activity_no_duration_diversity: '仅一次活动且时长单一，可辨识性不足',
  supporting_evidence_older_than_staleness_window: '支持证据已超过陈旧窗口',
  optical_HR_downweighted_not_excluded: '光电腕式心率已降权使用（未排除）',
  prior_only_HR_estimate: '心率估计仅来自生理先验',
  HR_series_all_excluded_quality_gates: '心率序列全部被质量门槛排除',
  all_admitted_rows_rejected_measurement_quality: '全部输入被测量质量门槛拒绝',
  solver_numerical_failure: '求解器数值失败，未能输出估计',
  prior_share_at_least_half_effective_curvature: '先验影响占比过半，估计以先验为主',
  no_new_comparable_evidence_capability_predict_only: '无新增可比证据，仅做先验预测',
  speed_basis_absent_v60_prior_only: '缺少配速基准，仅用一小时能力先验',
  capability_day_effects_separated_from_trend: '能力日效应与趋势已分开处理',
  model_prediction_not_lab_LTHR: '模型预测不等于实验室乳酸阈值',
  hr_shape_knots_monotone_constraint_required: '心率形状受单调约束',
  cadence_lock_suspected_series_excluded: '疑似步频锁定的序列已被排除',
  terrain_gradient_not_corrected: '未校正坡度影响',
  long_duration_uses_monotone_soft_constraint: '长时长证据仅作单调软约束',
  k_grid_coarsened_large_input: '大输入量下网格已粗化',
  HR_tau_grid_coarsened_large_input: '大输入量下心率动态网格已粗化',
};

/** 五态大白话（#1000）。缺全力测试不要求先测试；先验不写成用户实测。 */
const CALIBRATION_STATES: Record<string, string> = {
  measured_reference: '实测参考',
  model_estimated: '模型估计 · 基于你的普通训练估计',
  prior_dominated: '先验主导 · 基于研究先验估计',
  stale: '已过期 · 保留历史估计',
  unavailable: '暂无估计',
};

function unavailableStateLabel(reasons: string[] | null | undefined, kind: 'speed' | 'hr'): string {
  const codes = reasons ?? [];
  if (codes.includes('no_valid_running_input')) return '暂无估计 · 窗口内没有有效跑步输入';
  if (codes.includes('no_HR_series_or_qualified_physiological_prior')) return '暂无估计 · 没有心率序列，也没有可用的静息心率先验';
  if (codes.includes('inputs_physically_invalid')) return '暂无估计 · 输入超出物理合理范围';
  if (codes.includes('solver_numerical_failure')) return '暂无估计 · 求解器数值失败，未能输出估计';
  if (kind === 'hr' && codes.includes('HR_series_all_excluded_quality_gates')) return '暂无估计 · 心率序列全部被质量门槛排除';
  return '暂无估计 · 未能形成有效估计';
}

const calibrationWord = (value: string | undefined, fallback = '未知') =>
  value ? (CALIBRATION_WORDS[value] ?? fallback) : fallback;
const validDay = (value: string | undefined): string | null =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
const positive = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value) && value > 0;

export function projectCalibration(zones: import('../types/health').StrideZonesResponse | null): {
  pace: CalibrationMetricDisplay; hr: CalibrationMetricDisplay;
  cutoffDay: string | null; computedShanghai: string | null;
} {
  const threshold = zones?.threshold;
  const source = threshold?.source ?? zones?.source;
  const range = threshold?.speed_range_pace_per_km_sec;
  let paceRange: string | null = null;
  if (range?.bound_kind === 'two_sided' && positive(range.fast) && positive(range.slow)) {
    paceRange = `支持范围 ${calibrationPace(range.fast)}–${calibrationPace(range.slow)} /km`;
  } else if (range?.bound_kind === 'speed_lower_bound' && positive(range.slow)) {
    const pace = calibrationPace(range.slow);
    paceRange = `至少可达到 ${pace} /km（配速 ≤ ${pace}）`;
  } else if (range?.bound_kind === 'speed_upper_bound' && positive(range.fast)) {
    paceRange = `配速 ≥ ${calibrationPace(range.fast)} /km（仅单侧约束）`;
  }
  const cutoffDay = validDay(source?.data_cutoff_day) ?? validDay(threshold?.as_of_date);
  const epoch = threshold?.computed_at ? Date.parse(threshold.computed_at) : NaN;
  const computedShanghai = Number.isFinite(epoch)
    ? `${epochToShanghaiYmd(epoch)} ${fmtShanghaiMdHm(threshold?.computed_at).slice(6)}` : null;
  const selection = threshold?.selection ?? zones?.selection;
  function metric(kind: 'speed' | 'hr'): CalibrationMetricDisplay {
    const knownSource = source?.schema_version === 1 && source?.state === 'available';
    const detail = knownSource ? source[kind] : undefined;
    const available = knownSource && !!detail;
    const value = kind === 'speed' ? calibrationPace(threshold?.pace_per_km_sec)
      : positive(threshold?.hr_bpm) ? String(Math.round(threshold.hr_bpm)) : '—';
    const evidenceDay = available ? validDay(detail?.evidence_date) : null;
    let support = available ? `模型支持：${calibrationWord(detail?.support, '未知（保守参考）')}`
      : knownSource ? (kind === 'hr' ? '心率证据信息未提供' : '配速证据信息未提供')
      : source && source.state !== 'legacy_source_missing' ? '来源信息不可用 · 保守参考'
      : threshold ? '旧版估计 · 来源信息不可用' : '暂无校准数据';
    // 五态（#993）：带状态的行以状态行开头；未知状态保守降级不借标签。
    if (available && detail?.state) {
      support = detail.state === 'unavailable'
        ? unavailableStateLabel(detail.reasons, kind)
        : CALIBRATION_STATES[detail.state] ?? '来源信息不可用 · 保守参考';
    }
    const lines = [support];
    const help = [kind === 'speed'
      ? '阈值配速表示约一小时全力跑步能力的估计，不是普通训练平均配速。'
      : '心率与配速证据可能有关联，不代表独立交叉验证。',
      '数据质量描述测量可靠性；全力证据与模型支持描述能力估计的依据。高质量训练数据不等于高支持。',
      '支持范围或敏感性范围不是统计置信区间，不表示精确生理边界。'];
    if (available && detail) {
      if (detail.method === 'legacy_v3_training_estimate' || detail.method === 'legacy_v3') lines.push('旧版训练估计，非独立检测或实验室参考');
      lines.push(`数据质量：${calibrationWord(detail.measurement_quality)} · 全力证据：${calibrationWord(detail.effort_support)}`);
      help.push(`方法：${calibrationWord(detail.method, '未知方法（保守参考）')}`);
      if (kind === 'hr') {
        const target = detail.target_type;
        const targetLabel = target === 'field_HR_proxy_not_physiological_LTHR'
          ? '现场心率代理，不等于生理乳酸阈值'
          : target === 'model_HRsteady_at_v60_declared_reference_conditions' ? '模型推算稳态心率（参考条件下的一小时能力配速，非生理乳酸阈值）'
          : target === 'lab_method_specific_LTHR' ? `实验室方法特定阈值：${detail.lab_method ?? '方法未提供'}`
          : target === 'unavailable' ? '暂无可用心率参考' : '训练心率估计，非独立实验室参考';
        lines.push(targetLabel);
        if (detail.method === 'joint_map_hr_dynamic_fit') lines.push('联合估计，非独立验证');
      }
      const reasons = [...(detail.reasons ?? []), ...(detail.limitations ?? [])];
      for (const reason of reasons) {
        const text = calibrationWord(reason, '服务端报告其他限制，当前估计需保守参考');
        if (!lines.includes(text)) lines.push(text);
      }
      if (detail.rejected_reasons?.length) {
        lines.push('未采用历史协议（不参与当前估计）');
        for (const reason of detail.rejected_reasons) {
          const text = reason.toLowerCase().includes('stale') ? '协议证据已过期'
            : reason.startsWith('HR_') && CALIBRATION_WORDS[reason] ? CALIBRATION_WORDS[reason].replace('，协议未采用', '') : '其他历史协议未采用原因';
          const line = `未采用协议：${text}`;
          if (!lines.includes(line)) lines.push(line);
        }
      }
      help.push(`独立支持：${detail.independent_activities ?? 0} 次活动 / ${detail.independent_days ?? 0} 天`);
      for (const evidence of (detail.evidence ?? []).slice(0, 3)) {
        const span = positive(evidence.start_s) && positive(evidence.end_s)
          ? ` · 片段 ${formatDurationHuman(evidence.start_s)}–${formatDurationHuman(evidence.end_s)}` : '';
        help.push(`来源 ${validDay(evidence.activity_day) ?? '日期未知'}${positive(evidence.duration_s) ? ` · ${formatDurationHuman(evidence.duration_s)}` : ''}${span}`);
      }
      // The summary carries no verified activity access URL; never invent a link from an ID.
      help.push('来源活动不可查看；此处仅保留安全摘要。');
    } else if (knownSource) {
      lines.push('当前快照未提供该指标证据，无法解释其来源');
    } else if (source && source.state !== 'legacy_source_missing') {
      lines.push('来源说明暂不可用，保留已有值供参考');
    } else if (threshold) {
      lines.push('旧版支持标签不代表新的全力证据');
    } else {
      lines.push('缺少可用快照，无法估计');
    }
    if (value === '—' && threshold) lines.push('暂无中心估计，保留已知约束与可用区间');
    if (evidenceDay) lines.push(`证据日期 ${evidenceDay}`);
    const rejectedDay = validDay(detail?.latest_rejected_evidence_date);
    const staleDay = validDay(detail?.latest_stale_evidence_date);
    if (staleDay) lines.push(`最近陈旧协议日 ${staleDay}`);
    if (rejectedDay && rejectedDay !== staleDay) lines.push(`最近未采用证据日 ${rejectedDay}`);
    if (cutoffDay) help.push(`数据截止 ${cutoffDay}`);
    if (computedShanghai) help.push(`校准执行 ${computedShanghai}（上海时间）`);
    // 当前有效算法（#999/#1000）：只描述本人当前读到的版本，已部署不等于所有人已启用。
    const effectiveVersion = selection?.effective_version ?? threshold?.algorithm_version;
    if (effectiveVersion != null) {
      const revision = source?.algorithm_revision;
      help.push(`当前有效算法 v${effectiveVersion}${revision ? ` · 修订 ${revision}` : ''}`);
    }
    const overrideMissing = selection?.reason === 'override_snapshot_missing';
    if (selection?.override) {
      const identity = `v${selection.override.algorithm_version}${selection.override.algorithm_revision ? `（修订 ${selection.override.algorithm_revision}）` : ''}`;
      help.push(overrideMissing ? `你的选择：${identity}` : `已按你的选择使用 ${identity}`);
    }
    if (overrideMissing) help.push('你选择的版本在该日期无快照，暂用全局有效版本');
    else if (selection?.state === 'fallback') help.push('首选版本缺少快照，使用服务端回退版本');
    const low = detail?.range_low;
    const high = detail?.range_high;
    const hrRange = available && positive(low) && positive(high)
      ? `支持范围 ${Math.round(low)}–${Math.round(high)} bpm`
      : available && positive(low) ? `心率 ≥ ${Math.round(low)} bpm（仅单侧约束）`
      : available && positive(high) ? `心率 ≤ ${Math.round(high)} bpm（仅单侧约束）` : null;
    return { value, range: kind === 'speed' ? paceRange : hrRange, evidenceDay,
      label: kind === 'hr' && detail?.target_type === 'field_HR_proxy_not_physiological_LTHR' ? '现场心率参考' : kind === 'hr' ? '阈值心率' : '阈值配速', support, lines, help };
  }
  return { pace: metric('speed'), hr: metric('hr'), cutoffDay, computedShanghai };
}

export function projectTrainingZones(z: import('../types/health').StrideZonesResponse | null): { paceZones: Array<{name: string; label: string; range: string}>; hrZones: Array<{name: string; label: string; range: string}>; hasZones: boolean } {
  const hasZones = (z?.pace_zones.length ?? 0) > 0 || (z?.hr_zones.length ?? 0) > 0;
  const fmtPaceRange = (upper: string | null, lower: string | null): string => {
    if (upper && lower) return `${upper} – ${lower}`;
    if (upper) return `≥ ${upper}`;
    if (lower) return `≤ ${lower}`;
    return '—';
  };
  const paceZones: Array<{name: string; label: string; range: string}> = (z?.pace_zones ?? []).map((p) => ({
    name: p.name,
    label: p.label,
    range: fmtPaceRange(p.upper_pace, p.lower_pace),
  }));
  const hrZones: Array<{name: string; label: string; range: string}> = (z?.hr_zones ?? []).map((h) => {
    const lo = h.lower_bpm;
    const hi = h.upper_bpm;
    let range = '—';
    if (lo != null && hi != null) range = `${lo} – ${hi}`;
    else if (lo != null) range = `≥ ${lo}`;
    else if (hi != null) range = `≤ ${hi}`;
    return { name: h.name, label: h.label, range };
  });
  return { paceZones, hrZones, hasZones };
}
