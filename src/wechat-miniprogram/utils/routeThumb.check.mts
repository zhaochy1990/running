/**
 * routeThumb.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/routeThumb.check.mts`。
 * 覆盖三代 wire 形状解析（旧单折线 / 第二版多段 / 无 GPS）/ 各段单独起笔绘制 /
 * 视框→画布映射与内切圆收拢 / 线宽 / 缓存键；不依赖小程序运行时（绘制走录制 ctx）。
 */
import {
  drawRouteShape,
  LINE_WIDTH_RATIO,
  parseRouteShape,
  routeLineWidth,
  routeThumbCacheKey,
  type RoutePathCtx,
  type RoutePoint,
  type RouteShape,
} from './routeThumb.ts';
import { theme } from './theme.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}
function near(a: number, b: number, eps: number, what: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${what}: got ${a}, want ~${b} (±${eps})`);
}

/** 录制 ctx：ops 记调用序列；pens 每次 moveTo（起笔）新开一段并记下该段全部落笔坐标。 */
function recorder(): { ctx: RoutePathCtx; ops: string[]; pens: RoutePoint[][] } {
  const ops: string[] = [];
  const pens: RoutePoint[][] = [];
  const ctx: RoutePathCtx = {
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    beginPath: () => {
      ops.push('beginPath');
    },
    moveTo: (x, y) => {
      ops.push('moveTo');
      pens.push([[x, y]]);
    },
    lineTo: (x, y) => {
      ops.push('lineTo');
      pens[pens.length - 1].push([x, y]);
    },
    stroke: () => {
      ops.push('stroke');
    },
  };
  return { ctx, ops, pens };
}

/** 断言「各段单独起笔」：每段恰为 beginPath → moveTo → (n−1) 个 lineTo → stroke，
 * 段与段之间没有任何连线（不跨段连线、不闭合）。 */
function expectPenDownPerStroke(rec: { ops: string[]; pens: RoutePoint[][] }, strokes: RoutePoint[][]): void {
  const want: string[] = [];
  for (const stroke of strokes) {
    want.push('beginPath', 'moveTo', ...Array<string>(stroke.length - 1).fill('lineTo'), 'stroke');
  }
  eq(rec.ops, want, 'pen-down per stroke');
  eq(rec.pens.length, strokes.length, 'one pen per stroke');
}

// 活动列表 API 回放夹具（devops#1037 的三代 route_thumb），与 Go internal/api 的
// TestActivityList_RouteThumbServesAllShapeGenerations 同一份：旧单折线 / 第二版多段 / null。
const V1_FROM_API: unknown = JSON.parse('[[5.0,95.0],[50.0,20.0],[95.0,5.0]]');
const V2_FROM_API: unknown = JSON.parse(
  '{"v":2,"strokes":[[[5.0,95.0],[50.0,20.0]],[[50.0,20.0],[95.0,5.0]]],"start":[5.0,95.0],"end":[95.0,5.0],"short":10.0,"long":90.0,"travel":127.3}',
);

// ── parseRouteShape：非法 / 不足两点 → null（fallback 口径） ──
eq(parseRouteShape(null), null, 'null shape');
eq(parseRouteShape(undefined), null, 'undefined shape');
eq(parseRouteShape([]), null, 'empty shape');
eq(parseRouteShape([[10, 10]]), null, 'single point');
eq(parseRouteShape('[[0,0],[1,1]]'), null, 'string not accepted');
eq(parseRouteShape([[0, 0], [1]]), null, 'short point');
eq(parseRouteShape([[0, 0], [1, 'x']]), null, 'non-numeric coord');
eq(parseRouteShape([[0, 0], [1, NaN]]), null, 'NaN coord');
eq(parseRouteShape([[0, 0], [1, Infinity]]), null, 'Infinity coord');
eq(parseRouteShape([[0, 0], [1, 1, 1]]), null, 'long point');
eq(
  parseRouteShape([[0, 0], [100, 100]]),
  { strokes: [[[0, 0], [100, 100]]], metrics: null },
  'minimal valid shape',
);
// 60 点上限由后端契约保证，客户端不截断（超长只透传，绘制成本 O(n)）
const sixty = Array.from({ length: 60 }, (_, i) => [i, i]);
eq(parseRouteShape(sixty)!.strokes[0].length, 60, '60-point passthrough');
// 旧单折线回放：一段、无指标（常规线宽）
eq(parseRouteShape(V1_FROM_API), { strokes: [[[5, 95], [50, 20], [95, 5]]], metrics: null }, 'API v1 replay');

// ── parseRouteShape：第二版多段对象 ──
// API 回放：各段 + 线宽指标；start / end 不参与绘制（36px 单墨色缩略图不标起终点）
eq(
  parseRouteShape(V2_FROM_API),
  { strokes: [[[5, 95], [50, 20]], [[50, 20], [95, 5]]], metrics: { short: 10, long: 90, travel: 127.3 } },
  'API v2 replay',
);
// 段损坏 = 整个形状不可信 → null（与 Go DecodeV2 同口径，回退运动图标）
eq(parseRouteShape({ v: 2 }), null, 'v2 without strokes');
eq(parseRouteShape({ v: 2, strokes: [] }), null, 'v2 with no strokes');
eq(parseRouteShape({ v: 2, strokes: [[[5, 95]]] }), null, 'v2 one-point stroke');
eq(
  parseRouteShape({ v: 2, strokes: [[[5, 95], [50, 20]], [[95, 5]]] }),
  null,
  'v2 later stroke too short',
);
eq(
  parseRouteShape({ v: 2, strokes: [[[5, 95], [50, 'x']], [[50, 20], [95, 5]]] }),
  null,
  'v2 bad coord',
);
eq(parseRouteShape('not json'), null, 'string is not a shape');
// 版本标记：只认 v=2；其它版本 / 缺标记的旧对象不猜格式，回退运动图标
eq(parseRouteShape({ v: 1, strokes: [[[5, 95], [95, 5]]] }), null, 'v1 object rejected');
eq(parseRouteShape({ v: 3, strokes: [[[5, 95], [95, 5]]] }), null, 'future version rejected');
eq(parseRouteShape({ strokes: [[[5, 95], [95, 5]]] }), null, 'missing version rejected');
// 线宽指标：第二版对象必须带齐三个有限数，残缺即不可信 → 整个回退（与 Go DecodeV2、
// Web 端 decodeRouteThumb 同口径）
const v2With = (metrics: Record<string, unknown>): RouteShape | null =>
  parseRouteShape({ v: 2, strokes: [[[5, 95], [95, 5]]], ...metrics });
eq(
  v2With({ short: 8, long: 90, travel: 260 }),
  { strokes: [[[5, 95], [95, 5]]], metrics: { short: 8, long: 90, travel: 260 } },
  'complete metrics kept',
);
eq(v2With({}), null, 'missing metrics rejected');
eq(v2With({ short: 8, long: 90 }), null, 'missing travel rejected');
eq(v2With({ short: null, long: 90, travel: 260 }), null, 'non-numeric short rejected');
eq(v2With({ short: '8', long: 90, travel: 260 }), null, 'string metric rejected');
eq(v2With({ short: 8, long: 90, travel: NaN }), null, 'NaN metric rejected');
eq(v2With({ short: 8, long: 90, travel: Infinity }), null, 'Infinity metric rejected');
// 回归钉住（master steer）：parseRouteShape 对任何无法识别的内容一律返回 null → 运动图标，
// 绝不抛错中断列表。线上旧版小程序靠开头的 Array.isArray 分支把 v2 对象安全落成图标；
// 新版识别 v2 对象后，「读不懂」的口径不变——只是多认了一种读得懂的形状。
const v2Base = { start: [5, 95], end: [95, 5], short: 8, long: 90, travel: 260 };
const sparse = new Array<unknown>(3);
sparse[0] = [5, 95];
const unreadable: Array<[string, unknown]> = [
  ['unknown version v3 object', { ...v2Base, v: 3, strokes: [[[5, 95], [95, 5]]] }],
  ['version 1 object', { ...v2Base, v: 1, strokes: [[[5, 95], [95, 5]]] }],
  ['missing version', { ...v2Base, strokes: [[[5, 95], [95, 5]]] }],
  ['string version', { ...v2Base, v: '2', strokes: [[[5, 95], [95, 5]]] }],
  ['null version', { ...v2Base, v: null, strokes: [[[5, 95], [95, 5]]] }],
  ['strokes not an array', { ...v2Base, v: 2, strokes: '[[5,95],[95,5]]' }],
  ['strokes is an object', { ...v2Base, v: 2, strokes: { 0: [[5, 95], [95, 5]] } }],
  ['strokes is null', { ...v2Base, v: 2, strokes: null }],
  ['no strokes', { ...v2Base, v: 2, strokes: [] }],
  ['stroke is null', { ...v2Base, v: 2, strokes: [null] }],
  ['stroke is a string', { ...v2Base, v: 2, strokes: ['abc'] }],
  ['later stroke is a number', { ...v2Base, v: 2, strokes: [[[5, 95], [95, 5]], 7] }],
  ['point is null', { ...v2Base, v: 2, strokes: [[[null], [95, 5]]] }],
  ['point is a number', { ...v2Base, v: 2, strokes: [[5, [95, 5]]] }],
  ['point has three coords', { ...v2Base, v: 2, strokes: [[[5, 95, 7], [95, 5]]] }],
  ['NaN coord', { ...v2Base, v: 2, strokes: [[[5, NaN], [95, 5]]] }],
  ['Infinity coord', { ...v2Base, v: 2, strokes: [[[5, 95], [Infinity, 5]]] }],
  ['string coord', { ...v2Base, v: 2, strokes: [[[5, '95'], [95, 5]]] }],
  ['empty object', {}],
  ['array with a null point', [[5, 95], null]],
  ['sparse array', sparse],
  ['function', () => 1],
  ['symbol', Symbol('shape')],
  ['number', 42],
];
for (const [name, input] of unreadable) {
  let out: unknown = 'THREW';
  try {
    out = parseRouteShape(input);
  } catch (err) {
    out = `THREW: ${String(err)}`;
  }
  eq(out, null, `unreadable input falls back to the sport icon and never throws: ${name}`);
}
// 三种照常：v1 数组 / v2 对象 / null
eq(parseRouteShape(V1_FROM_API)!.strokes.length, 1, 'v1 array still parses');
eq(parseRouteShape(V2_FROM_API)!.strokes.length, 2, 'v2 object still parses');
eq(parseRouteShape(null), null, 'null still falls back');

// 退化直线 short=0 是合法形状（永不收细），不算残缺
eq(
  v2With({ short: 0, long: 90, travel: 300 }),
  { strokes: [[[5, 95], [95, 5]]], metrics: { short: 0, long: 90, travel: 300 } },
  'straight-line trace keeps its metrics',
);

// ── routeLineWidth：移植 Go thumbnail.StrokeWidth（用例表同 TestStrokeWidth） ──
const widthCases: Array<[string, number, number, number, number, number]> = [
  ['36 px regular', 36, 60, 90, 300, 1.2],
  ['36 px thin', 36, 8, 90, 260, 0.9],
  ['64 px never thins', 64, 8, 90, 260, 64 / 30],
  ['straight trace never thins', 36, 0, 90, 300, 1.2],
  ['short route does not thin', 36, 20, 90, 100, 1.2],
  ['degenerate both sides zero never thins', 36, 0, 0, 300, 1.2],
];
for (const [name, size, short, long, travel, want] of widthCases) {
  const shape = parseRouteShape({
    v: 2,
    strokes: [[[5, 95], [95, 5]]],
    start: [5, 95],
    end: [95, 5],
    short,
    long,
    travel,
  })!;
  near(routeLineWidth(shape, size), want, 1e-9, `width: ${name}`);
}
// 边长 ≥56 px 回到常规线宽（小尺寸权重 clamp((56-边长)/20) 归零）
const thin = v2With({ short: 8, long: 90, travel: 260 })!;
near(routeLineWidth(thin, 56), 56 * LINE_WIDTH_RATIO, 1e-9, '56 px back to regular width');
// 旧单折线没有指标：恒常规线宽
near(routeLineWidth(parseRouteShape(V1_FROM_API)!, 36), 36 * LINE_WIDTH_RATIO, 1e-9, 'legacy width');

// ── drawRouteShape：三种输入，各段单独起笔 ──
const legacy = parseRouteShape(V1_FROM_API)!;
const legacyRec = recorder();
drawRouteShape(legacyRec.ctx, legacy, 100, 1);
expectPenDownPerStroke(legacyRec, legacy.strokes);
near(legacyRec.ctx.lineWidth, 100 * LINE_WIDTH_RATIO, 1e-9, 'legacy draw width = size/30');
eq([legacyRec.ctx.lineJoin, legacyRec.ctx.lineCap], ['round', 'round'], 'round join / cap');

const multi = parseRouteShape(V2_FROM_API)!;
const multiRec = recorder();
drawRouteShape(multiRec.ctx, multi, 100, 1);
expectPenDownPerStroke(multiRec, multi.strokes);
// 路口共点：后端把同一坐标存进两段，同一映射后画布上仍是同一点（横街与外圈真正相接）
eq(multiRec.pens[0][1], multiRec.pens[1][0], 'shared junction vertex stays shared after fit');

// 真实起终点语义：横街末端（真实终点）离外圈很近但不相接 —— 绘制端只照下发各段落笔，
// 不按距离把终点接到相邻段上，也不闭合路径，开口保持开口（epic #1034「路口」口径）。
const openEnd = parseRouteShape({
  v: 2,
  strokes: [
    [
      [5, 95],
      [95, 95],
      [95, 5],
      [5, 5],
      [5, 95],
    ],
    [
      [50, 95],
      [50, 9],
    ],
  ],
  start: [5, 95],
  end: [50, 9],
  short: 60,
  long: 90,
  travel: 400,
})!;
const openRec = recorder();
drawRouteShape(openRec.ctx, openEnd, 100, 1);
expectPenDownPerStroke(openRec, openEnd.strokes);
// 收拢是所有段共用的一次整体缩放：外圈被收进内切圆后，横街起点（自身离中心近、
// 单独看不需要收）仍落在外圈上边上，不会因为「各段各缩」而从路口脱开
const [spurStartX, spurStartY] = openRec.pens[1][0];
near(spurStartY, openRec.pens[0][0][1], 1e-9, 'spur start stays on the ring after the shared fit');
if (spurStartX <= openRec.pens[0][0][0] || spurStartX >= openRec.pens[0][1][0]) {
  throw new Error(`spur start x=${spurStartX} left the ring's top edge`);
}
// GPS 断笔：两块互不相连的区域各画各的，中间不出现连线
const gapRec = recorder();
const gapped = parseRouteShape({
  v: 2,
  strokes: [
    [
      [5, 95],
      [45, 95],
    ],
    [
      [55, 95],
      [95, 95],
    ],
  ],
  start: [5, 95],
  end: [95, 95],
  short: 8,
  long: 90,
  travel: 180,
})!;
drawRouteShape(gapRec.ctx, gapped, 100, 1);
expectPenDownPerStroke(gapRec, gapped.strokes);

// ── fit：线性映射 + 内切圆收拢（与 Go RenderPNG 同语义；经 drawRouteShape 录制坐标观察） ──
// size=100 时 scale=0.99：视框角 (100,100) → (99,99)，中心 (49.5,49.5)，
// 角点半径 ≈ 70 > centre - 半线宽 → 收拢到内切圆内
const S = 100;
const cornerRec = recorder();
drawRouteShape(cornerRec.ctx, parseRouteShape([[0, 0], [100, 100]])!, S, 1);
const centre = (S - 1) / 2;
const halfLine = (S * LINE_WIDTH_RATIO) / 2;
for (const [x, y] of cornerRec.pens[0]) {
  near(Math.hypot(x - centre, y - centre), centre - halfLine, 1e-9, 'corner pulled to inscribed circle');
}
// 对角线端点收拢后仍在一条过中心的直线上（整体缩放不改形状）
const [c0, c1] = cornerRec.pens[0];
near(Math.atan2(c1[1] - c0[1], c1[0] - c0[0]), Math.atan2(100, 100), 1e-9, 'diagonal direction preserved');

// 全部点都在内切圆内：越靠角的原始折线收拢越狠，但最远点恰在圆上
const zigzagRec = recorder();
drawRouteShape(zigzagRec.ctx, parseRouteShape([[5, 50], [50, 5], [95, 50], [50, 95], [5, 50]])!, 300, 1);
for (const [x, y] of zigzagRec.pens[0]) {
  if (Math.hypot(x - 149.5, y - 149.5) > 149.5 + 1e-9) {
    throw new Error(`zigzag point (${x},${y}) escapes inscribed circle`);
  }
}
// 之字形本就在圆内（最远点 (5,50) 距中心 45 个视框单位 × 2.99 = 134.55 < 144.5）：
// 不收也不放，仍是线性映射的坐标（scale = (300-1)/100）
const zigzagScale = (300 - 1) / 100;
near(zigzagRec.pens[0][0][0], 5 * zigzagScale, 1e-9, 'zigzag x only linear-mapped');
near(zigzagRec.pens[0][0][1], 50 * zigzagScale, 1e-9, 'zigzag y only linear-mapped');

// 已在圆内的紧凑折线不放大（fit 上限 1，只收不放）
const compactRec = recorder();
drawRouteShape(compactRec.ctx, parseRouteShape([[45, 45], [55, 55]])!, S, 1);
eq(
  compactRec.pens[0],
  [
    [45 * 0.99, 45 * 0.99],
    [55 * 0.99, 55 * 0.99],
  ],
  'compact shape only linear-mapped',
);

// 单点重合折线（maxDist=0）不除零、原样映射
const degenerateRec = recorder();
drawRouteShape(degenerateRec.ctx, parseRouteShape([[50, 50], [50, 50]])!, S, 1);
eq(
  degenerateRec.pens[0],
  [
    [50 * 0.99, 50 * 0.99],
    [50 * 0.99, 50 * 0.99],
  ],
  'degenerate shape no NaN',
);

// 多段共用同一映射与同一收拢缩放：收拢后路口共点仍是同一点，且各段都在圆内
const bentRec = recorder();
const bent: RouteShape = {
  strokes: [
    [
      [0, 0],
      [100, 100],
    ],
    [
      [100, 100],
      [0, 100],
    ],
  ],
  metrics: null,
};
drawRouteShape(bentRec.ctx, bent, S, 1);
expectPenDownPerStroke(bentRec, bent.strokes);
eq(bentRec.pens[0][1], bentRec.pens[1][0], 'junction shared under shrink');
for (const pen of bentRec.pens) {
  for (const [x, y] of pen) {
    if (Math.hypot(x - centre, y - centre) > centre - halfLine + 1e-9) {
      throw new Error(`bent point (${x},${y}) escapes inscribed circle`);
    }
  }
}

// 细笔的收拢留白按细线宽算：最远点 + 半线宽 = 内切圆半径
const thinRec = recorder();
drawRouteShape(thinRec.ctx, { ...thin, strokes: [[[0, 0], [100, 100]]] }, 36, 1);
near(thinRec.ctx.lineWidth, 0.9, 1e-9, 'thin width at 36 px');
for (const [x, y] of thinRec.pens[0]) {
  near(Math.hypot(x - 17.5, y - 17.5), 17.5 - 0.9 / 2, 1e-9, 'thin stroke fits with its own half width');
}

// 导图倍率只决定分辨率：线宽按逻辑显示尺寸算（36 px 狭长往返 = 0.9），再整体放大倍率倍
const scaledRec = recorder();
drawRouteShape(scaledRec.ctx, thin, 36, 3);
near(scaledRec.ctx.lineWidth, 0.9 * 3, 1e-9, 'export scale multiplies, never re-decides the width');
for (const [x, y] of scaledRec.pens[0]) {
  if (x < 0 || y < 0 || x > 108 || y > 108) throw new Error(`scaled point (${x},${y}) off the canvas`);
}
const bigRec = recorder();
drawRouteShape(bigRec.ctx, thin, 56, 3);
near(bigRec.ctx.lineWidth, 56 * LINE_WIDTH_RATIO * 3, 1e-9, '≥56 px: regular width whatever the scale');

// ── 缓存键：label_id + 显示边长 + 形状内容 + 墨色值（任一变化 → 键变 → 失效重绘） ──
const INK = '#2c3340';
const same = routeThumbCacheKey('A1', 36, legacy, INK);
if (routeThumbCacheKey('A1', 36, parseRouteShape(V1_FROM_API)!, INK) !== same) {
  throw new Error('cache key must be stable for identical inputs');
}
if (routeThumbCacheKey('A1', 36, legacy, INK) === routeThumbCacheKey('A1', 36, multi, INK)) {
  throw new Error('cache key must differ when the shape content differs (v1 → v2 upgrade of one activity)');
}
if (routeThumbCacheKey('A1', 36, legacy, INK) === routeThumbCacheKey('A1', 72, legacy, INK)) {
  throw new Error('cache key must differ when the display size differs');
}
if (routeThumbCacheKey('A1', 36, legacy, INK) === routeThumbCacheKey('A1', 36, legacy, '#e3e2e5')) {
  throw new Error('cache key must differ when ink differs');
}
if (routeThumbCacheKey('A1', 36, legacy, INK) === routeThumbCacheKey('A2', 36, legacy, INK)) {
  throw new Error('cache key must differ when label differs');
}
// 同一段几何、指标变了（重算后收细与否不同）也是不同的图
if (
  routeThumbCacheKey('A1', 36, thin, INK) ===
  routeThumbCacheKey('A1', 36, v2With({ short: 8, long: 90, travel: 100 })!, INK)
) {
  throw new Error('cache key must differ when the width metrics differ');
}

// 墨色走主题令牌单源：合法换主题（改 routeInk 值）不应打挂本自检——这里只断言
// 缓存键随令牌值联动（上面各例已覆盖），不断言具体色值（色值对账归 theme.check.mts）。
if (typeof theme.routeInk !== 'string' || !/^#[0-9a-f]{6}$/i.test(theme.routeInk)) {
  throw new Error(`theme.routeInk 应为 hex 色值，got ${String(theme.routeInk)}`);
}

console.log('routeThumb 自检通过：形状解析（三代）/ 各段单独起笔 / 内切圆映射 / 线宽 / 缓存键');

