import Foundation

// MARK: - 教练对话分享阅读端视图模型（utils/coachShareRows.ts 直译，#624 D 变体）
//
// user 纯文本右气泡 / assistant markdown 左气泡；卡片信封经 CoachCardRegistry
// 翻译成阅读端**静态摘要卡**（只展示，无 CTA）——race-strategy / master-plan
// 两类保留卡头（master-plan 摘要即卡片，正文照常渲染）；动作卡（custom-workout
// / workout-op）与形状不符的信封降级为普通 markdown 气泡。

/// 阅读端静态摘要卡（只展示，无 CTA）。
public struct CoachShareCardView: Equatable, Sendable {
    public let icon: String
    public let title: String
    public let subtitle: String
    /// true = 卡头下方继续渲染 markdown 正文（master-plan 摘要即卡片）。
    public let inlineBody: Bool
}

public struct CoachShareMessageRow: Equatable, Identifiable, Sendable {
    public enum Role: Sendable, Equatable {
        case user
        case assistant
    }

    public let id: Int
    public let role: Role
    /// user 气泡纯文本直接渲染；assistant 走 MarkdownText。
    public let content: String
    /// 静态摘要卡；nil = 无卡片信封或已降级走 markdown 气泡。
    public let card: CoachShareCardView?
    /// race-strategy 卡替代正文；master-plan 卡头 + 正文照常。
    public var rendersMarkdown: Bool {
        role == .assistant && !(card.map { !$0.inlineBody } ?? false)
    }
}

/// 快照消息 → 阅读端气泡行（id 即快照数组序号）。
public func buildCoachShareMessages(_ messages: [CoachShareMessage]) -> [CoachShareMessageRow] {
    messages.enumerated().map { index, message in
        guard message.role == .assistant else {
            return CoachShareMessageRow(id: index, role: .user, content: message.content, card: nil)
        }
        var card: CoachShareCardView?
        if let wire = message.card, let view = CoachCardRegistry.build(wire, target: nil),
           view.type == "race-strategy" || view.type == "master-plan" {
            card = CoachShareCardView(icon: view.icon, title: view.title, subtitle: view.subtitle, inlineBody: view.inlineBody)
        }
        return CoachShareMessageRow(id: index, role: .assistant, content: message.content, card: card)
    }
}

/// 顶栏 meta 的日期段（`2026-10-21` → `10月21日`；上海时区语义由调用方
/// 先用 shanghaiYmdFromISO 转好）。
public func monthDayLabel(_ ymd: String) -> String {
    let month = Int(ymd.dropFirst(5).prefix(2)) ?? 0
    let day = Int(ymd.suffix(2)) ?? 0
    return "\(month)月\(day)日"
}

/// UTC ISO → 上海 YMD（早于 08:00 的分享 UTC 日期会差一天，不能切片）。
public func shanghaiYmdFromISO(_ iso: String) -> String {
    shanghaiWallClock(iso)?.ymd ?? ""
}
