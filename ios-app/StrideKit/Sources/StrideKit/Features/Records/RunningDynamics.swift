import Foundation

// 跑姿动态卡（devops#1041）：小程序 `components/activity/running-dynamics` 的
// 视图数据与纯计算直译——running-dynamics.ts（cardsFor / selectAt）与 chart.ts
// （dynamicsTime / dynamicsWindowAt / axisTicks / markWidth）。

// MARK: - 指标口径

/// 四项跑姿指标；枚举顺序即卡片顺序，label / unit / 小数位沿 mp metrics 表。
public enum RunningDynamicsKey: String, CaseIterable, Sendable {
    case cadence
    case strideLength = "stride_length"
    case verticalOscillation = "vertical_oscillation"
    case groundContactTime = "ground_contact_time"

    public var label: String {
        switch self {
        case .cadence: "步频"
        case .strideLength: "步幅"
        case .verticalOscillation: "垂直振幅"
        case .groundContactTime: "触地时间"
        }
    }

    public var unit: String {
        switch self {
        case .cadence: "步/分"
        case .strideLength: "米/步"
        case .verticalOscillation: "厘米"
        case .groundContactTime: "毫秒"
        }
    }

    /// 展示小数位（步频 0 / 步幅 2 / 垂直振幅 1 / 触地 0）。
    public var digits: Int {
        switch self {
        case .cadence, .groundContactTime: 0
        case .strideLength: 2
        case .verticalOscillation: 1
        }
    }
}

// MARK: - 视图数据

/// 单项指标卡：全程平均 + 分窗区间（当前时段范围与图表共用）。
public struct DynamicsCard: Equatable, Identifiable, Sendable {
    public let key: RunningDynamicsKey
    /// 全程平均（已按指标小数位格式化）。
    public let average: String
    /// 全程最小 / 最大（未选窗时的范围）。
    public let min: Double
    public let max: Double
    public let windows: [RunningDynamicsRange]

    public var id: RunningDynamicsKey { key }

    /// 当前时段范围；未选窗 = 全程，该指标没有这个窗口 = nil。
    public func range(selected: Int?) -> (min: Double, max: Double)? {
        guard let selected else { return (min, max) }
        guard let window = windows.first(where: { $0.index == selected }) else { return nil }
        return (window.min, window.max)
    }

    /// 当前时段的最小–最大文案；该指标没有这个窗口 = `—`（mp cardsFor）。
    public func rangeText(selected: Int?) -> String {
        guard let range = range(selected: selected) else { return "—" }
        return "\(dynamicsFixed(range.min, digits: key.digits))–\(dynamicsFixed(range.max, digits: key.digits))"
    }
}

/// 跑姿动态整卡视图数据；nil = 不渲染。
public struct DynamicsSection: Equatable, Sendable {
    public let durationS: Double
    public let windowS: Int
    public let cards: [DynamicsCard]

    /// 第 index 个窗口的起止秒（最后一个窗口不满一窗时止于活动时长）。
    public func windowBounds(_ index: Int) -> (start: Double, end: Double) {
        let start = Double(index) * Double(windowS)
        return (start, min(durationS, start + Double(windowS)))
    }

    /// 当前时段标签：未选窗「全程范围」，选中为该窗口起止 `HH:MM:SS–HH:MM:SS`。
    public func timeLabel(selected: Int?) -> String {
        guard let selected else { return "全程范围" }
        let bounds = windowBounds(selected)
        return "\(formatChartTime(bounds.start))–\(formatChartTime(bounds.end))"
    }

    /// 图上横轴秒数 → 窗口序号（mp dynamicsWindowAt：先按时间轴夹到首尾，再夹到最后一个窗口）。
    public func windowIndex(atSeconds seconds: Double) -> Int {
        let window = Double(windowS)
        let ratio = min(max(seconds / durationS, 0), 1)
        let last = Int(ceil(durationS / window)) - 1
        return min(last, Int(floor(ratio * durationS / window)))
    }
}

/// `running_dynamics` 摘要 → 整卡数据（mp initialize 的 available 过滤）：没有分窗区间的
/// 指标不出卡；时长 / 窗口非法或一张卡都凑不出 → nil，整卡不渲染。
/// Go API 按契约只产出有限值且 min ≤ max，这里的数值把关是数据边界上的兜底：
/// `windowIndex` / `axisTicks` 里有 `Int(...)` 转换，NaN / Inf / 极差为负会直接 trap。
public func dynamicsSection(_ summary: RunningDynamics?) -> DynamicsSection? {
    guard let summary, summary.durationS.isFinite, summary.durationS > 0, summary.windowS > 0 else { return nil }
    let cards = RunningDynamicsKey.allCases.compactMap { key -> DynamicsCard? in
        guard let metric = summary.metrics[key.rawValue], !metric.windows.isEmpty,
              metric.min.isFinite, metric.max.isFinite, metric.min <= metric.max else { return nil }
        return DynamicsCard(
            key: key,
            average: dynamicsFixed(metric.average, digits: key.digits),
            min: metric.min,
            max: metric.max,
            windows: metric.windows
        )
    }
    guard !cards.isEmpty else { return nil }
    return DynamicsSection(durationS: summary.durationS, windowS: summary.windowS, cards: cards)
}

// MARK: - 位数格式化

/// JS `Number.prototype.toFixed` 等价（mp cardsFor 的 `toFixed(digits)`）：按双精度的
/// 精确十进制值四舍五入（恰好 .5 进位），再补齐尾零。`String(format: "%.Nf")` 是对二进制值
/// 就近舍入，恰好可表示的 .5 末位会少 1（8.25 → mp "8.3" / printf "8.2"；Garmin 垂直振幅
/// 是两位小数厘米，x.x5 很常见）。
func dynamicsFixed(_ value: Double, digits: Int) -> String {
    guard value.isFinite else { return "—" }
    // `Decimal(Double)` 会把 1.115 收成最短十进制 "1.115"，分不清真假 .5；%.30f 才是精确展开。
    var exact = Decimal(string: String(format: "%.30f", value), locale: Locale(identifier: "en_US_POSIX")) ?? 0
    var rounded = Decimal()
    NSDecimalRound(&rounded, &exact, digits, .plain)
    return String(format: "%.\(digits)f", NSDecimalNumber(decimal: rounded).doubleValue)
}

// MARK: - 图表几何（chart.ts 直译）

/// 纵轴刻度（chart.ts axisTicks）：步长取 1/2/2.5/5/10 × 数量级，两端至少各留
/// 一个最小刻度单位（或不小于极差 2%）的余量。入参来自 dynamicsSection 已把关的有限值。
func dynamicsAxisTicks(min lower: Double, max upper: Double, digits: Int) -> [Double] {
    let increment = pow(10, -Double(digits))
    let padding = max(increment, (upper - lower) * 0.02)
    let target = (upper - lower + 2 * padding) / 4
    let order = pow(10, floor(log10(target)))
    let step = max(increment, ([1.0, 2, 2.5, 5, 10].first { $0 * order >= target } ?? 10) * order)
    let start = floor((lower - padding) / step)
    let end = ceil((upper + padding) / step)
    return (Int(start)...Int(end)).map { Double(String(format: "%.\(digits + 1)f", Double($0) * step)) ?? 0 }
}

/// 每根竖线的线宽（chart.ts markWidth）：一个窗口占的横向宽度减 1pt，夹在 0.6–2.3pt，
/// 长距离活动窗口多时自动收窄。
func dynamicsMarkWidth(plotWidth: Double, durationS: Double, windowS: Int) -> Double {
    min(2.3, max(0.6, plotWidth * Double(windowS) / durationS - 1))
}
