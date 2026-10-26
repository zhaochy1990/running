import Foundation

// MARK: - 反馈会话行纯逻辑（utils/feedbackRows.ts 直译，devops#554）
//
// 后端 created_at / last_reply.created_at 是 UTC RFC3339；用户可读时间一律
// 按上海墙钟展示（timezone discipline：UTC 存储，Asia/Shanghai 展示）。

/// 上海当天的 YYYY-MM-DD（由 Date 推，可注入时钟供测试）。
public func shanghaiYmdFrom(_ now: Date) -> String {
    Shanghai.todayYMD(now: now)
}

/// YYYY-MM-DD 偏移 n 天（UTC 数学，±跨月/跨年安全）。
public func ymdOffset(_ ymd: String, days: Int) -> String {
    var comps = DateComponents()
    comps.year = Int(ymd.prefix(4))
    comps.month = Int(ymd.dropFirst(5).prefix(2))
    comps.day = Int(ymd.dropFirst(8).prefix(2))
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    guard let base = cal.date(from: comps) else { return ymd }
    let shifted = cal.date(byAdding: .day, value: days, to: base) ?? base
    let unit = cal.dateComponents([.year, .month, .day], from: shifted)
    return String(format: "%04d-%02d-%02d", unit.year ?? 0, unit.month ?? 0, unit.day ?? 0)
}

/// UTC RFC3339 → 上海墙钟 { ymd, hm }（+8h 平移后读墙钟）。
/// 非法/缺失返回 nil。
public func shanghaiWallClock(_ iso: String?) -> (ymd: String, hm: String)? {
    guard let iso, !iso.isEmpty, let date = RFC3339.parse(iso) else { return nil }
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = Shanghai.timeZone
    let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    guard let y = c.year, let mo = c.month, let d = c.day, let h = c.hour, let mi = c.minute else { return nil }
    return (String(format: "%04d-%02d-%02d", y, mo, d), String(format: "%02d:%02d", h, mi))
}

/// 会话/气泡时间标签：今天 HH:MM · 昨天 HH:MM ·（跨年补年份）MM-DD HH:MM。
public func feedbackTimeLabel(_ iso: String?, now: Date) -> String {
    guard let wc = shanghaiWallClock(iso) else { return "" }
    let today = shanghaiYmdFrom(now)
    if wc.ymd == today { return wc.hm }
    if wc.ymd == ymdOffset(today, days: -1) { return "昨天 \(wc.hm)" }
    let parts = wc.ymd.split(separator: "-").map(String.init)
    guard parts.count == 3 else { return wc.ymd }
    let yearPrefix = wc.ymd.prefix(4) == today.prefix(4) ? "" : "\(wc.ymd.prefix(4))-"
    return "\(yearPrefix)\(parts[1])-\(parts[2]) \(wc.hm)"
}

/// 列表末条预览：有官方/本人回复带前缀，否则显示原文。
public func conversationPreview(content: String, lastReply: FeedbackItem.LastReply?) -> String {
    guard let lastReply else { return content }
    return "\(lastReply.author == "user" ? "我：" : "官方：")\(lastReply.content)"
}

/// 会话列表行（原型 C convRow）：emoji 头像 + 标题 + 已采纳角标 + 时间 + 预览 + 未读点。
public struct FeedbackConvRow: Equatable, Identifiable, Sendable {
    public let id: Int
    public let emoji: String
    /// 正文首行截 20 字（反馈无标题字段，原型提交流即取前 20 字）。
    public let title: String
    public let adopted: Bool
    public let time: String
    public let preview: String
    public let unread: Bool
}

public func toConvRows(_ items: [FeedbackItem], now: Date) -> [FeedbackConvRow] {
    items.map { item in
        FeedbackConvRow(
            id: item.id,
            emoji: item.type == .bug ? "🐞" : "💡",
            title: String((item.content.split(separator: "\n").first ?? "").prefix(20)),
            adopted: item.adoptedFeatureId != nil,
            time: feedbackTimeLabel(item.createdAt, now: now),
            preview: conversationPreview(content: item.content, lastReply: item.lastReply),
            unread: item.unread
        )
    }
}

// MARK: - ISO8601 解析辅助（fractional seconds / 无时区双兼容）

enum RFC3339 {
    /// 后端 RFC3339 带小数秒（Go time.RFC3339Nano 序列化）与整秒两态兼容。
    /// DateFormatter 非线程安全：每次调用局部创建（低频展示路径，可接受）。
    static func parse(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        return plain.date(from: raw)
    }
}
