import Charts
import SwiftUI

/// 跑姿动态卡（devops#1041，直译小程序 components/activity/running-dynamics）：
/// 标题行（跑姿动态 + 说明开关 +「每 N 秒 · 最小–最大」）→ 可折叠帮助 → 四项指标
/// 各一张卡（全程平均 + 当前时段范围 + 分窗最小–最大竖线图）。选窗状态四图共享：
/// 点按 / 左右拖动任一图，四张卡同步切到同一时段；再点一次已选窗口回到全程。
struct RunningDynamicsCardView: View {
    @Environment(AppModel.self) private var app

    let section: DynamicsSection

    /// 选中的窗口序号；nil = 全程。
    @State private var selected: Int?
    @State private var showHelp = false

    private var theme: any Theme { app.theme.current }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if showHelp {
                help
                    .padding(.vertical, theme.space(.sm))
            }
            VStack(alignment: .leading, spacing: theme.space(.md)) {
                ForEach(section.cards) { card in
                    Card {
                        DynamicsMetricBlock(section: section, card: card, selected: selected) { select($0) }
                    }
                }
            }
        }
    }

    /// 选窗落点（mp selectAt 同款：窗口没变就不重绘，拖动中落在同一窗口的回调全部吞掉）。
    private func select(_ index: Int?) {
        guard selected != index else { return }
        selected = index
    }

    private var header: some View {
        HStack(spacing: theme.space(.xs)) {
            Text("跑姿动态")
                .font(theme.font(.fs15, weight: .bold))
                .foregroundStyle(theme.foreground)
            Button { showHelp.toggle() } label: {
                Image(systemName: "info.circle")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showHelp ? "收起跑姿动态说明" : "展开跑姿动态说明")
            Spacer(minLength: 0)
            Text("每 \(section.windowS) 秒 · 最小–最大")
                .font(theme.font(.fs12))
                .foregroundStyle(theme.muted)
                .lineLimit(1)
        }
        .padding(.horizontal, theme.space(.lg))
    }

    /// 帮助三段（mp 原文，首段强调句加重）。
    private var help: some View {
        VStack(alignment: .leading, spacing: theme.space(.xs)) {
            Text("每根竖线显示这一项指标在 \(section.windowS) 秒内的最小值和最大值。")
                + Text("线越短，这段越稳定。线越长，这段波动越大。").font(theme.font(.fs12, weight: .medium))
            Text("在配速和坡度相近时，理想情况下，步频、步幅、垂直振幅和触地时间应保持相对稳定。平路匀速跑时，如果连续几个窗口的竖线都短、位置也接近，说明这段跑姿变化较小，跑动效率较高。")
            Text("点按或左右拖动任一图，可对照同一时段的四项数据。再点一次已选窗口，即可回到全程。连续几根短线的位置如果逐渐上移或下移，也说明这项指标在逐段变化。")
        }
        .font(theme.font(.fs12))
        .foregroundStyle(theme.foregroundSoft)
        .lineSpacing(6)
        .padding(.horizontal, theme.space(.md))
        .padding(.vertical, theme.space(.sm))
        .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).fill(theme.grid))
        .padding(.horizontal, theme.space(.lg))
    }
}

/// 单项指标卡：指标名 → 全程平均 / 当前时段范围 → 分窗图。
private struct DynamicsMetricBlock: View {
    @Environment(AppModel.self) private var app

    let section: DynamicsSection
    let card: DynamicsCard
    let selected: Int?
    let onSelect: (Int?) -> Void

    private var theme: any Theme { app.theme.current }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(card.key.label)
                .font(theme.font(.fs13, weight: .medium))
                .foregroundStyle(theme.foregroundSoft)
            HStack(alignment: .bottom) {
                HStack(alignment: .firstTextBaseline, spacing: theme.space(.xs)) {
                    caption("平均")
                    Text(card.average)
                        .font(theme.font(.fs22, weight: .bold, mono: true))
                        .foregroundStyle(theme.foreground)
                    caption(card.key.unit)
                }
                Spacer(minLength: theme.space(.sm))
                VStack(alignment: .trailing, spacing: 0) {
                    HStack(alignment: .firstTextBaseline, spacing: theme.space(.xs)) {
                        Text(card.rangeText(selected: selected))
                            .font(theme.font(.fs13, weight: .medium, mono: true))
                            .foregroundStyle(theme.foreground)
                        if card.range(selected: selected) != nil {
                            caption(card.key.unit)
                        }
                    }
                    caption(section.timeLabel(selected: selected))
                }
            }
            .padding(.top, theme.space(.sm))
            .padding(.bottom, theme.space(.xs))
            DynamicsChartView(section: section, card: card, selected: selected, onSelect: onSelect)
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(theme.font(.fs12))
            .foregroundStyle(theme.muted)
    }
}

/// 分窗最小–最大竖线图（chart.ts drawDynamicsChart 的 Swift Charts 版）：每个窗口一根
/// 竖线（最小到最大，恒值退化为圆点）；选中窗口压 accentTint 竖带并加粗，其余变淡。
/// 手势沿 mp 三态：点按选窗（再点取消）、横向拖动连续选窗、纵向拖动交给页面滚动。
private struct DynamicsChartView: View {
    @Environment(AppModel.self) private var app

    let section: DynamicsSection
    let card: DynamicsCard
    let selected: Int?
    let onSelect: (Int?) -> Void

    /// 进行中的拖动；nil = 未在拖。
    @State private var drag: DragState?

    private struct DragState: Equatable {
        /// 手势起点，用来识别新的一次拖动。
        let start: CGPoint
        /// 首次位移 ≥5pt 后定向：true = 横拖选窗，false = 纵向滚动。
        var horizontal: Bool?
    }

    /// 一根竖线的绘制参数。
    private struct Mark: Identifiable {
        let index: Int
        /// 窗口中点的横轴秒数。
        let t: Double
        let low: Double
        let high: Double
        let ink: Color
        let weight: Double

        var id: Int { index }
    }

    /// 画布高（mp 216rpx）与右轴刻度区宽（mp rightInset 38pt，算线宽时扣掉）。
    private static let height: CGFloat = 108
    private static let axisInset: Double = 38

    private var theme: any Theme { app.theme.current }

    var body: some View {
        let ticks = dynamicsAxisTicks(min: card.min, max: card.max, digits: card.key.digits)
        // 刻度首尾即纵轴定义域（mp y() 同口径）；整卡数据已保证 min ≤ max，至少两格。
        if ticks.count >= 2 {
            GeometryReader { proxy in
                let plotWidth = Double(proxy.size.width) - Self.axisInset - 2
                chart(
                    ticks: ticks,
                    markWidth: dynamicsMarkWidth(plotWidth: plotWidth, durationS: section.durationS, windowS: section.windowS)
                )
            }
            .frame(height: Self.height)
            // 选窗靠手势，VoiceOver 读不到图内竖线：合并成一个元素，值报当前时段范围。
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(card.key.label)每 \(section.windowS) 秒最小值和最大值")
            .accessibilityValue("\(card.rangeText(selected: selected)) \(card.key.unit)，\(section.timeLabel(selected: selected))")
        }
    }

    private func chart(ticks: [Double], markWidth: Double) -> some View {
        let duration = section.durationS
        let domain = ticks[0]...ticks[ticks.count - 1]
        let marks = marks(markWidth: markWidth)
        let band = selected.map(section.windowBounds)
        return Chart {
            if let band {
                RectangleMark(xStart: .value("t", band.start), xEnd: .value("t", band.end))
                    .foregroundStyle(theme.accentTint)
            }
            ForEach(marks) { mark in
                if mark.low == mark.high {
                    PointMark(x: .value("t", mark.t), y: .value("v", mark.low))
                        .symbolSize(mark.weight * mark.weight * .pi / 4)
                        .foregroundStyle(mark.ink)
                } else {
                    RuleMark(x: .value("t", mark.t), yStart: .value("v", mark.high), yEnd: .value("v", mark.low))
                        .lineStyle(StrokeStyle(lineWidth: mark.weight, lineCap: .round))
                        .foregroundStyle(mark.ink)
                }
            }
        }
        .chartXScale(domain: 0...duration)
        .chartYScale(domain: domain)
        .chartYAxis {
            AxisMarks(values: ticks) { value in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 1))
                    .foregroundStyle(theme.borderSoft)
                AxisValueLabel { Text(Fmt.autoStr(value.as(Double.self))) }
            }
        }
        .chartXAxis {
            // mp timeTicks：起点左对齐、中点居中、终点右对齐。Charts 的自动排布会把中点
            // 挤偏并丢掉终点标签，这里按位置钉死锚点并关掉碰撞消解。
            AxisMarks(values: [0.0, duration / 2, duration]) { value in
                AxisValueLabel(anchor: Self.timeLabelAnchor(at: value.index), collisionResolution: .disabled) {
                    Text(formatChartTime(value.as(Double.self) ?? 0))
                }
            }
        }
        .chartLegend(.hidden)
        .chartOverlay { proxy in overlay(proxy) }
    }

    /// 每个窗口一根竖线（mp：未选窗全部 accentDeep；选中后该窗加粗到 ≥3pt，其余降到 48% 透明）。
    private func marks(markWidth: Double) -> [Mark] {
        card.windows.map { window in
            let bounds = section.windowBounds(window.index)
            let isSelected = window.index == selected
            return Mark(
                index: window.index,
                t: (bounds.start + bounds.end) / 2,
                low: window.min,
                high: window.max,
                ink: selected == nil || isSelected ? theme.accentDeep : theme.accentDeep.opacity(0.48),
                weight: isSelected ? max(markWidth, 3) : markWidth
            )
        }
    }

    private static func timeLabelAnchor(at index: Int) -> UnitPoint {
        switch index {
        case 0: .topLeading
        case 2: .topTrailing
        default: .top
        }
    }

    // MARK: - 手势

    private func overlay(_ proxy: ChartProxy) -> some View {
        GeometryReader { geometry in
            Rectangle().fill(.clear).contentShape(Rectangle())
                .onTapGesture { location in
                    let index = windowIndex(atX: location.x, proxy: proxy, geometry: geometry)
                    onSelect(index == selected ? nil : index)
                }
                .simultaneousGesture(
                    DragGesture(minimumDistance: 5)
                        .onChanged { value in dragChanged(value, proxy: proxy, geometry: geometry) }
                        .onEnded { value in dragEnded(value, proxy: proxy, geometry: geometry) }
                )
        }
    }

    /// 绘图区横坐标 → 窗口序号（mp 按时间轴比例换算，越界由 windowIndex 夹回首尾窗口）。
    /// 绘图区帧在手势回调时才取：布局完成前为 nil，不能在建视图时读。
    private func windowIndex(atX x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) -> Int? {
        guard let plot = proxy.plotFrame.map({ geometry[$0] }), plot.width > 0 else { return nil }
        return section.windowIndex(atSeconds: Double((x - plot.minX) / plot.width) * section.durationS)
    }

    private func dragChanged(_ value: DragGesture.Value, proxy: ChartProxy, geometry: GeometryProxy) {
        // 新的一次拖动按起点登记；被系统打断、没走到 onEnded 的旧状态也在这里自愈。
        if drag?.start != value.startLocation {
            drag = DragState(start: value.startLocation)
        }
        if drag?.horizontal == nil {
            let dx = abs(value.translation.width)
            let dy = abs(value.translation.height)
            guard max(dx, dy) >= 5 else { return }
            drag?.horizontal = dx >= dy
        }
        if drag?.horizontal == true, let index = windowIndex(atX: value.location.x, proxy: proxy, geometry: geometry) {
            onSelect(index)
        }
    }

    private func dragEnded(_ value: DragGesture.Value, proxy: ChartProxy, geometry: GeometryProxy) {
        defer { drag = nil }
        guard drag?.horizontal == true else { return }
        if let index = windowIndex(atX: value.location.x, proxy: proxy, geometry: geometry) {
            onSelect(index)
        }
    }
}
