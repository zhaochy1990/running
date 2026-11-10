/**
 * 配速/心率三停渐变（绿 → 橙 → 红）：轨迹着色与海报配速条共用。
 * 原实现住在 activity-detail.ts（模块私有），devops#944 起抽到此处单源。
 * 颜色承载信息（绿慢红快），与主题 token（utils/theme.ts）解耦——数据
 * 可视化色板不进主题表（Epic 原则，见 theme.ts 头注）。
 */

/** 渐变端点色：绿 = 慢端（也是轨迹起终点标记的绿）、红 = 快端（终点标记）。 */
export const PACE_SLOW_GREEN = '#00a85a';
export const PACE_FAST_RED = '#d32f2f';

const GRADIENT_GREEN = PACE_SLOW_GREEN;
const GRADIENT_AMBER = '#e68a00';
const GRADIENT_RED = PACE_FAST_RED;

/** 线性插值两个 hex 颜色，t ∈ [0,1]。 */
export function lerpColor(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  const ar = parseInt(a.slice(1, 3), 16);
  const ag = parseInt(a.slice(3, 5), 16);
  const ab = parseInt(a.slice(5, 7), 16);
  const br = parseInt(b.slice(1, 3), 16);
  const bg = parseInt(b.slice(3, 5), 16);
  const bb = parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * tt);
  const g = Math.round(ag + (bg - ag) * tt);
  const bl = Math.round(ab + (bb - ab) * tt);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}

/** 3 停渐变：绿 → 橙 → 红。t=0 绿、t=0.5 橙、t=1 红；活动相对刻度
 * （同一原始值在两次活动里颜色可不同，与轨迹地图口径一致）。 */
export function gradient3(t: number): string {
  const tt = Math.max(0, Math.min(1, t));
  if (tt < 0.5) return lerpColor(GRADIENT_GREEN, GRADIENT_AMBER, tt * 2);
  return lerpColor(GRADIENT_AMBER, GRADIENT_RED, (tt - 0.5) * 2);
}
