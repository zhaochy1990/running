import Charts
import SwiftUI

/// 区间卡里的走势曲线（devops#766：uCharts → Swift Charts，#749 §5）：
/// LineMark 走势 + 档位基线带（RectangleMark 低透明度）+ 触摸 tooltip
/// （chartOverlay）。配速曲线纵轴取负（越快越靠上），刻度仍显示 `M'SS"`。
/// 与 uCharts 的差异：折线本体不做逐段区间着色（Charts 无四角线段图元），
/// 档位信息由基线带承载（parity ledger D-rec-4）。
struct ZoneChartView: View {

    @Environment(AppModel.self) private var app

    let series: [CurvePoint]
    let bands: [ZoneBand]
    /// 纵轴方向：心率原值；配速取负（快在上）。
    let isInverted: Bool
    /// tooltip 文案前缀（「心率」/「配速」）。
    let kindLabel: String

    @State private var selected: CurvePoint?

    init(series: [CurvePoint], bands: [ZoneBand], isInverted: Bool, kindLabel: String) {
        self.series = series
        self.bands = bands
        self.isInverted = isInverted
        self.kindLabel = kindLabel
    }

    private var plotted: [CurvePoint] {
        series.map { CurvePoint(t: $0.t, v: isInverted ? -$0.v : $0.v) }
    }

    private func tooltipText(_ p: CurvePoint) -> String {
        let value = isInverted ? -p.v : p.v
        let valueText = isInverted ? Fmt.paceQuote(value) : "\(Int(value.rounded())) bpm"
        return "\(kindLabel) \(valueText) · \(formatChartTime(p.t))"
    }

    var body: some View {
        let pts = plotted
        let bounds = axisBounds(pts.map(\.v), step: 10)
        let tMax = Swift.max(pts.map(\.t).max() ?? 0, 1)
        let sized = chart(bounds: bounds, tMax: tMax).frame(height: 120)
        return withTooltip(withGesture(sized))
    }

    // MARK: - 图

    /// 泛型分段：把长修饰链拆成独立小函数，规避类型推断超时。
    private func baseChart(bounds: (min: Double, max: Double), tMax: Double) -> some View {
        Chart {
            bandMarks(bounds: bounds, tMax: tMax)
            lineMarks
        }
        .chartYScale(domain: bounds.min...bounds.max)
        .chartLegend(.hidden)
    }

    private func withYAxis<V: View>(_ view: V) -> some View {
        view.chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 5)) { (value: AxisValue) in
                gridLine
                AxisValueLabel(yTickText(value))
            }
        }
    }

    private func withXAxis<V: View>(_ view: V) -> some View {
        view.chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { (value: AxisValue) in
                AxisValueLabel(formatChartTime(value.as(Double.self) ?? 0))
            }
        }
    }

    private func chart(bounds: (min: Double, max: Double), tMax: Double) -> some View {
        withXAxis(withYAxis(baseChart(bounds: bounds, tMax: tMax)))
    }

    private func withGesture<V: View>(_ view: V) -> some View {
        view.chartOverlay { proxy in overlayGesture(proxy) }
    }

    private func withTooltip<V: View>(_ view: V) -> some View {
        view.overlay(alignment: .top) { tooltip }
    }

    /// 虚线基线（对齐 uCharts dash 网格）。
    private var gridLine: some AxisMark {
        AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            .foregroundStyle(app.theme.current.grid)
    }

    /// 纵轴刻度文案（配速取负还原后格式化）。
    private func yTickText(_ value: AxisValue) -> String {
        let v = value.as(Double.self) ?? 0
        return isInverted ? Fmt.paceQuote(-v) : String(Int(v.rounded()))
    }

    /// 档位基线带（开放边夹回纵轴边界）。
    @ChartContentBuilder
    private func bandMarks(bounds: (min: Double, max: Double), tMax: Double) -> some ChartContent {
        ForEach(Array(bands.enumerated()), id: \.offset) { _, band in
            let lo: Double = clamped(band.lo, to: bounds)
            let hi: Double = clamped(band.hi, to: bounds)
            RectangleMark(
                xStart: .value("t", 0),
                xEnd: .value("t", tMax),
                yStart: .value("v", lo),
                yEnd: .value("v", hi)
            )
            .foregroundStyle(Tokens.color(band.color).opacity(0.10))
        }
    }

    /// 走势折线（uCharts 基础色 = CURVE_FALLBACK_COLOR 主题粉）。
    /// 局部 let 显式 Double：LineMark 的 Plottable 泛型不显式化会拖垮类型推断。
    @ChartContentBuilder
    private var lineMarks: some ChartContent {
        ForEach(Array(plotted.enumerated()), id: \.offset) { _, p in
            let x: Double = p.t
            let y: Double = p.v
            LineMark(x: .value("t", x), y: .value("v", y))
                .foregroundStyle(Tokens.color(0xFFB3AF))
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
                .interpolationMethod(.linear)
        }
    }

    // MARK: - 手势与 tooltip

    private func overlayGesture(_ proxy: ChartProxy) -> some View {
        GeometryReader { geometry in
            Rectangle().fill(.clear).contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { g in
                            selected = nearestPoint(
                                at: g.location.x - geometry[proxy.plotAreaFrame].minX,
                                proxy: proxy
                            )
                        }
                        .onEnded { _ in selected = nil }
                )
        }
    }

    @ViewBuilder
    private var tooltip: some View {
        let theme = app.theme.current
        if let selected {
            Text(tooltipText(selected))
                .font(theme.font(.fs11, weight: .medium))
                .foregroundStyle(theme.onAccent)
                .padding(.horizontal, theme.space(.sm))
                .padding(.vertical, 2)
                .background(Capsule().fill(theme.accent))
        }
    }

    /// 手势 x 位置 → 最近采样点。
    private func nearestPoint(at x: CGFloat, proxy: ChartProxy) -> CurvePoint? {
        guard let t = proxy.value(atX: x, as: Double.self), !plotted.isEmpty else { return nil }
        if let i = plotted.map(\.t).firstIndex(where: { $0 >= t }) { return plotted[i] }
        return plotted.last
    }

    /// 档位开放边（±Infinity）夹回纵轴边界，RectangleMark 才有界。
    private func clamped(_ v: Double, to bounds: (min: Double, max: Double)) -> Double {
        guard v.isFinite else { return v < 0 ? bounds.min : bounds.max }
        return min(max(v, bounds.min), bounds.max)
    }
}
