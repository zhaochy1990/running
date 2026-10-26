import SwiftUI

/// 活动详情（devops#766，baseline §3.1 直译）：
/// 头部（类型 chip/名称/日期/类型/体感）→ 轨迹地图（三色切换/天气浮层）→
/// 主指标网格（跑步 9 项/力量 4 项）→ 心率/配速区间卡（走势曲线 + 区间条）→
/// 圈速表（最快最慢高亮/环比箭头/恢复圈）或力量分组表 → 训练反馈 → AI 点评。
/// 404 与网络失败统一「未找到」（无重试）；数据不足逐块隐藏。
public struct ActivityDetailView: View {

    @Environment(AppModel.self) private var app
    @State private var model: ActivityDetailModel

    public init(labelId: String) {
        _model = State(initialValue: ActivityDetailModel(labelId: labelId))
    }

    public var body: some View {
        Group {
            switch model.state {
            case .loading:
                StateCardView(title: nil, text: "加载中…", showSpinner: true)
            case .notFound:
                StateCardView(
                    title: "未找到该训练记录",
                    text: "可能已删除或同步发生错误",
                    actionTitle: "返回",
                    action: { app.router.pop() }
                )
            case .loaded:
                content
            }
        }
        .background(app.theme.current.background)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(model.header.name.isEmpty ? "活动详情" : model.header.name)
                        .font(app.theme.current.font(.fs13, weight: .medium))
                        .lineLimit(1)
                    if !model.header.dateLabel.isEmpty {
                        Text(model.header.dateLabel)
                            .font(app.theme.current.font(.fs10))
                            .foregroundStyle(app.theme.current.mutedTwo)
                    }
                }
            }
        }
        .task { await model.activate(app: app) }
    }

    // MARK: - 内容

    private var content: some View {
        ScrollView {
            VStack(spacing: app.theme.current.space(.md)) {
                headerRow
                if let map = model.map {
                    TrackMapCardView(
                        map: map,
                        markers: model.markers,
                        coloring: model.coloring,
                        onColoringChange: { model.setColoring($0) },
                        weather: { model.weather }
                    )
                }
                if !model.metrics.isEmpty {
                    MetricsGridView(metrics: model.metrics)
                }
                if !model.hrZones.isEmpty || model.hrSeries.count > 1 {
                    ZoneCardView(
                        title: "心率区间",
                        series: model.hrSeries,
                        bands: model.hrBands,
                        zones: model.hrZones,
                        isInverted: false,
                        kindLabel: "心率"
                    )
                }
                if !model.paceZones.isEmpty || model.paceSeries.count > 1 {
                    ZoneCardView(
                        title: "配速区间",
                        series: model.paceSeries,
                        bands: model.paceBands,
                        zones: model.paceZones,
                        isInverted: true,
                        kindLabel: "配速"
                    )
                }
                if model.hasSegments {
                    if model.laps.isEmpty {
                        StrengthGroupsView(groups: model.strengthGroups)
                    } else {
                        LapsTableView(laps: model.laps)
                    }
                }
                if !model.feelNote.isEmpty || !model.sportNote.isEmpty {
                    FeedbackCardView(
                        feelEmoji: model.header.feelEmoji,
                        feelNote: model.feelNote,
                        sportNote: model.sportNote
                    )
                }
                if let commentary = model.commentary {
                    Card {
                        VStack(alignment: .leading, spacing: app.theme.current.space(.xs)) {
                            cardTitle("教练简评")
                            Text(commentary)
                                .font(app.theme.current.font(.fs13))
                                .foregroundStyle(app.theme.current.foregroundSoft)
                        }
                    }
                }
            }
            .padding(.horizontal, app.theme.current.space(.md))
            .padding(.bottom, app.theme.current.space(.xxl))
        }
    }

    /// 头部：运动类型 chip + 训练类型 + 体感 emoji（名称/日期在顶栏）。
    private var headerRow: some View {
        HStack(spacing: app.theme.current.space(.sm)) {
            Text(model.header.sportLabel)
                .font(app.theme.current.font(.fs11, weight: .medium))
                .foregroundStyle(app.theme.current.accentDeep)
                .padding(.horizontal, app.theme.current.space(.sm))
                .padding(.vertical, 3)
                .background(Capsule().fill(app.theme.current.accentTint))
            if !model.header.trainTypeLabel.isEmpty {
                Text(model.header.trainTypeLabel)
                    .font(app.theme.current.font(.fs12))
                    .foregroundStyle(app.theme.current.muted)
            }
            if !model.header.feelEmoji.isEmpty {
                Text(model.header.feelEmoji)
                    .font(app.theme.current.font(.fs14))
            }
            Spacer()
        }
    }

    private func cardTitle(_ text: String) -> some View {
        Text(text)
            .font(app.theme.current.font(.fs13, weight: .medium))
            .foregroundStyle(app.theme.current.foreground)
    }
}

// MARK: - 通用卡片

struct Card<Content: View>: View {
    @Environment(AppModel.self) private var app
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(app.theme.current.space(.lg))
            .background(
                RoundedRectangle(cornerRadius: app.theme.current.radius(.md))
                    .fill(app.theme.current.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: app.theme.current.radius(.md))
                    .strokeBorder(app.theme.current.borderSoft)
            )
    }
}

/// 三态卡（loading / 未找到）。
struct StateCardView: View {
    @Environment(AppModel.self) private var app

    let title: String?
    let text: String
    var showSpinner = false
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: app.theme.current.space(.md)) {
            if showSpinner {
                ProgressView().tint(app.theme.current.accent)
            }
            if let title {
                Text(title)
                    .font(app.theme.current.font(.fs15, weight: .medium))
                    .foregroundStyle(app.theme.current.foreground)
            }
            Text(text)
                .font(app.theme.current.font(.fs13))
                .foregroundStyle(app.theme.current.muted)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(app.theme.current.font(.fs13, weight: .medium))
                    .foregroundStyle(app.theme.current.accentDeep)
                    .padding(.horizontal, app.theme.current.space(.xl))
                    .padding(.vertical, app.theme.current.space(.xs))
                    .background(Capsule().strokeBorder(app.theme.current.accent))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 轨迹地图卡

/// 地图 + 天气浮层（左上）+ 着色 segmented（右上）。
struct TrackMapCardView: View {
    @Environment(AppModel.self) private var app

    let map: TrackMapData
    let markers: [TrackMarker]
    let coloring: MapColoring
    let onColoringChange: (MapColoring) -> Void
    let weather: () -> [ActivityDetailModel.WeatherItem]

    var body: some View {
        ZStack(alignment: .topLeading) {
            TrackMapView(map: map, markers: markers)
                .frame(height: 230)
                .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
                .allowsHitTesting(true)

            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(weather()) { item in
                        HStack(spacing: 3) {
                            Image(systemName: item.systemImage)
                                .font(.system(size: 10))
                            Text(item.value)
                                .font(app.theme.current.font(.fs10))
                        }
                        .foregroundStyle(app.theme.current.foregroundSoft)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(.ultraThinMaterial))
                    }
                }
                Spacer()
                // segmented 着色切换（重建 polyline，对齐小程序 map-toggle）。
                HStack(spacing: 2) {
                    toggle("配速", .pace)
                    toggle("HR", .hr)
                    toggle("无色", .none)
                }
                .padding(2)
                .background(Capsule().fill(.ultraThinMaterial))
            }
            .padding(app.theme.current.space(.xs))
        }
    }

    private func toggle(_ label: String, _ value: MapColoring) -> some View {
        Button {
            onColoringChange(value)
        } label: {
            Text(label)
                .font(app.theme.current.font(.fs10, weight: coloring == value ? .medium : .regular))
                .foregroundStyle(coloring == value ? app.theme.current.onAccent : app.theme.current.foregroundSoft)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(
                    Capsule().fill(coloring == value ? app.theme.current.accent : Color.clear)
                )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 主指标网格

struct MetricsGridView: View {
    @Environment(AppModel.self) private var app
    let metrics: [ActivityDetailModel.Metric]

    private func color(_ c: ActivityDetailModel.Metric.ValueColor) -> Color {
        let theme = app.theme.current
        // 数据语义色（浅底）：跑量/配速 绿、时长 青、心率 红（parity D-rec-2 映射）。
        switch c {
        case .run, .pace: return .green
        case .duration: return .teal
        case .hr: return theme.danger
        case .none: return theme.foreground
        }
    }

    var body: some View {
        Card {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: app.theme.current.space(.md)), count: 3), spacing: app.theme.current.space(.lg)) {
                ForEach(metrics) { metric in
                    VStack(spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 1) {
                            Text(metric.value)
                                .font(app.theme.current.font(.fs18, weight: .bold, mono: true))
                                .foregroundStyle(color(metric.color))
                            if let unit = metric.unit {
                                Text(unit)
                                    .font(app.theme.current.font(.fs10))
                                    .foregroundStyle(app.theme.current.muted)
                            }
                        }
                        Text(metric.label)
                            .font(app.theme.current.font(.fs11))
                            .foregroundStyle(app.theme.current.muted)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }
}

// MARK: - 区间卡

struct ZoneCardView: View {
    @Environment(AppModel.self) private var app

    let title: String
    let series: [CurvePoint]
    let bands: [ZoneBand]
    let zones: [ZoneBar]
    let isInverted: Bool
    let kindLabel: String

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: app.theme.current.space(.md)) {
                Text(title)
                    .font(app.theme.current.font(.fs13, weight: .medium))
                    .foregroundStyle(app.theme.current.foreground)
                if series.count > 1 {
                    ZoneChartView(series: series, bands: bands, isInverted: isInverted, kindLabel: kindLabel)
                }
                ForEach(zones) { zone in
                    HStack(spacing: app.theme.current.space(.sm)) {
                        Text(zone.label)
                            .font(app.theme.current.font(.fs11))
                            .foregroundStyle(app.theme.current.muted)
                            .frame(width: 84, alignment: .leading)
                        GeometryReader { proxy in
                            ZStack(alignment: .leading) {
                                Capsule().fill(app.theme.current.grid)
                                Capsule()
                                    .fill(Tokens.color(zone.color))
                                    .frame(width: max(proxy.size.width * zone.percent / 100, zone.percent > 0 ? 4 : 0))
                            }
                        }
                        .frame(height: 6)
                        Text(zone.duration)
                            .font(app.theme.current.font(.fs11, mono: true))
                            .foregroundStyle(app.theme.current.muted)
                            .frame(width: 44, alignment: .trailing)
                    }
                }
            }
        }
    }
}

// MARK: - 圈速表

struct LapsTableView: View {
    @Environment(AppModel.self) private var app
    let laps: [LapRow]

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: app.theme.current.space(.xs)) {
                Text("分段数据")
                    .font(app.theme.current.font(.fs13, weight: .medium))
                    .foregroundStyle(app.theme.current.foreground)

                // 表头（圈数/时间/距离/平均配速/平均心率/平均步频）
                lapRow(
                    index: Text("圈数").font(app.theme.current.font(.fs10)),
                    duration: "时间",
                    distance: "距离",
                    pace: "平均配速",
                    hr: "平均心率",
                    cadence: "平均步频",
                    isHeader: true
                )

                ForEach(laps) { lap in
                    lapRow(
                        index: HStack(spacing: 2) {
                            Text(lap.index)
                                .font(app.theme.current.font(.fs12, weight: .medium, mono: true))
                                .foregroundStyle(rowForeground(lap.rowClass))
                            if !lap.tag.isEmpty {
                                Text(lap.tag)
                                    .font(app.theme.current.font(.fs10))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 3)
                                    .padding(.vertical, 1)
                                    .background(Capsule().fill(app.theme.current.accent))
                            }
                        },
                        duration: lap.duration,
                        distance: lap.distanceKm,
                        pace: lap.paceMin + lap.paceSec,
                        hr: lap.hr,
                        cadence: lap.cadence,
                        isHeader: false,
                        trend: lap.paceTrend,
                        hrTrend: lap.hrTrend,
                        rowClass: lap.rowClass
                    )
                }
            }
        }
    }

    private func rowForeground(_ rowClass: LapPaceMark.RowClass) -> Color {
        switch rowClass {
        case .fastest: .green
        case .slowest: app.theme.current.danger
        case .rest: app.theme.current.mutedTwo
        case .none: app.theme.current.foreground
        }
    }

    private func lapRow(
        index: some View,
        duration: String,
        distance: String,
        pace: String,
        hr: String,
        cadence: String,
        isHeader: Bool,
        trend: LapPaceMark.Trend = .none,
        hrTrend: LapPaceMark.Trend = .none,
        rowClass: LapPaceMark.RowClass = .none
    ) -> some View {
        let theme = app.theme.current
        let primary = isHeader ? theme.mutedTwo : rowClass == .rest ? theme.mutedTwo : theme.foreground
        return HStack(spacing: 4) {
            index.frame(width: 52, alignment: .leading)
            cell(duration, color: primary, mono: true).frame(maxWidth: .infinity, alignment: .leading)
            cell(distance, color: primary, mono: true).frame(width: 44, alignment: .trailing)
            HStack(spacing: 2) {
                cell(pace, color: paceColor(rowClass, header: isHeader), mono: true)
                trendIcon(trend)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            HStack(spacing: 2) {
                cell(hr, color: primary, mono: true)
                trendIcon(hrTrend, hrColored: true)
            }
            .frame(width: 62, alignment: .trailing)
            cell(cadence, color: primary, mono: true).frame(width: 44, alignment: .trailing)
        }
        .padding(.vertical, 3)
        .padding(.horizontal, app.theme.current.space(.xs))
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(rowBackground(rowClass))
        )
    }

    private func cell(_ text: String, color: Color, mono: Bool) -> some View {
        Text(text)
            .font(app.theme.current.font(.fs11, mono: mono))
            .foregroundStyle(color)
    }

    private func paceColor(_ rowClass: LapPaceMark.RowClass, header: Bool) -> Color {
        if header { return app.theme.current.mutedTwo }
        switch rowClass {
        case .fastest: return .green
        case .slowest: return app.theme.current.danger
        default: return app.theme.current.foreground
        }
    }

    private func rowBackground(_ rowClass: LapPaceMark.RowClass) -> Color {
        switch rowClass {
        case .fastest: return Color.green.opacity(0.08)
        case .slowest: return app.theme.current.danger.opacity(0.08)
        default: return .clear
        }
    }

    /// 环比箭头：配速涨绿降红（快=好），心率涨红降绿（数据方向）。
    @ViewBuilder
    private func trendIcon(_ trend: LapPaceMark.Trend, hrColored: Bool = false) -> some View {
        if trend != .none {
            Image(systemName: trend == .up ? "arrow.up.right" : "arrow.down.right")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(trendColor(trend, hrColored: hrColored))
        }
    }

    private func trendColor(_ trend: LapPaceMark.Trend, hrColored: Bool) -> Color {
        guard hrColored else {
            return trend == .up ? .green : app.theme.current.danger
        }
        return trend == .up ? app.theme.current.danger : .green
    }
}

// MARK: - 力量分组表

struct StrengthGroupsView: View {
    @Environment(AppModel.self) private var app
    let groups: [ExerciseGroup]

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: app.theme.current.space(.sm)) {
                Text("动作组")
                    .font(app.theme.current.font(.fs13, weight: .medium))
                    .foregroundStyle(app.theme.current.foreground)
                ForEach(groups) { group in
                    HStack(alignment: .firstTextBaseline) {
                        Text(group.name)
                            .font(app.theme.current.font(.fs13, weight: .medium))
                            .foregroundStyle(app.theme.current.foreground)
                        Spacer()
                        HStack(spacing: 2) {
                            Text("\(group.sets) 组")
                            Text(" · \(group.duration)")
                            if group.avgHr != "—" {
                                Text(" · \(group.avgHr) bpm")
                            }
                        }
                        .font(app.theme.current.font(.fs11, mono: true))
                        .foregroundStyle(app.theme.current.muted)
                    }
                }
            }
        }
    }
}

// MARK: - 训练反馈

struct FeedbackCardView: View {
    @Environment(AppModel.self) private var app

    let feelEmoji: String
    let feelNote: String
    let sportNote: String

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: app.theme.current.space(.xs)) {
                Text("训练反馈\(feelEmoji.isEmpty ? "" : " \(feelEmoji)")")
                    .font(app.theme.current.font(.fs13, weight: .medium))
                    .foregroundStyle(app.theme.current.foreground)
                if !feelNote.isEmpty {
                    Text(feelNote)
                        .font(app.theme.current.font(.fs13))
                        .foregroundStyle(app.theme.current.foregroundSoft)
                }
                if !sportNote.isEmpty {
                    Text(sportNote)
                        .font(app.theme.current.font(.fs13))
                        .foregroundStyle(app.theme.current.foregroundSoft)
                }
            }
        }
    }
}
