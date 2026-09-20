// 训练状态页 —— 镜像 Web 端 /training-status（Threshold · Zones · Training Load）。
//
// 数据来自 5 个 STRIDE 数据面接口（经 Go API）：
//   GET /api/{user}/health?days=90         健康 + HRV 快照 + RHR 基线
//   GET /api/{user}/hrv?days=90            逐日 HRV
//   GET /api/{user}/stride/zones           阈值 + 配速/心率区间
//   GET /api/{user}/stride/training-load   负荷 current + series（覆盖 16 周热力图）
//   GET /api/{user}/activities?date_from=  活动列表（热力图日详情用，分页拉全）
//
// 图表用内置 uCharts（vendor/ucharts）渲染，纯数据/配色逻辑在 utils/trainingStatus.ts。

import UCharts from '../../vendor/ucharts/u-charts.min';
import {
  classifyForm,
  formColor,
  FORM_ZONE_COLOR,
  FORM_ZONE_LABEL,
  chineseSportName,
  formatDateShort,
  formatDurationHuman,
  HEATMAP_COLORS,
  isDistanceSport,
  loadStateLabel,
  padBounds,
  readinessColor,
  readinessGateLabel,
  readinessLabel,
  aggregateWeeklyDose,
  buildHeatCells,
  buildHeatWeeks,
  buildLineChartOptions,
  buildColumnChartOptions,
  type ChartBounds,
  type ChartSeries,
  type ColumnDatum,
  type HeatCell,
} from '../../utils/trainingStatus';
import { fmtPace } from '../../utils/format';
import { epochToShanghaiYmd, shanghaiWeekdayLabel } from '../../utils/date';
import { getHealth, getHrv, getStrideTrainingLoad, getStrideZones } from '../../services/health';
import { getActivities } from '../../services/activities';
import { userStore } from '../../store/index';
import type {
  HealthResponse,
  HrvResponse,
  StrideTrainingLoadRecord,
  StrideTrainingLoadResponse,
  StrideZonesResponse,
} from '../../types/health';
import type { Activity } from '../../types/activity';

type Chart = InstanceType<typeof UCharts>;

interface MetricCard {
  label: string;
  sub: string;
  value: string;
  unit: string;
  baseline: string;
  color: string;
}

interface LoadStat {
  label: string;
  value: string;
  color: string;
}

interface ZoneRow {
  name: string;
  label: string;
  range: string;
}

interface HeatDayDetail {
  date: string;
  title: string;
  dose: string;
  lines: string[];
}

interface TrendOption {
  value: number;
  label: string;
  active: boolean;
}

interface ChartTooltipSpec {
  tooltip(value: number, time: string, seriesName?: string): string;
}

interface TrainingStatusPageData {
  statusBarHeight: number;
  contentPaddingTop: number;
  loading: boolean;
  error: string;
  metrics: MetricCard[];
  loadStats: LoadStat[];
  readinessLabel: string;
  readinessColor: string;
  readinessBg: string;
  readinessReasons: string;
  hasLoad: boolean;
  hasZones: boolean;
  paceZones: ZoneRow[];
  hrZones: ZoneRow[];
  trendWindow: number;
  trendOptions: TrendOption[];
  hasRhrChart: boolean;
  hasHrvChart: boolean;
  hasDoseChart: boolean;
  hasLoadChart: boolean;
  hasFormChart: boolean;
  hasWeekChart: boolean;
  heatWeeks: Array<{ weekIdx: number; month: string; cells: HeatCell[] }>;
  heatColors: string[];
  heatSelected: HeatDayDetail | null;
  formLegend: Array<{ color: string; label: string }>;
  currentCtlNote: string;
  calibrationLine: string;
  loadDateLine: string;
}

interface TrainingStatusPageHandlers {
  onBack(): void;
  onWindowChange(e: WechatMiniprogram.TouchEvent): void;
  onHeatTap(e: WechatMiniprogram.TouchEvent): void;
  onRhrTouch(e: WechatMiniprogram.TouchEvent): void;
  onHrvTouch(e: WechatMiniprogram.TouchEvent): void;
  onDoseTouch(e: WechatMiniprogram.TouchEvent): void;
  onLoadTouch(e: WechatMiniprogram.TouchEvent): void;
  onFormTouch(e: WechatMiniprogram.TouchEvent): void;
  onWeekTouch(e: WechatMiniprogram.TouchEvent): void;
  fetch(): Promise<void>;
  fetchAllActivities(): Promise<Activity[]>;
  render(): void;
  drawCharts(): void;
}

// —— 模块级原始数据（页面只读，渲染时聚合成 view model；与 health 页同模式）——

let healthData: HealthResponse | null = null;
let hrvData: HrvResponse | null = null;
let zonesData: StrideZonesResponse | null = null;
let loadData: StrideTrainingLoadResponse | null = null;
let activitiesByDate = new Map<string, Activity[]>();
let userId = '';
let loaded = false;
let trendDays = 30;

// —— uCharts 实例与工具提示 spec（canvas 重建时同步替换）——

let rhrChart: Chart | null = null;
let hrvChart: Chart | null = null;
let doseChart: Chart | null = null;
let loadChart: Chart | null = null;
let formChart: Chart | null = null;
let weekChart: Chart | null = null;

let rhrSpec: ChartTooltipSpec | null = null;
let hrvSpec: ChartTooltipSpec | null = null;
let doseSpec: ChartTooltipSpec | null = null;
let formSpec: ChartTooltipSpec | null = null;
let weekSpec: ChartTooltipSpec | null = null;

let formRows: Array<{ label: string; form: number | null; chronic: number | null }> = [];
let weekRows: Array<{ label: string; totalDose: number | null; activeDays: number }> = [];

// ---------------------------------------------------------------------------
// 平台辅助
// ---------------------------------------------------------------------------

function statusBarHeight(): number {
  try {
    return wx.getWindowInfo().statusBarHeight || 0;
  } catch {
    return wx.getSystemInfoSync().statusBarHeight || 0;
  }
}

function contentPaddingTopRpx(): number {
  let statusPx = statusBarHeight();
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

function pixelRatio(): number {
  try {
    return wx.getWindowInfo().pixelRatio || 2;
  } catch {
    return 2;
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 兼容 health 接口 YYYYMMDD / YYYY-MM-DD 两种日期形态。 */
function normalizeYmd(date: string): string {
  return date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
}

function countNonNull(values: ReadonlyArray<number | null>): number {
  let n = 0;
  for (const v of values) if (v != null) n += 1;
  return n;
}

/** uCharts 工具提示 item.data：逐点配色柱状图（Form）的 data 可能是 `{value, color}` 对象。 */
function itemNumber(item: { data: unknown }): number {
  const d = item.data;
  if (typeof d === 'number') return d;
  if (d && typeof d === 'object') {
    const v = (d as { value?: number }).value;
    return typeof v === 'number' ? v : Number.NaN;
  }
  return Number.NaN;
}

// ---------------------------------------------------------------------------
// 趋势数据准备（按窗口天数切片）
// ---------------------------------------------------------------------------

function rhrTrend(days: number): { categories: string[]; series: number[]; bounds: ChartBounds } {
  const base = healthData?.rhr_baseline ?? null;
  const rows = (healthData?.health ?? [])
    .slice()
    .reverse()
    .filter((r) => r.rhr != null)
    .slice(-days);
  const series = rows.map((r) => r.rhr as number);
  const categories = rows.map((r) => formatDateShort(normalizeYmd(r.date)));
  let min = series.length ? Math.min(...series) : 0;
  let max = series.length ? Math.max(...series) : 0;
  if (base != null) {
    min = Math.min(min, base);
    max = Math.max(max, base);
  }
  return { categories, series, bounds: padBounds(min, max, 2) };
}

function hrvTrend(days: number): { categories: string[]; series: number[]; bounds: ChartBounds } {
  const low = healthData?.hrv?.hrv_normal_low ?? null;
  const high = healthData?.hrv?.hrv_normal_high ?? null;
  const rows = (hrvData?.hrv ?? [])
    .slice()
    .filter((r) => r.last_night_avg != null)
    .slice(-days);
  const series = rows.map((r) => r.last_night_avg as number);
  const categories = rows.map((r) => formatDateShort(r.date));
  let min = series.length ? Math.min(...series) : 0;
  let max = series.length ? Math.max(...series) : 0;
  if (low != null) min = Math.min(min, low);
  if (high != null) max = Math.max(max, high);
  return { categories, series, bounds: padBounds(min, max, 5) };
}

function dailyDose(days: number): { categories: string[]; data: Array<number | null>; max: number } {
  const rows = (loadData?.series ?? []).slice(-days);
  const data = rows.map((r) => (r.coverage_status === 'unknown' ? null : (r.training_dose ?? null)));
  const categories = rows.map((r) => formatDateShort(r.date));
  const values = data.filter((v): v is number => v != null);
  return { categories, data, max: values.length ? Math.max(...values) : 0 };
}

function loadTrend(days: number): {
  categories: string[];
  chronic: Array<number | null>;
  acute: Array<number | null>;
  bounds: ChartBounds;
} {
  const rows = (loadData?.series ?? []).slice(-days);
  const chronic = rows.map((r) => (r.coverage_status === 'unknown' ? null : (r.chronic_load ?? null)));
  const acute = rows.map((r) => (r.coverage_status === 'unknown' ? null : (r.acute_load ?? null)));
  const categories = rows.map((r) => formatDateShort(r.date));
  const values = [...chronic, ...acute].filter((v): v is number => v != null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  return { categories, chronic, acute, bounds: padBounds(min, max, Math.max(1, (max - min) * 0.1)) };
}

function formTrend(days: number): {
  categories: string[];
  data: ColumnDatum[];
  bounds: ChartBounds;
  rows: Array<{ label: string; form: number | null; chronic: number | null }>;
} {
  const rows = (loadData?.series ?? []).slice(-days);
  const categories = rows.map((r) => formatDateShort(r.date));
  const data: ColumnDatum[] = rows.map((r) => {
    if (r.coverage_status === 'unknown' || r.form == null) return null;
    return { value: r.form, color: formColor(r.form, r.chronic_load) };
  });
  const values = rows.map((r) => r.form ?? 0);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  return {
    categories,
    data,
    bounds: padBounds(min, max, Math.max(0.5, (max - min) * 0.1)),
    rows: rows.map((r) => ({ label: formatDateShort(r.date), form: r.form, chronic: r.chronic_load })),
  };
}

function weekTrend(): {
  categories: string[];
  data: Array<number | null>;
  rows: Array<{ label: string; totalDose: number | null; activeDays: number }>;
} {
  const buckets = aggregateWeeklyDose(loadData?.series ?? []);
  return {
    categories: buckets.map((b) => b.weekLabel),
    data: buckets.map((b) => (b.totalDose == null ? null : Math.round(b.totalDose * 10) / 10)),
    rows: buckets.map((b) => ({ label: b.weekLabel, totalDose: b.totalDose, activeDays: b.activeDays })),
  };
}

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

function buildMetrics(): MetricCard[] {
  const latestRhrRow = (healthData?.health ?? []).find((r) => r.rhr != null) ?? null;
  const latestRhr = latestRhrRow?.rhr ?? null;
  const latestRhrDate = latestRhrRow ? formatDateShort(normalizeYmd(latestRhrRow.date)) : null;
  const rhrBaseline = healthData?.rhr_baseline ?? null;

  const latestHrvRow =
    (hrvData?.hrv ?? []).slice().reverse().find((r) => r.last_night_avg != null) ?? null;
  const latestHrv = latestHrvRow?.last_night_avg ?? null;
  const latestHrvDate = latestHrvRow ? formatDateShort(latestHrvRow.date) : null;
  const hrvLow = healthData?.hrv?.hrv_normal_low ?? null;
  const hrvHigh = healthData?.hrv?.hrv_normal_high ?? null;
  const hrvBaseline = hrvLow != null && hrvHigh != null ? `正常 ${hrvLow}-${hrvHigh} ms` : '';

  const threshold = zonesData?.threshold ?? null;
  const pacePerKm = threshold?.pace_per_km_sec ?? null;
  const paceStr = pacePerKm != null ? fmtPace(pacePerKm).replace('/km', '') : '—';
  const hrStr = threshold?.hr_bpm != null ? String(Math.round(threshold.hr_bpm)) : '—';

  return [
    {
      label: '静息心率',
      sub: latestRhrDate ? `${latestRhrDate} · 手表读数` : '手表读数',
      value: latestRhr != null ? String(latestRhr) : '—',
      unit: 'bpm',
      baseline: rhrBaseline != null ? `基线 ${rhrBaseline} bpm` : '',
      color: '#0097a7',
    },
    {
      label: '心率变异性',
      sub: latestHrvDate ? `${latestHrvDate} · 手表读数` : '手表读数',
      value: latestHrv != null ? String(latestHrv) : '—',
      unit: 'ms',
      baseline: hrvBaseline,
      color: '#7a4dd4',
    },
    {
      label: '阈值配速',
      sub: 'STRIDE Threshold Pace',
      value: paceStr,
      unit: '/km',
      baseline: threshold?.speed_confidence ? `置信 ${threshold.speed_confidence}` : '',
      color: '#00a85a',
    },
    {
      label: '阈值心率',
      sub: 'STRIDE Threshold HR',
      value: hrStr,
      unit: 'bpm',
      baseline: threshold?.hr_confidence ? `置信 ${threshold.hr_confidence}` : '',
      color: '#d97706',
    },
  ];
}

function buildLoadStats(cur: StrideTrainingLoadRecord | null): LoadStat[] {
  if (!cur) return [];
  return [
    { label: '训练负荷', value: cur.training_dose != null ? cur.training_dose.toFixed(0) : '—', color: '#e68a00' },
    { label: '急性负荷', value: cur.acute_load != null ? cur.acute_load.toFixed(1) : '—', color: '#d97706' },
    { label: '慢性负荷', value: cur.chronic_load != null ? cur.chronic_load.toFixed(1) : '—', color: '#0097a7' },
    {
      label: '竞技状态',
      value: cur.form != null ? `${cur.form > 0 ? '+' : ''}${cur.form.toFixed(1)}` : '—',
      color: classifyForm(cur.form, cur.chronic_load) === 'overload' ? '#d32f2f' : '#00a85a',
    },
    { label: '负荷比', value: cur.load_ratio != null ? cur.load_ratio.toFixed(2) : '—', color: '#7a4dd4' },
    { label: '状态', value: loadStateLabel(cur.load_ratio), color: '#e3e2e5' },
  ];
}

function buildReadiness(cur: StrideTrainingLoadRecord | null): {
  label: string;
  color: string;
  bg: string;
  reasons: string;
} {
  const gate = cur?.readiness_gate ?? null;
  const color = readinessColor(gate);
  return {
    label: gate ? `${readinessGateLabel(gate)} · ${readinessLabel(gate)}` : '—',
    color,
    bg: hexToRgba(color, 0.12),
    reasons: (cur?.readiness_reasons ?? []).join(' · '),
  };
}

function buildZones(): { paceZones: ZoneRow[]; hrZones: ZoneRow[]; hasZones: boolean } {
  const z = zonesData;
  const hasZones = !!z?.threshold && z.pace_zones.length > 0 && z.hr_zones.length > 0;
  const fmtPaceRange = (upper: string | null, lower: string | null): string => {
    if (upper && lower) return `${upper} – ${lower}`;
    if (upper) return `≥ ${upper}`;
    if (lower) return `≤ ${lower}`;
    return '—';
  };
  const paceZones: ZoneRow[] = (z?.pace_zones ?? []).map((p) => ({
    name: p.name,
    label: p.label,
    range: fmtPaceRange(p.upper_pace, p.lower_pace),
  }));
  const hrZones: ZoneRow[] = (z?.hr_zones ?? []).map((h) => {
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

/** 热力图某天的详情（日期 + 剂量 + 当天活动摘要）。 */
function heatDetail(date: string, state: string, dose: number | null): HeatDayDetail {
  const weekday = shanghaiWeekdayLabel(date);
  const title = `${formatDateShort(date)} · ${weekday}`;
  let doseText: string;
  if (state === 'unknown') doseText = '数据未确认';
  else if (state === 'absent') doseText = '历史无记录';
  else doseText = dose != null ? `训练负荷 ${dose.toFixed(0)}` : '训练负荷 —';

  const lines: string[] = [];
  for (const a of activitiesByDate.get(date) ?? []) {
    const sport = chineseSportName(a.sport_name);
    const hr = a.avg_hr ?? '—';
    if (isDistanceSport(a.sport_name)) {
      lines.push(`${sport} ${a.distance_km}km · 平均配速 ${(a.pace_fmt || '—').replace('/km', '')} · 平均心率 ${hr}`);
    } else {
      lines.push(`${sport} ${formatDurationHuman(a.duration_s)} · 平均心率 ${hr}`);
    }
  }
  if (lines.length === 0 && state === 'rest') lines.push('休息日');
  return { date, title, dose: doseText, lines };
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

Page<TrainingStatusPageData, TrainingStatusPageHandlers>({
  data: {
    statusBarHeight: 0,
    contentPaddingTop: 232,
    loading: true,
    error: '',
    metrics: [],
    loadStats: [],
    readinessLabel: '',
    readinessColor: '#8888a0',
    readinessBg: 'rgba(136, 136, 160, 0.12)',
    readinessReasons: '',
    hasLoad: false,
    hasZones: false,
    paceZones: [],
    hrZones: [],
    trendWindow: 30,
    trendOptions: [
      { value: 14, label: '14d', active: false },
      { value: 30, label: '30d', active: true },
      { value: 60, label: '60d', active: false },
      { value: 90, label: '90d', active: false },
    ],
    hasRhrChart: false,
    hasHrvChart: false,
    hasDoseChart: false,
    hasLoadChart: false,
    hasFormChart: false,
    hasWeekChart: false,
    heatWeeks: [],
    heatColors: [...HEATMAP_COLORS],
    heatSelected: null,
    formLegend: [
      { color: FORM_ZONE_COLOR.race_ready, label: '比赛就绪 (+10%~+25%×CTL)' },
      { color: FORM_ZONE_COLOR.transition, label: '维持期 (±10%×CTL)' },
      { color: FORM_ZONE_COLOR.productive, label: '提升期 (−25%~−10%×CTL)' },
      { color: FORM_ZONE_COLOR.overload, label: '过度负荷 (<−25%×CTL)' },
      { color: FORM_ZONE_COLOR.over_taper, label: '减量过多 (>+25%×CTL)' },
    ],
    currentCtlNote: '',
    calibrationLine: 'Calibration: — · 来源：STRIDE 自研算法',
    loadDateLine: 'Training load latest: —',
  },

  onLoad() {
    this.setData({
      statusBarHeight: statusBarHeight(),
      contentPaddingTop: contentPaddingTopRpx(),
    });

    // 先等认证流程 settle 再拉数据，避免首屏请求在登录完成前发出被 401。
    userStore.waitForAuth().then(() => {
      const { user, isAuthenticated } = userStore.getState();
      if (!isAuthenticated || !user) {
        wx.reLaunch({ url: '/pages/login/login' });
        return;
      }
      userId = user.id;
      void this.fetch();
    });
  },

  onUnload() {
    rhrChart = hrvChart = doseChart = loadChart = formChart = weekChart = null;
    rhrSpec = hrvSpec = doseSpec = formSpec = weekSpec = null;
  },

  onBack() {
    wx.navigateBack();
  },

  async fetch() {
    if (!userId) {
      this.setData({ loading: false });
      return;
    }
    try {
      const [h, hv, z, ld, acts] = await Promise.all([
        getHealth(userId, 90),
        getHrv(userId, 90),
        getStrideZones(userId),
        getStrideTrainingLoad(userId, 112),
        this.fetchAllActivities(),
      ]);
      healthData = h;
      hrvData = hv;
      zonesData = z;
      loadData = ld;
      activitiesByDate = new Map();
      for (const a of acts) {
        const key = a.date;
        const arr = activitiesByDate.get(key);
        if (arr) arr.push(a);
        else activitiesByDate.set(key, [a]);
      }
      loaded = true;
      this.render();
    } catch (err) {
      loaded = false;
      this.setData({
        loading: false,
        error: err instanceof Error ? err.message : '请求失败',
      });
    }
  },

  /** 分页拉取 16 周窗口内的全部活动（服务端 limit 上限 200，按 total 终止）。 */
  async fetchAllActivities(): Promise<Activity[]> {
    const from = epochToShanghaiYmd(Date.now() - 112 * 86400000);
    const PAGE = 200;
    const all: Activity[] = [];
    let offset = 0;
    for (;;) {
      const page = await getActivities(userId, { dateFrom: from, limit: PAGE, offset });
      all.push(...page.activities);
      if (page.activities.length === 0 || all.length >= page.total) break;
      offset = all.length;
    }
    return all;
  },

  render() {
    const cur = loadData?.current ?? null;
    const hasLoad = loaded && !!cur;
    const { paceZones, hrZones, hasZones } = buildZones();
    const readiness = buildReadiness(cur);

    const rhr = rhrTrend(trendDays);
    const hv = hrvTrend(trendDays);
    const dd = dailyDose(trendDays);
    const lt = loadTrend(trendDays);
    const ft = formTrend(trendDays);
    const wt = weekTrend();

    const ctl = cur?.chronic_load ?? null;

    this.setData(
      {
        loading: false,
        error: '',
        metrics: buildMetrics(),
        loadStats: buildLoadStats(cur),
        readinessLabel: readiness.label,
        readinessColor: readiness.color,
        readinessBg: readiness.bg,
        readinessReasons: readiness.reasons,
        hasLoad,
        hasZones,
        paceZones,
        hrZones,
        trendWindow: trendDays,
        trendOptions: [
          { value: 14, label: '14d', active: trendDays === 14 },
          { value: 30, label: '30d', active: trendDays === 30 },
          { value: 60, label: '60d', active: trendDays === 60 },
          { value: 90, label: '90d', active: trendDays === 90 },
        ],
        hasRhrChart: rhr.series.length >= 2,
        hasHrvChart: hv.series.length >= 2,
        hasDoseChart: hasLoad && dd.data.some((v) => v != null),
        hasLoadChart: hasLoad && countNonNull(lt.chronic) + countNonNull(lt.acute) >= 2,
        hasFormChart: hasLoad && ft.data.some((v) => v != null),
        hasWeekChart: hasLoad && wt.data.some((v) => v != null),
        heatWeeks: buildHeatWeeks(buildHeatCells(loadData?.series ?? [])),
        heatSelected: null,
        currentCtlNote:
          ctl != null && ctl > 0
            ? `当前 CTL ≈ ${ctl.toFixed(0)} · 对应阈值 ±${(ctl * 0.1).toFixed(0)} / ±${(ctl * 0.25).toFixed(0)}`
            : '',
        calibrationLine: `Calibration: ${zonesData?.threshold?.as_of_date ?? '—'} · 来源：STRIDE 自研算法`,
        loadDateLine: `Training load latest: ${cur?.date ?? '—'}`,
      },
      // canvas 节点要等 view 层渲染出来才拿得到
      () => wx.nextTick(() => this.drawCharts()),
    );
  },

  onWindowChange(e: WechatMiniprogram.TouchEvent) {
    const value = Number(e.currentTarget.dataset.value);
    if (![14, 30, 60, 90].includes(value) || value === trendDays) return;
    trendDays = value;
    this.render();
  },

  onHeatTap(e: WechatMiniprogram.TouchEvent) {
    const date = e.currentTarget.dataset.date as string;
    const cell = buildHeatCells(loadData?.series ?? [])
      .filter((c) => c.date === date)
      .pop();
    if (!cell || cell.state === 'future') return;
    // 再点同一个格子收起（按完整日期比较，避免 M/D 前缀误判，如 9/1 与 9/16）
    const selected = this.data.heatSelected;
    if (selected && selected.date === date) {
      this.setData({ heatSelected: null });
      return;
    }
    this.setData({ heatSelected: heatDetail(cell.date, cell.state, cell.dose) });
  },

  // —— uCharts 触摸工具提示 ——

  onRhrTouch(e: WechatMiniprogram.TouchEvent) {
    if (rhrChart && rhrSpec) rhrChart.showToolTip(e, { formatter: (item, time) => rhrSpec!.tooltip(itemNumber(item), time) });
  },
  onHrvTouch(e: WechatMiniprogram.TouchEvent) {
    if (hrvChart && hrvSpec) hrvChart.showToolTip(e, { formatter: (item, time) => hrvSpec!.tooltip(itemNumber(item), time) });
  },
  onDoseTouch(e: WechatMiniprogram.TouchEvent) {
    if (doseChart && doseSpec) doseChart.showToolTip(e, { formatter: (item, time) => doseSpec!.tooltip(itemNumber(item), time) });
  },
  onLoadTouch(e: WechatMiniprogram.TouchEvent) {
    // 双序列（慢性/急性）用 uCharts 默认工具提示（多行 name: value）。
    if (loadChart) loadChart.showToolTip(e);
  },
  onFormTouch(e: WechatMiniprogram.TouchEvent) {
    if (formChart && formSpec) formChart.showToolTip(e, { formatter: (item, time) => formSpec!.tooltip(itemNumber(item), time) });
  },
  onWeekTouch(e: WechatMiniprogram.TouchEvent) {
    if (weekChart && weekSpec) weekChart.showToolTip(e, { formatter: (item, time) => weekSpec!.tooltip(itemNumber(item), time) });
  },

  drawCharts() {
    const instance = this;
    const dpr = pixelRatio();

    const draw = (
      id: string,
      makeOptions: (w: number, h: number) => Record<string, unknown>,
      store: (c: Chart) => void,
    ) => {
      wx.createSelectorQuery()
        .in(instance)
        .select(id)
        .fields({ node: true, size: true }, (res) => {
          if (!res || !res.node || !res.width || !res.height) return;
          const node = res.node as { width: number; height: number; getContext(type: string): unknown };
          node.width = res.width * dpr;
          node.height = res.height * dpr;
          store(new UCharts({ ...makeOptions(res.width, res.height), context: node.getContext('2d') }));
        })
        .exec();
    };

    // RHR 趋势
    const rhr = rhrTrend(trendDays);
    rhrSpec = { tooltip: (v, time) => `${time} · RHR ${v} bpm` };
    if (rhr.series.length >= 2) {
      draw('#rhr-chart', (w, h) =>
        buildLineChartOptions({
          categories: rhr.categories,
          series: [{ name: '静息心率', data: rhr.series, color: '#0097a7' }],
          bounds: rhr.bounds,
          width: w,
          height: h,
          dpr,
        }),
        (c) => {
          rhrChart = c;
        },
      );
    } else {
      rhrChart = null;
    }

    // HRV 趋势
    const hv = hrvTrend(trendDays);
    hrvSpec = { tooltip: (v, time) => `${time} · HRV ${v} ms` };
    if (hv.series.length >= 2) {
      draw('#hrv-chart', (w, h) =>
        buildLineChartOptions({
          categories: hv.categories,
          series: [{ name: '心率变异性', data: hv.series, color: '#7a4dd4' }],
          bounds: hv.bounds,
          width: w,
          height: h,
          dpr,
        }),
        (c) => {
          hrvChart = c;
        },
      );
    } else {
      hrvChart = null;
    }

    // 负荷区块（仅 hasLoad 时 canvas 存在）
    if (!loadData?.current) {
      doseChart = loadChart = formChart = weekChart = null;
      return;
    }

    const dd = dailyDose(trendDays);
    doseSpec = { tooltip: (v, time) => `${time} · 训练负荷 ${v}` };
    if (dd.data.some((v) => v != null)) {
      draw('#dose-chart', (w, h) =>
        buildColumnChartOptions({
          categories: dd.categories,
          data: dd.data,
          color: '#e68a00',
          bounds: { min: 0, max: Math.max(10, dd.max * 1.1) },
          width: w,
          height: h,
          dpr,
        }),
        (c) => {
          doseChart = c;
        },
      );
    } else {
      doseChart = null;
    }

    const lt = loadTrend(trendDays);
    if (countNonNull(lt.chronic) + countNonNull(lt.acute) >= 2) {
      const series: ChartSeries[] = [
        { name: '慢性负荷', data: lt.chronic, color: '#00a85a' },
        { name: '急性负荷', data: lt.acute, color: '#0097a7' },
      ];
      draw('#load-chart', (w, h) =>
        buildLineChartOptions({
          categories: lt.categories,
          series,
          bounds: lt.bounds,
          width: w,
          height: h,
          dpr,
        }),
        (c) => {
          loadChart = c;
        },
      );
    } else {
      loadChart = null;
    }

    const ft = formTrend(trendDays);
    formRows = ft.rows;
    formSpec = {
      tooltip: (v, time) => {
        const row = formRows.find((r) => r.label === time);
        const zone = row ? classifyForm(row.form, row.chronic) : null;
        return `${time} · Form ${v}${zone ? ` (${FORM_ZONE_LABEL[zone]})` : ''}`;
      },
    };
    if (ft.data.some((v) => v != null)) {
      draw('#form-chart', (w, h) =>
        buildColumnChartOptions({
          categories: ft.categories,
          data: ft.data,
          color: '#00a85a',
          bounds: ft.bounds,
          width: w,
          height: h,
          dpr,
        }),
        (c) => {
          formChart = c;
        },
      );
    } else {
      formChart = null;
    }

    const wt = weekTrend();
    weekRows = wt.rows;
    weekSpec = {
      tooltip: (v, time) => {
        const row = weekRows.find((r) => r.label === time);
        const doseText = Number.isFinite(v) ? v.toFixed(1) : '数据不完整';
        return `周一 ${time} · ${doseText}（${row?.activeDays ?? 0} 天）`;
      },
    };
    if (wt.data.some((v) => v != null)) {
      const weekValues = wt.data.filter((v): v is number => v != null);
      const weekMax = weekValues.length ? Math.max(...weekValues) : 0;
      draw('#week-chart', (w, h) =>
        buildLineChartOptions({
          categories: wt.categories,
          series: [{ name: '周剂量', data: wt.data, color: '#e68a00' }],
          bounds: { min: 0, max: Math.max(10, weekMax * 1.1) },
          width: w,
          height: h,
          dpr,
        }),
        (c) => {
          weekChart = c;
        },
      );
    } else {
      weekChart = null;
    }
  },
});
