import Foundation

// 比赛策略报告页的纯视图模型（devops#769）—— 直译小程序 utils/raceStrategyRows.ts：
// 策略内容 → 可编辑行视图 的确定性变换、「用时=距离×配速」自动换算、
// 目标配速与分享文案。

// MARK: - 配速与时长解析

/// 配速文本 `5:40/km` → 每公里秒数；解析不了返回 nil。
public func parsePaceSPerKm(_ pace: String) -> Int? {
    let trimmed = pace.trimmingCharacters(in: .whitespaces)
    guard let re = try? NSRegularExpression(pattern: #"^(\d{1,2}):([0-5]\d)(?:/\s*km)?$"#),
          let m = re.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
          let r1 = Range(m.range(at: 1), in: trimmed),
          let r2 = Range(m.range(at: 2), in: trimmed),
          let min = Int(trimmed[r1]), let sec = Int(trimmed[r2]) else { return nil }
    let total = min * 60 + sec
    return total > 0 ? total : nil
}

/// 每公里秒数 → `5:40/km`。
public func formatPace(_ sPerKm: Int) -> String {
    String(format: "%d:%02d/km", sPerKm / 60, sPerKm % 60)
}

/// `h:mm:ss`（<1h 允许 `mm:ss`）→ 秒；解析不了返回 nil。
public func parseDuration(_ text: String) -> Int? {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard let re = try? NSRegularExpression(pattern: #"^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$"#),
          let m = re.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) else { return nil }
    func group(_ i: Int) -> Int? {
        guard let r = Range(m.range(at: i), in: trimmed) else { return nil }
        return Int(trimmed[r])
    }
    guard let p1 = group(1), let p2 = group(2) else { return nil }
    let h = group(3) != nil ? p1 : 0
    let min = group(3) != nil ? p2 : p1
    let sec = group(3) ?? p2
    let total = h * 3600 + min * 60 + sec
    return total > 0 ? total : nil
}

/// 秒数 → `h:mm:ss`（<1h 时 `mm:ss`，与教练口径一致）。
public func formatDuration(_ sec: Int) -> String {
    let h = sec / 3600, m = (sec % 3600) / 60, s = sec % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
}

/// 项目 token → 标准距离 km（全马/半马/{n}Km）；未知项目返回 nil。
public func raceDistanceKm(_ itemType: String) -> Double? {
    if itemType == "Marathon" { return 42.195 }
    if itemType == "HalfMarathon" { return 21.0975 }
    guard let m = itemType.range(of: #"^(\d+(?:\.\d+)?)Km$"#, options: .regularExpression) else { return nil }
    return Double(itemType[m].dropLast(2))
}

/// 目标配速 = 目标成绩 ÷ 项目距离（四舍五入到秒）；任一项解析不了返回 ''。
public func targetPaceLabel(_ targetTime: String, itemType: String) -> String {
    guard let sec = parseDuration(targetTime), let km = raceDistanceKm(itemType), km > 0 else { return "" }
    return formatPace(Int((Double(sec) / km).rounded()))
}

// MARK: - 行视图

/// 分段配速表的可编辑行：pace/note 手动编辑；times 自动算（距离已知时）。
public struct PaceRowView: Equatable, Identifiable, Sendable {
    public var id: Int { index }
    public var index: Int
    /// 原始分段名（保存体往返用）。
    public var segment: String
    /// 分段名里的距离短标签；无距离前缀回落整段名。
    public var distance: String
    /// 分段名去掉距离后的描述。
    public var desc: String
    /// 距离 km；nil = 未给出（用时保持文本态）。
    public var distanceKm: Double?
    public var pace: String
    public var segmentTime: String
    public var cumulativeTime: String
    public var note: String
}

/// 拆分段名：模型常把地形/位置描述写进 segment（「0–3km 外滩起跑（…）」），
/// 表格距离列只放短标签，描述另起一行小字；匹配不到距离前缀时整段名为距离。
public func splitSegmentName(_ segment: String) -> (distance: String, desc: String) {
    let trimmed = segment.trimmingCharacters(in: .whitespaces)
    let pattern = #"^([0-9]+(?:[.,][0-9]+)?\s*[–~\-—]+\s*[0-9]+(?:[.,][0-9]+)?\s*(?:km|公里)?|[0-9]+(?:[.,][0-9]+)?\s*(?:km|公里))\s*[：:、]?\s*(.*)$"#
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
          let m = re.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
          let r1 = Range(m.range(at: 1), in: trimmed),
          let r2 = Range(m.range(at: 2), in: trimmed) else { return (trimmed, "") }
    let distance = String(trimmed[r1]).split(separator: " ").joined(separator: " ")
    return (distance, String(trimmed[r2]).trimmingCharacters(in: .whitespaces))
}

/// 补给计划的可编辑行。
public struct FuelingRowView: Equatable, Identifiable, Sendable {
    public var id: Int { index }
    public var index: Int
    public var timePoint: String
    public var content: String
}

/// 补给打包清单的只读行。
public struct ChecklistRowView: Equatable, Identifiable, Sendable {
    public var id: Int { index }
    public var index: Int
    public var item: String
    public var count: Int
    public var note: String
}

/// 报告页整体视图模型。
public struct StrategyViewData: Equatable, Sendable {
    public var raceName: String
    public var itemType: String
    public var itemTypeLabel: String
    public var targetTime: String
    /// 目标成绩 ÷ 项目距离；解析不了 ''（hero 不显示）。
    public var targetPace: String
    public var summary: String
    public var paceRows: [PaceRowView]
    public var fuelingRows: [FuelingRowView]
    public var checklistRows: [ChecklistRowView]
    public var courseTips: [String]
    /// 多条以 \n 连接。
    public var weatherTips: String
    public var basisNote: String
}

/// 「用时=距离×配速」：逐行换算本段用时并累计；距离缺失/配速解析不了的行保持原文本。
public func recomputePaceTimes(_ rows: [PaceRowView]) -> [PaceRowView] {
    var cumulative = 0
    return rows.enumerated().map { i, row in
        var row = row
        row.index = i
        if let km = row.distanceKm, km > 0, let pace = parsePaceSPerKm(row.pace) {
            let seg = Int((km * Double(pace)).rounded())
            cumulative += seg
            row.segmentTime = formatDuration(seg)
            row.cumulativeTime = formatDuration(cumulative)
        }
        return row
    }
}

/// 策略内容 → 报告页视图（自动换算后的分段表）。
public func toStrategyView(_ strategy: RaceStrategyContent) -> StrategyViewData {
    let paceRows: [PaceRowView] = strategy.paceSegments.enumerated().map { i, seg in
        let split = splitSegmentName(seg.segment)
        return PaceRowView(
            index: i,
            segment: seg.segment,
            distance: split.distance,
            desc: split.desc,
            distanceKm: seg.distanceKm,
            pace: seg.pace,
            segmentTime: seg.segmentTime,
            cumulativeTime: seg.cumulativeTime,
            note: seg.note
        )
    }
    let label = typeAbbr(strategy.itemType)
    return StrategyViewData(
        raceName: strategy.raceName,
        itemType: strategy.itemType,
        itemTypeLabel: label.isEmpty ? strategy.itemType : label,
        targetTime: strategy.targetFinishTime,
        targetPace: targetPaceLabel(strategy.targetFinishTime, itemType: strategy.itemType),
        summary: strategy.summary,
        paceRows: recomputePaceTimes(paceRows),
        fuelingRows: strategy.fuelingPlan.enumerated().map { i, f in
            FuelingRowView(index: i, timePoint: f.timePoint, content: f.content)
        },
        checklistRows: (strategy.fuelingChecklist ?? []).enumerated().map { i, c in
            ChecklistRowView(index: i, item: c.item, count: c.count, note: c.note)
        },
        courseTips: strategy.courseTips,
        weatherTips: strategy.weatherTips.joined(separator: "\n"),
        basisNote: strategy.basisNote
    )
}

/// 视图 → 保存体（编辑值回收；fueling 空行丢弃；其余文本字段原样带回）。
public func fromStrategyView(_ view: StrategyViewData, base: RaceStrategyContent) -> RaceStrategyContent {
    var content = base
    content.raceName = view.raceName
    content.itemType = view.itemType
    content.targetFinishTime = view.targetTime
    content.summary = view.summary
    content.paceSegments = recomputePaceTimes(view.paceRows).map { row in
        RacePaceSegment(
            segment: row.segment,
            distanceKm: row.distanceKm,
            pace: row.pace,
            segmentTime: row.segmentTime,
            cumulativeTime: row.cumulativeTime,
            note: row.note
        )
    }
    content.fuelingPlan = view.fuelingRows
        .filter { !$0.timePoint.trimmingCharacters(in: .whitespaces).isEmpty || !$0.content.trimmingCharacters(in: .whitespaces).isEmpty }
        .map {
            RaceFuelingItem(
                timePoint: $0.timePoint.trimmingCharacters(in: .whitespaces),
                content: $0.content.trimmingCharacters(in: .whitespaces)
            )
        }
    return content
}

/// 最近更新的版本（详情卡摘要与报告页默认选中；空列表 nil）。
public func latestStrategyVersion(_ versions: [RaceStrategyVersion]) -> RaceStrategyVersion? {
    versions.max { a, b in a.updatedAt < b.updatedAt }
}

/// 分享标题：'我的杭马比赛策略 · 目标 3:59:59'。
public func strategyShareTitle(_ view: StrategyViewData) -> String {
    "我的\(view.raceName)比赛策略 · 目标 \(view.targetTime)"
}

/// `2026-10-18T09:30:00Z` → `2026/10/18`；非法输入原样返回。
public func raceDayLabel(_ raceDate: String) -> String {
    guard raceDate.range(of: #"^\d{4}-\d{2}-\d{2}"#, options: .regularExpression) != nil else { return raceDate }
    return String(raceDate.prefix(10)).replacingOccurrences(of: "-", with: "/")
}

/// UTC RFC3339 → 上海时区 `YYYY/MM/DD HH:mm`（不做时区换算会差 8 小时）。
public func strategyUpdatedAtLabel(_ iso: String) -> String {
    guard let date = ISO8601DateFormatter().date(from: iso) else { return "" }
    let fmt = DateFormatter()
    fmt.locale = Locale(identifier: "en_US_POSIX")
    fmt.timeZone = Shanghai.timeZone
    fmt.dateFormat = "yyyy/MM/dd HH:mm"
    return fmt.string(from: date)
}
