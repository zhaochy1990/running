import Foundation

// 训练状态页纯函数层（devops#768 PR-5）—— 直译小程序 `utils/trainingStatus.ts`：
// Form zone / readiness / 负荷比分类、16 周热力图分桶与格子、8 周周剂量聚合、
// 运动中文名与时长文案。与 Web 端同一套阈值口径；不碰视图层。
// **不带雷达/预测/PB 三块（#756 拍板：当前小程序无此三块，以 baseline 为准）。**

// MARK: - Form zone（阈值按当日慢性负荷 CTL 比例划分，与 Web 相同）

public enum FormZone: String, CaseIterable, Sendable {
    case overTaper = "over_taper"
    case raceReady = "race_ready"
    case transition
    case productive
    case overload

    public var color: UInt32 {
        switch self {
        case .overTaper: 0xFFAB00
        case .raceReady: 0x0097A7
        case .transition: 0x8888A0
        case .productive: 0x00A85A
        case .overload: 0xD32F2F
        }
    }

    public var label: String {
        switch self {
        case .overTaper: "减量过多"
        case .raceReady: "比赛就绪"
        case .transition: "维持期"
        case .productive: "提升期"
        case .overload: "过度负荷"
        }
    }

    /// 图例文案（五区 + 阈值注记）。
    public var legendLabel: String {
        switch self {
        case .overTaper: "减量过多 (>+25%×CTL)"
        case .raceReady: "比赛就绪 (+10%~+25%×CTL)"
        case .transition: "维持期 (±10%×CTL)"
        case .productive: "提升期 (−25%~−10%×CTL)"
        case .overload: "过度负荷 (<−25%×CTL)"
        }
    }
}

public func classifyForm(form: Double?, chronic: Double?) -> FormZone? {
    guard let form, let chronic, chronic > 0 else { return nil }
    let r = form / chronic
    if r > 0.25 { return .overTaper }
    if r >= 0.1 { return .raceReady }
    if r >= -0.1 { return .transition }
    if r >= -0.25 { return .productive }
    return .overload
}

public func formColor(form: Double?, chronic: Double?) -> UInt32 {
    classifyForm(form: form, chronic: chronic)?.color ?? 0x8888A0
}

// MARK: - readiness gate（green / yellow / red，与 Web 相同）

public enum Readiness {
    public static func color(gate: String?) -> UInt32 {
        switch gate {
        case "green": 0x00A85A
        case "yellow": 0xE68A00
        case "red": 0xD32F2F
        default: 0x8888A0
        }
    }

    public static func label(gate: String?) -> String {
        switch gate {
        case "green": "可进行强度训练"
        case "yellow": "注意，建议减量"
        case "red": "建议停训恢复"
        default: "—"
        }
    }

    public static func gateLabel(gate: String?) -> String {
        switch gate {
        case "green": "绿灯"
        case "yellow": "黄灯"
        case "red": "红灯"
        default: "—"
        }
    }
}

/// 由负荷比（ACWR）衍生的训练状态分类。
public func loadStateLabel(ratio: Double?) -> String {
    guard let ratio, ratio.isFinite else { return "—" }
    if ratio < 0.8 { return "恢复期" }
    if ratio < 1.0 { return "维持期" }
    if ratio < 1.3 { return "提升期" }
    return "过度负荷"
}

// MARK: - 16 周训练热力图

/// 剂量分桶（与 Web heatmapBucket 一致）：0 空/休息，1–4 递增。
public func heatmapBucket(dose: Double?) -> Int {
    guard let dose, dose > 0 else { return 0 }
    if dose <= 40 { return 1 }
    if dose <= 80 { return 2 }
    if dose <= 120 { return 3 }
    return 4
}

/// 热力图五档色（亮色主题适配的橙色系渐变；0 = 有记录零剂量/休息）。
public func heatmapColor(bucket: Int) -> UInt32 {
    switch bucket {
    case 1: 0xFFB380 // 0xFF8F3C @ 25%
    case 2: 0xFFA366 // @ 50%
    case 3: 0xFF9A55 // @ 75%
    case 4: 0xFF8F3C // 全量
    default: 0xEFF2F6 // 休息中性底（grid token）
    }
}

public enum HeatDayState: String, Equatable, Sendable {
    case active, rest, unknown, absent, future
}

public struct HeatCell: Equatable, Identifiable, Sendable {
    public let date: String
    public let weekIdx: Int
    /// 0=Mon … 6=Sun。
    public let dayIdx: Int
    public let dose: Double?
    public let state: HeatDayState
    public let isToday: Bool

    public var id: String { date }
}

/// 16 周格子（周一起列；future / absent / unknown / rest / active 五态）。
public func buildHeatCells(series: [StrideTrainingLoadRecord], weeks: Int = 16, todayYmd: String) -> [HeatCell] {
    let seriesByDate = Dictionary(uniqueKeysWithValues: series.map { ($0.date, $0) })
    let thisMonday = Shanghai.weekStart(ymd: todayYmd)
    let firstMonday = Shanghai.addDays(thisMonday, -(weeks - 1) * 7)
    var out: [HeatCell] = []
    for w in 0..<weeks {
        for d in 0..<7 {
            let date = Shanghai.addDays(firstMonday, w * 7 + d)
            let row = seriesByDate[date]
            let isFuture = date > todayYmd

            let state: HeatDayState
            let dose: Double?
            if isFuture {
                state = .future
                dose = nil
            } else if row == nil {
                state = .absent
                dose = nil
            } else if row?.coverageStatus == "unknown" {
                state = .unknown
                dose = nil
            } else {
                dose = row?.trainingDose
                state = (dose != nil && dose! > 0) ? .active : .rest
            }
            out.append(HeatCell(date: date, weekIdx: w, dayIdx: d, dose: dose, state: state, isToday: date == todayYmd))
        }
    }
    return out
}

public struct HeatWeek: Equatable, Identifiable, Sendable {
    public let weekIdx: Int
    /// 周一首列跨月时挂月份标签（`7月`）；否则空串。
    public let month: String
    public let cells: [HeatCell]

    public var id: Int { weekIdx }
}

/// 按列（周）重排格子 + 月分组标签。
public func buildHeatWeeks(cells: [HeatCell]) -> [HeatWeek] {
    var out: [HeatWeek] = []
    var lastMonth = ""
    let weekIndexes = Array(Set(cells.map(\.weekIdx))).sorted()
    for w in weekIndexes {
        let weekCells = cells.filter { $0.weekIdx == w }.sorted { $0.dayIdx < $1.dayIdx }
        let month = weekCells.first.map { String($0.date.dropFirst(5).prefix(2)) } ?? ""
        let label = month != lastMonth ? "\(Int(month) ?? 0)月" : ""
        out.append(HeatWeek(weekIdx: w, month: label, cells: weekCells))
        if !month.isEmpty { lastMonth = month }
    }
    return out
}

// MARK: - 8 周周剂量聚合（与 Web lib/weeklyLoad.ts 一致）

public struct WeeklyDoseBucket: Equatable, Sendable {
    public let weekStart: String
    /// `7/14` 样式。
    public let weekLabel: String
    public let totalDose: Double?
    public let activeDays: Int
}

public func aggregateWeeklyDose(records: [StrideTrainingLoadRecord], todayYmd: String, weeks: Int = 8) -> [WeeklyDoseBucket] {
    let currentWeekStart = Shanghai.weekStart(ymd: todayYmd)
    var byStart: [String: (total: Double?, activeDays: Int)] = [:]
    var unknownWeeks = Set<String>()
    var orderedStarts: [String] = []
    for i in stride(from: weeks - 1, through: 0, by: -1) {
        let start = Shanghai.addDays(currentWeekStart, -i * 7)
        orderedStarts.append(start)
        byStart[start] = (nil, 0)
    }
    for r in records {
        let ws = Shanghai.weekStart(ymd: r.date)
        guard byStart[ws] != nil else { continue }
        if r.coverageStatus == "unknown" {
            unknownWeeks.insert(ws)
            continue
        }
        guard let dose = r.trainingDose else { continue }
        let old = byStart[ws]!
        byStart[ws] = ((old.total ?? 0) + dose, old.activeDays + (dose > 0 ? 1 : 0))
    }
    return orderedStarts.map { start in
        let bucket = byStart[start]!
        let label = "\(Int(start.dropFirst(5).prefix(2)) ?? 0)/\(Int(start.suffix(2)) ?? 0)"
        return WeeklyDoseBucket(
            weekStart: start,
            weekLabel: label,
            totalDose: unknownWeeks.contains(start) ? nil : bucket.total,
            activeDays: bucket.activeDays
        )
    }
}

// MARK: - 每日活动摘要文案（Web DailyDoseTooltip 口径）

private let sportNameCN: [(String, String)] = [
    ("run", "跑步"), ("treadmill", "跑步"), ("strength", "力量训练"), ("gym", "力量训练"),
    ("bike", "骑行"), ("cycling", "骑行"), ("swim", "游泳"), ("walk", "步行"),
    ("hike", "徒步"), ("ski", "滑雪"), ("snowboard", "滑雪"), ("hiit", "HIIT"),
    ("row", "划船"), ("jump rope", "跳绳"), ("cardio", "有氧"),
]

public func chineseSportName(_ name: String?) -> String {
    let s = name ?? ""
    let lower = s.lowercased()
    for (needle, cn) in sportNameCN where lower.contains(needle) {
        return cn
    }
    return s.isEmpty ? "训练" : s
}

/// 距离类运动展示「距离 + 配速 + 心率」；力量/HIIT 等只展示时长 + 心率。
public func isDistanceSport(_ name: String?) -> Bool {
    let lower = (name ?? "").lowercased()
    return ["run", "bike", "cycling", "swim", "walk", "hike", "treadmill", "row"].contains { lower.contains($0) }
}

/// 秒 → `1h43min` / `43min` / `8h`（Web 工具提示一致）。
public func formatDurationHuman(_ seconds: Double?) -> String {
    guard let seconds, seconds > 0 else { return "—" }
    let total = Int(seconds.rounded())
    let h = total / 3600
    let m = (total % 3600) / 60
    if h > 0 && m > 0 { return "\(h)h\(m)min" }
    if h > 0 { return "\(h)h" }
    return "\(m)min"
}

/// 兼容 health 接口 YYYYMMDD / YYYY-MM-DD 两种日期形态。
public func normalizeYmd(_ date: String) -> String {
    date.count == 8
        ? "\(date.prefix(4))-\(date.dropFirst(4).prefix(2))-\(date.suffix(2))"
        : date
}

/// 短日期 `M/D`（health/hrv 序列 x 轴文案）。
public func formatDateShort(_ ymd: String) -> String {
    Shanghai.shortDate(ymd: normalizeYmd(ymd))
}

/// 数值边界外扩 pad（相等时也保证高度）。
public func padBounds(min: Double, max: Double, pad: Double) -> (min: Double, max: Double) {
    guard min.isFinite, max.isFinite else { return (0, 1) }
    if min == max { return (min - pad, max + pad) }
    return (min - pad, max + pad)
}
