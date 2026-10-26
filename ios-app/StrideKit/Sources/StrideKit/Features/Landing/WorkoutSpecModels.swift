import Foundation

// MARK: - 课表 spec 模型与分段渲染（types/plan.ts + utils/workoutSegments.ts 直译）
//
// workout-share 落地页与（未合并的）workout-detail「所见即所得」（devops#703）：
// 跑课 blocks/steps → 分段组（repeat>1 骑线 ×N、步后休息独立行、心率帽）；
// 力量课 → 动作行。PR-7 先自持一份；PR-5 训练域落地 workout-detail 时如
// 需要复用，提升到 Shared 再去重（ledger 登记）。

/// 步目标（pace 区间 / 心率区间 / 功率区间 / 体感）。
public struct WorkoutTarget: Codable, Sendable, Equatable {
    public let kind: String
    public let low: Double?
    public let high: Double?

    public init(kind: String, low: Double?, high: Double?) {
        self.kind = kind
        self.low = low
        self.high = high
    }
}

/// 步后休息（time_s / hr_bpm / manual）。
public struct WorkoutStepRest: Codable, Sendable, Equatable {
    public let kind: String
    public let value: Double?

    public init(kind: String, value: Double?) {
        self.kind = kind
        self.value = value
    }
}

/// 一步（warmup/work/recovery/cooldown/rest）。
public struct WorkoutStep: Codable, Sendable, Equatable {
    public let stepKind: String
    public let duration: WorkoutDuration
    public let target: WorkoutTarget?
    public let note: String?
    public let hrCapBpm: Double?
    public let rest: WorkoutStepRest?

    public init(stepKind: String, duration: WorkoutDuration, target: WorkoutTarget?,
                note: String?, hrCapBpm: Double?, rest: WorkoutStepRest?) {
        self.stepKind = stepKind
        self.duration = duration
        self.target = target
        self.note = note
        self.hrCapBpm = hrCapBpm
        self.rest = rest
    }

    enum CodingKeys: String, CodingKey {
        case stepKind = "step_kind"
        case duration, target, note, rest
        case hrCapBpm = "hr_cap_bpm"
    }
}

/// 步时长（distance_m / time_s / open）。
public struct WorkoutDuration: Codable, Sendable, Equatable {
    public let kind: String
    public let value: Double?

    public init(kind: String, value: Double?) {
        self.kind = kind
        self.value = value
    }
}

/// 跑课 spec（schema `run-workout/v1`）。
public struct RunWorkoutSpec: Codable, Sendable, Equatable {
    public struct Block: Codable, Sendable, Equatable {
        public let steps: [WorkoutStep]
        /// JSON 字段名 `repeat`（Swift 关键字，映射 repeatCount）。
        public let repeatCount: Int

        enum CodingKeys: String, CodingKey {
            case steps
            case repeatCount = "repeat"
        }

        public init(steps: [WorkoutStep], repeatCount: Int) {
            self.steps = steps
            self.repeatCount = repeatCount
        }
    }

    public let name: String?
    public let date: String?
    public let note: String?
    public let blocks: [Block]

    public init(name: String?, date: String?, note: String?, blocks: [Block]) {
        self.name = name
        self.date = date
        self.note = note
        self.blocks = blocks
    }
}

/// 力量课 spec（schema `strength-workout/v1`）。
public struct StrengthWorkoutSpec: Codable, Sendable, Equatable {
    public struct Exercise: Codable, Sendable, Equatable {
        public let canonicalId: String
        public let displayName: String
        public let sets: Int
        public let targetKind: String
        public let targetValue: Double
        public let restSeconds: Int
        public let note: String?

        public init(canonicalId: String, displayName: String, sets: Int, targetKind: String,
                    targetValue: Double, restSeconds: Int, note: String?) {
            self.canonicalId = canonicalId
            self.displayName = displayName
            self.sets = sets
            self.targetKind = targetKind
            self.targetValue = targetValue
            self.restSeconds = restSeconds
            self.note = note
        }

        enum CodingKeys: String, CodingKey {
            case canonicalId = "canonical_id"
            case displayName = "display_name"
            case sets
            case targetKind = "target_kind"
            case targetValue = "target_value"
            case restSeconds = "rest_seconds"
            case note
        }
    }

    public let name: String?
    public let date: String?
    public let note: String?
    public let exercises: [Exercise]

    public init(name: String?, date: String?, note: String?, exercises: [Exercise]) {
        self.name = name
        self.date = date
        self.note = note
        self.exercises = exercises
    }
}

// MARK: - 分段行视图模型

/// 分段行（主行 + 休息行两态）。
public struct SegmentRow: Equatable, Identifiable, Sendable {
    public let id: String
    public let kindLabel: String
    public let kindColorName: String
    /// 休息行：空心灰标签 + 次要色文字（执行顺序中的一步）。
    public let quiet: Bool
    /// 主行：`800 m · 4:05–4:15/km`；休息行 `90 秒` / `4:00`。
    public let main: String
    /// 步心率上限，如 `心率≤152`。
    public let hrCapText: String
    public let note: String
}

/// 分段组：repeat>1 时整组带骑线 ×N 徽章。
public struct SegmentGroup: Equatable, Identifiable, Sendable {
    public let id: String
    public let repeatCount: Int
    public let rows: [SegmentRow]
}

/// 力量动作行。
public struct ExerciseRow: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    /// `3 组 × 12 次` / `3 组 × 45 秒`。
    public let target: String
    /// `组间休息 60 秒`，0 为空。
    public let rest: String
    public let note: String
}

// MARK: - 格式化（workoutSegments.ts 同口径）

/// 步类型配色语义沿用赛季总览阶段色（热身绿/跑步粉/恢复蓝/冷身紫/休息灰）；
/// 亮色主题按语义映射系统动态色（D-rec-2 同族），name 在视图层转 Color。
public func stepKindMeta(_ kind: String) -> (label: String, colorName: String, quiet: Bool) {
    switch kind {
    case "warmup": return ("热身", "green", false)
    case "work": return ("跑步", "pink", false)
    case "recovery": return ("恢复", "blue", false)
    case "cooldown": return ("冷身", "purple", false)
    case "rest": return ("休息", "gray", true)
    default: return (kind, "gray", false)
    }
}

/// 秒 → `M:SS`（段时长/休息用）。
public func fmtClock(_ seconds: Double) -> String {
    let total = max(0, Int(seconds.rounded()))
    return "\(total / 60):\(String(format: "%02d", total % 60))"
}

func fmtPaceValue(_ secondsPerKm: Double) -> String {
    fmtClock(secondsPerKm)
}

/// 步目标文案：pace 区间 / 心率区间 / 功率区间 / 体感。
public func fmtTarget(_ target: WorkoutTarget?) -> String {
    guard let target else { return "体感" }
    if target.kind == "pace_s_km", let low = target.low, let high = target.high {
        return "\(fmtPaceValue(low))–\(fmtPaceValue(high))/km"
    }
    if target.kind == "hr_bpm", let low = target.low, let high = target.high {
        return "\(Int(low))–\(Int(high)) bpm"
    }
    if target.kind == "power_w", let low = target.low, let high = target.high {
        return "\(Int(low))–\(Int(high)) W"
    }
    return "体感"
}

/// 步时长：距离段 `800 m` / `14 km`，时长段 `15:00`，open 段不定时长。
public func fmtStepDuration(_ step: WorkoutStep) -> String {
    if step.duration.kind == "distance_m", let value = step.duration.value {
        if value < 1000 { return "\(Int(value)) m" }
        let km = value / 1000
        return km == km.rounded() ? "\(Int(km)) km" : String(format: "%.1f km", km)
    }
    if step.duration.kind == "time_s", let value = step.duration.value {
        return fmtClock(value)
    }
    return "不定时长"
}

/// 步后休息文案（work 步携带；展开为独立休息行）。
public func fmtStepRest(_ rest: WorkoutStepRest) -> String {
    if rest.kind == "time_s", let value = rest.value {
        return value < 120 ? "\(Int(value)) 秒" : fmtClock(value)
    }
    if rest.kind == "hr_bpm", let value = rest.value {
        return "心率降到 \(Int(value)) 以下继续"
    }
    return "休息至手动继续"
}

/// 跑课 blocks → 分段组。
public func buildRunGroups(_ spec: RunWorkoutSpec) -> [SegmentGroup] {
    spec.blocks.enumerated().map { blockIndex, block in
        var rows: [SegmentRow] = []
        block.steps.enumerated().forEach { stepIndex, step in
            let meta = stepKindMeta(step.stepKind)
            rows.append(SegmentRow(
                id: "s\(blockIndex)-\(stepIndex)",
                kindLabel: meta.label,
                kindColorName: meta.colorName,
                quiet: meta.quiet,
                main: "\(fmtStepDuration(step)) · \(fmtTarget(step.target))",
                hrCapText: step.hrCapBpm.map { "心率≤\(Int($0))" } ?? "",
                note: (step.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            ))
            // 步后休息第一公民（devops#520 D2 idiom）：展开为独立休息行。
            if let rest = step.rest {
                rows.append(SegmentRow(
                    id: "s\(blockIndex)-\(stepIndex)-rest",
                    kindLabel: "休息",
                    kindColorName: "gray",
                    quiet: true,
                    main: fmtStepRest(rest),
                    hrCapText: "",
                    note: ""
                ))
            }
        }
        return SegmentGroup(id: "b\(blockIndex)", repeatCount: block.repeatCount, rows: rows)
    }
}

/// 力量课 → 动作行。
public func buildExerciseRows(_ spec: StrengthWorkoutSpec) -> [ExerciseRow] {
    spec.exercises.enumerated().map { index, exercise in
        ExerciseRow(
            id: "e\(index)",
            name: exercise.displayName.isEmpty ? exercise.canonicalId : exercise.displayName,
            target: "\(exercise.sets) 组 × \(exercise.targetKind == "reps" ? "\(Int(exercise.targetValue)) 次" : fmtClock(exercise.targetValue))",
            rest: exercise.restSeconds > 0 ? "组间休息 \(exercise.restSeconds) 秒" : "",
            note: (exercise.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }
}

// MARK: - 整课估时（配速中值兜底，services/plan.ts 同口径）

let defaultPaceSKm = 360.0
let openStepDefaultS = 300.0
let nonTimeRestDefaultS = 60.0

func estimateStepSeconds(_ step: WorkoutStep, fallbackPace: Double) -> Double {
    if step.duration.kind == "time_s", let value = step.duration.value, value > 0 { return value }
    if step.duration.kind == "distance_m", let value = step.duration.value, value > 0 {
        let pace: Double
        if let target = step.target, target.kind == "pace_s_km", let low = target.low, let high = target.high {
            pace = (low + high) / 2
        } else {
            pace = fallbackPace
        }
        return (value / 1000) * pace
    }
    return openStepDefaultS
}

func estimateRestSeconds(_ rest: WorkoutStepRest) -> Double {
    if rest.kind == "time_s", let value = rest.value, value > 0 { return value }
    return nonTimeRestDefaultS
}

/// 整课估时（秒）：落库 total_duration_s 缺失时的展示兜底
/// （配速中值折算，10-20 用户拍板）。
public func estimateWorkoutSeconds(_ spec: RunWorkoutSpec) -> Double {
    var paceSum = 0.0
    var paceCount = 0
    for block in spec.blocks {
        for step in block.steps {
            if let target = step.target, target.kind == "pace_s_km", let low = target.low, let high = target.high {
                paceSum += (low + high) / 2
                paceCount += 1
            }
        }
    }
    let fallbackPace = paceCount > 0 ? paceSum / Double(paceCount) : defaultPaceSKm
    var total = 0.0
    for block in spec.blocks {
        for _ in 0..<max(1, block.repeatCount) {
            for step in block.steps {
                total += estimateStepSeconds(step, fallbackPace: fallbackPace)
                if let rest = step.rest { total += estimateRestSeconds(rest) }
            }
        }
    }
    return total
}

/// 秒 → `h:mm:ss`（<1h 时 `mm:ss`；赛事域另有 Int 版 `formatDuration`，
/// 本域时长来源是 Double 落库值，独立命名避免重载歧义）。
public func fmtDurationShort(_ sec: Double) -> String {
    let total = Int(sec.rounded())
    let h = total / 3600
    let m = (total % 3600) / 60
    let s = total % 60
    return h > 0 ? "\(h):\(String(format: "%02d", m)):\(String(format: "%02d", s))"
        : "\(String(format: "%02d", m)):\(String(format: "%02d", s))"
}

// MARK: - ±7 天选日（utils/date.ts buildPushDateOptions 直译）

public struct PushDateOption: Equatable, Identifiable, Sendable {
    public let label: String
    public let value: String
    public let selected: Bool

    public var id: String { value }
}

/// 今天起共 8 个可选日（含今天）；计划日落在可见范围内提升为默认（带
/// 「（原排期）」标），否则回退今天。
public func buildPushDateOptions(plannedDate: String, plannedTag: String = "（计划日）", now: Date = Date()) -> [PushDateOption] {
    let forwardDays = 7
    let today = Shanghai.todayYMD(now: now)
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = Shanghai.timeZone

    func ymdByOffset(_ base: String, _ days: Int) -> String? {
        guard let date = Shanghai.ymdDate(base),
              let shifted = calendar.date(byAdding: .day, value: days, to: date) else { return nil }
        return Shanghai.todayYMD(now: shifted)
    }

    // 计划日与今天的天数差（上海时区日历数学；解析失败按不可见处理）。
    let plannedOffset: Int? = Shanghai.ymdDate(plannedDate).flatMap { planned -> Int? in
        calendar.dateComponents([.day],
                                from: calendar.startOfDay(for: now),
                                to: calendar.startOfDay(for: planned)).day
    }
    let plannedVisible = plannedOffset != nil && plannedOffset! >= 0
    let defaultOffset = plannedVisible && plannedOffset! <= forwardDays ? plannedOffset! : 0

    var out: [PushDateOption] = []
    for offset in 0...forwardDays {
        guard let ymd = ymdByOffset(today, offset) else { continue }
        var label: String
        switch offset {
        case 0: label = "今天"
        case 1: label = "明天"
        case 2: label = "后天"
        default:
            let weekday = Shanghai.weekdayLabel(ymd)
            label = "\(weekday) \(ymd.dropFirst(5))"
        }
        if ymd == plannedDate {
            label += plannedTag
        }
        out.append(PushDateOption(label: label, value: ymd, selected: offset == defaultOffset))
    }
    return out
}
