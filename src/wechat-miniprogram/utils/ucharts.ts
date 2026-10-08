/**
 * uCharts 触摸事件契约（vendored uCharts 不改，这里做事件形态转换）。
 *
 * uCharts 的 getTouches 对带 clientX 的事件按
 * `(pageY − currentTarget.offsetTop − height/dpr/2×(dpr−1)) × dpr` 换算 canvas 坐标：
 * dpr=2 时 Y 被整体削掉半个图高，图表上半部分的触摸全部落在绘图区外，表现为只有
 * 底部横轴附近能触发读数。小程序 canvas 触摸事件自带 canvas 相对坐标 x/y（typings
 * 的 TouchEvent 只声明了 clientX 形态），剥掉 clientX 只喂 x/y 即可让 uCharts 走
 * `t.x × dpr` 的精确分支。
 *
 * 注意坐标单位是画布逻辑 px（uCharts 内部再乘 pixelRatio），不是设备 px；
 * vendor/ucharts/u-charts.min.d.ts 头注释写的「设备 px」与此不符，以本文件为准。
 */

export interface UChartsTouchEvent {
  changedTouches: Array<{ x: number; y: number }>;
}

/** canvas 触摸事件 → uCharts showToolTip 事件；x/y 缺失（异常基础库）时原样退回。 */
export function toUChartsTouchEvent(
  e: WechatMiniprogram.TouchEvent,
): UChartsTouchEvent | WechatMiniprogram.TouchEvent {
  const t = (e.touches[0] ?? e.changedTouches[0]) as unknown as { x?: number; y?: number };
  if (typeof t?.x !== 'number' || typeof t?.y !== 'number') return e;
  return { changedTouches: [{ x: t.x, y: t.y }] };
}
