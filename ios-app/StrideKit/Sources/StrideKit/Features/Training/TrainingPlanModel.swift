import Foundation
import Observation

// 「我的训练计划」ViewModel（devops#768 PR-5，baseline §4.2 直译）：
// 方案 B「备赛旅程」—— 目标条 / lede / 训练周期图（km·dose 切换、阶段色带、
// 三态柱、当前周粉红、点柱详情）/ 旅程时间轴（阶段块+周行展开）/ 本周关键课 /
// 训练原则 / 教练 CTA；content_version 1/2 分流；v1 旧计划提示去网页。
// 视图模型构建为纯静态函数（小程序 training-plan.ts buildViewModels 直译）。

// MARK: - 阶段 / 课型配色语义

/// 阶段配色沿用 Web PHASE_VISUALS 语义（降饱和贴主题）；「当前/你在这里」
/// 的注意力色仍是主题粉。
public enum PhaseMeta {

    public static func label(kind: String) -> String {
        switch kind {
        case "base": "基础"
        case "speed": "速度"
        case "build": "专项"
        case "peak": "峰值"
        case "taper": "减量"
        case "race": "比赛"
        case "recovery": "恢复"
        default: kind
        }
    }

    public static func color(kind: String) -> UInt32 {
        switch kind {
        case "base": 0x7AC9A3
        case "speed", "build": 0x6DB3CF
        case "peak": 0xD9A45F
        case "taper": 0xB395D6
        case "race": 0xFF6363
        case "recovery": 0x9C9C9D
        default: 0x9C9C9D
        }
    }

    static let order = ["base", "speed", "build", "peak", "taper", "race", "recovery"]

    /// 阶段类型：phase_type 优先，缺失按名称正则推导，再兜底顺序表。
    public static func kind(of phase: MasterPlanPhase, index: Int) -> String {
        if let t = phase.phaseType, order.contains(t) { return t }
        let name = phase.name
        if name.contains("基础") || name.lowercased().contains("base") { return "base" }
        if name.contains("速度") || name.lowercased().contains("speed") { return "speed" }
        if name.contains("峰值") || name.lowercased().contains("peak") { return "peak" }
        if name.contains("专项") || name.lowercased().contains("build") { return "build" }
        if name.contains("减量") || name.lowercased().contains("taper") { return "taper" }
        if name.contains("比赛") || name.lowercased().contains("race") { return "race" }
        if name.contains("恢复") || name.lowercased().contains("recovery") { return "recovery" }
        return order[index % order.count]
    }
}

/// 课型 chip（11 值枚举 → 中文标签 + SF Symbol）。
public enum SessionTypeMeta {

    private static let table: [String: (String, String)] = [
        "long_run": ("长距离跑", "figure.run"),
        "threshold": ("阈值跑", "dumbbell"),
        "tempo": ("节奏跑", "dumbbell"),
        "interval": ("间歇跑", "bolt"),
        "vo2max": ("间歇跑", "bolt"),
        "hill": ("坡度跑", "arrow.up.right"),
        "race_pace": ("配速跑", "flag"),
        "time_trial": ("测验", "flag"),
        "tune_up_race": ("热身赛", "flag"),
        "race": ("比赛", "flag"),
        "strength_key": ("力量课", "dumbbell"),
    ]

    public static func label(_ type: String) -> String { table[type]?.0 ?? type }
    public static func systemImage(_ type: String) -> String { table[type]?.1 ?? "figure.run" }
}

private let milestoneTypeLabels = [
    "race": "比赛", "test_run": "测验", "long_run": "长距离",
    "strength_test": "力量测验", "body_composition": "体测",
]

private let distanceLabels = ["5K": "5K", "10K": "10K", "HM": "半马", "FM": "全马"]

// MARK: - 视图模型

public enum PlanBarState: String, Equatable, Sendable {
    case done, current, future
}

public struct PlanChartBar: Equatable, Identifiable, Sendable {
    public let week: Int
    public let state: PlanBarState
    /// 归一化填充高度（0-1）。
    public let fill: Double
    /// 归一化计划带上沿（0-1）。
    public let band: Double
    /// 归一化计划中值刻度（0-1，仅 km 口径）。
    public let tick: Double
    public let barColor: UInt32
    public let bandColor: UInt32
    public let opacity: Double
    public let label: String

    public var id: Int { week }
}

public struct PlanChartSpan: Equatable, Identifiable, Sendable {
    public let index: Int
    public let label: String
    public let weeks: Int
    public let color: UInt32

    public var id: Int { index }
}

public struct PlanMilestoneVM: Equatable, Identifiable, Sendable {
    public let id: String
    public let dateLabel: String
    public let typeLabel: String
    public let valueText: String
    public let done: Bool
    public let isNext: Bool
    public let daysUntilLabel: String
}

public struct PlanPhaseVM: Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let typeLabel: String
    public let color: UInt32
    public let weeksLabel: String
    public let weekCount: Int
    public let dateRange: String
    public let kmRange: String
    public let focus: String
    public let rhythm: String
    public let keyWorkouts: String
    public let triggers: [String]
    public let keySessionTypes: [String]
    public let summaryLine: String
    public let hrZoneLine: String
    public let coachNote: String
    public let milestones: [PlanMilestoneVM]
    public let state: PlanBarState
}

public struct PlanWeekRowVM: Equatable, Identifiable, Sendable {
    public let weekIndex: Int
    public let phaseId: String
    public let dateRange: String
    public let planKm: String
    public let actualKm: String
    public let actualSub: String
    public let tag: String
    public let state: PlanBarState

    public var id: Int { weekIndex }
}

public enum PlanTimelineItem: Equatable, Identifiable, Sendable {
    case phase(PlanPhaseVM)
    case week(PlanWeekRowVM)

    public var id: String {
        switch self {
        case .phase(let p): "p-\(p.id)"
        case .week(let w): "w-\(w.weekIndex)"
        }
    }

    public var state: PlanBarState {
        switch self {
        case .phase(let p): p.state
        case .week(let w): w.state
        }
    }
}

public struct PlanSessionVM: Equatable, Identifiable, Sendable {
    public let index: Int
    public let systemImage: String
    public let title: String
    public let meta: String
    public let km: String

    public var id: Int { index }
}

/// 备赛旅程整体视图模型（buildViewModels 产物）。
public struct TrainingPlanVM: Equatable, Sendable {
    public let raceName: String
    public let raceDistanceLabel: String
    public let raceDateLabel: String
    public let targetTime: String
    public let targetPace: String
    public let countdownDays: Int
    public let ledeText: String
    public let weekNow: Int
    public let weekTotal: Int
    public let bars: [PlanChartBar]
    public let spans: [PlanChartSpan]
    public let chartDetail: String
    public let timeline: [PlanTimelineItem]
    public let currentSessions: [PlanSessionVM]
    public let principles: [(String, String)]

    public static func == (lhs: TrainingPlanVM, rhs: TrainingPlanVM) -> Bool {
        lhs.raceName == rhs.raceName && lhs.countdownDays == rhs.countdownDays
            && lhs.weekNow == rhs.weekNow && lhs.bars == rhs.bars && lhs.timeline == rhs.timeline
    }
}

// MARK: - 纯构建

public enum TrainingPlanBuilder {

    /// 负荷近似系数（原型定稿启发式）：计划 dose ≈ 周跑量 × 6.6-7.6，
    /// 实际 dose ≈ 实际跑量 × 7.1。仅在后端没写显式 dose 字段时兜底。
    static let dosePerKmPlannedLow = 6.6
    static let dosePerKmPlannedHigh = 7.6
    static let dosePerKmActual = 7.1

    /// 目标配速 = 目标成绩 ÷ 赛距；仅接受 H:MM:SS，无法换算返回空串。
    public static func targetPace(distance: String?, targetTime: String?) -> String {
        let dist: Double
        switch distance {
        case "FM": dist = 42.195
        case "HM": dist = 21.0975
        case "10K": dist = 10
        case "5K": dist = 5
        default: return ""
        }
        guard let targetTime, !targetTime.isEmpty else { return "" }
        let parts = targetTime.split(separator: ":").compactMap { Double($0) }
        guard parts.count == 3, parts.allSatisfy({ $0 >= 0 }) else { return "" }
        let sec = parts[0] * 3600 + parts[1] * 60 + parts[2]
        guard sec > 0 else { return "" }
        let pace = Int((sec / dist).rounded())
        return "\(pace / 60):\(String(format: "%02d", pace % 60))/km"
    }

    /// 每个阶段覆盖的周区间（weeks 不全覆盖时按日期推，保证每阶段有 span）。
    static func phaseWeekSpans(_ plan: SeasonPlanContent) -> [String: (from: Int, to: Int)] {
        var out: [String: (from: Int, to: Int)] = [:]
        for w in plan.weeks {
            var span = out[w.phaseId] ?? (from: w.weekIndex, to: w.weekIndex)
            span.from = min(span.from, w.weekIndex)
            span.to = max(span.to, w.weekIndex)
            out[w.phaseId] = span
        }
        let planStart = plan.startDate.split(separator: "T").first.map(String.init)
        for (i, p) in plan.phases.enumerated() {
            if out[p.id] != nil { continue }
            let s = ymd(p.startDate)
            let e = ymd(p.endDate)
            if let s, let planStart, let start = Shanghai.ymdDate(planStart) {
                let from = (days(s, start) / 7) + 1
                let to: Int
                if let e {
                    to = from + max(1, Int((ceil(Double(days(e, s) + 1) / 7)))) - 1
                } else {
                    to = from
                }
                out[p.id] = (from: from, to: to)
            } else {
                let prevTo = i > 0 ? out[plan.phases[i - 1].id]?.to : nil
                out[p.id] = (from: (prevTo ?? 0) + 1, to: (prevTo ?? 0) + 1)
            }
        }
        return out
    }

    /// 当前周：优先后端派生 current_week_number，缺了按 start_date 推。
    static func resolveWeekNow(_ plan: SeasonPlanContent, todayYmd: String) -> Int {
        let total = plan.totalWeeks > 0 ? plan.totalWeeks : max(plan.weeks.count, plan.phases.count)
        if let cur = plan.currentWeekNumber, cur >= 1 {
            return min(cur, total)
        }
        guard let start = ymd(plan.startDate), let today = Shanghai.ymdDate(todayYmd) else { return 1 }
        let raw = (days(today, start) / 7) + 1
        return max(1, min(total > 0 ? total : raw, raw))
    }

    static func plannedDoseRange(week: MasterPlanWeek?, phase: MasterPlanPhase) -> (low: Double, high: Double) {
        let lowKm = week?.targetWeeklyKmLow ?? phase.weeklyDistanceKmLow
        let highKm = week?.targetWeeklyKmHigh ?? phase.weeklyDistanceKmHigh
        return (
            week?.targetTrainingDoseLow ?? (lowKm * dosePerKmPlannedLow).rounded(),
            week?.targetTrainingDoseHigh ?? (highKm * dosePerKmPlannedHigh).rounded()
        )
    }

    static func actualDose(week: MasterPlanWeek?) -> Double? {
        guard let week else { return nil }
        if let d = week.actualTrainingDose { return d }
        return week.actualDistanceKm.map { $0 * dosePerKmActual }
    }

    static func plannedKmText(week: MasterPlanWeek?, phase: MasterPlanPhase) -> String {
        if let low = week?.targetWeeklyKmLow, let high = week?.targetWeeklyKmHigh {
            return "\(fmtKm(low))-\(fmtKm(high)) km"
        }
        return "\(fmtKm(phase.weeklyDistanceKmLow))-\(fmtKm(phase.weeklyDistanceKmHigh)) km"
    }

    static func weekStartDate(_ plan: SeasonPlanContent, weekIndex: Int) -> String? {
        if let row = plan.weeks.first(where: { $0.weekIndex == weekIndex }) {
            return String(row.weekStart.prefix(10))
        }
        guard let startIso = isoYMD(plan.startDate) else { return nil }
        return Shanghai.addDays(startIso, (weekIndex - 1) * 7)
    }

    /// 训练周期图（柱 + 阶段 span），归一化到 0-1。
    static func buildChart(plan: SeasonPlanContent, spans: [String: (from: Int, to: Int)],
                           weekNow: Int, weekTotal: Int, metric: Bool) -> (bars: [PlanChartBar], spans: [PlanChartSpan]) {
        let phasesById = Dictionary(uniqueKeysWithValues: plan.phases.map { ($0.id, $0) })
        let weeksByIndex = Dictionary(uniqueKeysWithValues: plan.weeks.map { ($0.weekIndex, $0) })

        func phaseOf(week: Int) -> MasterPlanPhase {
            if let pid = weeksByIndex[week]?.phaseId, let p = phasesById[pid] { return p }
            for (id, span) in spans where span.from <= week && week <= span.to {
                if let p = phasesById[id] { return p }
            }
            return plan.phases.last ?? plan.phases[0]
        }

        var maxKm = 0.0
        var maxDose = 0.0
        for w in 1...max(weekTotal, 1) {
            let week = weeksByIndex[w]
            let phase = phaseOf(week: w)
            let high = week?.targetWeeklyKmHigh ?? phase.weeklyDistanceKmHigh
            maxKm = max(maxKm, high, week?.actualDistanceKm ?? 0)
            maxDose = max(maxDose, plannedDoseRange(week: week, phase: phase).high, actualDose(week: week) ?? 0)
        }
        if maxKm <= 0 { maxKm = 1 }
        if maxDose <= 0 { maxDose = 1 }

        var bars: [PlanChartBar] = []
        for w in 1...max(weekTotal, 1) {
            let week = weeksByIndex[w]
            let phase = phaseOf(week: w)
            let kind = PhaseMeta.kind(of: phase, index: plan.phases.firstIndex(where: { $0.id == phase.id }) ?? 0)
            let state: PlanBarState = w < weekNow ? .done : (w == weekNow ? .current : .future)
            let plannedLow = week?.targetWeeklyKmLow ?? phase.weeklyDistanceKmLow
            let plannedHigh = week?.targetWeeklyKmHigh ?? phase.weeklyDistanceKmHigh
            let plannedMid = week?.plannedDistanceKm ?? (plannedLow + plannedHigh) / 2

            var fill = 0.0
            var band = 0.0
            var tick = 0.0
            if metric {
                // dose 口径
                let range = plannedDoseRange(week: week, phase: phase)
                band = max(range.high, range.low) / maxDose
                if let ad = actualDose(week: week) {
                    fill = ad / maxDose
                }
            } else {
                // km 口径
                fill = (week?.actualDistanceKm ?? plannedMid) / maxKm
                tick = plannedMid / maxKm
            }
            bars.append(PlanChartBar(
                week: w,
                state: state,
                fill: fill,
                band: band,
                tick: tick,
                barColor: state == .current ? 0xFF6363 : PhaseMeta.color(kind: kind),
                bandColor: PhaseMeta.color(kind: kind),
                opacity: state == .future ? 0.18 : (state == .done ? 0.85 : 1),
                label: state == .current ? "当前" : ""
            ))
        }

        let spanVMs = plan.phases.enumerated().map { i, p -> PlanChartSpan in
            let kind = PhaseMeta.kind(of: p, index: i)
            let span = spans[p.id]
            return PlanChartSpan(
                index: i,
                label: PhaseMeta.label(kind: kind),
                weeks: span.map { $0.to - $0.from + 1 } ?? 1,
                color: PhaseMeta.color(kind: kind)
            )
        }
        return (bars, spanVMs)
    }

    /// 点柱后的详情行（Web hover tooltip 等价）。
    public static func buildChartDetail(plan: SeasonPlanContent, spans: [String: (from: Int, to: Int)],
                                        weekNow: Int, weekIndex: Int, metric: Bool) -> String {
        let weeksByIndex = Dictionary(uniqueKeysWithValues: plan.weeks.map { ($0.weekIndex, $0) })
        let phasesById = Dictionary(uniqueKeysWithValues: plan.phases.map { ($0.id, $0) })
        let week = weeksByIndex[weekIndex]
        let phase: MasterPlanPhase
        if let pid = week?.phaseId, let p = phasesById[pid] {
            phase = p
        } else if let entry = spans.first(where: { $0.value.from <= weekIndex && weekIndex <= $0.value.to }),
                  let p = phasesById[entry.key] {
            phase = p
        } else {
            phase = plan.phases.last ?? plan.phases[0]
        }

        var parts: [String] = [String(format: "W%02d", weekIndex)]
        if let ws = weekStartDate(plan, weekIndex: weekIndex) {
            parts.append("\(Shanghai.shortDate(ymd: ws)) – \(Shanghai.shortDate(ymd: Shanghai.addDays(ws, 6)))")
        }
        let state: PlanBarState = weekIndex < weekNow ? .done : (weekIndex == weekNow ? .current : .future)
        let actualKm = week?.actualDistanceKm
        if metric {
            let range = plannedDoseRange(week: week, phase: phase)
            parts.append("计划负荷 \(fmtKm(range.low))-\(fmtKm(range.high)) dose")
            if let ad = actualDose(week: week), ad > 0 {
                parts.append("实际负荷 \(fmtKm(ad)) dose\(state == .current ? "（截至目前）" : "")")
            }
        } else {
            parts.append("计划 \(plannedKmText(week: week, phase: phase).replacingOccurrences(of: " km", with: "")) km")
            if let actualKm {
                parts.append("实际 \(fmtKm(actualKm)) km\(state == .current ? "（截至目前）" : "")")
                var sub: [String] = []
                if let pace = week?.actualAvgPaceFmt, !pace.isEmpty { sub.append("\(pace)/km") }
                if let hr = week?.actualAvgHr { sub.append("\(Int(hr)) bpm") }
                if !sub.isEmpty { parts.append(sub.joined(separator: " · ")) }
            } else if state != .future {
                parts.append("未完成")
            }
        }
        return parts.joined(separator: " · ")
    }

    /// 整体视图模型（goal 条 + 周期图 + 时间轴 + 本周关键课 + 原则）。
    public static func buildViewModels(plan: SeasonPlanContent, todayYmd: String) -> TrainingPlanVM {
        let totalWeeks = plan.totalWeeks > 0 ? plan.totalWeeks : max(plan.weeks.count, plan.phases.count)
        let weekNow = resolveWeekNow(plan, todayYmd: todayYmd)
        let spans = phaseWeekSpans(plan)
        let weeksByIndex = Dictionary(uniqueKeysWithValues: plan.weeks.map { ($0.weekIndex, $0) })
        let phasesById = Dictionary(uniqueKeysWithValues: plan.phases.map { ($0.id, $0) })

        var currentPhaseId = plan.currentPhaseId ?? ""
        if currentPhaseId.isEmpty || phasesById[currentPhaseId] == nil {
            currentPhaseId = spans.first { $0.value.from <= weekNow && weekNow <= $0.value.to }?.key ?? ""
        }
        let currentPhase = phasesById[currentPhaseId] ?? plan.phases.last

        let goal = plan.goal
        let raceDateYmd = isoYMD(goal.raceDate ?? isoYMD(plan.endDate))
        let countdownDays: Int
        if let raceDateYmd, let race = Shanghai.ymdDate(raceDateYmd), let today = Shanghai.ymdDate(todayYmd) {
            countdownDays = max(0, days(race, today))
        } else {
            countdownDays = 0
        }

        var ledeParts: [String] = []
        if let startIso = TrainingPlanBuilder.isoYMD(plan.startDate), let raceDateYmd {
            ledeParts.append("\(Shanghai.shortDate(ymd: startIso)) – \(Shanghai.shortDate(ymd: raceDateYmd))")
        }
        ledeParts.append("共 \(totalWeeks) 周")
        ledeParts.append("当前第 \(weekNow) 周")
        if let currentPhase {
            ledeParts.append("\(currentPhase.name)，重点是「\(currentPhase.focus)」")
        }
        let ledeText = ledeParts.joined(separator: " · ")

        let nextMilestoneId = plan.nextMilestone?.id ?? ""

        let phaseVMs: [PlanPhaseVM] = plan.phases.enumerated().map { idx, p in
            let kind = PhaseMeta.kind(of: p, index: idx)
            let span = spans[p.id] ?? (from: 1, to: 1)
            let state: PlanBarState
            if p.isCompleted == true {
                state = .done
            } else if p.id == currentPhaseId {
                state = .current
            } else if span.to < weekNow {
                state = .done
            } else {
                state = .future
            }
            var phaseDateRange = ""
            if let sIso = isoYMD(p.startDate), let eIso = isoYMD(p.endDate) {
                phaseDateRange = "\(Shanghai.shortDate(ymd: sIso)) – \(Shanghai.shortDate(ymd: eIso))"
            }

            var summaryLine = ""
            var hrZoneLine = ""
            if state == .done, let s = p.summary {
                var bits = ["\(fmtKm((s.totalDistanceKm * 10).rounded() / 10)) km", "\(s.runCount) 次"]
                if let pace = s.avgPaceFmt, !pace.isEmpty { bits.append("均配 \(pace)/km") }
                if let hr = s.avgHr { bits.append("\(Int(hr)) bpm") }
                summaryLine = "阶段小结：\(bits.joined(separator: " · "))"
                if let zones = s.hrZoneDistribution, !zones.isEmpty {
                    hrZoneLine = zones.map { "Z\($0.zoneIndex) \(Int($0.percent.rounded()))%" }.joined(separator: " · ")
                }
            }

            let milestones: [PlanMilestoneVM] = plan.milestones
                .filter { $0.phaseId == p.id }
                .map { m in
                    let md = ymd(m.date)
                    let daysUntil: Int
                    if m.id == nextMilestoneId, let nm = plan.nextMilestone {
                        daysUntil = nm.daysUntil
                    } else if let md, let today = Shanghai.ymdDate(todayYmd) {
                        daysUntil = days(md, today)
                    } else {
                        daysUntil = 0
                    }
                    let isNext = m.id == nextMilestoneId && m.completedActual == nil && daysUntil >= 0
                    return PlanMilestoneVM(
                        id: m.id,
                        dateLabel: isoYMD(m.date).map { Shanghai.shortDate(ymd: $0) } ?? String(m.date.prefix(10)),
                        typeLabel: milestoneTypeLabels[m.type] ?? m.type,
                        valueText: m.completedActual != nil ? "实测 \(m.completedActual!)（目标 \(m.target)）" : "目标 \(m.target)",
                        done: m.completedActual != nil,
                        isNext: isNext,
                        daysUntilLabel: "\(max(0, daysUntil)) 天后"
                    )
                }

            return PlanPhaseVM(
                id: p.id,
                name: p.name,
                typeLabel: PhaseMeta.label(kind: kind),
                color: PhaseMeta.color(kind: kind),
                weeksLabel: String(format: "W%02d-W%02d", span.from, span.to),
                weekCount: span.to - span.from + 1,
                dateRange: phaseDateRange,
                kmRange: "\(fmtKm(p.weeklyDistanceKmLow))-\(fmtKm(p.weeklyDistanceKmHigh)) km/w",
                focus: p.focus,
                rhythm: p.rhythm ?? "",
                keyWorkouts: p.keyWorkouts ?? "",
                triggers: p.monitoringTriggers ?? [],
                keySessionTypes: (p.keySessionTypes ?? []).map { SessionTypeMeta.label($0) },
                summaryLine: summaryLine,
                hrZoneLine: hrZoneLine,
                coachNote: state == .current ? (p.coachNote ?? "") : "",
                milestones: milestones,
                state: state
            )
        }

        // 旅程时间轴：阶段块 → 周行。
        var timeline: [PlanTimelineItem] = []
        for (idx, pvm) in phaseVMs.enumerated() {
            timeline.append(.phase(pvm))
            guard let span = spans[plan.phases[idx].id] else { continue }
            for w in span.from...max(span.from, span.to) {
                let week = weeksByIndex[w]
                let st: PlanBarState = w < weekNow ? .done : (w == weekNow ? .current : .future)
                let ws = weekStartDate(plan, weekIndex: w)
                var dateRange = ""
                if let ws {
                    dateRange = "\(Shanghai.shortDate(ymd: ws)) – \(Shanghai.shortDate(ymd: Shanghai.addDays(ws, 6)))"
                }
                var sub: [String] = []
                if let pace = week?.actualAvgPaceFmt, !pace.isEmpty { sub.append("\(pace)/km") }
                if let hr = week?.actualAvgHr { sub.append("\(Int(hr)) bpm") }
                var tag = ""
                if w == totalWeeks { tag = "比赛周" }
                else if week?.isTaperWeek == true { tag = "减量周" }
                else if week?.isRecoveryWeek == true { tag = "调整周" }
                timeline.append(.week(PlanWeekRowVM(
                    weekIndex: w,
                    phaseId: pvm.id,
                    dateRange: dateRange,
                    planKm: plannedKmText(week: week, phase: plan.phases[idx]),
                    actualKm: week?.actualDistanceKm != nil ? "\(fmtKm(week!.actualDistanceKm!)) km" : "",
                    actualSub: sub.isEmpty ? "" : sub.joined(separator: " · "),
                    tag: tag,
                    state: st
                )))
            }
        }

        // 本周关键课（当前周展开时渲染）。
        let currentWeek = weeksByIndex[weekNow]
        let currentSessions: [PlanSessionVM] = (currentWeek?.keySessions ?? []).enumerated().map { i, s in
            let km: String
            if let d = s.distanceKm {
                km = "\(fmtKm(d)) km"
            } else if let dur = s.durationMin {
                km = "\(Int(dur.rounded())) 分钟"
            } else {
                km = ""
            }
            return PlanSessionVM(
                index: i,
                systemImage: SessionTypeMeta.systemImage(s.type),
                title: SessionTypeMeta.label(s.type),
                meta: s.purpose ?? s.intensity ?? "",
                km: km
            )
        }

        let chart = buildChart(plan: plan, spans: spans, weekNow: weekNow, weekTotal: totalWeeks, metric: false)
        let chartDetail = buildChartDetail(plan: plan, spans: spans, weekNow: weekNow, weekIndex: weekNow, metric: false)

        return TrainingPlanVM(
            raceName: goal.raceName?.isEmpty == false ? goal.raceName! : "赛季训练计划",
            raceDistanceLabel: goal.distance.flatMap { distanceLabels[$0] } ?? (goal.distance ?? ""),
            raceDateLabel: (isoYMD(goal.raceDate ?? plan.endDate) ?? "").replacingOccurrences(of: "-", with: "."),
            targetTime: goal.targetTime ?? "",
            targetPace: targetPace(distance: goal.distance, targetTime: goal.targetTime),
            countdownDays: countdownDays,
            ledeText: ledeText,
            weekNow: weekNow,
            weekTotal: totalWeeks,
            bars: chart.bars,
            spans: chart.spans,
            chartDetail: chartDetail,
            timeline: timeline,
            currentSessions: currentSessions,
            principles: (plan.trainingPrinciples).enumerated().map { i, t in
                (String(format: "%02d", i + 1), t)
            }
        )
    }

    // MARK: 日期工具（上海日历日；ISO 串先切日期部分）

    /// ISO 串 → `YYYY-MM-DD`。
    static func isoYMD(_ iso: String?) -> String? {
        guard let iso, !iso.isEmpty else { return nil }
        let part = String(iso.prefix(10))
        return part.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil ? part : nil
    }

    /// ISO 串 / YMD → 上海日历日 Date。
    static func ymd(_ iso: String?) -> Date? {
        isoYMD(iso).flatMap(Shanghai.ymdDate)
    }

    /// b - a 的整天差（上海日历日）。
    static func days(_ b: Date, _ a: Date) -> Int {
        Int((b.timeIntervalSince(a) / 86_400).rounded())
    }

    /// Web 端 formatKm 习惯：整数无小数、否则 1 位小数。
    static func fmtKm(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
    }
}

// MARK: - ViewModel

@MainActor
@Observable
public final class TrainingPlanModel {

    public enum LoadState: Equatable, Sendable {
        case loading, ready, empty, v1, error
    }

    public private(set) var loadState: LoadState = .loading
    public private(set) var errorText = ""
    public private(set) var vm: TrainingPlanVM?
    /// km / dose 切换（true = dose）。
    public private(set) var doseMetric = false
    public private(set) var selectedWeek = 1
    public private(set) var chartDetail = ""
    public private(set) var bars: [PlanChartBar] = []
    public private(set) var spans: [PlanChartSpan] = []
    /// 各阶段周行是否展开（key = phase id；默认全收起）。
    public var expandedPhases: Set<String> = []

    private var repo: TrainingRepository?
    private var userId = ""
    private var plan: SeasonPlanContent?
    private var todayYmd = ""

    public init(now: Date = Date()) {
        todayYmd = Shanghai.todayYMD(now: now)
    }

    public func activate(app: AppModel) async {
        await app.waitUntilSessionSettled()
        repo = TrainingRepository(api: app.api)
        userId = app.me?.id ?? ""
        await load()
    }

    public func retry() async {
        await load()
    }

    private func load() async {
        loadState = .loading
        errorText = ""
        guard !userId.isEmpty else {
            loadState = .error
            errorText = "请先登录后查看训练计划"
            return
        }
        do {
            guard let envelope = try await repo?.currentMasterPlan(userId: userId) else {
                loadState = .empty
                return
            }
            guard envelope.contentVersion == 2, let plan = envelope.plan else {
                // v1 正文是 markdown，App 端不渲染，提示去网页查看。
                loadState = .v1
                return
            }
            apply(plan)
        } catch {
            // 后端 detail 可能是英文 jargon，不上屏。
            loadState = .error
            errorText = "加载失败，请稍后重试"
        }
    }

    private func apply(_ plan: SeasonPlanContent) {
        guard !plan.phases.isEmpty else {
            loadState = .error
            errorText = "计划内容为空"
            return
        }
        self.plan = plan
        let vm = TrainingPlanBuilder.buildViewModels(plan: plan, todayYmd: todayYmd)
        self.vm = vm
        doseMetric = false
        selectedWeek = vm.weekNow
        bars = vm.bars
        spans = vm.spans
        chartDetail = vm.chartDetail
        expandedPhases = []
        loadState = .ready
    }

    // MARK: - 交互

    /// km / dose 切换重绘。
    public func toggleMetric(_ dose: Bool) {
        guard dose != doseMetric, let plan, let vm else { return }
        doseMetric = dose
        let chart = TrainingPlanBuilder.buildChart(
            plan: plan,
            spans: TrainingPlanBuilder.phaseWeekSpans(plan),
            weekNow: vm.weekNow,
            weekTotal: vm.weekTotal,
            metric: dose
        )
        bars = chart.bars
        spans = chart.spans
        chartDetail = TrainingPlanBuilder.buildChartDetail(
            plan: plan, spans: TrainingPlanBuilder.phaseWeekSpans(plan),
            weekNow: vm.weekNow, weekIndex: selectedWeek, metric: dose
        )
    }

    /// 点柱出详情行。
    public func selectWeek(_ week: Int) {
        guard let plan, let vm else { return }
        selectedWeek = week
        chartDetail = TrainingPlanBuilder.buildChartDetail(
            plan: plan, spans: TrainingPlanBuilder.phaseWeekSpans(plan),
            weekNow: vm.weekNow, weekIndex: week, metric: doseMetric
        )
    }

    public func togglePhaseWeeks(_ phaseId: String) {
        if expandedPhases.contains(phaseId) {
            expandedPhases.remove(phaseId)
        } else {
            expandedPhases.insert(phaseId)
        }
    }
}
