/**
 * curve.ts 自检：`node utils/curve.check.mts`。
 * 只覆盖曲线数据准备 / 区间配色 / 坐标边界，不依赖小程序运行时与 uCharts。
 */
import type { TimeseriesPoint, Zone } from '../types/activity';
import {
  axisBounds,
  buildChartOptions,
  buildHrSeries,
  buildPaceSeries,
  colorOfBands,
  downsample,
  formatChartTime,
  lineColorStops,
  zoneBands,
} from './curve.ts';
import { readFileSync } from 'node:fs';

const pt = (timestamp: number | null, extra: Partial<TimeseriesPoint> = {}): TimeseriesPoint =>
  ({ timestamp, ...extra }) as TimeseriesPoint;

const zone = (type: string, index: number, min: number | null, max: number | null): Zone =>
  ({ zone_type: type, zone_index: index, range_min: min, range_max: max }) as Zone;

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// 厘秒 → 秒；缺时间戳 / 缺值 / 0 心率都丢掉
eq(
  buildHrSeries([pt(100, { heart_rate: 120 }), pt(200, { heart_rate: null }), pt(null, { heart_rate: 130 }), pt(300, { heart_rate: 140 })]),
  [{ t: 0, v: 120 }, { t: 2, v: 140 }],
  'hr series',
);

// 配速优先 adjusted_pace，回落 speed，超范围丢弃
eq(
  buildPaceSeries([pt(0, { adjusted_pace: 300 }), pt(100, { speed: 310 }), pt(200, { adjusted_pace: 1500 }), pt(300, { speed: 0 })]),
  [{ t: 0, v: 300 }, { t: 1, v: 310 }],
  'pace series',
);

// 抽稀：不超上限、保留首尾
const many = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: 100 + i }));
const thin = downsample(many, 100);
eq(thin.length <= 100, true, 'downsample cap');
eq([thin[0], thin[thin.length - 1]], [many[0], many[999]], 'downsample keeps ends');
eq(downsample(many.slice(0, 10), 100).length, 10, 'downsample no-op below max');

// 区间档位：心率开放边（<130 / >170）、配速 range_min 是较慢边（值更大）也要归一化成 lo < hi
const hrBands = zoneBands([
  zone('heartRate', 1, null, 130),
  zone('heartRate', 2, 130, 150),
  zone('heartRate', 3, 150, null),
]);
eq(hrBands.map((b) => [b.lo, b.hi]), [[-Infinity, 130], [130, 150], [150, Infinity]], 'hr bands');
eq(hrBands.map((b) => b.color), ['#4c8dff', '#37c85a', '#f5c542'], 'hr band colors');
const paceBands = zoneBands([zone('pace', 1, 400, 360), zone('pace', 2, 360, 320)]);
eq(paceBands.map((b) => [b.lo, b.hi]), [[320, 360], [360, 400]], 'pace bands normalized and sorted');

// 真实数据形状：手表上报的第一档与第二档同区间（重复值表达开放边）——
// 心率第一档应在下方，配速第一档应在上方，否则 Z2 的数据会被当成 Z1 上色
const dupHr = zoneBands([zone('heartRate', 1, 133, 149), zone('heartRate', 2, 133, 149), zone('heartRate', 3, 150, 158)]);
eq(dupHr.map((b) => [b.lo, b.hi]), [[-Infinity, 133], [133, 149], [150, 158]], 'duplicate first hr zone → open below');
// （配速区间进 zoneBands 前已由页面换算成 s/km）
const dupPace = zoneBands([zone('pace', 1, 345.455, 284.235), zone('pace', 2, 345.455, 284.235), zone('pace', 3, 284.235, 265.021)]);
eq(
  dupPace.map((b) => [b.lo, b.hi]),
  [[265.021, 284.235], [284.235, 345.455], [345.455, Infinity]],
  'duplicate first pace zone → open above (s/km)',
);
eq(colorOfBands(dupPace, 320), '#37c85a', 'slow segment gets Z2 color, not Z1');

// 取值 → 档位色：命中区间取本档，落在区间外取最近档
eq(colorOfBands(hrBands, 120), '#4c8dff', 'color in first band');
eq(colorOfBands(hrBands, 140), '#37c85a', 'color in middle band');
eq(colorOfBands(hrBands, 200), '#f5c542', 'color above all bands → nearest');
eq(colorOfBands([], 120), '#ffb3af', 'no bands → fallback color');

// 曲线配色停靠点：同一档两停靠点，跨档同位硬切（0/0.5/1 对应 3 个采样）
eq(
  lineColorStops([{ t: 0, v: 120 }, { t: 10, v: 120 }, { t: 20, v: 160 }], hrBands),
  [[0, '#4c8dff'], [0.5, '#4c8dff'], [0.5, '#f5c542'], [1, '#f5c542']],
  'color stops switch at zone change',
);
eq(lineColorStops([], hrBands), [], 'no points → no stops');
eq(
  lineColorStops([{ t: 0, v: 200 }, { t: 10, v: 210 }], hrBands),
  [[0, '#f5c542'], [1, '#f5c542']],
  'single zone → flat stops',
);

// 横轴刻度
eq(formatChartTime(0), '00:00:00', 'zero');
eq(formatChartTime(3381), '00:56:21', 'minutes seconds');
eq(formatChartTime(6761), '01:52:41', 'hours');

// 纵轴边界：按 step 取整、平线也要有高度
eq(axisBounds([100, 180], 10), { min: 100, max: 180 }, 'bounds rounded');
eq(axisBounds([101, 179], 10), { min: 100, max: 180 }, 'bounds expand');
eq(axisBounds([150, 150], 10), { min: 150, max: 160 }, 'flat line still has height');
eq(axisBounds([], 10), { min: 0, max: 10 }, 'empty → default range');

console.log('curve.check: OK');

// uCharts 渲染冒烟：用假 context（任何方法都是 no-op）跑真实的绘图代码，
// 能抳出选项名写错 / 数据长度对不上 / formatter 报错这类问题。
// 注意 uCharts 异步绘制，构造完要等一帧才会看到调用。
const calls: string[] = [];
const texts: string[] = [];
const segments: Array<[string, number, number]> = [];
const stops: Array<[number, string]> = [];
const ctx = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === 'createLinearGradient') {
        return () => ({ addColorStop: (offset: number, color: string) => stops.push([offset, color]) });
      }
      if (typeof key === 'string') {
        return (...args: unknown[]) => {
          calls.push(key);
          if (key === 'fillText') texts.push(String(args[0]));
          if (key === 'moveTo' || key === 'lineTo') segments.push([key, Number(args[0]), Number(args[1])]);
        };
      }
      return undefined;
    },
    set() {
      return true;
    },
  },
);
const series = [
  { t: 0, v: 120 },
  { t: 600, v: 160 },
  { t: 1200, v: 140 },
];
const options = buildChartOptions(
  {
    id: '#hr-curve',
    series,
    bands: hrBands,
    plot: (v) => v,
    step: 10,
    yFormatter: (v) => `${Math.round(v)}`,
    tooltip: (v, time) => `心率 ${Math.round(v)} bpm · ${time}`,
  },
  300,
  120,
  2,
);
// uCharts 是给小程序用的 CommonJS 文件，而本目录 package.json 是 `type: module`，
// Node 直接 import 会按 ESM 解析（module.exports 丢失），所以在这里按 CJS 求值。
const vendorModule = { exports: {} as { default?: unknown } };
new Function('module', 'exports', readFileSync(new URL('../vendor/ucharts/u-charts.min.js', import.meta.url), 'utf8'))(
  vendorModule,
  vendorModule.exports,
);
const UCharts = vendorModule.exports as unknown as new (opts: Record<string, unknown>) => {
  showToolTip: (...args: unknown[]) => void;
};
const chart = new UCharts({ ...options, context: ctx });
await new Promise((resolve) => setTimeout(resolve, 300));

eq([options.width, options.height], [600, 240], 'draw size scaled by dpr (uCharts 不做 ctx.scale)');
eq(calls.includes('clearRect') && calls.includes('stroke'), true, 'draws a stroked line');
eq(stops.length > 0, true, 'line gradient has zone stops');
eq(texts.includes('00:00:00'), true, 'x axis shows time labels');
eq(texts.some((t) => t === '120' || t === '160'), true, 'y axis labels come from formatter');
// 触摸读数：真机上 bindtouchmove 把事件交给 showToolTip，这里直接喂等价事件，
// 断言 tooltip 文案（含时间标签）真的画到了 canvas 上
texts.length = 0;
chart.showToolTip(
  { changedTouches: [{ x: 150, y: 60 }] },
  { formatter: (item: { data: number }, category: string) => `心率 ${Math.round(item.data)} bpm · ${category}` },
);
await new Promise((resolve) => setTimeout(resolve, 300));
const tipText = texts.find((t) => t.startsWith('心率 ')) ?? '';
eq(/^心率 \d+ bpm · \d\d:\d\d:\d\d$/.test(tipText), true, `touch shows tooltip (${tipText})`);
console.log('tooltip drawn:', tipText);
console.log('curveChart.check: OK');
