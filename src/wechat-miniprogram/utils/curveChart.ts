/**
 * 走势曲线（心率 / 配速）的 uCharts 渲染层。
 * 与 `curve.ts` 分开是为了让数据 / 配置逻辑能在 node 里跑自检（`utils/curve.check.mts`）。
 */
import { fmtPaceQuote } from './format';
import { buildChartOptions, type CurveChartSpec, type CurvePoint, type ZoneBand } from './curve';
import UCharts from '../vendor/ucharts/u-charts.min';

export type CurveChart = InstanceType<typeof UCharts>;

/** 曲线 canvas 节点（lib 无 DOM 类型，只声明用到的部分）。 */
export interface CurveCanvas {
  width: number;
  height: number;
  getContext(type: string): unknown;
}

/** 心率曲线：纵轴 bpm，值越大越靠上。 */
export function hrChartSpec(series: CurvePoint[], bands: ZoneBand[]): CurveChartSpec {
  return {
    id: '#hr-curve',
    series,
    bands,
    plot: (v) => v,
    step: 10,
    yFormatter: (v) => `${Math.round(v)}`,
    tooltip: (v, time) => `心率 ${Math.round(v)} bpm · ${time}`,
  };
}

/** 配速曲线：纵轴取负的 s/km，越快越靠上；刻度仍显示 `M'SS"`。 */
export function paceChartSpec(series: CurvePoint[], bands: ZoneBand[]): CurveChartSpec {
  return {
    id: '#pace-curve',
    series,
    bands,
    plot: (v) => -v,
    step: 10,
    yFormatter: (v) => fmtPaceQuote(-v),
    tooltip: (v, time) => `配速 ${fmtPaceQuote(-v)}/km · ${time}`,
  };
}

/** 建一个折线图实例。uCharts 按设备像素绘制，所以 canvas 尺寸与绘制宽高都乘 dpr。 */
export function createCurveChart(
  spec: CurveChartSpec,
  canvas: CurveCanvas,
  width: number,
  height: number,
  dpr: number,
): CurveChart {
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  return new UCharts({
    ...buildChartOptions(spec, width, height, dpr),
    context: canvas.getContext('2d'),
  });
}
