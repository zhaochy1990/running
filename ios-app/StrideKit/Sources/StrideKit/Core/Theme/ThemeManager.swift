import Foundation
import Observation

/// 主题管理器（devops#753 决议 2：Theme 协议 + @Observable ThemeManager，
/// 全套颜色含 accent 可切换；1.0 默认亮色，仅此一个实现）。
@MainActor
@Observable
public final class ThemeManager {

    /// 当前主题。页面一律读 `theme.current.xxx`，不直接引用 LightTheme。
    public private(set) var current: any Theme

    public init(default defaultTheme: any Theme = LightTheme()) {
        self.current = defaultTheme
    }

    /// 切换主题（1.x 主题设置入口用；1.0 无调用方）。
    public func apply(_ theme: any Theme) {
        current = theme
    }
}
