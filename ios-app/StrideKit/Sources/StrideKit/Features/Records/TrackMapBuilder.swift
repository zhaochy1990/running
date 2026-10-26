import CoreLocation
import Foundation

// 轨迹地图数据构建（devops#766，#754 决议二 / #422/#463 渲染决议直译）。
//
// 坐标铁律：**WGS-84 直传，勿转 GCJ-02**（MapKit 中国区自动加偏；小程序的
// wgs84ToGcj02 是腾讯瓦片所需，iOS 整段不迁）。
//
// 渲染规格：
// - 抽稀 ≤600 点（stride 均匀取样 + 补末点）
// - 共享端点 8 点/段分段（相邻 polyline 共用一个端点，无视觉断缝）
// - 三色 gradient3（无/心率/配速，活动内相对，绿→橙→红，8 点 chunk 均值）
// - 起终点绿▶/红■（重合不画终点）；圈号徽标（恢复圈不计）；pause 间隙分段
// - 四周 10% padding（最小 0.0008° ≈ 90m）自适应视野；<20 有效点整图隐藏
//
// 纯函数，视图层（TrackMapView）只负责把结果喂给 MKMapView。

// MARK: - 常量

/// 三色渐变端点（数据色板，独立于主题；沿用小程序原值）。
let mapGreen: UInt32 = 0x00A85A
let mapAmber: UInt32 = 0xE68A00
let mapRed: UInt32 = 0xD32F2F

/// 抽稀后点上限。
public let maxMapPoints = 600
/// 每段 bin 长度（条）。
public let mapChunk = 8
/// 有效 GPS 点少于此数整图隐藏。
public let minMapPoints = 20
/// polyline 宽（小程序 5rpx → 2.5pt）。
public let mapLineWidth: Double = 2.5

// MARK: - 数据类型

/// 地图着色模式。
public enum MapColoring: String, CaseIterable, Sendable {
    case none
    case hr
    case pace
}

/// 轨迹点（WGS-84 原始坐标 + 着色 metric）。
public struct MapPoint: Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    /// s/km，lower = faster。
    public let pace: Double?
    public let hr: Double?

    public init(latitude: Double, longitude: Double, pace: Double? = nil, hr: Double? = nil) {
        self.latitude = latitude
        self.longitude = longitude
        self.pace = pace
        self.hr = hr
    }
}

/// 一条着色 polyline。
public struct TrackPolyline: Equatable, Sendable {
    public let points: [CLLocationCoordinate2D]
    public let color: UInt32
    public let width: Double

    public init(points: [CLLocationCoordinate2D], color: UInt32, width: Double = mapLineWidth) {
        self.points = points
        self.color = color
        self.width = width
    }

    public static func == (lhs: TrackPolyline, rhs: TrackPolyline) -> Bool {
        lhs.color == rhs.color && lhs.width == rhs.width && lhs.points.count == rhs.points.count
            && zip(lhs.points, rhs.points).allSatisfy { $0.latitude == $1.latitude && $0.longitude == $1.longitude }
    }
}

/// 地图标注（起终点 / 圈号徽标）。
public struct TrackMarker: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case start
        case end
        case lapBadge(number: Int)
    }

    public let kind: Kind
    public let coordinate: CLLocationCoordinate2D

    public init(kind: Kind, coordinate: CLLocationCoordinate2D) {
        self.kind = kind
        self.coordinate = coordinate
    }

    public static func == (lhs: TrackMarker, rhs: TrackMarker) -> Bool {
        lhs.kind == rhs.kind && lhs.coordinate.latitude == rhs.coordinate.latitude
            && lhs.coordinate.longitude == rhs.coordinate.longitude
    }
}

/// 一次活动的完整地图数据（某着色模式下；标注独立于着色，由
/// `buildMarkers` 单独给出）。
public struct TrackMapData: Equatable, Sendable {
    public let center: CLLocationCoordinate2D
    /// 含 10% padding 的自适应视野（SW / NE 对角）。
    public let fitSouthWest: CLLocationCoordinate2D
    public let fitNorthEast: CLLocationCoordinate2D
    public let polylines: [TrackPolyline]

    /// CLLocationCoordinate2D 非 Equatable，逐字段比较。
    public static func == (lhs: TrackMapData, rhs: TrackMapData) -> Bool {
        lhs.center.latitude == rhs.center.latitude && lhs.center.longitude == rhs.center.longitude
            && lhs.fitSouthWest.latitude == rhs.fitSouthWest.latitude && lhs.fitSouthWest.longitude == rhs.fitSouthWest.longitude
            && lhs.fitNorthEast.latitude == rhs.fitNorthEast.latitude && lhs.fitNorthEast.longitude == rhs.fitNorthEast.longitude
            && lhs.polylines == rhs.polylines
    }
}

// MARK: - 分段与抽稀

/// 把 timeseries 按 pause 间隙切段（timestamp 同为厘秒）；无 GPS 的点丢弃。
public func buildMapSegments(_ timeseries: [TimeseriesPoint], pauses: [Pause]?) -> [[MapPoint]] {
    let windows = (pauses ?? [])
        .compactMap { w -> (Double, Double)? in
            guard let start = w.startTs, let end = w.endTs else { return nil }
            return (start, end)
        }
        .sorted { $0.0 < $1.0 }

    var segments: [[MapPoint]] = []
    var current: [MapPoint] = []
    var pw = 0
    for p in timeseries {
        guard let ts = p.timestamp, let lat = p.gpsLat, let lon = p.gpsLon else { continue }
        while pw < windows.count && windows[pw].1 < ts { pw += 1 }
        let inPause = pw < windows.count && windows[pw].0 <= ts && ts <= windows[pw].1
        if inPause {
            if !current.isEmpty {
                segments.append(current)
                current = []
            }
            continue
        }
        current.append(MapPoint(latitude: lat, longitude: lon, pace: p.paceForColoring, hr: p.heartRate))
    }
    if !current.isEmpty { segments.append(current) }
    return segments
}

/// 线性插值两个 hex 颜色，t ∈ [0,1]。
public func lerpColor(_ a: UInt32, _ b: UInt32, t: Double) -> UInt32 {
    let tt = min(max(t, 0), 1)
    let ar = Double((a >> 16) & 0xFF), ag = Double((a >> 8) & 0xFF), ab = Double(a & 0xFF)
    let br = Double((b >> 16) & 0xFF), bg = Double((b >> 8) & 0xFF), bb = Double(b & 0xFF)
    let r = UInt32((ar + (br - ar) * tt).rounded())
    let g = UInt32((ag + (bg - ag) * tt).rounded())
    let bl = UInt32((ab + (bb - ab) * tt).rounded())
    return (r << 16) | (g << 8) | bl
}

/// 3 停渐变：绿 → 橙 → 红。活动相对——同一原始值在两次活动里颜色可不同。
public func gradient3(_ t: Double) -> UInt32 {
    let tt = min(max(t, 0), 1)
    if tt < 0.5 { return lerpColor(mapGreen, mapAmber, t: tt * 2) }
    return lerpColor(mapAmber, mapRed, t: (tt - 0.5) * 2)
}

/// 活动内相对 min/max（着色归一基准；无效值丢弃）。
struct TrackStats {
    var count = 0
    var paceMin = Double.infinity
    var paceMax = -Double.infinity
    var hrMin = Double.infinity
    var hrMax = -Double.infinity
    var minLat = Double.infinity
    var maxLat = -Double.infinity
    var minLng = Double.infinity
    var maxLng = -Double.infinity

    mutating func add(_ p: MapPoint) {
        count += 1
        if let pace = p.pace, pace > 0 {
            paceMin = min(paceMin, pace)
            paceMax = max(paceMax, pace)
        }
        if let hr = p.hr, hr > 0 {
            hrMin = min(hrMin, hr)
            hrMax = max(hrMax, hr)
        }
        minLat = min(minLat, p.latitude)
        maxLat = max(maxLat, p.latitude)
        minLng = min(minLng, p.longitude)
        maxLng = max(maxLng, p.longitude)
    }
}

/// 一个 chunk 的均值 metric → 颜色（配速慢→绿、快→红，与心率反向）。
func chunkColor(_ chunk: [MapPoint], coloring: MapColoring, stats: TrackStats) -> UInt32 {
    var sum = 0.0
    var n = 0
    for p in chunk {
        let v = coloring == .hr ? p.hr : p.pace
        if let v, v > 0 {
            sum += v
            n += 1
        }
    }
    guard n > 0 else { return mapGreen }
    let avg = sum / Double(n)
    if coloring == .hr {
        let range = stats.hrMax - stats.hrMin
        return gradient3(range > 0 ? (avg - stats.hrMin) / range : 0)
    }
    let range = stats.paceMax - stats.paceMin
    return gradient3(range > 0 ? (stats.paceMax - avg) / range : 0)
}

/// 抽稀：按 stride 均匀取样 + 补本段末点（stride 由全部段的总点数决定，
/// 保证整图 ≤maxMapPoints；末点补齐让段边界精确落在真实端点）。
func decimate(_ points: [MapPoint], stride: Int) -> [MapPoint] {
    guard stride > 1 else { return points }
    var out = points.indices.filter { $0 % stride == 0 }.map { points[$0] }
    if let last = points.last, out.last != last { out.append(last) }
    return out
}

/// 某一段的 polyline 序列（共享端点 8 点窗口；none 着色整段一条绿线）。
/// 共享端点下每个窗口恒 ≥2 点（末窗 [n-k-1, n-1]），无孤立点分支。
func segmentPolylines(_ segment: [MapPoint], coloring: MapColoring, stats: TrackStats) -> [TrackPolyline] {
    guard segment.count >= 2 else { return [] }
    if coloring == .none {
        return [TrackPolyline(points: segment.map(\.coordinate), color: mapGreen)]
    }
    var lines: [TrackPolyline] = []
    var start = 0
    while start < segment.count - 1 {
        let end = min(start + mapChunk - 1, segment.count - 1)
        let chunk = Array(segment[start...end])
        lines.append(TrackPolyline(points: chunk.map(\.coordinate), color: chunkColor(chunk, coloring: coloring, stats: stats)))
        start = end // 共享端点：下一段从本段末点起
    }
    return lines
}

// MARK: - 总装

/// 组装某一着色模式下的完整地图数据。有效 GPS 点 < minMapPoints → nil（整图隐藏）。
///
/// `segments` 为 buildMapSegments 的输出；`markers`（起终点 + 圈号徽标）与
/// 着色无关，由 `buildMarkers` 单独给出（切换着色不重排标注）。
public func buildTrackMap(segments: [[MapPoint]], coloring: MapColoring) -> TrackMapData? {
    var stats = TrackStats()
    for seg in segments {
        for p in seg { stats.add(p) }
    }
    guard stats.count >= minMapPoints else { return nil }

    // 抽稀步长按有效点总数定（与小程序一致），再逐段取样补末点。
    let stride = stats.count > maxMapPoints
        ? Int(ceil(Double(stats.count) / Double(maxMapPoints)))
        : 1
    let polylines: [TrackPolyline] = segments.flatMap { segment in
        segmentPolylines(decimate(segment, stride: stride), coloring: coloring, stats: stats)
    }

    // 四周扩 10% 跨度（最小 ~0.0008° ≈ 90m），让轨迹居中、四周留白不贴边。
    let padLat = max((stats.maxLat - stats.minLat) * 0.1, 0.0008)
    let padLng = max((stats.maxLng - stats.minLng) * 0.1, 0.0008)

    return TrackMapData(
        center: CLLocationCoordinate2D(latitude: (stats.minLat + stats.maxLat) / 2,
                                       longitude: (stats.minLng + stats.maxLng) / 2),
        fitSouthWest: CLLocationCoordinate2D(latitude: stats.minLat - padLat, longitude: stats.minLng - padLng),
        fitNorthEast: CLLocationCoordinate2D(latitude: stats.maxLat + padLat, longitude: stats.maxLng + padLng),
        polylines: polylines
    )
}

/// 起终点 + 圈号徽标（有轨迹才调用）：起点 ▶ 绿、终点 ■ 红（与起点重合不画）；
/// 圈号用「累计距离占总距离的比例」映射到 timeseries 点，恢复圈不计号。
public func buildMarkers(segments: [[MapPoint]], lapSegments: [Segment], timeseries: [TimeseriesPoint]) -> [TrackMarker] {
    guard let first = segments.first?.first, let last = segments.last?.last else { return [] }
    var markers: [TrackMarker] = [
        TrackMarker(kind: .start, coordinate: first.coordinate),
    ]
    // 绕圈跑回起点时终点会和起点重合，不重叉。
    if last.latitude != first.latitude || last.longitude != first.longitude {
        markers.append(TrackMarker(kind: .end, coordinate: last.coordinate))
    }
    markers.append(contentsOf: lapBadgeMarkers(lapSegments: lapSegments, timeseries: timeseries))
    return markers
}

/// 画 RQ 风格圈号：每圈结束处一个编号徽标。
/// timeseries.distance 实测 cm、segment.distance_m 为 m，故用比例映射而非绝对值。
func lapBadgeMarkers(lapSegments: [Segment], timeseries: [TimeseriesPoint]) -> [TrackMarker] {
    struct Pt {
        let d: Double
        let coord: CLLocationCoordinate2D
    }
    let pts: [Pt] = timeseries.compactMap { p in
        guard let d = p.distance, let lat = p.gpsLat, let lon = p.gpsLon else { return nil }
        return Pt(d: d, coord: CLLocationCoordinate2D(latitude: lat, longitude: lon))
    }
    guard pts.count >= 2 else { return [] }
    let totalTs = pts[pts.count - 1].d - pts[0].d
    let totalLap = lapSegments.reduce(0) { $0 + ($1.distanceM ?? 0) }
    guard totalTs > 0, totalLap > 0 else { return [] }

    let marks = lapPaceMarks(lapSegments)
    var markers: [TrackMarker] = []
    var cum = 0.0
    var lapNo = 0
    var cursor = 0
    for i in lapSegments.indices {
        cum += lapSegments[i].distanceM ?? 0
        if marks[i].rest { continue }
        lapNo += 1
        let target = pts[0].d + (cum / totalLap) * totalTs
        while cursor < pts.count - 1 && pts[cursor].d < target { cursor += 1 }
        markers.append(TrackMarker(kind: .lapBadge(number: lapNo), coordinate: pts[cursor].coord))
    }
    return markers
}

extension MapPoint {
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}
