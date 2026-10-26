import Foundation
import Observation

// 活动详情 ViewModel（devops#766，baseline §3.1 直译）：
// 404 与网络失败统一「未找到」（无重试）；力量活动走力量 4 项 + 分组表、
// 不渲染地图；数据不足的块逐块隐藏；着色切换只重建 polyline 不动标注。

@MainActor
@Observable
public final class ActivityDetailModel {

    // MARK: - 视图数据

    public enum State: Equatable, Sendable {
        case loading
        case notFound
        case loaded
    }

    public struct Header: Equatable, Sendable {
        public let sportLabel: String
        public let name: String
        public let dateLabel: String
        public let trainTypeLabel: String
        public let feelEmoji: String
    }

    public struct Metric: Equatable, Identifiable, Sendable {
        public enum ValueColor: Equatable, Sendable {
            case run
            case duration
            case pace
            case hr
            case none
        }

        public let label: String
        public let value: String
        public let unit: String?
        public let color: ValueColor

        public var id: String { label }
    }

    public struct WeatherItem: Equatable, Identifiable, Sendable {
        public let systemImage: String
        public let value: String
        public var id: String { systemImage }
    }

    public private(set) var state: State = .loading
    public private(set) var header = Header(sportLabel: "", name: "", dateLabel: "", trainTypeLabel: "", feelEmoji: "")
    public private(set) var metrics: [Metric] = []
    public private(set) var hrZones: [ZoneBar] = []
    public private(set) var paceZones: [ZoneBar] = []
    public private(set) var hrSeries: [CurvePoint] = []
    public private(set) var paceSeries: [CurvePoint] = []
    public private(set) var hrBands: [ZoneBand] = []
    public private(set) var paceBands: [ZoneBand] = []
    public private(set) var laps: [LapRow] = []
    public private(set) var strengthGroups: [ExerciseGroup] = []
    /// 圈速表（跑步）/ 力量分组表（力量）有数据才渲染整卡。
    public private(set) var hasSegments = false
    public private(set) var sportNote = ""
    public private(set) var feelNote = ""
    public private(set) var commentary: String?
    public private(set) var weather: [WeatherItem] = []

    // —— 轨迹地图 ——
    /// nil = 隐藏地图（力量 / 室内 / <20 有效点）。
    public private(set) var map: TrackMapData?
    public private(set) var markers: [TrackMarker] = []
    public private(set) var coloring: MapColoring = .pace

    private var mapSegments: [[MapPoint]] = []
    private var lapSegments: [Segment] = []
    private var rawTimeseries: [TimeseriesPoint] = []
    private var repo: ActivitiesRepository?
    private var userId = ""
    private let labelId: String

    public init(labelId: String) {
        self.labelId = labelId
    }

    // MARK: - 生命周期

    public func activate(app: AppModel) async {
        guard repo == nil else { return }
        repo = ActivitiesRepository(api: app.api)
        await app.waitUntilSessionSettled()
        userId = app.me?.id ?? ""
        await fetch()
    }

    public func fetch() async {
        guard let repo, !userId.isEmpty, !labelId.isEmpty else {
            state = .notFound
            return
        }
        do {
            let detail = try await repo.detail(userId: userId, labelId: labelId)
            let view = Self.buildView(detail)
            apply(view)
            state = .loaded
        } catch {
            // 详情不存在（404）或网络失败都归到「未找到」空态。
            state = .notFound
        }
    }

    // MARK: - 交互

    /// 地图着色切换（segmented）：只重建 polyline / 视野，标注不动。
    public func setColoring(_ new: MapColoring) {
        guard new != coloring else { return }
        coloring = new
        map = buildTrackMap(segments: mapSegments, coloring: new)
    }

    // MARK: - 视图数据应用

    private func apply(_ view: ViewData) {
        header = view.header
        metrics = view.metrics
        hrZones = view.hrZones
        paceZones = view.paceZones
        hrSeries = view.hrSeries
        paceSeries = view.paceSeries
        hrBands = view.hrBands
        paceBands = view.paceBands
        laps = view.laps
        strengthGroups = view.strengthGroups
        hasSegments = view.hasSegments
        sportNote = view.sportNote
        feelNote = view.feelNote
        commentary = view.commentary
        weather = view.weather

        mapSegments = view.mapSegments
        lapSegments = view.lapSegments
        rawTimeseries = view.rawTimeseries
        coloring = .pace
        map = buildTrackMap(segments: mapSegments, coloring: .pace)
        markers = (map != nil) ? buildMarkers(segments: mapSegments, lapSegments: lapSegments, timeseries: rawTimeseries) : []
    }

    struct ViewData {
        var header: Header
        var metrics: [Metric]
        var hrZones: [ZoneBar]
        var paceZones: [ZoneBar]
        var hrSeries: [CurvePoint]
        var paceSeries: [CurvePoint]
        var hrBands: [ZoneBand]
        var paceBands: [ZoneBand]
        var laps: [LapRow]
        var strengthGroups: [ExerciseGroup]
        var hasSegments: Bool
        var sportNote: String
        var feelNote: String
        var commentary: String?
        var weather: [WeatherItem]
        var mapSegments: [[MapPoint]]
        var lapSegments: [Segment]
        var rawTimeseries: [TimeseriesPoint]
    }

    /// 组装视图（纯函数，单测面）：力量 4 项 / 跑步 9 项、区间卡、圈速 /
    /// 力量分组、天气、备注、AI 点评、轨迹分段。
    nonisolated static func buildView(_ detail: ActivityDetailResponse) -> ViewData {
        let a = detail.activity
        let isStrength = a.isStrength

        var laps: [LapRow] = []
        var strengthGroups: [ExerciseGroup] = []
        if isStrength {
            strengthGroups = buildStrengthSegments(detail.segments)
        } else {
            // v1 只展示圈速表；圈速即后端 segments（type2 手表圈/间歇组，回落 autoKm）。
            laps = buildLapRows(detail.segments)
        }

        let zones = buildZones(detail.zones)
        let timeseries = detail.timeseries ?? []
        var mapSegments: [[MapPoint]] = []
        if !isStrength {
            mapSegments = buildMapSegments(timeseries, pauses: a.pauses)
        }

        let trimmedName = a.name?.trimmingCharacters(in: .whitespaces) ?? ""
        let sportCN = SportDisplay.sportCN(a.sportName)

        return ViewData(
            header: Header(
                sportLabel: sportCN,
                name: trimmedName.isEmpty ? sportCN : trimmedName,
                dateLabel: Shanghai.dateLabel(fromISO: a.date),
                trainTypeLabel: SportDisplay.trainTypeCN(a.trainType),
                feelEmoji: SportDisplay.feelEmoji(a.feelType)
            ),
            metrics: buildMetrics(a, isStrength: isStrength),
            hrZones: zones.hr,
            paceZones: zones.pace,
            hrSeries: downsample(buildHrSeries(timeseries)),
            paceSeries: downsample(buildPaceSeries(timeseries)),
            hrBands: zones.hrBands,
            paceBands: zones.paceBands,
            laps: laps,
            strengthGroups: strengthGroups,
            hasSegments: isStrength ? !strengthGroups.isEmpty : !laps.isEmpty,
            sportNote: a.sportNote ?? "",
            feelNote: a.feelNote ?? "",
            commentary: {
                guard let c = a.commentary?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty else { return nil }
                return a.commentary
            }(),
            weather: buildWeather(a),
            mapSegments: mapSegments,
            lapSegments: detail.segments,
            rawTimeseries: timeseries
        )
    }

    /// 主指标网格：跑步 9 项 / 力量 4 项（顺序与配色沿小程序 buildMetrics）。
    nonisolated static func buildMetrics(_ a: Activity, isStrength: Bool) -> [Metric] {
        var metrics: [Metric] = []
        if !isStrength {
            metrics.append(Metric(label: "距离", value: a.distanceKm > 0 ? Fmt.autoStr(a.distanceKm) : "—", unit: "km", color: .run))
            metrics.append(Metric(label: "平均配速", value: Fmt.paceQuote(a.avgPaceSKm), unit: nil, color: .pace))
        }
        metrics.append(Metric(label: "平均心率", value: Fmt.intStr(a.avgHr), unit: "bpm", color: .hr))
        metrics.append(Metric(label: "训练负荷", value: Fmt.decimalStr(a.trainingLoad, digits: 0), unit: nil, color: .none))
        metrics.append(Metric(label: "时长", value: a.durationFmt ?? Fmt.hms(a.durationS), unit: nil, color: .duration))
        metrics.append(Metric(label: "最大心率", value: Fmt.intStr(a.maxHr), unit: "bpm", color: .hr))
        if !isStrength {
            metrics.append(Metric(label: "平均步幅", value: Fmt.stepLenM(a.avgStepLenCm), unit: "m", color: .none))
            metrics.append(Metric(label: "平均步频", value: Fmt.intStr(a.avgCadence), unit: "spm", color: .none))
            metrics.append(Metric(label: "累计爬升", value: Fmt.intStr(a.ascentM), unit: "m", color: .none))
        }
        return metrics
    }

    /// 天气行：温度（体感）/ 湿度 / 风速（SF Symbols 对应小程序 svg）。
    nonisolated static func buildWeather(_ a: Activity) -> [WeatherItem] {
        var out: [WeatherItem] = []
        if let temperature = a.temperature {
            var value = "\(Fmt.autoStr(temperature))°C"
            if let feelsLike = a.feelsLike, feelsLike != temperature {
                value += "（体感 \(Fmt.autoStr(feelsLike))°）"
            }
            out.append(WeatherItem(systemImage: "thermometer.medium", value: value))
        }
        if let humidity = a.humidity {
            out.append(WeatherItem(systemImage: "drop.fill", value: "\(Fmt.autoStr(humidity))%"))
        }
        if let wind = a.windSpeed, wind > 0 {
            out.append(WeatherItem(systemImage: "wind", value: "\(Fmt.autoStr(wind)) km/h"))
        }
        return out
    }
}
