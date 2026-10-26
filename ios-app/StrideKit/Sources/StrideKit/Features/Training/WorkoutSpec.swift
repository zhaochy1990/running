import Foundation

// 训练域纯函数层（devops#768 PR-5）—— 直译小程序 `utils/date.ts`（周运算 /
// 推送日期选项）、`services/plan.ts`（强度柱状图 / 估时 / buildDayView 辅助）、
// `pages/workout-detail/workout-detail.ts`（类型 chip 启发式）与
// `utils/workoutSegments.ts`（分段组 / 动作行）。全部可单测，不碰视图层。

// MARK: - 上海周运算（utils/date.ts 消费面）

extension Shanghai {

    /// `YYYY-MM-DD` → 该周周一（ISO 周起点）的 `YYYY-MM-DD`；非法输入返回原串。
    public static func weekStart(ymd: String) -> String {
        guard ymd.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return ymd }
        guard let date = ymdDate(ymd) else { return ymd }
        let dow = calendar.component(.weekday, from: date) // 1=周日
        let daysBack = (dow + 5) % 7 // Mon=0 … Sun=6
        guard let monday = calendar.date(byAdding: .day, value: -daysBack, to: date) else { return ymd }
        return String(format: "%04d-%02d-%02d",
                      calendar.component(.year, from: monday),
                      calendar.component(.month, from: monday),
                      calendar.component(.day, from: monday))
    }

    /// 周目录名（后端 weekName 格式）：`YYYY-MM-DD_MM-DD`，起始为周一。
    public static func weekFolderName(weekStartYmd: String) -> String {
        let end = addDays(weekStartYmd, 6)
        return "\(weekStartYmd)_\(String(end.dropFirst(5)))"
    }

    /// anchorYmd 所在周 + n 天（上海日历日运算，避免 tz 折算差一天）；非法原样。
    public static func addDays(_ ymd: String, _ days: Int) -> String {
        guard ymd.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil,
              let date = ymdDate(ymd),
              let moved = calendar.date(byAdding: .day, value: days, to: date) else { return ymd }
        return String(format: "%04d-%02d-%02d",
                      calendar.component(.year, from: moved),
                      calendar.component(.month, from: moved),
                      calendar.component(.day, from: moved))
    }

    /// `(2026年7月)` 样式周副标题（基于周一的年月）。
    public static func weekSubtitle(weekStartYmd: String) -> String {
        let parts = weekStartYmd.split(separator: "-")
        guard parts.count == 3, let month = Int(parts[1]) else { return "" }
        return "(\(parts[0])年\(month)月)"
    }

    /// M/D（无前导零，Web formatShort 习惯）。
    public static func shortDate(ymd: String) -> String {
        let parts = ymd.split(separator: "-")
        guard parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]) else { return ymd }
        return "\(m)/\(d)"
    }
}

/// 周选择条 7 天 chip（周一→周日）。
public struct WeekDayChip: Equatable, Identifiable, Sendable {
    public let date: String
    public let label: String
    public let dayNumber: Int
    public let isToday: Bool

    public var id: String { date }

    public init(date: String, label: String, dayNumber: Int, isToday: Bool) {
        self.date = date
        self.label = label
        self.dayNumber = dayNumber
        self.isToday = isToday
    }
}

extension Shanghai {

    /// 展开以 anchorYmd 所在周为基准的周一到周日 7 天（isToday = 该周内今天）。
    public static func buildWeekDays(anchorYmd: String, todayYmd: String) -> [WeekDayChip] {
        let monday = weekStart(ymd: anchorYmd)
        let labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        return (0..<7).map { i in
            let date = addDays(monday, i)
            return WeekDayChip(date: date, label: labels[i], dayNumber: Int(date.suffix(2)) ?? 0, isToday: date == todayYmd)
        }
    }
}

// MARK: - 推送日期选项（utils/date.ts buildPushDateOptions）

public struct PushDateOption: Equatable, Identifiable, Sendable {
    public let label: String
    public let value: String
    public let isSelected: Bool

    public var id: String { value }

    public init(label: String, value: String, isSelected: Bool) {
        self.label = label
        self.value = value
        self.isSelected = isSelected
    }
}

/// 今天起往后 8 个可选日（今天/明天/后天中文标签，其余「周X MM/DD」）；
/// 计划日在可见窗口内提升为默认选中，过期回退今天。
public func buildPushDateOptions(plannedDate: String, todayYmd: String) -> [PushDateOption] {
    guard todayYmd.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return [] }
    var out: [PushDateOption] = []
    for i in 0...7 {
        let date = Shanghai.addDays(todayYmd, i)
        let label: String
        switch i {
        case 0: label = "今天"
        case 1: label = "明天"
        case 2: label = "后天"
        default: label = "\(Shanghai.weekdayLabel(date)) \(String(date.dropFirst(5)))"
        }
        let plannedVisible = date >= todayYmd
        let defaultDate = (plannedVisible && plannedDate >= todayYmd && plannedDate <= Shanghai.addDays(todayYmd, 7))
            ? plannedDate : todayYmd
        out.append(PushDateOption(label: date == plannedDate ? "\(label)（计划日）" : label,
                                  value: date,
                                  isSelected: date == defaultDate))
    }
    return out
}

// MARK: - 备注截断

/// 首个非空行，截断 200 字（教练备注回联口径）。
public func firstLine(_ text: String?) -> String {
    guard let text else { return "" }
    let line = text.split(separator: "\n", omittingEmptySubsequences: true)
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .first { !$0.isEmpty } ?? ""
    return line.count > 200 ? String(line.prefix(200)) + "…" : line
}

/// JS `a || b || c` 的空串回退语义（教练备注三级回退：session → 计划级 → 周）。
public func firstNonEmpty(_ parts: String...) -> String {
    parts.first { !$0.isEmpty } ?? ""
}

// MARK: - 强度柱状图与估时（services/plan.ts 直译）

/// 强度柱：高度 pct（0-100）、宽度权重（段估时秒）、首段淡化。
public struct IntensityBar: Equatable, Sendable {
    public let pct: Double
    public let weight: Double
    public let dim: Bool

    public init(pct: Double, weight: Double, dim: Bool) {
        self.pct = pct
        self.weight = weight
        self.dim = dim
    }
}

/// 无任何配速信息时的估时兜底（5:30/km）。
let defaultPaceSKm: Double = 330
/// open 段（lap 键手动结束）估 5 分钟。
let openStepDefaultS: Double = 300
/// manual / hr_bpm 休息估时不可知，示意宽度。
let nonTimeRestDefaultS: Double = 90

/// 段估时（秒，近似可视化用）：time_s 直取；distance_m 按目标配速中值折算
/// （无 pace target 用课内配速均值兜底）；open 估 5 分钟。
public func estimateStepSeconds(step: WorkoutStep, fallbackPace: Double) -> Double {
    if step.duration.kind == "time_s", let v = step.duration.value, v > 0 { return v }
    if step.duration.kind == "distance_m", let v = step.duration.value, v > 0 {
        let t = step.target
        let pace: Double
        if t?.kind == .paceSKm, let low = t?.low, let high = t?.high {
            pace = (low + high) / 2
        } else {
            pace = fallbackPace
        }
        return (v / 1000) * pace
    }
    return openStepDefaultS
}

/// 步后休息估时：time_s 直取；manual / hr_bpm 结束时机由跑者决定。
public func estimateRestSeconds(rest: WorkoutStepRest) -> Double {
    if rest.kind == "time_s", let v = rest.value, v > 0 { return v }
    return nonTimeRestDefaultS
}

/// 课内配速中值均值（无 pace target 距离段的估时兜底）。
public func fallbackPace(of blocks: [WorkoutBlock]) -> Double {
    var sum = 0.0
    var count = 0
    for block in blocks {
        for step in block.steps {
            if step.target?.kind == .paceSKm, let low = step.target?.low, let high = step.target?.high {
                sum += (low + high) / 2
                count += 1
            }
        }
    }
    return count > 0 ? sum / Double(count) : defaultPaceSKm
}

/// 整课估时（秒，全量求和不受柱状图采样影响）：落库 total_duration_s 缺失时
/// 的展示兜底（配速中值折算，10-20 拍板）。课表详情页复用同一口径。
public func estimateWorkoutSeconds(blocks: [WorkoutBlock]) -> Double {
    let pace = fallbackPace(of: blocks)
    var total = 0.0
    for block in blocks {
        for _ in 0..<max(1, block.repeatCount) {
            for step in block.steps {
                total += estimateStepSeconds(step: step, fallbackPace: pace)
                if let rest = step.rest { total += estimateRestSeconds(rest: rest) }
            }
        }
    }
    return total
}

func clampPct(_ v: Double) -> Double {
    min(100, max(10, v.rounded()))
}

/// work 段绝对强度分（60-100 启发式）：配速/心率分段线性，区间取中值。
public func stepIntensity(step: WorkoutStep) -> Double {
    guard let target = step.target else { return 75 }
    switch target.kind {
    case .hrBpm:
        let high = target.high ?? target.low
        guard let high else { return 75 }
        return piecewise(high, anchors: [(145, 62), (155, 72), (165, 84), (175, 92), (185, 100)])
    case .paceSKm:
        let slow = target.low ?? target.high
        let fast = target.high ?? target.low
        guard let slow, let fast else { return 75 }
        return piecewise((slow + fast) / 2, anchors: [
            (180, 100), (210, 95), (240, 90), (270, 85), (300, 78), (360, 65), (420, 55),
        ])
    default:
        return 75
    }
}

/// 分段线性插值：anchors 升序点列，x 之外 clamp 到端点 y。
func piecewise(_ x: Double, anchors: [(Double, Double)]) -> Double {
    guard let first = anchors.first, let last = anchors.last else { return 0 }
    if x <= first.0 { return first.1 }
    if x >= last.0 { return last.1 }
    for i in 1..<anchors.count {
        let (x1, y1) = anchors[i - 1]
        let (x2, y2) = anchors[i]
        if x <= x2 { return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1) }
    }
    return last.1
}

/// 跑课 blocks → 强度柱状图（高度=强度 0-100、宽度=段估时占比、work 分数跨度
/// ≥3 时课内归一到 [55,95]、休息零高度占位、首段淡化、>16 柱均匀采样）。
public func deriveIntensityBars(blocks: [WorkoutBlock]) -> [IntensityBar] {
    struct Entry {
        var pct: Double?
        var weight: Double
        var fixed: Bool
    }
    let pace = fallbackPace(of: blocks)

    var raw: [Entry] = []
    var workScores: [Double] = []
    for block in blocks {
        for _ in 0..<max(1, block.repeatCount) {
            for step in block.steps {
                switch step.stepKind {
                case .rest, .recovery:
                    raw.append(Entry(pct: nil, weight: estimateStepSeconds(step: step, fallbackPace: pace), fixed: false))
                case .warmup:
                    raw.append(Entry(pct: 35, weight: estimateStepSeconds(step: step, fallbackPace: pace), fixed: true))
                case .cooldown:
                    raw.append(Entry(pct: 25, weight: estimateStepSeconds(step: step, fallbackPace: pace), fixed: true))
                case .work:
                    workScores.append(stepIntensity(step: step))
                    raw.append(Entry(pct: stepIntensity(step: step), weight: estimateStepSeconds(step: step, fallbackPace: pace), fixed: false))
                }
                if let rest = step.rest {
                    raw.append(Entry(pct: nil, weight: estimateRestSeconds(rest: rest), fixed: false))
                }
            }
        }
    }
    if raw.isEmpty { return [] }

    let lo = workScores.min() ?? 0
    let hi = workScores.max() ?? 0
    func normalize(_ s: Double) -> Double {
        if hi - lo < 3 { return clampPct(s) }
        return clampPct(55 + ((s - lo) / (hi - lo)) * 40)
    }

    let sampled = raw.count > 16 ? sampleEvenly(raw, count: 16) : raw
    return sampled.enumerated().map { i, e in
        IntensityBar(
            pct: e.pct == nil ? 0 : (e.fixed ? clampPct(e.pct!) : normalize(e.pct!)),
            weight: e.weight,
            dim: i == 0
        )
    }
}

func sampleEvenly<T>(_ arr: [T], count: Int) -> [T] {
    guard count > 1, arr.count > 1 else { return arr }
    return (0..<count).map { i in
        let ratio = Double(i) * Double(arr.count - 1) / Double(count - 1)
        return arr[Int(ratio.rounded())]
    }
}

// MARK: - 课表类型 chip（workout-detail 启发式，仅装饰）

/// 类型 chip 七类启发式：力量 → 间歇（距离制重复）→ 节奏（≥4 分钟时长重复）
/// → 变速（其余重复）→ 长距离（总量 ≥15 km）→ 渐进（多主课逐段提速）→ 有氧。
public func deriveWorkoutType(kind: SessionKind, spec: SessionSpec?, totalDistanceM: Double?) -> String {
    if kind == .strength { return "力量" }
    guard kind == .run, let run = spec?.runSpec else { return "" }
    let blocks = run.blocks
    var hasDistanceRepeat = false
    var hasLongTimeRepeat = false
    var hasTimeRepeat = false
    var singleWorkCount = 0
    var fastening = true
    var prevPaceMid: Double?
    var totalKm = (totalDistanceM ?? 0) > 0 ? totalDistanceM! / 1000 : 0
    if totalKm == 0 {
        for block in blocks {
            for step in block.steps where step.duration.kind == "distance_m" {
                if let v = step.duration.value {
                    totalKm += (v * Double(max(1, block.repeatCount))) / 1000
                }
            }
        }
    }
    for block in blocks {
        for step in block.steps where step.stepKind == .work {
            if block.repeatCount > 1 {
                if step.duration.kind == "distance_m" {
                    hasDistanceRepeat = true
                } else {
                    hasTimeRepeat = true
                    if step.duration.kind == "time_s", let v = step.duration.value, v >= 240 {
                        hasLongTimeRepeat = true
                    }
                }
            } else {
                singleWorkCount += 1
                if step.target?.kind == .paceSKm, let low = step.target?.low, let high = step.target?.high {
                    let mid = (low + high) / 2
                    // 配速值变小 = 变快；多主课逐段提速视为渐进。
                    if let prev = prevPaceMid, mid > prev + 1 { fastening = false }
                    prevPaceMid = mid
                }
            }
        }
    }
    if hasDistanceRepeat { return "间歇" }
    if hasLongTimeRepeat { return "节奏" }
    if hasTimeRepeat { return "变速" }
    if totalKm >= 15 { return "长距离" }
    if singleWorkCount >= 2 && fastening { return "渐进" }
    return "有氧"
}

// MARK: - 分段组 / 动作行（utils/workoutSegments.ts 直译）

/// 步类型配色沿用赛季总览页阶段色语义（热身绿/跑步粉/恢复蓝/冷身紫/休息灰）。
public enum StepKindMeta {
    public static func label(_ kind: StepKind) -> String {
        switch kind {
        case .warmup: "热身"
        case .work: "跑步"
        case .recovery: "恢复"
        case .cooldown: "冷身"
        case .rest: "休息"
        }
    }

    public static func color(_ kind: StepKind) -> UInt32 {
        switch kind {
        case .warmup: 0x7AC9A3
        case .work: 0xFF6363
        case .recovery: 0x6DB3CF
        case .cooldown: 0xB395D6
        case .rest: 0x9C9C9D
        }
    }
}

public struct SegmentRow: Equatable, Identifiable, Sendable {
    public let key: String
    public let kindLabel: String
    public let color: UInt32
    /// 休息行：空心灰标签 + 次要色文字。
    public let quiet: Bool
    /// 主行 `800 m · 4:05–4:15/km`；休息行 `90 秒`。
    public let main: String
    public let hrCapText: String
    public let note: String

    public var id: String { key }

    public init(key: String, kindLabel: String, color: UInt32, quiet: Bool, main: String, hrCapText: String, note: String) {
        self.key = key
        self.kindLabel = kindLabel
        self.color = color
        self.quiet = quiet
        self.main = main
        self.hrCapText = hrCapText
        self.note = note
    }
}

public struct SegmentGroup: Equatable, Identifiable, Sendable {
    public let key: String
    public let repeatCount: Int
    public let rows: [SegmentRow]

    public var id: String { key }
}

/// 秒 → `M:SS`（段时长/休息用）。
func fmtClock(_ seconds: Double) -> String {
    let total = max(0, Int(seconds.rounded()))
    return String(format: "%d:%02d", total / 60, total % 60)
}

/// 步目标：pace 区间 / 心率区间 / 功率区间 / 体感。
func fmtTarget(_ target: WorkoutTarget) -> String {
    switch target.kind {
    case .paceSKm:
        if let low = target.low, let high = target.high {
            return "\(fmtClock(low))–\(fmtClock(high))/km"
        }
    case .hrBpm:
        if let low = target.low, let high = target.high {
            return "\(Int(low))–\(Int(high)) bpm"
        }
    case .powerW:
        if let low = target.low, let high = target.high {
            return "\(Int(low))–\(Int(high)) W"
        }
    case .open:
        break
    }
    return "体感"
}

/// 步时长：距离段 `800 m` / `14 km`，时长段 `15:00`，open 段不定时长。
func fmtStepDuration(_ step: WorkoutStep) -> String {
    if step.duration.kind == "distance_m", let v = step.duration.value {
        if v < 1000 { return "\(Int(v)) m" }
        let km = v / 1000
        return km == km.rounded() ? "\(Int(km)) km" : String(format: "%.1f km", km)
    }
    if step.duration.kind == "time_s", let v = step.duration.value {
        return fmtClock(v)
    }
    return "不定时长"
}

/// 步后休息文案（work 步携带；展开为独立休息行）。
func fmtStepRest(_ rest: WorkoutStepRest) -> String {
    if rest.kind == "time_s", let v = rest.value {
        return v < 120 ? "\(Int(v)) 秒" : fmtClock(v)
    }
    if rest.kind == "hr_bpm", let v = rest.value {
        return "心率降到 \(Int(v)) 以下继续"
    }
    return "休息至手动继续"
}

/// 跑课 blocks → 分段组（repeat>1 整组骑线 ×N 徽章、步后休息独立行、心率帽）。
public func buildRunGroups(spec: RunWorkoutSpec) -> [SegmentGroup] {
    spec.blocks.enumerated().map { bi, block in
        var rows: [SegmentRow] = []
        block.steps.enumerated().forEach { si, step in
            rows.append(SegmentRow(
                key: "s\(bi)-\(si)",
                kindLabel: StepKindMeta.label(step.stepKind),
                color: StepKindMeta.color(step.stepKind),
                quiet: step.stepKind == .rest,
                main: "\(fmtStepDuration(step)) · \(step.target.map(fmtTarget) ?? "体感")",
                hrCapText: step.hrCapBpm != nil ? "心率≤\(Int(step.hrCapBpm!))" : "",
                note: step.note?.trimmingCharacters(in: .whitespaces) ?? ""
            ))
            if let rest = step.rest {
                rows.append(SegmentRow(
                    key: "s\(bi)-\(si)-rest",
                    kindLabel: StepKindMeta.label(.rest),
                    color: StepKindMeta.color(.rest),
                    quiet: true,
                    main: fmtStepRest(rest),
                    hrCapText: "",
                    note: ""
                ))
            }
        }
        return SegmentGroup(key: "b\(bi)", repeatCount: block.repeatCount, rows: rows)
    }
}

public struct ExerciseRow: Equatable, Identifiable, Sendable {
    public let key: String
    public let name: String
    /// `3 组 × 12 次` / `3 组 × 45 秒`。
    public let target: String
    /// `组间休息 60 秒`，0 为空。
    public let rest: String
    public let note: String

    public var id: String { key }
}

/// 力量课 → 动作行（动作 / 组数×次数 / 负重提示位 / 备注）。
public func buildExerciseRows(spec: StrengthWorkoutSpec) -> [ExerciseRow] {
    spec.exercises.enumerated().map { i, ex in
        ExerciseRow(
            key: "e\(i)",
            name: ex.displayName.isEmpty ? ex.canonicalId : ex.displayName,
            target: "\(ex.sets) 组 × \(ex.targetKind == "reps" ? "\(Int(ex.targetValue)) 次" : fmtClock(ex.targetValue))",
            rest: ex.restSeconds > 0 ? "组间休息 \(Int(ex.restSeconds)) 秒" : "",
            note: ex.note?.trimmingCharacters(in: .whitespaces) ?? ""
        )
    }
}
