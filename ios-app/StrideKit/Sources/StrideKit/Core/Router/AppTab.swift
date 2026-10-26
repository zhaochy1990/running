import Foundation

/// 四 tab 完全镜像小程序 tabBar（devops#751 决议 1）：教练 / 记录 / 训练 / 我，
/// 教练=首页（冷启动落点，镜像 app.json pages[0]）。选中色 `#ff6363`。
public enum AppTab: String, Hashable, Sendable, CaseIterable, Identifiable {
    case coach
    case activities
    case training
    case profile

    public var id: String { rawValue }

    /// tab 标题（沿小程序文案）。
    public var title: String {
        switch self {
        case .coach: "教练"
        case .activities: "记录"
        case .training: "训练"
        case .profile: "我"
        }
    }

    /// tab 双态图标（SF Symbols 重制，devops#753 决议 6；逐 icon 对照表归各域票）。
    public var systemImage: String {
        switch self {
        case .coach: "bubble.left.and.text.bubble.right"
        case .activities: "figure.run"
        case .training: "list.clipboard"
        case .profile: "person.crop.circle"
        }
    }

    /// tab 根路由。
    public var root: Route {
        switch self {
        case .coach: .coach
        case .activities: .activities
        case .training: .trainingHome
        case .profile: .profile
        }
    }
}
