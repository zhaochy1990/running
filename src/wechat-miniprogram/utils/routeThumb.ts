/**
 * 轨迹缩略图矢量绘制（devops#827，#815 浅色主题发版的唯一前置；第二版多段形状
 * devops#1038，epic devops#1034）——纯函数，不碰小程序运行时；offscreen canvas、
 * 导图与缓存在 components/route-thumb。
 * `node --import ./utils/ts-resolve-hooks.mjs utils/routeThumb.check.mts` 跑自检。
 *
 * 数据契约（活动列表行的 `route_thumb`，单通道三代并存，devops#1037）：
 *  - `[[x,y],...]`：旧版单折线，≤60 点，按一段绘制、常规线宽；
 *  - `{"v":2,"strokes":[...],"start":[x,y],"end":[x,y],"short":s,"long":l,"travel":t}`：
 *    第二版多段形状，各段按时间顺序单独起笔（同一坐标存进两段 = 路口共点）。
 *    start / end 是定位序列的真实首末有效点——是位置，不是任何一段的端点：开放端
 *    保持开放，绘制端不为它们落笔，也不按距离把任何一段接到它们或彼此上。short /
 *    long / travel 是线宽指标（旋转包围矩形短边 / 长边、去重前简化轨迹总长）；
 *  - `null`：无 GPS / 未算，回退运动图标。
 * 坐标均已投影 + 归一到 [0,100]×[0,100] 方形视框（内缩 5，保纵横比）。语义参考实现：
 * `src/go/internal/thumbnail/route_v2.go`（EncodeV2 / StrokeWidth）与 `thumbnail.go`。
 */

/** 视框边长（与 Go thumbnail.Viewbox 一致）。 */
const VIEWBOX = 100;

/** 常规线宽 ≈ 尺寸/30 起步（票内口径；旧 PNG 渲染端是 size/24，视觉对齐后取档）。 */
export const LINE_WIDTH_RATIO = 1 / 30;

/** 第二版形状的版本标记（wire 对象的 `v`）；其它版本不猜格式，回退运动图标。 */
const SHAPE_VERSION = 2;

/** 视框坐标点。 */
export type RoutePoint = [number, number];

/** 解析后的可绘形状。 */
export interface RouteShape {
  /** 各段折线（视框坐标），按时间顺序；旧版单折线即唯一一段。 */
  strokes: RoutePoint[][];
  /** 第二版的线宽指标（视框单位）：旋转包围矩形短边 / 长边、去重前简化轨迹总长。
   *  旧版单折线为 null，恒按常规线宽画。 */
  metrics: { short: number; long: number; travel: number } | null;
}

/** 画路线所需的 canvas 2d 路径接口（结构类型，自检用录制 ctx 传入）。 */
export interface RoutePathCtx {
  lineWidth: number;
  lineJoin: string;
  lineCap: string;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

/**
 * 校验并收窄 wire 形状（三代通用）：数组按旧版单折线，带 `v:2` 的对象按第二版多段，
 * 非法 / 不足两点返回 null（走运动图标 fallback，与 route_thumb 缺失同口径）。
 * 后端数据宽进严出，绝不因一行坏数据抛错中断整个列表。
 */
export function parseRouteShape(raw: unknown): RouteShape | null {
  if (Array.isArray(raw)) {
    const stroke = parseStroke(raw);
    return stroke && { strokes: [stroke], metrics: null };
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const shape = raw as Record<string, unknown>;
  if (shape.v !== SHAPE_VERSION || !Array.isArray(shape.strokes) || shape.strokes.length === 0) {
    return null;
  }
  const strokes: RoutePoint[][] = [];
  for (const s of shape.strokes) {
    const stroke = parseStroke(s);
    if (!stroke) return null;
    strokes.push(stroke);
  }
  // 段或线宽指标任一残缺 = 形状不可信：整个回退运动图标，不画残缺路线（与 Go
  // DecodeV2、Web 端 decodeRouteThumb 同口径，三端对同一行给同一个答案）。
  const { short, long, travel } = shape;
  if (!isFiniteNumber(short) || !isFiniteNumber(long) || !isFiniteNumber(travel)) return null;
  return { strokes, metrics: { short, long, travel } };
}

function parseStroke(raw: unknown): RoutePoint[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const out: RoutePoint[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2 || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) {
      return null;
    }
    out.push([p[0], p[1]]);
  }
  return out;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 形状在 displaySize（逻辑像素）下的线宽，移植 Go thumbnail.StrokeWidth：只有「狭长 +
 * 往返多」的路线在小尺寸下收细，最多收 25%；边长 ≥56 px 恒常规线宽。
 */
export function routeLineWidth(shape: RouteShape, displaySize: number): number {
  const base = displaySize * LINE_WIDTH_RATIO;
  const m = shape.metrics;
  // 没有指标（旧单折线）或退化直线（short=0）永不收细：常规线宽，Go StrokeWidth 同口径。
  if (!m || m.short <= 0 || m.long <= 0) return base;
  const narrow = clamp01((0.23 - m.short / m.long) / 0.1);
  const repeat = clamp01((m.travel / m.long - 1.5) / 0.5);
  const weight = clamp01((56 - displaySize) / 20) * narrow * repeat;
  return base * (1 - 0.25 * weight);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * 把形状画到 displaySize×exportScale 见方的画布：各段单独起笔（beginPath → moveTo →
 * lineTo… → stroke），段与段之间不连线、不闭合，所以路口共点处自然相接，而 GPS 断笔
 * 与真实起终点的开放端保持开放。线宽按逻辑显示尺寸决定（routeLineWidth），导图倍率
 * 只放大画布与线宽（分辨率），不参与线宽决策。
 */
export function drawRouteShape(ctx: RoutePathCtx, shape: RouteShape, displaySize: number, exportScale: number): void {
  const lineWidth = routeLineWidth(shape, displaySize) * exportScale;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const stroke of fitRouteStrokes(shape.strokes, displaySize * exportScale, lineWidth)) {
    ctx.beginPath();
    ctx.moveTo(stroke[0][0], stroke[0][1]);
    for (let i = 1; i < stroke.length; i++) {
      ctx.lineTo(stroke[i][0], stroke[i][1]);
    }
    ctx.stroke();
  }
}

/**
 * 各段 [0,100] 视框折线 → size×size 画布像素坐标，线性映射 `x*S/100`，并把所有段作为
 * 一个整体收进内切圆：缩略图圆槽 border-radius:50% 会裁掉四角，若只做方形映射，靠角
 * 的线段会被裁断。收拢以画布中心为原点统一缩放（不是各段各缩），保证最远点 + 半线宽
 * ≤ 内切圆半径，同时各段共用的路口顶点缩放后仍是同一点。
 */
function fitRouteStrokes(strokes: RoutePoint[][], size: number, lineWidth: number): RoutePoint[][] {
  const scale = (size - 1) / VIEWBOX;
  const centre = (size - 1) / 2;
  let maxDist = 0;
  const px = strokes.map((stroke) =>
    stroke.map(([x, y]) => {
      const p: RoutePoint = [x * scale, y * scale];
      maxDist = Math.max(maxDist, Math.hypot(p[0] - centre, p[1] - centre));
      return p;
    }),
  );
  if (maxDist > 0) {
    const fit = Math.min(1, (centre - lineWidth / 2) / maxDist);
    for (const stroke of px) {
      for (const p of stroke) {
        p[0] = centre + (p[0] - centre) * fit;
        p[1] = centre + (p[1] - centre) * fit;
      }
    }
  }
  return px;
}

/**
 * 导图缓存键：label_id + 显示边长（逻辑 px）+ 形状内容 + 墨色值。导图是这四者的纯函数，
 * 任一变化键即变、缓存自动失效重绘：
 *  - 形状内容（JSON 含版本与全部段、线宽指标）：同一活动被重算后（如旧单折线升级为
 *    第二版多段）下拉刷新拿到的是新图，不会命中旧图；
 *  - 显示边长：不同尺寸的导图分辨率不同，不串用；
 *  - 墨色取 utils/theme.ts 的 routeInk（wxss 侧 --color-route-ink 镜像，theme.check.mts
 *    对账），换主题即重绘。
 */
export function routeThumbCacheKey(labelId: string, sizePx: number, shape: RouteShape, ink: string): string {
  return `${labelId}|${sizePx}|${JSON.stringify(shape)}|${ink}`;
}
