/**
 * routeThumb.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/routeThumb.check.mts`。
 * 覆盖 wire 形状校验 / 视框→画布映射 / 内切圆收拢 / 缓存键；不依赖小程序运行时。
 */
import { fitRoutePoints, LINE_WIDTH_RATIO, parseRouteShape, routeThumbCacheKey, VIEWBOX } from './routeThumb.ts';
import { theme } from './theme.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}
function near(a: number, b: number, eps: number, what: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${what}: got ${a}, want ~${b} (±${eps})`);
}

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
eq(parseRouteShape([[0, 0], [100, 100]]), [[0, 0], [100, 100]], 'minimal valid shape');
// 60 点上限由后端契约保证，客户端不截断（超长只透传，绘制成本 O(n)）
const sixty = Array.from({ length: 60 }, (_, i) => [i, i]);
eq(parseRouteShape(sixty)!.length, 60, '60-point passthrough');

// ── fitRoutePoints：线性映射 + 内切圆收拢（与 Go RenderPNG 同语义） ──
// size=100 时 scale=0.99：视框角 (100,100) → (99,99)，中心 (49.5,49.5)，
// 角点半径 ≈ 70 > centre - 半线宽 → 收拢到内切圆内
const S = 100;
const fitted = fitRoutePoints([[0, 0], [100, 100]], S);
eq(fitted.length, 2, 'fit keeps point count');
const centre = (S - 1) / 2;
const halfLine = (S * LINE_WIDTH_RATIO) / 2;
for (const [x, y] of fitted) {
  near(Math.hypot(x - centre, y - centre), centre - halfLine, 1e-9, 'corner pulled to inscribed circle');
}
// 对角线端点收拢后仍在一条过中心的直线上（整体缩放不改形状）
near(
  Math.atan2(fitted[1][1] - fitted[0][1], fitted[1][0] - fitted[0][0]),
  Math.atan2(100, 100),
  1e-9,
  'diagonal direction preserved',
);

// 全部点都在内切圆内：越靠角的原始折线收拢越狠，但最远点恰在圆上
const zigzag = parseRouteShape([[5, 50], [50, 5], [95, 50], [50, 95], [5, 50]])!;
const fittedZig = fitRoutePoints(zigzag, 300);
for (const [x, y] of fittedZig) {
  if (Math.hypot(x - 149.5, y - 149.5) > 149.5 + 1e-9) {
    throw new Error(`zigzag point (${x},${y}) escapes inscribed circle`);
  }
}

// 已在圆内的紧凑折线不放大（fit 上限 1，只收不放）
const compact = fitRoutePoints([[45, 45], [55, 55]], S);
eq(compact, [[45 * 0.99, 45 * 0.99], [55 * 0.99, 55 * 0.99]], 'compact shape only linear-mapped');

// 单点重合折线（maxDist=0）不除零、原样映射
eq(fitRoutePoints([[50, 50], [50, 50]], S), [[50 * 0.99, 50 * 0.99], [50 * 0.99, 50 * 0.99]], 'degenerate shape no NaN');

// ── 缓存键：label_id + 墨色值（主题换墨 → 键变 → 失效重绘） ──
eq(routeThumbCacheKey('A1', '#2c3340'), 'A1|#2c3340', 'cache key format');
if (routeThumbCacheKey('A1', '#e3e2e5') === routeThumbCacheKey('A1', '#2c3340')) {
  throw new Error('cache key must differ when ink differs');
}
if (routeThumbCacheKey('A1', '#2c3340') === routeThumbCacheKey('A2', '#2c3340')) {
  throw new Error('cache key must differ when label differs');
}

// 墨色走主题令牌单源：合法换主题（改 routeInk 值）不应打挂本自检——这里只断言
// 缓存键随令牌值联动（上面 3 例已覆盖），不断言具体色值（色值对账归 theme.check.mts）。
if (typeof theme.routeInk !== 'string' || !/^#[0-9a-f]{6}$/i.test(theme.routeInk)) {
  throw new Error(`theme.routeInk 应为 hex 色值，got ${String(theme.routeInk)}`);
}

console.log('routeThumb 自检通过：形状校验 12 例 / 内切圆映射 5 例 / 缓存键 3 例');
