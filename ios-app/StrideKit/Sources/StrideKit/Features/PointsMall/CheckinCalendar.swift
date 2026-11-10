import Foundation

// MARK: - 签到月历布局 + 本轮奖励常量（utils/checkinCalendar.ts 直译，devops#938）
//
// 布局 = #851 原型变体 A：周一起始、前后月补位灰格、已签格 +N 快照；
// 「本月已签 N 天」与周历布局都在客户端算。日期一律上海 YYYY-MM-DD 字符串
// 运算（时区纪律：复用 Shanghai）。

/// 一轮 7 天的奖励表 —— 与 Go storage.cycleRewards 逐字对齐（devops#847）。
public let checkinCycleRewards = [1, 1, 1, 1, 2, 2, 3]

/// 里程碑圆内累计分值 1/2/3/4/6/8/11（签到成就卡）。
public let checkinCycleCumulative = [1, 2, 3, 4, 6, 8, 11]

public enum MonthCellState: Hashable, Sendable {
    case checked
    case today
    case future
    case missed
    case other
}

public struct MonthCell: Hashable, Identifiable, Sendable {
    /// 补位格保持稳定唯一 id（同一补位标签可能重复出现）。
    public let id: String
    /// 当月日为 YYYY-MM-DD；前后月补位为空。
    public let date: String
    /// 展示标签 MM.DD。
    public let label: String
    public let state: MonthCellState
    /// 已签格的得分快照（+N），其余 0。
    public let pts: Int

    init(date: String, label: String, state: MonthCellState, pts: Int) {
        self.id = date.isEmpty ? "pad-\(label)" : date
        self.date = date
        self.label = label
        self.state = state
        self.pts = pts
    }
}

public struct MonthBoard: Hashable, Sendable {
    /// 整月周历按 7 列切行（含前后月补位）。
    public let rows: [[MonthCell]]
    /// 今天所在行行号（收起态默认显示这一行）。
    public let weekIndex: Int
    /// 本月已签天数（客户端计数）。
    public let checkedCount: Int
}

private func pad2(_ n: Int) -> String { String(format: "%02d", n) }

/// YYYY-MM-DD（上海日历日）→ 周几（0=周日…6=周六）；非法输入 0。
private func shanghaiDow(_ ymd: String) -> Int {
    var comps = DateComponents()
    comps.year = Int(ymd.prefix(4))
    comps.month = Int(ymd.dropFirst(5).prefix(2))
    comps.day = Int(ymd.dropFirst(8).prefix(2))
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = Shanghai.timeZone
    guard let date = cal.date(from: comps) else { return 0 }
    return cal.component(.weekday, from: date) - 1
}

/// YYYY-MM 所在月的最后一天（1-31）。
private func daysInMonth(year: Int, month: Int) -> Int {
    var comps = DateComponents()
    comps.year = month == 12 ? year : year
    comps.month = month == 12 ? 1 : month + 1
    comps.day = 0
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = Shanghai.timeZone
    guard let firstOfNext = cal.date(from: comps) else { return 30 }
    return cal.component(.day, from: firstOfNext)
}

/// 由「今天」+ 当月已签映射生成整月周历。
///
/// - Parameters:
///   - todayYmd: 服务器上海日历日（status.today.date）
///   - checkedPoints: YYYY-MM-DD → 当日得分快照（status.month.checked 展开）
public func buildMonthBoard(todayYmd: String, checkedPoints: [String: Int]) -> MonthBoard {
    guard todayYmd.count >= 10,
          let year = Int(todayYmd.prefix(4)),
          let month = Int(todayYmd.dropFirst(5).prefix(2)),
          let todayDay = Int(todayYmd.dropFirst(8).prefix(2)) else {
        return MonthBoard(rows: [], weekIndex: 0, checkedCount: 0)
    }

    var cells: [MonthCell] = []

    // 前月补位：本月 1 号离周一几天就补前月最后几天（周一 0…周日 6）。
    let lead = (shanghaiDow("\(todayYmd.prefix(7))-01") + 6) % 7
    let prevMonth = month == 1 ? 12 : month - 1
    let prevYear = month == 1 ? year - 1 : year
    let prevLast = daysInMonth(year: prevYear, month: prevMonth)
    if lead > 0 {
        for i in stride(from: lead - 1, through: 0, by: -1) {
            cells.append(MonthCell(date: "", label: "\(pad2(prevMonth)).\(pad2(prevLast - i))", state: .other, pts: 0))
        }
    }

    let last = daysInMonth(year: year, month: month)
    for d in 1...max(1, last) {
        let ymd = String(format: "%04d-%02d-%02d", year, month, d)
        let pts = checkedPoints[ymd] ?? 0
        let state: MonthCellState
        if pts > 0 {
            state = .checked
        } else if d == todayDay {
            state = .today
        } else if d > todayDay {
            state = .future
        } else {
            state = .missed
        }
        cells.append(MonthCell(date: ymd, label: "\(pad2(month)).\(pad2(d))", state: state, pts: pts))
    }

    // 后月补位到整行。
    let nextMonth = month == 12 ? 1 : month + 1
    var nextDay = 1
    while cells.count % 7 != 0 {
        cells.append(MonthCell(date: "", label: "\(pad2(nextMonth)).\(pad2(nextDay))", state: .other, pts: 0))
        nextDay += 1
    }

    var rows: [[MonthCell]] = []
    var index = cells.startIndex
    while index < cells.count {
        let end = cells.index(index, offsetBy: 7, limitedBy: cells.endIndex) ?? cells.endIndex
        rows.append(Array(cells[index..<end]))
        index = end
    }

    return MonthBoard(
        rows: rows,
        weekIndex: (lead + todayDay - 1) / 7,
        checkedCount: cells.filter { $0.pts > 0 }.count
    )
}

/// status.month.checked → YYYY-MM-DD → 得分快照映射（月历布局输入）。
public func checkedPointsMap(_ status: CheckInStatus) -> [String: Int] {
    var map: [String: Int] = [:]
    for entry in status.month.checked {
        map[entry.date] = entry.points
    }
    return map
}

/// 本轮已得积分（status.cycle 里已签格快照求和，客户端算）。
public func cycleEarnedPoints(_ cycle: [CheckInCycleCell]) -> Int {
    cycle.reduce(0) { $0 + ($1.status == .checked ? $1.points : 0) }
}
