import Foundation

// 圈速表标记 + 力量分组（devops#766）：纯函数直译小程序 `utils/lapRows.ts`
// （lapPaceMarks）与 activity-detail.ts 的 buildStrengthSegments。

// MARK: - 圈速标记

/// 单圈配速标记：与上一圈的走向 + 全场最快 / 最慢高亮（恢复圈两者都没有）。
public struct LapPaceMark: Equatable, Sendable {

    public enum Trend: String, Equatable, Sendable {
        case none = ""
        case up
        case down
    }

    public enum RowClass: String, Equatable, Sendable {
        case none = ""
        case fastest
        case slowest
        case rest
    }

    /// 配速走向（vs 上一「有圈号」圈；快 = up）。
    public let trend: Trend
    /// 心率走向（vs 上一「有圈号」圈；升高 = up）。
    public let hrTrend: Trend
    /// 恢复圈（组间停顿）：不计圈号、不比箭头、不参与最快 / 最慢。
    public let rest: Bool
    public let rowClass: RowClass
    /// 圈数徽标文字（"" / 最快 / 最慢）。
    public let tag: String

    public init(trend: Trend, hrTrend: Trend, rest: Bool, rowClass: RowClass, tag: String) {
        self.trend = trend
        self.hrTrend = hrTrend
        self.rest = rest
        self.rowClass = rowClass
        self.tag = tag
    }
}

/// 有配速的圈少于这个数就不标最快 / 最慢。
private let minRankableLaps = 3

/// 后端 SegmentName 给停顿圈起的名字（exercise_type 4/3 → 恢复 / 休息）。
private let restSegNames: Set<String> = ["恢复", "休息"]

/// COROS 原始圈类型：3 = 恢复圈。
private let restMode = 3

/// 计算圈速表每圈的配速箭头与最快 / 最慢高亮（语义与 lapRows.ts 逐条一致）：
///
/// - 恢复圈（seg_name 恢复/休息，或原始 mode 3）不计圈号、不比箭头、不参与最快/最慢
/// - 箭头：本圈配速 vs 上一「有圈号」圈（跨过中间的恢复圈）
/// - 最快 / 最慢：所有有配速的普通圈一起按 avg_pace（s/km）比，不按 duration_s
public func lapPaceMarks(_ laps: [Segment]) -> [LapPaceMark] {
    let rest = laps.map { restSegNames.contains($0.segName) || $0.mode == restMode }
    let active = laps.indices.filter { !rest[$0] }
    let paced = active.filter { laps[$0].avgPace != nil }

    var fast = -1
    var slow = -1
    if paced.count >= minRankableLaps {
        for i in paced {
            let pace = laps[i].avgPace!
            if fast < 0 || pace < laps[fast].avgPace! { fast = i }
            if slow < 0 || pace > laps[slow].avgPace! { slow = i }
        }
        // 全部同配速时不分高下
        if laps[fast].avgPace == laps[slow].avgPace { fast = -1; slow = -1 }
    }

    func direction(_ cur: Double?, _ prev: Double?) -> LapPaceMark.Trend {
        guard let cur, let prev, cur != prev else { return .none }
        return cur > prev ? .up : .down
    }

    var prevActive = -1
    return laps.indices.map { i in
        if rest[i] {
            return LapPaceMark(trend: .none, hrTrend: .none, rest: true, rowClass: .rest, tag: "")
        }
        let cur = laps[i].avgPace
        let prev = prevActive >= 0 ? laps[prevActive].avgPace : nil
        let prevHr = prevActive >= 0 ? laps[prevActive].avgHr : nil
        prevActive = i
        let trend: LapPaceMark.Trend = {
            guard let cur, let prev, cur != prev else { return .none }
            return cur < prev ? .up : .down
        }()
        return LapPaceMark(
            trend: trend,
            hrTrend: direction(laps[i].avgHr, prevHr),
            rest: false,
            rowClass: i == fast ? .fastest : i == slow ? .slowest : .none,
            tag: i == fast ? "最快" : i == slow ? "最慢" : ""
        )
    }
}

// MARK: - 圈速表行

/// 圈速表一行（展示格式化后的字符串，视图直接消费）。
public struct LapRow: Equatable, Identifiable, Sendable {
    /// 恢复圈不占圈号。
    public let index: String
    public let duration: String
    public let distanceKm: String
    /// 平均配速拆两段（分钟 / `'SS"`），按 `'` 对齐。
    public let paceMin: String
    public let paceSec: String
    public let paceTrend: LapPaceMark.Trend
    public let hrTrend: LapPaceMark.Trend
    public let rowClass: LapPaceMark.RowClass
    public let tag: String
    public let hr: String
    public let cadence: String

    public var id: String { "\(index)-\(duration)-\(distanceKm)-\(paceMin)\(paceSec)-\(hr)" }
}

/// 圈速表（圈速 = 后端 `segments`：type2 手表圈/间歇组，回落 autoKm）。
public func buildLapRows(_ segments: [Segment]) -> [LapRow] {
    let marks = lapPaceMarks(segments)
    var lapNo = 0
    return segments.indices.map { i in
        let seg = segments[i]
        let mark = marks[i]
        let (paceMin, paceSec) = Fmt.paceQuoteParts(seg.avgPace)
        if !mark.rest { lapNo += 1 }
        return LapRow(
            index: mark.rest ? "恢复" : String(lapNo),
            duration: seg.durationFmt ?? "—",
            distanceKm: seg.distanceKm != nil && seg.distanceKm! > 0 ? String(format: "%.2f", seg.distanceKm!) : "—",
            paceMin: paceMin,
            paceSec: paceSec,
            paceTrend: mark.trend,
            hrTrend: mark.hrTrend,
            rowClass: mark.rowClass,
            tag: mark.tag,
            hr: Fmt.intStr(seg.avgHr),
            cadence: Fmt.intStr(seg.avgCadence)
        )
    }
}

// MARK: - 力量分组

/// 力量活动分组表一行：动作 / 组数 / 时长 / 均心率。
public struct ExerciseGroup: Equatable, Identifiable, Sendable {
    public let name: String
    public let sets: Int
    public let duration: String
    public let avgHr: String

    public var id: String { "\(name)-\(sets)-\(duration)-\(avgHr)" }
}

/// 力量分组（力量活动替代圈速表）：同名连续 segment 合一组，
/// 休息圈（seg_name 休息 或 mode 15/16/17）整段跳过。
/// 注：此处 rest 判定口径与圈速表（mode 3）不同，各自照搬小程序原文。
public func buildStrengthSegments(_ segments: [Segment]) -> [ExerciseGroup] {
    func isRest(_ seg: Segment) -> Bool {
        seg.segName == "休息" || seg.mode == 15 || seg.mode == 16 || seg.mode == 17
    }

    struct Acc {
        var name: String
        var sets: Int
        var durationS: Double
        var hrSum: Double
        var hrCount: Int
    }

    var groups: [Acc] = []
    for seg in segments {
        if isRest(seg) { continue }
        let name = seg.segName.isEmpty ? "训练" : seg.segName
        // 值语义：同名连续段累计进 groups 末元素（TS 原版是对象引用共享）。
        if let last = groups.last, last.name == name {
            groups[groups.count - 1].sets += 1
            groups[groups.count - 1].durationS += seg.durationS ?? 0
            if let hr = seg.avgHr {
                groups[groups.count - 1].hrSum += hr
                groups[groups.count - 1].hrCount += 1
            }
        } else {
            groups.append(Acc(name: name, sets: 1, durationS: seg.durationS ?? 0,
                              hrSum: seg.avgHr ?? 0, hrCount: seg.avgHr != nil ? 1 : 0))
        }
    }

    return groups.map {
        ExerciseGroup(
            name: $0.name,
            sets: $0.sets,
            duration: $0.durationS > 0 ? Fmt.durationShort($0.durationS) : "—",
            avgHr: $0.hrCount > 0 ? String(Int(($0.hrSum / Double($0.hrCount)).rounded())) : "—"
        )
    }
}
