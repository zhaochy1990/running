import Foundation

// 记录域展示格式化 + 上海时区日期工具（devops#766）。
// 纯函数直译小程序 `utils/format.ts` / `utils/date.ts`（记录域消费面），
// null / 非法输入一律兜底 `—` 或空串，绝不抛错。

// MARK: - 数值格式化

public enum Fmt {

    /// 米 → 公里字符串（保留 2 位小数）。null/非法/非正 → `—`。
    public static func km(_ meters: Double?) -> String {
        guard let meters, meters.isFinite, meters > 0 else { return "—" }
        return String(format: "%.2f", meters / 1000)
    }

    /// 秒 → `HH:MM:SS`（小时不足两位补零）。null/非法 → `—`。
    public static func hms(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite, seconds > 0 else { return "—" }
        let total = Int(seconds.rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        if h > 99 { return String(format: "%d:%02d:%02d", h, m, s) }
        return String(format: "%02d:%02d:%02d", h, m, s)
    }

    /// 自然时长：1 小时内 `M:SS`，超过则 `H:MM:SS`。null/非法 → `—`。
    public static func durationShort(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite, seconds > 0 else { return "—" }
        let total = Int(seconds.rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        if h > 0 { return String(format: "%d:%02d:%02d", h, m, s) }
        return String(format: "%d:%02d", m, s)
    }

    /// 负荷值字符串（保留 1 位小数）。null/非法 → `—`。
    public static func dose(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%.1f", value)
    }

    /// 配速 `M:SS/km`。null/非法 → `—`。
    public static func pace(_ secondsPerKm: Double?) -> String {
        let (m, sec) = paceParts(secondsPerKm)
        guard let m else { return "—" }
        return String(format: "%d:%02d/km", m, sec)
    }

    /// 配速拆成对齐用两段（分钟 + `'SS"`）；`—` 时 `("—", "")`。
    public static func paceQuoteParts(_ secondsPerKm: Double?) -> (String, String) {
        let (m, sec) = paceParts(secondsPerKm)
        guard let m else { return ("—", "") }
        return (String(m), String(format: "'%02d\"", sec))
    }

    /// 配速 `M'SS"`（如 4'30"）。null/非法 → `—`。
    public static func paceQuote(_ secondsPerKm: Double?) -> String {
        let (min, sec) = paceQuoteParts(secondsPerKm)
        return min + sec
    }

    /// ms/km（手表区间边界）→ `M:SS`；非法/非正 → nil。
    public static func paceBound(_ msPerKm: Double?) -> String? {
        guard let msPerKm, msPerKm.isFinite, msPerKm > 0 else { return nil }
        let s = Int((msPerKm / 1000).rounded())
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    /// 数值取整字符串。null/非法 → `—`。
    public static func intStr(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(Int(value.rounded()))
    }

    /// 数值定小数位字符串。null/非法 → `—`。
    public static func decimalStr(_ value: Double?, digits: Int = 1) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%.\(digits)f", value)
    }

    /// 原样数值字符串（JS `${value}` 模板等价：整数不带小数点，小数去尾零）。
    public static func autoStr(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%g", value)
    }

    /// 步幅 cm → m（保留两位）。缺失 → `—`。
    public static func stepLenM(_ cm: Double?) -> String {
        guard let cm, cm.isFinite else { return "—" }
        return String(format: "%.2f", cm / 100)
    }

    private static func paceParts(_ secondsPerKm: Double?) -> (Int?, Int) {
        guard let secondsPerKm, secondsPerKm.isFinite, secondsPerKm > 0 else { return (nil, 0) }
        let s = Int(secondsPerKm.rounded())
        return (s / 60, s % 60)
    }
}

// MARK: - 上海时区日期

/// 上海墙钟时间工具（`utils/date.ts` 等价）：后端返回的活动 `date` 已是上海
/// 本地串，这里只做字符串切片；「今天 / 星期几」计算固定 Asia/Shanghai
/// （UTC+8 无夏令时），禁止用设备本地时区假设。
public enum Shanghai {

    public static let timeZone = TimeZone(identifier: "Asia/Shanghai")!

    private static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return cal
    }

    /// 今天（上海）`YYYY-MM-DD`（测试可注入时钟）。
    public static func todayYMD(now: Date = Date()) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// 今天（上海）`YYYY-MM`（记录 tab 默认展开的月份）。
    public static func todayYM(now: Date = Date()) -> String {
        String(todayYMD(now: now).prefix(7))
    }

    /// `YYYY-MM-DD` → 中文星期（周日…周六）；非法输入返回空串。
    public static func weekdayLabel(_ ymd: String?) -> String {
        let labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
        guard let ymd, let date = ymdDate(ymd) else { return "" }
        let dow = calendar.component(.weekday, from: date) // 1=周日
        return labels[(dow - 1 + 7) % 7]
    }

    /// 列表行日期标签：`YYYY-MM-DD`（或 ISO 串前 10 位）→ `8月28日 周三`。
    public static func dateLabel(fromYMD ymd: String?) -> String {
        guard let ymd else { return "" }
        let datePart = String(ymd.prefix(10))
        guard let date = ymdDate(datePart) else { return datePart }
        let c = calendar.dateComponents([.month, .day], from: date)
        let base = "\(c.month ?? 0)月\(c.day ?? 0)日"
        let weekday = weekdayLabel(datePart)
        return weekday.isEmpty ? base : "\(base) \(weekday)"
    }

    /// 详情头部日期标签：ISO 串 → `8月28日 08:30`（无时刻只给日期）。
    public static func dateLabel(fromISO iso: String?) -> String {
        guard let iso, !iso.isEmpty else { return "" }
        let datePart = String(iso.prefix(10))
        guard let date = ymdDate(datePart) else { return "" }
        let c = calendar.dateComponents([.month, .day], from: date)
        var label = "\(c.month ?? 0)月\(c.day ?? 0)日"
        if iso.count >= 16 {
            let time = String(iso.dropFirst(11).prefix(5))
            if time.count == 5, time.range(of: #"^\d{2}:\d{2}$"#, options: .regularExpression) != nil {
                label += " \(time)"
            }
        }
        return label
    }

    /// `2026-03` → `2026年3月`；非法输入原样返回。
    public static func monthLabel(_ monthKey: String) -> String {
        guard let match = monthKey.range(of: #"^(\d{4})-(\d{2})$"#, options: .regularExpression) else {
            return monthKey
        }
        let key = String(monthKey[match])
        let year = key.prefix(4)
        let month = Int(key.suffix(2)) ?? 0
        return "\(year)年\(month)月"
    }

    private static func ymdDate(_ ymd: String) -> Date? {
        guard ymd.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        return calendar.date(from: DateComponents(year: Int(ymd.prefix(4)), month: Int(ymd.dropFirst(5).prefix(2)), day: Int(ymd.suffix(2))))
    }
}

// MARK: - 运动类型展示

public enum SportDisplay {

    /// 起终点/列表行兜底图标的 SF Symbols 对应（parity D-icon-1：图标重制）。
    public static func systemImage(forSportName name: String?) -> String {
        let n = (name ?? "").lowercased()
        if n.contains("strength") { return "dumbbell" }
        if n.contains("run") || n.contains("treadmill") || n.contains("trail") { return "figure.run" }
        return "calendar"
    }

    private static let sportCN: [String: String] = [
        "Run": "跑步",
        "Indoor Run": "室内跑",
        "Trail Run": "越野跑",
        "Track Run": "田径场跑",
        "Treadmill": "跑步机",
        "Strength Training": "力量训练",
        "Strength": "力量训练",
        "Walk": "步行",
        "Hike": "徒步",
        "Bike": "骑行",
        "Swim (Pool)": "泳池游泳",
        "Swim (Open Water)": "开放水域",
    ]

    /// 运动类型中文名（chip 文案）；未知回落原名，再缺失回落「活动」。
    public static func sportCN(_ name: String?) -> String {
        sportCN[name ?? ""] ?? name ?? "活动"
    }

    private static let trainTypeCN: [String: String] = [
        "Base": "基础",
        "Aerobic Endurance": "有氧耐力",
        "Threshold": "乳酸阈",
        "Interval": "间歇",
        "VO2 Max": "最大摄氧",
        "Anaerobic": "无氧",
        "Sprint": "冲刺",
        "Recovery": "恢复",
    ]

    public static func trainTypeCN(_ type: String?) -> String {
        guard let type, !type.isEmpty else { return "" }
        return trainTypeCN[type] ?? type
    }

    private static let feelEmojis = ["", "😄", "🙂", "😐", "😞", "😫"]

    /// 体感 emoji（1-5 档）；越界/缺失返回空串。
    public static func feelEmoji(_ feelType: Int?) -> String {
        guard let feelType, (1...5).contains(feelType) else { return "" }
        return feelEmojis[feelType]
    }
}
