import { readFileSync } from 'node:fs';
import { projectCalibration, projectTrainingZones } from './trainingStatus.ts';
import type { StrideZonesResponse } from '../types/health';
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
  buildThresholdPaceTrend,
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

// 柱间距自适应：uCharts 会把固定 width 乘 dpr 致柱子贴满格距，这里断言 categoryGap 随窗口缩放
const columnGap = (categories: number, width: number): number => {
  const opts = buildColumnChartOptions({
    categories: Array.from({ length: categories }, (_, i) => String(i)),
    data: Array.from({ length: categories }, () => 1),
    color: '#e68a00',
    bounds: { min: 0, max: 2 },
    width,
    height: 140,
    dpr: 2,
  });
  return (opts.extra as { column: { categoryGap: number } }).column.categoryGap;
};
eq(columnGap(2, 300), 3, 'categoryGap caps at 3 for sparse columns');
eq(columnGap(30, 300), 2, 'categoryGap proportional to slot at 30d');
eq(columnGap(90, 300), 1, 'categoryGap floors at 1 for dense 90d columns');
eq((colOpts.extra as { column: { width?: unknown } }).column.width, undefined, 'no fixed width to override the adaptive gap');



const paceTrend = buildThresholdPaceTrend([
  { as_of_date: '2026-10-30', pace_per_km_sec: 260, hr_bpm: 160 },
  { as_of_date: '2026-10-31', pace_per_km_sec: 250, hr_bpm: 161 },
  { as_of_date: '2026-11-02', pace_per_km_sec: null, hr_bpm: 164 },
  { as_of_date: '2026-11-03', pace_per_km_sec: 240, hr_bpm: 166 },
], 4, '2026-11-03');
eq(JSON.stringify(paceTrend.categories), '["10/31","11/1","11/2","11/3"]', 'trend uses Shanghai calendar days');
eq(JSON.stringify(paceTrend.series), '[-250,null,null,-240]', 'trend leaves missing estimates empty with faster pace higher');

// Public presentation seam: the same API response and independent expected literals as Web/iOS.
const displayVectors = JSON.parse(readFileSync(new URL('../../../docs/calibration/fixtures/client-display-v1.json', import.meta.url), 'utf8'));
const firstVector = displayVectors.cases[0];
const firstDisplay = projectCalibration(firstVector.response as StrideZonesResponse);
eq(firstDisplay.pace.value, firstVector.expected.pace, 'shared two-sided center');
eq(firstDisplay.pace.range, firstVector.expected.pace_range, 'shared fast-to-slow range');
eq(firstDisplay.hr.subtitle, '', 'field reference omits the threshold subtitle');
for (const vector of displayVectors.cases) {
  const display = projectCalibration(vector.response as StrideZonesResponse);
  eq(display.pace.value, vector.expected.pace, `${vector.name} center`);
  eq(display.pace.range, vector.expected.pace_range, `${vector.name} directional range`);
  eq(display.hr.value, vector.expected.hr, `${vector.name} HR`);
  if (vector.expected.rejected_evidence_day) {
    const staleDay = vector.expected.stale_evidence_day;
    if (staleDay) eq(display.hr.lines.includes(`最近陈旧协议日 ${staleDay}`), true, `${vector.name} stale date`);
    eq(display.hr.lines.includes(`最近未采用证据日 ${vector.expected.rejected_evidence_day}`), vector.expected.rejected_evidence_day !== staleDay, `${vector.name} distinct rejected date without duplication`);
    if (vector.name === 'producer-stale-hr-mixed' || vector.name.endsWith('-quality')) eq(display.hr.lines.includes('未采用协议：心率存在突变或恢复'), true, 'historical quality rejection explained');
    eq(display.hr.lines.includes('未采用历史协议（不参与当前估计）'), true, `${vector.name} explicit historical scope`);
    if (staleDay) eq(display.hr.lines.includes('未采用协议：协议证据已过期'), true, `${vector.name} historical stale reason`);
    eq(display.hr.lines.includes('心率支持证据陈旧'), false, `${vector.name} current support not mislabeled stale`);
    eq(display.hr.support, vector.expected.current_hr_supported ? '模型支持：低' : '模型支持：不足', `${vector.name} current support unchanged`);
    if (vector.expected.current_hr_supported) eq(display.hr.evidenceDay, vector.expected.hr_evidence_day, `${vector.name} selected evidence unchanged`);
  }
  if (vector.expected.source_unavailable) {
    eq(display.pace.support, '来源信息不可用 · 保守参考', `${vector.name} conservative support`);
    eq(display.hr.support, '来源信息不可用 · 保守参考', `${vector.name} conservative HR support`);
    eq(display.pace.lines.some(line => line.includes('已确认全力')), false, `${vector.name} no borrowed effort`);
  }
  if (vector.expected.hr_range != null) eq(display.hr.range, vector.expected.hr_range, `${vector.name} canonical HR range`);
  if (vector.expected.hr_method_label != null) eq(display.hr.help.includes(`方法：${vector.expected.hr_method_label}`), true, `${vector.name} canonical HR method`);
  if (vector.expected.speed_effort_label != null) eq(display.pace.lines.some((line) => line.includes(`全力证据：${vector.expected.speed_effort_label}`)), true, `${vector.name} canonical effort support`);
  if (vector.expected.lab_method != null) eq(display.hr.lines.includes(`实验室方法特定阈值：${vector.expected.lab_method}`), true, `${vector.name} original lab method`);
  eq(display.pace.evidenceDay, vector.expected.evidence_day, `${vector.name} evidence day`);
  eq(display.cutoffDay, vector.expected.cutoff_day, `${vector.name} cutoff day`);
  eq(display.computedShanghai, vector.expected.computed_shanghai, `${vector.name} execution instant`);
}
const weakDisplay = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'low-stale').response);
eq(weakDisplay.pace.support, '模型支持：低', 'quality high never upgrades low support');
eq(weakDisplay.hr.lines.includes('心率支持证据陈旧'), true, 'stale reason remains visible');
eq(firstDisplay.hr.label, '现场心率参考', 'field proxy is not physiological LTHR');
eq(firstDisplay.pace.help.includes('来源活动不可查看；此处仅保留安全摘要。'), true, 'unverified source stays summary only');
eq(projectCalibration(null).pace.value, '—', 'unavailable never becomes zero');
eq(firstDisplay.hr.range, '支持范围 163–169 bpm', 'HR support range');
const unavailableDisplay = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'source-unavailable').response);
eq(unavailableDisplay.pace.support, '来源信息不可用 · 保守参考', 'broken source is not mislabeled legacy');
const paceOnlyZones = projectTrainingZones({ threshold: null, pace_zones: [{name:'Z1',label:'轻松',upper_pace:'4:10',lower_pace:'5:00'}], hr_zones:[] });
eq(paceOnlyZones.hasZones, true, 'pace zones remain available without HR or center');
eq(paceOnlyZones.paceZones[0].range, '4:10 – 5:00', 'zones retain server fast-to-slow order');
eq(projectTrainingZones({threshold:null,pace_zones:[],hr_zones:[{name:'Z1',label:'轻松',lower_bpm:null,upper_bpm:140}]}).hasZones, true, 'HR zones remain available alone');
const canonicalLegacy = structuredClone(firstVector.response);
canonicalLegacy.threshold.source.speed.method = 'legacy_v3_training_estimate';
eq(projectCalibration(canonicalLegacy).pace.lines.includes('旧版训练估计，非独立检测或实验室参考'), true, 'available legacy source remains honest');
const canonicalHour = structuredClone(firstVector.response);
canonicalHour.threshold.source.speed.method = 'direct_60min_maximal';
eq(projectCalibration(canonicalHour).pace.help.includes('方法：约一小时全力直接锚点'), true, 'canonical direct hour method');


const speedOnlySource = structuredClone(firstVector.response);
delete speedOnlySource.threshold.source.hr;
eq(projectCalibration(speedOnlySource).hr.support, '心率证据信息未提供', 'current speed-only source is not legacy');
const unavailableHrTarget = structuredClone(firstVector.response);
unavailableHrTarget.threshold.hr_bpm = null;
unavailableHrTarget.threshold.source.hr.target_type = 'unavailable';
eq(projectCalibration(unavailableHrTarget).hr.lines.includes('暂无可用心率参考'), true, 'unavailable HR is not an existing estimate');

const protocolQuality = structuredClone(firstVector.response);
protocolQuality.threshold.source.hr.measurement_quality = 'protocol_quality_gate_passed';
protocolQuality.threshold.source.hr.support = 'low';
const protocolQualityDisplay = projectCalibration(protocolQuality).hr;
eq(protocolQualityDisplay.lines.includes('数据质量：通过协议质量门槛 · 全力证据：已确认全力'), true, 'canonical protocol quality retains its own meaning');
eq(protocolQualityDisplay.support, '模型支持：低', 'protocol quality gate never upgrades model support');

const missingAnchors = structuredClone(firstVector.response);
missingAnchors.threshold.source.speed.reasons = ['no_independent_maximal_anchors'];
eq(projectCalibration(missingAnchors).pace.lines.includes('缺少独立近全力证据'), true, 'canonical missing independent anchors reason');
missingAnchors.threshold.source.speed.reasons = ['hour_extrapolation_not_identified_by_independent_recent_anchors'];
eq(projectCalibration(missingAnchors).pace.lines.includes('近期独立锚点不足无法推断一小时能力'), true, 'canonical insufficient recent anchors reason');

const probableEffort = structuredClone(firstVector.response);
probableEffort.threshold.source.speed.effort_support = 'probable_maximal';
eq(projectCalibration(probableEffort).pace.lines.includes('数据质量：高 · 全力证据：可能全力'), true, 'canonical probable maximal effort is not unknown');

const fieldProtocol = structuredClone(firstVector.response);
fieldProtocol.threshold.source.hr.method = 'field_30min_last20_v1';
eq(projectCalibration(fieldProtocol).hr.help.includes('方法：场地测试协议（30分钟测试的后20分钟）'), true, 'canonical field protocol explains the actual window');

const labProtocol = structuredClone(firstVector.response);
labProtocol.threshold.source.hr.method = 'lab_lthr_report_v1';
labProtocol.threshold.source.hr.target_type = 'lab_method_specific_LTHR';
labProtocol.threshold.source.hr.lab_method = 'LT2_4mmol_protocol';
const labProtocolDisplay = projectCalibration(labProtocol).hr;
eq(labProtocolDisplay.help.includes('方法：实验室乳酸阈值报告'), true, 'canonical laboratory report protocol');
eq(labProtocolDisplay.lines.includes('实验室方法特定阈值：LT2_4mmol_protocol'), true, 'laboratory method is preserved');

const halfIntegerHr = structuredClone(firstVector.response);
halfIntegerHr.threshold.hr_bpm = 166.5;
halfIntegerHr.threshold.source.hr.range_low = 163.5;
halfIntegerHr.threshold.source.hr.range_high = 169.5;
const halfIntegerHrDisplay = projectCalibration(halfIntegerHr).hr;
eq(halfIntegerHrDisplay.value, '167', 'positive HR half integer rounds upward');
eq(halfIntegerHrDisplay.range, '支持范围 164–170 bpm', 'positive HR range halves round upward');

const unsupportedEffortAlias = structuredClone(firstVector.response);
unsupportedEffortAlias.threshold.source.speed.effort_support = 'likely_maximal';
eq(projectCalibration(unsupportedEffortAlias).pace.lines.includes('数据质量：高 · 全力证据：未知'), true, 'unsupported effort alias remains unknown');

// ── T6 (#1000): evolved-v4 five states, override disclosure, revision marker ──
for (const vector of displayVectors.cases) {
  const display = projectCalibration(vector.response as StrideZonesResponse);
  const exp = vector.expected as Record<string, string | null | undefined>;
  if (exp.pace_state !== undefined) eq(display.pace.support, exp.pace_state, `${vector.name} shared pace state label`);
  if (exp.hr_state !== undefined) eq(display.hr.support, exp.hr_state, `${vector.name} shared HR state label`);
  if (exp.pace_algorithm_label !== undefined) {
    eq(display.pace.help.includes(exp.pace_algorithm_label as string), true, `${vector.name} shared algorithm label`);
    eq(display.hr.help.includes(exp.pace_algorithm_label as string), true, `${vector.name} shared HR algorithm label`);
  }
  if (exp.override_label !== undefined) {
    eq(display.pace.help.includes(exp.override_label as string), true, `${vector.name} override pin disclosed`);
    eq(display.hr.help.includes(exp.override_label as string), true, `${vector.name} override pin disclosed (HR)`);
  }
  if (exp.override_fallback_label !== undefined) {
    eq(display.pace.help.includes(exp.override_fallback_label as string), true, `${vector.name} override fallback reason`);
    eq(display.pace.help.join(' ').includes('已按你的选择使用'), false, `${vector.name} fallback never claims the pin is served`);
  }
  if (exp.hr_joint_label !== undefined) eq(display.hr.lines.includes(exp.hr_joint_label as string), true, `${vector.name} joint HR marker`);
  if (exp.hr_proxy_label !== undefined) eq(display.hr.lines.includes(exp.hr_proxy_label as string), true, `${vector.name} shared field-proxy wording`);
  if (exp.hr_model_target_label !== undefined) eq(display.hr.lines.includes(exp.hr_model_target_label as string), true, `${vector.name} shared model-target wording`);
  if (exp.hr_reference_target_label !== undefined) {
    eq(display.hr.lines.includes(exp.hr_reference_target_label as string), true, `${vector.name} reference-target wording`);
    eq(display.hr.lines.join(' ').includes('模型推算稳态心率'), false, `${vector.name} reference never labeled as model prediction`);
  }
  // P2-1：同一 categorical 原因可能由速度拟合与联合重解分别计入，文案只渲染一次；
  // 「来源 …」是证据事实列表（同日多段可合法重复），不参与查重。
  for (const all of [display.pace.lines, display.hr.lines, display.pace.help, display.hr.help]) {
    const kept = all.filter((line: string) => !line.startsWith('来源 '));
    eq(new Set(kept).size === kept.length, true, `${vector.name} no duplicate reason/detail lines`);
  }
}

const lowEvidence = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'evolved-low-evidence').response);
eq(lowEvidence.pace.support, '模型估计 · 基于你的普通训练估计', 'low-evidence pace state');
eq(lowEvidence.hr.support, '先验主导 · 基于研究先验估计', 'low-evidence HR state (v4 rev3 regression branch)');
eq(lowEvidence.pace.value, '4:49', 'low-evidence center');
eq(lowEvidence.pace.range, '支持范围 4:15–5:03 /km', 'low-evidence pace range');
eq(lowEvidence.hr.value, '162', 'low-evidence HR center');
eq(lowEvidence.hr.range, '支持范围 156–168 bpm', 'low-evidence HR range');
eq(lowEvidence.hr.lines.some((line) => line.includes('对数速度回归')), true, 'regression method in plain words');
eq(lowEvidence.hr.lines.includes('模型推算稳态心率（参考条件下的一小时能力配速，不是生理乳酸阈值实测）'), true, 'model-predicted steady HR target line');
eq([...lowEvidence.pace.lines, ...lowEvidence.pace.help].join('').includes('必须先测试'), false, 'never demand a test first');
eq(lowEvidence.pace.range?.includes('95%'), false, 'range never claims 95%');

const priorOnly = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'evolved-prior-only').response);
eq(priorOnly.pace.support, '先验主导 · 基于研究先验估计', 'prior-only pace state');
eq(priorOnly.hr.support, '暂无估计 · 没有心率序列，也没有可用的静息心率先验', 'prior-only HR state (no M source)');
eq(priorOnly.pace.lines.some((line) => line.includes('仅短时、低质量或单层证据')), true, 'identifiability reason in plain words');
eq(priorOnly.pace.value !== '—', true, 'prior-only still shows pace');
eq(priorOnly.hr.value, '—', 'prior-only HR stays empty without a source');

const measuredRef = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'evolved-measured-reference').response);
eq(measuredRef.pace.support, '模型估计 · 基于你的普通训练估计', 'verified reference informs the constrained fit');
eq(measuredRef.hr.support, '先验主导 · 基于研究先验估计', 'HR walks the regression branch');
eq(measuredRef.hr.lines.some((line) => line.includes('对数速度回归')), true, 'regression method in plain words');
eq(measuredRef.hr.lines.includes('联合估计，非独立验证'), false, 'reference is not a joint estimate');

const evolvedUnavailable = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'evolved-unavailable').response);
eq(evolvedUnavailable.pace.support, '暂无估计 · 窗口内没有有效跑步输入', 'unavailable pace with reason');
eq(evolvedUnavailable.hr.support, '暂无估计 · 没有心率序列，也没有可用的静息心率先验', 'unavailable HR with reason');
eq(evolvedUnavailable.pace.value, '—', 'unavailable pace stays empty');
eq(evolvedUnavailable.hr.value, '—', 'unavailable HR stays empty');
eq(evolvedUnavailable.pace.range, null, 'no invented pace range');

const historicalV4 = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'historical-v4').response);
eq(historicalV4.pace.support, '模型支持：高', 'historical v4 keeps legacy support wording');
eq(historicalV4.pace.help.includes('当前有效算法 v4'), true, 'historical v4 effective algorithm');
eq(historicalV4.pace.help.join(' ').includes('修订'), false, 'historical v4 has no revision marker');

const overrideSelected = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'override-selected').response);
eq(overrideSelected.pace.help.includes('已按你的选择使用 v4（修订 v4-rev3-2026-11）'), true, 'override pin wording');
eq(overrideSelected.pace.help.includes('当前有效算法 v4 · 修订 v4-rev3-2026-11'), true, 'effective algorithm with revision');
const overrideFallback = projectCalibration(displayVectors.cases.find((v: { name: string }) => v.name === 'override-fallback').response);
eq(overrideFallback.pace.help.includes('你选择的版本在该日期无快照，暂用全局有效版本'), true, 'override fallback wording');
eq(overrideFallback.pace.help.includes('当前有效算法 v3'), true, 'fallback serves global v3');

const futureState = structuredClone(firstVector.response);
futureState.threshold.source.speed.state = 'some_future_state';
const futureStateDisplay = projectCalibration(futureState).pace;
eq(futureStateDisplay.support, '来源信息不可用 · 保守参考', 'unknown state degrades conservatively');
eq(futureStateDisplay.value, '3:34', 'unknown state keeps the center');

console.log('trainingStatus.check: OK');
