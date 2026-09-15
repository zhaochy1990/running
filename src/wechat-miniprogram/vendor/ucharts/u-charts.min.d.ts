/**
 * uCharts（原生小程序版，Apache-2.0，见同目录 README）最小类型声明：
 * 只声明本项目用到的构造 + 触摸读数方法，其余走宽松类型。
 */
interface UChartsInstance {
  /** 画布坐标（设备 px）相对位置，用于显示 tooltip / 十字线。 */
  showToolTip(
    e: unknown,
    option?: {
      index?: number;
      formatter?: (item: { name: string; data: number }, category: string, index: number, opts: unknown) => string;
    },
  ): void;
  /** 换数据重绘（保留滚动位置）。 */
  updateData(data: Record<string, unknown>): void;
}

declare const UCharts: new (opts: Record<string, unknown>) => UChartsInstance;

export default UCharts;
