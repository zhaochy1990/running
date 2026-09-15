/**
 * 活动详情曲线（心率 / 配速）的数据准备与配色：纯函数，不碰 canvas / 小程序运行时，
 * 渲染交给 uCharts（见 `vendor/ucharts/`）。`node utils/curve.check.mts` 跑自检。
 */
import type { TimeseriesPoint, Zone } from '../types/activity';

/** timeseries.timestamp 是厘秒（与 pause / 轨迹一致），横轴统一换成「起点起的秒数」。 */
export interface CurvePoint {
  t: number;
  v: number;
}

/** 抽稀后点数上限：卡片内宽约 300px，再多看不出差别。 */
export const MAX_CURVE_POINTS = 160;

/** 区间配色：Z1 蓝 → Z5 红（与 COROS 一致）；超过 5 档循环补色。 */
export const ZONE_COLORS = ['#4c8dff', '#37c85a', '#f5c542', '#f5863b', '#ef4444', '#b45bff', '#9aa4b2'];

/** 没有区间数据时的曲线兜底色（主题粉）。 */
export const CURVE_FALLBACK_COLOR = '#ffb3af';

/** 区间条与曲线共用的第 i 档配色。 */
export function zoneColor(index: number): string {
  return ZONE_COLORS[index % ZONE_COLORS.length];
}

/** 取值档位：lo/hi 为取值边界（开放边为 ±Infinity），与曲线同单位。 */
export interface ZoneBand {
  lo: number;
  hi: number;
  color: string;
}

/**
 * 把手表 / 校准区间转成取值→颜色档位。
 * 注意边界方向：心率 range_min < range_max，配速 range_min 是较慢边（更大值），这里统一成 lo < hi。
 * 另外手表上报的第一档往往和第二档同区间（用重复值表达开放边，见 formatZoneRange），
 * 这里按同一口径把第一档挪到区间外那一侧，否则 Z2 的数据会被当成 Z1 上色。
 */
export function zoneBands(zones: Zone[]): ZoneBand[] {
  const bands = zones.map((z, i) => {
    const a = z.range_min;
    const b = z.range_max;
    const lo = a == null ? -Infinity : b == null ? a : Math.min(a, b);
    const hi = b == null ? Infinity : a == null ? b : Math.max(a, b);
    return { lo, hi, color: zoneColor(i) };
  });
  const [first, second] = bands;
  if (second && first.lo === second.lo && first.hi === second.hi) {
    // 心率：取值随档位递增，第一档在区间下方；配速：档位越高配速越快（值越小），第一档在区间上方。
    if (zones[0].zone_type === 'heartRate') {
      first.lo = -Infinity;
      first.hi = second.lo;
    } else {
      first.lo = second.hi;
      first.hi = Infinity;
    }
  }
  return bands.sort((x, y) => x.lo - y.lo);
}

/** 值命中的档位色；落在所有档位之外（数据与区间不同源）时取最近的档位。 */
export function colorOfBands(bands: ZoneBand[], value: number): string {
  if (!bands.length) return CURVE_FALLBACK_COLOR;
  let nearest = bands[0];
  let nearestGap = Infinity;
  for (const b of bands) {
    if (value >= b.lo && value <= b.hi) return b.color;
    const gap = value < b.lo ? b.lo - value : value - b.hi;
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = b;
    }
  }
  return nearest.color;
}

/**
 * uCharts 折线渐变停靠点：按采样点的区间色硬切，得到 `[[0..1 位置, 颜色], ...]`。
 * 同一档连续采样只产出 2 个停靠点，跨档处两个停靠点同位，颜色在相邻采样间切换。
 */
export function lineColorStops(
  points: CurvePoint[],
  bands: ZoneBand[],
): Array<[number, string]> {
  const n = points.length;
  if (n === 0) return [];
  const pos = (i: number) => (n > 1 ? i / (n - 1) : 0);
  let current = colorOfBands(bands, points[0].v);
  const stops: Array<[number, string]> = [[0, current]];
  for (let i = 1; i < n; i++) {
    const color = colorOfBands(bands, points[i].v);
    if (color === current) continue;
    const at = pos(i - 1);
    stops.push([at, current], [at, color]);
    current = color;
  }
  stops.push([1, current]);
  return stops;
}

/** 横轴刻度：`HH:MM:SS`（与 COROS 一致，始终带小时位）。 */
export function formatChartTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 纵轴取值边界：按 step 取整并保证有高度（step=10 适合心率）。 */
export function axisBounds(values: number[], step: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!values.length || !Number.isFinite(min)) return { min: 0, max: step };
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  return { min: lo, max: hi === lo ? lo + step : hi };
}

/** 配速有效区间（s/km）：缺失 / 0 / 离谱值都丢掉（与轨迹着色一致）。 */
function validPace(p: TimeseriesPoint): number | null {
  const v = p.adjusted_pace ?? p.speed;
  return v != null && v > 0 && v < 1200 ? v : null;
}

function buildSeries(
  points: TimeseriesPoint[],
  pick: (p: TimeseriesPoint) => number | null,
): CurvePoint[] {
  const out: CurvePoint[] = [];
  let t0: number | null = null;
  for (const p of points) {
    const v = pick(p);
    if (p.timestamp == null || v == null) continue;
    if (t0 == null) t0 = p.timestamp;
    out.push({ t: Math.round((p.timestamp - t0) / 100), v });
  }
  return out;
}

/** 心率曲线（bpm）。 */
export function buildHrSeries(points: TimeseriesPoint[]): CurvePoint[] {
  return buildSeries(points, (p) => (p.heart_rate != null && p.heart_rate > 0 ? p.heart_rate : null));
}

/** 配速曲线（s/km，adjusted_pace 优先，回落 speed）。 */
export function buildPaceSeries(points: TimeseriesPoint[]): CurvePoint[] {
  return buildSeries(points, validPace);
}

/** 等间隔抽稀到 <= max 点，保留首尾。 */
export function downsample(points: CurvePoint[], max = MAX_CURVE_POINTS): CurvePoint[] {
  if (points.length <= max) return points;
  const step = Math.max(1, Math.ceil((points.length - 1) / Math.max(1, max - 1)));
  const out = points.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// uCharts 折线图配置（纯数据，便于 node 假 context 冒烟自检）
// ---------------------------------------------------------------------------

/** uCharts 会把这些值乘 pixelRatio，所以都按 css px 给。 */
const CHART_PADDING: [number, number, number, number] = [10, 4, 0, 0]; // 上右下左
const CHART_GRID_COLOR = 'rgba(255, 255, 255, 0.08)';
const CHART_FONT_COLOR = '#9c9c9d';
const CHART_FONT_SIZE = 10;
const CHART_GRID_LINES = 4;

export interface CurveChartSpec {
  /** canvas 节点 id（WXML 里的 id 属性） */
  id: string;
  series: CurvePoint[];
  bands: ZoneBand[];
  /** 值 → 绘制值（配速取负，越快越靠上） */
  plot: (value: number) => number;
  /** 纵轴刻度粒度（心率 10 bpm / 配速 10 s·km⁻¹） */
  step: number;
  /** 纵轴刻度文案（收绘制值） */
  yFormatter: (value: number) => string;
  /** 触摸读数文案（收绘制值与时间标签） */
  tooltip: (value: number, time: string) => string;
}

/** uCharts 折线图 options。坐标按设备像素（uCharts 不做 ctx.scale），所以宽高也要乘 dpr。 */
export function buildChartOptions(
  spec: CurveChartSpec,
  width: number,
  height: number,
  dpr: number,
): Record<string, unknown> {
  const values = spec.series.map((p) => spec.plot(p.v));
  const bounds = axisBounds(values, spec.step);
  return {
    type: 'line',
    width: width * dpr,
    height: height * dpr,
    pixelRatio: dpr,
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
      splitNumber: CHART_GRID_LINES,
      fontSize: CHART_FONT_SIZE,
      fontColor: CHART_FONT_COLOR,
      data: [{ min: bounds.min, max: bounds.max, formatter: (v: number) => spec.yFormatter(v), axisLine: false }],
    },
    extra: {
      // linearColor 由区间档位生成 → 一个区间一种颜色的折线
      line: { type: 'straight', width: 2, linearType: 'custom' },
      tooltip: { showBox: true, bgColor: '#101111', fontColor: '#e3e2e5', gridType: 'dash' },
    },
    categories: spec.series.map((p) => formatChartTime(p.t)),
    series: [
      {
        name: '曲线',
        data: values,
        color: CURVE_FALLBACK_COLOR,
        linearColor: lineColorStops(spec.series, spec.bands),
      },
    ],
  };
}
