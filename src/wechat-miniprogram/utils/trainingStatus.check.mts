/**
 * trainingStatus.ts 自检：`node utils/trainingStatus.check.mts`。
 * 只覆盖指标分类 / 图表配置 / 热力图 / 周剂量聚合，不依赖小程序运行时与 uCharts。
 */
import {
  aggregateWeeklyDose,
  buildColumnChartOptions,
  buildHeatCells,
  buildHeatWeeks,
  buildLineChartOptions,
  chineseSportName,
  classifyForm,
  formatDateShort,
  formatDurationHuman,
  heatmapBucket,
  isDistanceSport,
  loadStateLabel,
  padBounds,
  readinessColor,
  readinessGateLabel,
  readinessLabel,
} from './trainingStatus.ts';
import type { StrideTrainingLoadRecord } from '../types/health';

const row = (date: string, extra: Partial<StrideTrainingLoadRecord> = {}): StrideTrainingLoadRecord =>
  ({
    date,
    algorithm_version: 1,
    training_dose: null,
    acute_load: null,
    chronic_load: null,
    form: null,
    load_ratio: null,
    coverage_status: 'complete',
    readiness_gate: null,
    readiness_reasons: [],
    ...extra,
  }) as StrideTrainingLoadRecord;

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// —— Form zone：按当日 CTL 比例分类，数据不足归 null ——
eq(classifyForm(12, 60), 'race_ready', 'form +20% CTL → race_ready');
eq(classifyForm(0, 60), 'transition', 'form 0 → transition');
eq(classifyForm(-15, 60), 'productive', 'form −25% → productive');
eq(classifyForm(-30, 60), 'overload', 'form −50% → overload');
eq(classifyForm(20, 60), 'over_taper', 'form +33% → over_taper');
eq(classifyForm(null, 60), null, 'form null → null');
eq(classifyForm(5, null), null, 'chronic null → null');

// —— readiness gate：未知 gate 归中性灰，不渲染成 STOP ——
eq(readinessColor('green'), '#00a85a', 'green gate color');
eq(readinessColor(null), '#8888a0', 'null gate neutral');
eq(readinessColor('bogus'), '#8888a0', 'unknown gate neutral');
eq(readinessGateLabel('yellow'), '黄灯', 'yellow gate label');
eq(readinessLabel('red'), '建议停训恢复', 'red gate text');

// —— 负荷比状态分类 ——
eq(loadStateLabel(0.6), '恢复期', 'ratio 0.6 → 恢复期');
eq(loadStateLabel(0.9), '维持期', 'ratio 0.9 → 维持期');
eq(loadStateLabel(1.2), '提升期', 'ratio 1.2 → 提升期');
eq(loadStateLabel(1.5), '过度负荷', 'ratio 1.5 → 过度负荷');
eq(loadStateLabel(null), '—', 'ratio null → —');

// —— 剂量分桶 ——
eq([heatmapBucket(null), heatmapBucket(0), heatmapBucket(40), heatmapBucket(80), heatmapBucket(120), heatmapBucket(121)],
  [0, 0, 1, 2, 3, 4], 'heatmap buckets');

// —— 热力图：active / rest / absent / unknown / future + today 标记 ——
const heatSeries = [
  row('2026-09-08', { training_dose: 30 }), // active（bucket 1）
  row('2026-09-12', { training_dose: 0 }), // rest
  row('2026-09-09', { coverage_status: 'unknown' }), // unknown
];
const cells = buildHeatCells(heatSeries, 2, '2026-09-16');
const byDate = new Map(cells.map((c) => [c.date, c]));
eq(byDate.get('2026-09-08')?.state, 'active', 'dose day active');
eq(byDate.get('2026-09-08')?.tone, 'heatmap__cell--b1', 'dose 30 → bucket-1 tone');
eq(byDate.get('2026-09-12')?.state, 'rest', 'zero dose rest');
eq(byDate.get('2026-09-10')?.state, 'absent', 'missing record absent');
eq(byDate.get('2026-09-09')?.state, 'unknown', 'unknown coverage');
eq(byDate.get('2026-09-18')?.state, 'future', 'future day');
eq(byDate.get('2026-09-16')?.isToday, true, 'today marked');
eq(cells.length, 14, '2 weeks → 14 cells');
const weeks = buildHeatWeeks(cells);
eq(weeks.length, 2, '2 week columns');
// 跨月窗口：以 09-07（周一）为 today，2 周分别从 8 月 / 9 月开局
const monthCells = buildHeatCells([], 2, '2026-09-07');
const monthWeeks = buildHeatWeeks(monthCells);
eq(monthWeeks[1].month, '9月', 'month label appears on week whose Monday crosses month');

// —— 8 周周剂量聚合：固定 today（周一）保证确定性 ——
const weekly = aggregateWeeklyDose(
  [
    row('2026-09-14', { training_dose: 100 }),
    row('2026-09-15', { training_dose: 50 }),
    row('2026-08-31', { training_dose: 80 }),
    row('2026-09-07', { coverage_status: 'unknown' }),
    row('2026-06-01', { training_dose: 999 }), // 窗口外丢弃
  ],
  '2026-09-14',
);
eq(weekly.length, 8, 'always 8 buckets');
const last = weekly[weekly.length - 1];
eq(last.weekStart, '2026-09-14', 'last bucket starts current week Monday');
eq(last.totalDose, 150, 'same-week doses summed');
eq(last.activeDays, 2, 'active days counted');
const unknownWeek = weekly.find((b) => b.weekStart === '2026-09-07');
eq(unknownWeek?.totalDose, null, 'unknown week exposes null dose, not invented 0');

// —— 日期 / 运动名 / 时长 ——
eq(formatDateShort('2026-09-16'), '9/16', 'YYYY-MM-DD short');
eq(formatDateShort('20260916'), '9/16', 'YYYYMMDD short');
eq(chineseSportName('Indoor Run'), '跑步', 'run → 跑步');
eq(chineseSportName('Gym'), '力量训练', 'gym → 力量训练');
eq(isDistanceSport('Trail Run'), true, 'run is distance sport');
eq(isDistanceSport('Strength'), false, 'strength not distance sport');
eq(formatDurationHuman(6180), '1h43min', 'duration human');
eq(formatDurationHuman(2580), '43min', 'duration human < 1h');

// —— 坐标边界 / 图表配置 ——
eq(padBounds(50, 50, 2), { min: 48, max: 52 }, 'padBounds keeps height for flat series');
const lineOpts = buildLineChartOptions({
  categories: ['9/1', '9/2', '9/3'],
  series: [{ name: 'RHR', data: [50, 52, 51], color: '#0097a7' }],
  bounds: { min: 48, max: 54 },
  width: 300,
  height: 140,
  dpr: 2,
});
eq(lineOpts.type, 'line', 'line chart type');
eq(lineOpts.width, 600, 'width scaled by dpr');
eq(lineOpts.categories, ['9/1', '9/2', '9/3'], 'line categories');
const colOpts = buildColumnChartOptions({
  categories: ['9/1', '9/2'],
  data: [{ value: 10, color: '#00a85a' }, null],
  color: '#e68a00',
  bounds: { min: 0, max: 20 },
  width: 300,
  height: 140,
  dpr: 2,
});
eq(colOpts.type, 'column', 'column chart type');
eq((colOpts.series as Array<{ data: unknown }>)[0].data.length, 2, 'column keeps per-point data incl. null gap');

console.log('trainingStatus.check: OK');
