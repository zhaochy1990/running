import Charts
import SwiftUI

/// 训练状态页（devops#768 PR-5，baseline §4.3 直译）：四指标卡 → readiness
/// 条 + 负荷 6 格 → 窗口 segmented → 六图（Swift Charts + chartOverlay tooltip）
/// → 16 周热力图（LazyVGrid 自绘格子）→ 脚注。**不带雷达/预测/PB（#756 拍板）**。
public struct TrainingStatusView: View {

    @Environment(AppModel.self) private var app
    @State private var model = TrainingStatusModel()

    public init() {}

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: app.theme.current.space(.md)) {
                if model.loading {
                    ProgressView()
                        .tint(app.theme.current.mutedTwo)
                        .frame(maxWidth: .infinity)
                        .padding(.top, app.theme.current.space(.xxxl))
                } else if !model.errorText.isEmpty {
                    errorCard
                } else {
                    content
                }
            }
            .padding(.horizontal, app.theme.current.space(.md))
            .padding(.top, app.theme.current.space(.xs))
            .padding(.bottom, app.theme.current.space(.xxl))
        }
        .background(app.theme.current.background)
        .navigationTitle("训练状态")
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("训练状态").font(app.theme.current.font(.fs15, weight: .medium))
                    Text("Threshold · Zones · Load")
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.muted)
                }
            }
        }
        .task { await model.activate(app: app) }
    }

    private var errorCard: some View {
        VStack(spacing: app.theme.current.space(.xs)) {
            Text("加载失败")
                .font(app.theme.current.font(.fs15, weight: .medium))
                .foregroundStyle(app.theme.current.muted)
            Text(model.errorText)
                .font(app.theme.current.font(.fs12))
                .foregroundStyle(app.theme.current.mutedTwo)
            Button("重试") { Task { await model.retry() } }
                .font(app.theme.current.font(.fs13, weight: .medium))
                .foregroundStyle(app.theme.current.accentDeep)
                .padding(.top, app.theme.current.space(.xs))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, app.theme.current.space(.xxxl))
    }

    // MARK: - 内容区

    @ViewBuilder
    private var content: some View {
        sectionTitle("核心指标")
        metricGrid
        sectionTitle("趋势", trailing: AnyView(windowToggle))
        chartCard(label: "静息心率 · 手表读数") {
            if model.hasRhrChart {
                TrendChartView(points: model.rhrSeries,
                               colorHex: 0x0097A7,
                               baseline: model.rhrBaseline,
                               band: nil,
                               tooltipPrefix: "RHR",
                               unitSuffix: " bpm")
            } else {
                chartEmpty("暂无 RHR 数据")
            }
        }
        chartCard(label: "心率变异性 · 手表读数") {
            if model.hasHrvChart {
                TrendChartView(points: model.hrvSeries,
                               colorHex: 0x7A4DD4,
                               baseline: nil,
                               band: model.hrvBand,
                               tooltipPrefix: "HRV",
                               unitSuffix: " ms")
            } else {
                chartEmpty("暂无 HRV 数据")
            }
        }

        if model.hasLoad {
            sectionTitle("训练负荷")
            loadCard
            chartCard(label: "每日训练负荷（Dose）") {
                if model.hasDoseChart {
                    TrendChartView(points: model.doseSeries, colorHex: 0xE68A00,
                                   tooltipPrefix: "训练负荷", unitSuffix: "")
                } else {
                    chartEmpty("暂无训练负荷数据")
                }
            }
            chartCard(label: "慢性负荷（42日 EWMA） vs 急性负荷（7日 EWMA）") {
                if model.hasLoadChart {
                    dualLoadChart
                } else {
                    chartEmpty("暂无趋势数据")
                }
            }
            chartCard(label: "竞技状态 Form（慢性负荷 − 急性负荷）") {
                if model.hasFormChart {
                    formChart
                } else {
                    chartEmpty("暂无 Form 数据")
                }
                formLegend
                if !model.currentCtlNote.isEmpty {
                    Text(model.currentCtlNote)
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.mutedTwo)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, app.theme.current.space(.xs))
                }
            }
            chartCard(label: "8 周负荷趋势") {
                if model.hasWeekChart {
                    weekChart
                } else {
                    chartEmpty("暂无周剂量数据")
                }
            }
            heatmapCard
        }
        footer
    }

    // MARK: - 指标卡

    private var metricGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: app.theme.current.space(.sm)),
                            GridItem(.flexible(), spacing: app.theme.current.space(.sm))],
                  spacing: app.theme.current.space(.sm)) {
            ForEach(model.metrics) { m in
                VStack(alignment: .leading, spacing: 3) {
                    Text(m.label)
                        .font(app.theme.current.font(.fs12, weight: .medium))
                        .foregroundStyle(app.theme.current.foreground)
                    Text(m.sub)
                        .font(app.theme.current.font(.fs10))
                        .foregroundStyle(app.theme.current.mutedTwo)
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(m.value)
                            .font(app.theme.current.font(.fs20, weight: .bold, mono: true))
                            .foregroundStyle(Tokens.color(m.color))
                        Text(m.unit)
                            .font(app.theme.current.font(.fs11))
                            .foregroundStyle(Tokens.color(m.color))
                    }
                    if !m.baseline.isEmpty {
                        Text(m.baseline)
                            .font(app.theme.current.font(.fs10))
                            .foregroundStyle(app.theme.current.mutedTwo)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(app.theme.current.space(.md))
                .background(app.theme.current.surface)
                .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
            }
        }
    }

    // MARK: - 负荷卡（6 格 + readiness）

    private var loadCard: some View {
        VStack(spacing: app.theme.current.space(.md)) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3),
                      spacing: app.theme.current.space(.md)) {
                ForEach(model.loadStats) { s in
                    VStack(spacing: 2) {
                        Text(s.label)
                            .font(app.theme.current.font(.fs11))
                            .foregroundStyle(app.theme.current.mutedTwo)
                        Text(s.value)
                            .font(app.theme.current.font(.fs15, weight: .bold, mono: true))
                            .foregroundStyle(Tokens.color(s.color))
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            HStack(spacing: app.theme.current.space(.sm)) {
                Text(model.readinessLabel)
                    .font(app.theme.current.font(.fs12, weight: .medium))
                    .foregroundStyle(Tokens.color(model.readinessColor))
                    .padding(.horizontal, app.theme.current.space(.sm))
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Tokens.color(model.readinessColor).opacity(0.12)))
                if !model.readinessReasons.isEmpty {
                    Text(model.readinessReasons)
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.muted)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    // MARK: - 窗口切换

    private var windowToggle: some View {
        Picker("窗口", selection: Binding(
            get: { model.trendDays },
            set: { model.selectWindow($0) }
        )) {
            ForEach(TrainingStatusModel.trendWindows, id: \.self) { d in
                Text("\(d)d").font(app.theme.current.font(.fs11))
                    .tag(d)
            }
        }
        .pickerStyle(.segmented)
        .frame(width: 200)
    }

    // MARK: - 慢急双折线 / Form / 周剂量

    private var dualLoadChart: some View {
        Chart {
            ForEach(Array(model.chronicSeries.enumerated()), id: \.offset) { _, p in
                if let y = p.y {
                    LineMark(x: .value("t", p.x), y: .value("v", y))
                        .foregroundStyle(Tokens.color(0x00A85A))
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.linear)
                }
            }
            ForEach(Array(model.acuteSeries.enumerated()), id: \.offset) { _, p in
                if let y = p.y {
                    LineMark(x: .value("t", p.x), y: .value("v", y))
                        .foregroundStyle(Tokens.color(0x0097A7))
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.linear)
                }
            }
        }
        .chartYScale(domain: loadDomain)
        .chartLegend {
            HStack(spacing: app.theme.current.space(.md)) {
                legendDot(0x00A85A, "慢性负荷")
                legendDot(0x0097A7, "急性负荷")
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisValueLabel(label(at: value, series: model.chronicSeries))
            }
        }
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .foregroundStyle(app.theme.current.grid)
            }
        }
        .frame(height: 120)
    }

    private var loadDomain: ClosedRange<Double> {
        let values = (model.chronicSeries + model.acuteSeries).compactMap(\.y)
        let lo = values.min() ?? 0
        let hi = values.max() ?? 1
        let bounds = padBounds(min: lo, max: hi, pad: max(1, (hi - lo) * 0.1))
        return bounds.min...max(bounds.min + 0.1, bounds.max)
    }

    private var formChart: some View {
        Chart {
            ForEach(Array(model.formSeries.enumerated()), id: \.offset) { _, p in
                if let y = p.y {
                    BarMark(x: .value("t", p.x), y: .value("v", y))
                        .foregroundStyle(Tokens.color(p.color ?? 0x8888A0))
                        .cornerRadius(1.5)
                }
            }
            RuleMark(y: .value("zero", 0))
                .foregroundStyle(app.theme.current.border)
        }
        .chartLegend(.hidden)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisValueLabel(label(at: value, series: model.formSeries))
            }
        }
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .foregroundStyle(app.theme.current.grid)
            }
        }
        .frame(height: 100)
    }

    private var weekChart: some View {
        Chart {
            ForEach(Array(model.weekSeries.enumerated()), id: \.offset) { _, p in
                if let y = p.y {
                    LineMark(x: .value("t", p.x), y: .value("v", y))
                        .foregroundStyle(Tokens.color(0xE68A00))
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.linear)
                    PointMark(x: .value("t", p.x), y: .value("v", y))
                        .foregroundStyle(Tokens.color(0xE68A00))
                        .symbolSize(20)
                }
            }
        }
        .chartLegend(.hidden)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { value in
                AxisValueLabel(label(at: value, series: model.weekSeries))
            }
        }
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .foregroundStyle(app.theme.current.grid)
            }
        }
        .frame(height: 100)
    }

    private var formLegend: some View {
        VStack(spacing: app.theme.current.space(.xs)) {
            ForEach(FormZone.allCases, id: \.self) { zone in
                HStack(spacing: app.theme.current.space(.xs)) {
                    Circle().fill(Tokens.color(zone.color)).frame(width: 6, height: 6)
                    Text(zone.legendLabel)
                        .font(app.theme.current.font(.fs10))
                        .foregroundStyle(app.theme.current.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.top, app.theme.current.space(.sm))
    }

    // MARK: - 16 周热力图（自绘格子）

    private var heatmapCard: some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.sm)) {
            Text("16 周训练热力图")
                .font(app.theme.current.font(.fs12, weight: .medium))
                .foregroundStyle(app.theme.current.muted)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 3) {
                    // 星期 gutter（一 / 三 / 五）
                    VStack(spacing: 3) {
                        Text("").font(.system(size: 9)).frame(height: 12)
                        ForEach(0..<7, id: \.self) { d in
                            Text(["一", "", "三", "", "五", "", ""][d])
                                .font(.system(size: 9))
                                .foregroundStyle(app.theme.current.mutedTwo)
                                .frame(width: 10, height: 12)
                        }
                    }
                    ForEach(model.heatWeeks) { week in
                        VStack(spacing: 3) {
                            Text(week.month)
                                .font(.system(size: 9))
                                .foregroundStyle(app.theme.current.mutedTwo)
                                .frame(width: 12, height: 12)
                            ForEach(week.cells) { cell in
                                heatCell(cell)
                            }
                        }
                    }
                }
            }

            HStack(spacing: app.theme.current.space(.xs)) {
                Text("少").font(app.theme.current.font(.fs10)).foregroundStyle(app.theme.current.mutedTwo)
                ForEach(0...4, id: \.self) { bucket in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Tokens.color(heatmapColor(bucket: bucket)))
                        .frame(width: 10, height: 10)
                }
                Text("多").font(app.theme.current.font(.fs10)).foregroundStyle(app.theme.current.mutedTwo)
            }

            if let detail = model.heatSelected {
                VStack(alignment: .leading, spacing: 3) {
                    Text(detail.title)
                        .font(app.theme.current.font(.fs12, weight: .medium))
                        .foregroundStyle(app.theme.current.foreground)
                    Text(detail.dose)
                        .font(app.theme.current.font(.fs12, mono: true))
                        .foregroundStyle(app.theme.current.accentDeep)
                    ForEach(Array(detail.lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(app.theme.current.font(.fs11))
                            .foregroundStyle(app.theme.current.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(app.theme.current.space(.sm))
                .background(RoundedRectangle(cornerRadius: app.theme.current.radius(.sm)).fill(app.theme.current.accentTint.opacity(0.5)))
            }
        }
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    private func heatCell(_ cell: HeatCell) -> some View {
        Button {
            model.selectHeatCell(cell)
        } label: {
            RoundedRectangle(cornerRadius: 2)
                .fill(heatCellColor(cell))
                .frame(width: 12, height: 12)
                .overlay {
                    if cell.isToday {
                        RoundedRectangle(cornerRadius: 2)
                            .strokeBorder(app.theme.current.accent, lineWidth: 1.2)
                    }
                    if let selected = model.heatSelected, selected.date == cell.date {
                        RoundedRectangle(cornerRadius: 2)
                            .strokeBorder(app.theme.current.foreground, lineWidth: 1.2)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(cell.state == .future)
    }

    private func heatCellColor(_ cell: HeatCell) -> Color {
        switch cell.state {
        case .active: Tokens.color(heatmapColor(bucket: heatmapBucket(dose: cell.dose)))
        case .rest: Tokens.color(heatmapColor(bucket: 0))
        case .unknown: app.theme.current.borderSoft
        case .absent: app.theme.current.borderSoft.opacity(0.5)
        case .future: Color.clear
        }
    }

    // MARK: - 脚注 / 通用件

    private var footer: some View {
        VStack(spacing: 2) {
            Text(model.calibrationLine)
            Text(model.loadDateLine)
            Text("RHR / HRV: 来自手表原始读数（COROS / Garmin）")
        }
        .font(app.theme.current.font(.fs10))
        .foregroundStyle(app.theme.current.mutedTwo)
        .frame(maxWidth: .infinity)
        .padding(.top, app.theme.current.space(.sm))
    }

    private func sectionTitle(_ title: String, trailing: AnyView? = nil) -> some View {
        HStack {
            Text(title)
                .font(app.theme.current.font(.fs13, weight: .medium))
                .foregroundStyle(app.theme.current.foreground)
            Spacer()
            trailing
        }
    }

    private func chartCard<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.sm)) {
            Text(label)
                .font(app.theme.current.font(.fs12, weight: .medium))
                .foregroundStyle(app.theme.current.muted)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    private func chartEmpty(_ text: String) -> some View {
        Text(text)
            .font(app.theme.current.font(.fs12))
            .foregroundStyle(app.theme.current.mutedTwo)
            .frame(maxWidth: .infinity)
            .padding(.vertical, app.theme.current.space(.lg))
    }

    private func legendDot(_ hex: UInt32, _ label: String) -> some View {
        HStack(spacing: 3) {
            Circle().fill(Tokens.color(hex)).frame(width: 6, height: 6)
            Text(label).font(app.theme.current.font(.fs10)).foregroundStyle(app.theme.current.muted)
        }
    }

    /// x 轴刻度取最近点位标签。
    private func label(at value: AxisValue, series: [TrendPoint]) -> String {
        guard let x = value.as(Double.self),
              let idx = series.map(\.x).firstIndex(where: { $0 >= x }), idx < series.count else {
            return series.last?.label ?? ""
        }
        return series[idx].label
    }
}

// MARK: - 趋势折线/柱通用图（RHR / HRV / 日剂量共用；tooltip chartOverlay）

struct TrendChartView: View {

    @Environment(AppModel.self) private var app

    let points: [TrendPoint]
    let colorHex: UInt32
    /// RHR 基线（虚线 RuleMark）。
    var baseline: Double?
    /// HRV 正常区间带（RectangleMark 低透明度）。
    var band: (low: Double, high: Double)?
    var tooltipPrefix: String
    var unitSuffix: String

    @State private var selected: TrendPoint?

    var body: some View {
        let bounds = axisBounds
        Chart {
            bandMarks(bounds: bounds)
            if let baseline {
                RuleMark(y: .value("baseline", baseline))
                    .foregroundStyle(app.theme.current.mutedTwo.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
            }
            ForEach(Array(points.enumerated()), id: \.offset) { _, p in
                if let y = p.y {
                    LineMark(x: .value("t", p.x), y: .value("v", y))
                        .foregroundStyle(Tokens.color(colorHex))
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.linear)
                }
            }
            if let selected {
                PointMark(x: .value("t", selected.x), y: .value("v", selected.y ?? 0))
                    .foregroundStyle(Tokens.color(colorHex))
                    .symbolSize(36)
            }
        }
        .chartYScale(domain: bounds.min...max(bounds.min + 0.1, bounds.max))
        .chartLegend(.hidden)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisValueLabel(xLabel(at: value))
            }
        }
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .foregroundStyle(app.theme.current.grid)
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { g in
                                selected = nearest(
                                    at: g.location.x - geometry[proxy.plotAreaFrame].minX,
                                    proxy: proxy
                                )
                            }
                            .onEnded { _ in selected = nil }
                    )
            }
        }
        .overlay(alignment: .top) { tooltip }
        .frame(height: 120)
    }

    private var axisBounds: (min: Double, max: Double) {
        var values = points.compactMap(\.y)
        if let baseline { values.append(baseline) }
        if let band { values.append(band.low); values.append(band.high) }
        let lo = values.min() ?? 0
        let hi = values.max() ?? 1
        let pad = lo == hi ? 2 : (hi - lo) * 0.15
        return (lo - pad, hi + pad)
    }

    @ChartContentBuilder
    private func bandMarks(bounds: (min: Double, max: Double)) -> some ChartContent {
        if let band {
            RectangleMark(
                xStart: .value("t", points.first?.x ?? 0),
                xEnd: .value("t", points.last?.x ?? 1),
                yStart: .value("lo", min(max(band.low, bounds.min), bounds.max)),
                yEnd: .value("hi", min(max(band.high, bounds.min), bounds.max))
            )
            .foregroundStyle(Tokens.color(colorHex).opacity(0.10))
        }
    }

    @ViewBuilder
    private var tooltip: some View {
        if let selected, let y = selected.y {
            Text("\(selected.label) · \(tooltipPrefix) \(y == y.rounded() ? String(Int(y)) : String(format: "%.1f", y))\(unitSuffix)")
                .font(app.theme.current.font(.fs11, weight: .medium))
                .foregroundStyle(app.theme.current.onAccent)
                .padding(.horizontal, app.theme.current.space(.sm))
                .padding(.vertical, 2)
                .background(Capsule().fill(app.theme.current.accent))
        }
    }

    private func nearest(at x: CGFloat, proxy: ChartProxy) -> TrendPoint? {
        // 只落点在有值的点上（dose 打洞行不选中，避免 PointMark 画到 0）。
        let plottable = points.filter { $0.y != nil }
        guard !plottable.isEmpty, let t = proxy.value(atX: x, as: Double.self) else { return nil }
        if let i = plottable.map(\.x).firstIndex(where: { $0 >= t }) { return plottable[i] }
        return plottable.last
    }

    private func xLabel(at value: AxisValue) -> String {
        guard let x = value.as(Double.self),
              let i = points.map(\.x).firstIndex(where: { $0 >= x }), i < points.count else {
            return points.last?.label ?? ""
        }
        return points[i].label
    }
}
