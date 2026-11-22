import type { RunningDynamics, RunningDynamicsMetric } from '../../../types/activity';
import { fmtHms } from '../../../utils/format';
import { theme, themeRgba } from '../../../utils/theme';

const left = 2;
const rightInset = 38;

export interface DynamicsChart {
  width: number;
  height: number;
  ctx: WechatMiniprogram.CanvasRenderingContext.CanvasRenderingContext2D;
}

export function dynamicsTime(seconds: number): string {
  return seconds <= 0 ? '00:00:00' : fmtHms(seconds);
}

export function dynamicsWindowAt(x: number, width: number, summary: RunningDynamics): number {
  const ratio = Math.max(0, Math.min(1, (x - left) / (width - rightInset - left)));
  return Math.min(Math.ceil(summary.duration_s / summary.window_s) - 1, Math.floor(ratio * summary.duration_s / summary.window_s));
}

function axisTicks(min: number, max: number, digits: number): number[] {
  const increment = 10 ** -digits;
  const padding = Math.max(increment, (max - min) * 0.02);
  const target = (max - min + 2 * padding) / 4;
  const order = 10 ** Math.floor(Math.log10(target));
  const step = Math.max(increment, ([1, 2, 2.5, 5, 10].find(value => value * order >= target) ?? 10) * order);
  const start = Math.floor((min - padding) / step);
  const end = Math.ceil((max + padding) / step);
  return Array.from({ length: end - start + 1 }, (_, index) => Number(((start + index) * step).toFixed(digits + 1)));
}

export function drawDynamicsChart(
  chart: DynamicsChart, summary: RunningDynamics, metric: RunningDynamicsMetric, digits: number, selected: number | null,
): void {
  const { width, height, ctx } = chart;
  const right = width - rightInset;
  const top = 8;
  const bottom = height - 21;
  const ticks = axisTicks(metric.min, metric.max, digits);
  const x = (seconds: number) => left + seconds / summary.duration_s * (right - left);
  const y = (value: number) => bottom - (value - ticks[0]) / (ticks[ticks.length - 1] - ticks[0]) * (bottom - top);
  ctx.clearRect(0, 0, width, height);
  if (selected !== null) {
    const start = x(selected * summary.window_s);
    const end = x(Math.min(summary.duration_s, (selected + 1) * summary.window_s));
    ctx.fillStyle = theme.accentTint;
    ctx.fillRect(start, top - 4, Math.max(1, end - start), bottom - top + 8);
  }

  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.textSecondary;
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.borderSoft;
  ctx.lineCap = 'butt';
  for (const tick of ticks) {
    const level = y(tick);
    ctx.beginPath();
    ctx.moveTo(left, level);
    ctx.lineTo(right, level);
    ctx.stroke();
    ctx.fillText(String(tick), width - 1, level);
  }

  const markWidth = Math.min(2.3, Math.max(0.6, x(summary.window_s) - left - 1));
  ctx.lineCap = 'round';
  for (const range of metric.windows) {
    const start = range.index * summary.window_s;
    const end = Math.min(summary.duration_s, start + summary.window_s);
    const center = x((start + end) / 2);
    const ink = selected === null || selected === range.index ? theme.accentDeep : themeRgba(theme.accentPaleRgb, 0.48);
    const weight = selected === range.index ? Math.max(markWidth, 3) : markWidth;
    ctx.beginPath();
    if (range.min === range.max) {
      ctx.fillStyle = ink;
      ctx.arc(center, y(range.min), weight / 2, 0, 2 * Math.PI);
      ctx.fill();
    } else {
      ctx.strokeStyle = ink;
      ctx.lineWidth = weight;
      ctx.moveTo(center, y(range.max));
      ctx.lineTo(center, y(range.min));
      ctx.stroke();
    }
  }

  ctx.fillStyle = theme.textSecondary;
  const timeTicks = [
    { seconds: 0, align: 'left' },
    { seconds: summary.duration_s / 2, align: 'center' },
    { seconds: summary.duration_s, align: 'right' },
  ] as const;
  for (const tick of timeTicks) {
    ctx.textAlign = tick.align;
    ctx.fillText(dynamicsTime(tick.seconds), x(tick.seconds), height - 6);
  }
}
