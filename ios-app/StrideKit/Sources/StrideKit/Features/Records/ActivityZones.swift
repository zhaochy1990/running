import Foundation

// 心率 / 配速区间（devops#766）：区间条 + 走势曲线共用。
// 纯函数直译小程序 `activity-detail.ts`（normalizePaceZones / formatXxxRange /
// toZoneBar / buildZones）与 `utils/curve.ts`（zoneColor / zoneBands /
// buildHrSeries / buildPaceSeries / downsample / formatChartTime / axisBounds）。

// MARK: - 配色

/// 区间配色：Z1 蓝 → Z5 红（与 COROS 一致）；超过 5 档循环补色。
/// 数据色板独立于主题（parity：沿用小程序原值，浅底同样可读）。
public let zoneColors: [UInt32] = [0x4C8DFF, 0x37C85A, 0xF5C542, 0xF5863B, 0xEF4444, 0xB45BFF, 0x9AA4B2]

public func zoneColor(_ index: Int) -> UInt32 {
    zoneColors[index % zoneColors.count]
}

// MARK: - COROS 7→6 区归一化

/// COROS 配速区间默认上报 7 个（100% 阈值配速处多拆一档），COROS App 显示 6 个：
/// 把 Z4 (94-100%) 与 Z5 (100-102%) 合并成一档，再重编号 Z6→Z5、Z7→Z6。
/// 仅当确实含 z4-z7 的 7 区间布局才合并，否则原样返回。
/// 注意边界方向：range_min=较慢边（更大 ms/km）、range_max=较快边（更小 ms/km）。
public func normalizePaceZones(_ zones: [Zone]) -> [Zone] {
    guard zones.count >= 7 else { return zones }
    let byIndex = Dictionary(zones.map { ($0.zoneIndex, $0) }, uniquingKeysWith: { a, _ in a })
    guard let z4 = byIndex[4], let z5 = byIndex[5], let z6 = byIndex[6], let z7 = byIndex[7] else {
        return zones
    }
    let merged = Zone(
        zoneType: "pace",
        zoneIndex: 4,
        rangeMin: z4.rangeMin, // 较慢边（更大 ms/km）
        rangeMax: z5.rangeMax, // 较快边（更小 ms/km）
        rangeUnit: "ms/km",
        durationS: (z4.durationS ?? 0) + (z5.durationS ?? 0),
        percent: (z4.percent ?? 0) + (z5.percent ?? 0)
    )
    func renumber(_ z: Zone, to index: Int) -> Zone {
        Zone(zoneType: z.zoneType, zoneIndex: index, rangeMin: z.rangeMin, rangeMax: z.rangeMax,
             rangeUnit: z.rangeUnit, durationS: z.durationS, percent: z.percent)
    }
    return [byIndex[1]!, byIndex[2]!, byIndex[3]!, merged, renumber(z6, to: 5), renumber(z7, to: 6)]
}

// MARK: - 区间标签

/// 心率区间标签（开放边界约定：最低恢复区与区间2共享下界 → `< min`；最高区 `≥ min`）。
func formatHRRange(_ z: Zone, peers: [Zone]) -> String {
    let min = z.rangeMin.map { Int($0.rounded()) }
    let max = z.rangeMax.map { Int($0.rounded()) }
    if min == nil && max == nil { return "" }
    if min == nil { return "< \(max!)" }
    if max == nil { return "≥ \(min!)" }
    let maxIdx = peers.map(\.zoneIndex).max() ?? 0
    if z.zoneIndex == 1, let z2 = peers.first(where: { $0.zoneIndex == 2 }),
       let z2Min = z2.rangeMin, Int(z2Min.rounded()) == min {
        return "< \(min!)"
    }
    if z.zoneIndex == maxIdx { return "≥ \(min!)" }
    return "\(min!) - \(max!)"
}

/// 配速区间标签（与心率相反：range_min=较慢边、range_max=较快边，开放边取反）。
func formatPaceRange(_ z: Zone, peers: [Zone]) -> String {
    let slow = Fmt.paceBound(z.rangeMin)
    let fast = Fmt.paceBound(z.rangeMax)
    if slow == nil && fast == nil { return "" }
    if slow == nil { return "< \(fast!)" }
    if fast == nil { return "> \(slow!)" }
    let maxIdx = peers.map(\.zoneIndex).max() ?? 0
    if z.zoneIndex == 1, let z2 = peers.first(where: { $0.zoneIndex == 2 }),
       let z2Min = z2.rangeMin, let zMin = z.rangeMin,
       Int(z2Min.rounded()) == Int(zMin.rounded()) {
        return "> \(slow!)"
    }
    if z.zoneIndex == maxIdx { return "< \(slow!)" }
    return "\(slow!) - \(fast!)"
}

/// 非高驰配速区间（单位非 ms/km）的兜底展示：原始值 + 单位。
func rawPaceRange(_ z: Zone) -> String {
    let unit = z.rangeUnit.map { " \($0)" } ?? ""
    let lo = z.rangeMin.map { String($0) } ?? ""
    let hi = z.rangeMax.map { String($0) } ?? ""
    if !lo.isEmpty && !hi.isEmpty { return "\(lo) - \(hi)\(unit)" }
    if !lo.isEmpty { return "< \(lo)\(unit)" }
    if !hi.isEmpty { return "> \(hi)\(unit)" }
    return "Z\(z.zoneIndex + 1)"
}

/// 区间条标签总入口（配速走 ms/km↔M:SS 换算，其它单位兜底原值）。
public func formatZoneRange(_ z: Zone, peers: [Zone]) -> String {
    if z.zoneType == "pace" {
        if z.rangeUnit == "ms/km" || z.rangeUnit == "pace" {
            let r = formatPaceRange(z, peers: peers)
            return r.isEmpty ? "Z\(z.zoneIndex + 1)" : "\(r)/km"
        }
        return rawPaceRange(z)
    }
    let r = formatHRRange(z, peers: peers)
    return r.isEmpty ? "Z\(z.zoneIndex + 1)" : "\(r) bpm"
}

// MARK: - 区间条 / 档位带

/// 区间条一行（区间标签 + 占比条 + 时长）。
public struct ZoneBar: Equatable, Identifiable, Sendable {
    public let key: String
    public let label: String
    /// 0-100（夹取）。
    public let percent: Double
    public let duration: String
    public let color: UInt32

    public var id: String { key }
}

public func toZoneBar(_ z: Zone, peers: [Zone], color: UInt32) -> ZoneBar {
    let percent = min(max(z.percent ?? 0, 0), 100)
    return ZoneBar(
        key: "\(z.zoneType)-\(z.zoneIndex)",
        label: formatZoneRange(z, peers: peers),
        percent: percent,
        duration: (z.durationS ?? 0) > 0 ? Fmt.durationShort(z.durationS) : "—",
        color: color
    )
}

/// 取值档位（曲线基线带用）：lo/hi 为取值边界（开放边 ±Infinity 语义）。
public struct ZoneBand: Equatable, Sendable {
    public let lo: Double
    public let hi: Double
    public let color: UInt32

    public init(lo: Double, hi: Double, color: UInt32) {
        self.lo = lo
        self.hi = hi
        self.color = color
    }
}

/// 手表 / 校准区间 → 取值→颜色档位（curve.ts zoneBands 直译）：
/// 心率 range_min < range_max；配速 range_min 是较慢边（更大值），统一成 lo < hi。
/// 手表第一档常与第二档同区间（重复值表达开放边），把第一档挪到区间外一侧。
public func zoneBands(_ zones: [Zone]) -> [ZoneBand] {
    let bands: [ZoneBand] = zones.indices.map { i in
        let z = zones[i]
        // lo/hi 统一成 lo < hi：配速的 range_min 是较慢边（更大值），取 min/max 归一。
        let lo: Double
        let hi: Double
        if let a = z.rangeMin {
            lo = z.rangeMax.map { min(a, $0) } ?? a
        } else {
            lo = -.infinity
        }
        if let b = z.rangeMax {
            hi = z.rangeMin.map { max(b, $0) } ?? b
        } else {
            hi = .infinity
        }
        return ZoneBand(lo: lo, hi: hi, color: zoneColor(i))
    }
    guard bands.count >= 2 else { return bands }
    var first = bands[0]
    let second = bands[1]
    if first.lo == second.lo && first.hi == second.hi {
        if zones[0].zoneType == "heartRate" {
            first = ZoneBand(lo: -.infinity, hi: second.lo, color: first.color)
        } else {
            first = ZoneBand(lo: second.hi, hi: .infinity, color: first.color)
        }
    }
    var result = bands
    result[0] = first
    return result.sorted { $0.lo < $1.lo }
}

/// 手表配速区间单位是 ms/km，曲线是 s/km，比色前先换算（非 ms/km 单位不动）。
public func paceZoneToSeconds(_ z: Zone) -> Zone {
    guard z.rangeUnit == "ms/km" || z.rangeUnit == "pace" else { return z }
    return Zone(zoneType: z.zoneType, zoneIndex: z.zoneIndex,
                rangeMin: z.rangeMin.map { $0 / 1000 }, rangeMax: z.rangeMax.map { $0 / 1000 },
                rangeUnit: z.rangeUnit, durationS: z.durationS, percent: z.percent)
}

/// 区间条 + 档位带总装（详情页 buildZones 直译）。
public func buildZones(_ zones: [Zone]) -> (hr: [ZoneBar], pace: [ZoneBar], hrBands: [ZoneBand], paceBands: [ZoneBand]) {
    let hr = zones.filter { $0.zoneType == "heartRate" }
    let paceRaw = zones.filter { $0.zoneType == "pace" }
    let isCorosPace = !paceRaw.isEmpty && paceRaw.allSatisfy { $0.rangeUnit == "ms/km" || $0.rangeUnit == "pace" }
    let pace = isCorosPace ? normalizePaceZones(paceRaw) : paceRaw
    func colorize(_ list: [Zone]) -> [ZoneBar] {
        list.indices.map { i in toZoneBar(list[i], peers: list, color: zoneColor(i)) }
    }
    return (
        colorize(hr),
        colorize(pace),
        zoneBands(hr),
        zoneBands(pace.map(paceZoneToSeconds))
    )
}

// MARK: - 走势曲线序列

/// 曲线采样点：横轴 = 起点起秒数（timeseries 厘秒换算），纵轴 = 心率 bpm / 配速 s/km。
public struct CurvePoint: Equatable, Sendable {
    public let t: Double
    public let v: Double

    public init(t: Double, v: Double) {
        self.t = t
        self.v = v
    }
}

/// 抽稀后点数上限：卡片内宽约 300px，再多看不出差别。
public let maxCurvePoints = 160

/// 心率曲线（bpm；缺失 / 0 丢弃）。
public func buildHrSeries(_ points: [TimeseriesPoint]) -> [CurvePoint] {
    buildSeries(points) { p in
        guard let hr = p.heartRate, hr > 0 else { return nil }
        return hr
    }
}

/// 配速曲线（s/km；adjusted_pace 优先回落 speed；0 / ≥1200 离谱值丢弃）。
public func buildPaceSeries(_ points: [TimeseriesPoint]) -> [CurvePoint] {
    buildSeries(points) { p in
        guard let v = p.paceForColoring, v > 0, v < 1200 else { return nil }
        return v
    }
}

private func buildSeries(_ points: [TimeseriesPoint], pick: (TimeseriesPoint) -> Double?) -> [CurvePoint] {
    var out: [CurvePoint] = []
    var t0: Double?
    for p in points {
        guard let ts = p.timestamp, let v = pick(p) else { continue }
        if t0 == nil { t0 = ts }
        out.append(CurvePoint(t: ((ts - (t0 ?? ts)) / 100).rounded(), v: v))
    }
    return out
}

/// 等间隔抽稀到 ≤ limit 点，保留首尾。
public func downsample(_ points: [CurvePoint], limit: Int = maxCurvePoints) -> [CurvePoint] {
    guard points.count > limit, limit >= 2 else { return points }
    let step = Swift.max(1, Int(ceil(Double(points.count - 1) / Double(limit - 1))))
    var out = points.indices.filter { $0 % step == 0 }.map { points[$0] }
    if let last = points.last, out.last != last { out.append(last) }
    return out
}

/// 横轴刻度：`HH:MM:SS`（与 COROS 一致，始终带小时位）。
public func formatChartTime(_ seconds: Double) -> String {
    let total = max(0, Int(seconds.rounded()))
    return String(format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
}

/// 纵轴取值边界：按 step 取整并保证有高度（step=10 适合心率）。
public func axisBounds(_ values: [Double], step: Double) -> (min: Double, max: Double) {
    guard let lo = values.min(), let hi = values.max() else { return (0, step) }
    let floor = (lo / step).rounded(.down) * step
    var ceil = (hi / step).rounded(.up) * step
    if ceil == floor { ceil = floor + step }
    return (floor, ceil)
}
