/**
 * 轨迹缩略图矢量绘制（devops#827，#815 浅色主题发版的唯一前置）——纯函数，
 * 不碰小程序运行时；offscreen canvas 与导图缓存在 components/route-thumb。
 * `node --import ./utils/ts-resolve-hooks.mjs utils/routeThumb.check.mts` 跑自检。
 *
 * 数据契约（后端现成，零后端改动）：活动列表行的 `route_thumb` 是
 * `[[x,y],...]` 折线，≤60 点，已投影 + 归一到 [0,100]×[0,100] 方形视框
 * （内缩 5，保纵横比），`null` = 无 GPS / 未算。语义参考实现：
 * `src/go/internal/thumbnail/thumbnail.go`（Viewbox/Padding 常量与归一逻辑）。
 */

/** 视框边长（与 Go thumbnail.Viewbox 一致）。 */
export const VIEWBOX = 100;

/** 线宽 ≈ 尺寸/30 起步（票内口径；旧 PNG 渲染端是 size/24，视觉对齐后取档）。 */
export const LINE_WIDTH_RATIO = 1 / 30;

/**
 * 校验并收窄 wire 形状的折线：每点是 [有限数, 有限数]，点数 ≥2 才可画；
 * 非法 / 不足两点返回 null（走运动图标 fallback，与 route_thumb 缺失同口径）。
 * 后端数据宽进严出，绝不因一行坏数据抛错中断整个列表。
 */
export function parseRouteShape(raw: unknown): number[][] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const out: number[][] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = p[0];
    const y = p[1];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    out.push([x, y]);
  }
  return out;
}

/**
 * [0,100] 视框折线 → size×size 画布像素坐标，线性映射 `x*S/100`，并把整条
 * 折线收进内切圆：缩略图圆槽 border-radius:50% 会裁掉四角，若只做方形映射，
 * 靠角的线段会被裁断（旧 PNG 渲染端 RenderPNG 同样做了内切圆收拢，此为
 * 「形状与旧 PNG 一致」验收的一部分）。收拢以画布中心为原点整体缩放，
 * 保证最远点 + 半线宽 ≤ 内切圆半径。
 */
export function fitRoutePoints(shape: number[][], size: number): Array<[number, number]> {
  const scale = (size - 1) / VIEWBOX;
  const centre = (size - 1) / 2;
  const halfLine = (size * LINE_WIDTH_RATIO) / 2;
  const px = shape.map(([x, y]) => [x * scale, y * scale] as [number, number]);
  let maxDist = 0;
  for (const [x, y] of px) {
    maxDist = Math.max(maxDist, Math.hypot(x - centre, y - centre));
  }
  if (maxDist > 0) {
    const fit = Math.min(1, (centre - halfLine) / maxDist);
    for (const p of px) {
      p[0] = centre + (p[0] - centre) * fit;
      p[1] = centre + (p[1] - centre) * fit;
    }
  }
  return px;
}

/** 导图缓存键：label_id + 墨色值 —— 主题令牌一变 key 即变，缓存自动失效重绘。
 * 墨色取 utils/theme.ts 的 routeInk（wxss 侧 --color-route-ink 镜像，
 * theme.check.mts 对账），深色对应值存档于 styles/theme-dark.wxss。 */
export function routeThumbCacheKey(labelId: string, ink: string): string {
  return `${labelId}|${ink}`;
}
