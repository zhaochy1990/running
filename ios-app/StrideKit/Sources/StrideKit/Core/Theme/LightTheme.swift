import SwiftUI

/// 亮色主题 —— Theme 协议的首个实现，1.0 默认主题（devops#753 决议 1/2）。
///
/// App 亮色 vs 小程序深色 `#07080A` 是 parity ledger 全局最大 confirmed
/// 偏差（LEDGER.md D-theme-1）；Info.plist 同步锁 `UIUserInterfaceStyle=Light`。
public struct LightTheme: Theme {
    public let identifier = "light"

    public init() {}

    // 颜色面：全部取自 Tokens.Hex 单一事实源
    public var background: Color { Tokens.color(Tokens.Hex.background) }
    public var surface: Color { Tokens.color(Tokens.Hex.surface) }
    public var foreground: Color { Tokens.color(Tokens.Hex.foreground) }
    public var foregroundSoft: Color { Tokens.color(Tokens.Hex.foregroundSoft) }
    public var muted: Color { Tokens.color(Tokens.Hex.muted) }
    public var mutedTwo: Color { Tokens.color(Tokens.Hex.mutedTwo) }
    public var border: Color { Tokens.color(Tokens.Hex.border) }
    public var borderSoft: Color { Tokens.color(Tokens.Hex.borderSoft) }
    public var accent: Color { Tokens.color(Tokens.Hex.accent) }
    public var accentDeep: Color { Tokens.color(Tokens.Hex.accentDeep) }
    public var onAccent: Color { Tokens.color(Tokens.Hex.onAccent) }
    public var accentTint: Color { Tokens.color(Tokens.Hex.accentTint) }
    public var warning: Color { Tokens.color(Tokens.Hex.warning) }
    public var danger: Color { Tokens.color(Tokens.Hex.danger) }
    public var grid: Color { Tokens.color(Tokens.Hex.grid) }

    /// 固定字号 Geist（不接 Dynamic Type，#753 决议 5）。
    public func font(_ size: FontScale, weight: GeistWeight = .regular, mono: Bool = false) -> Font {
        GeistFonts.font(size: size.rawValue, weight: weight, mono: mono)
    }

    public func radius(_ token: RadiusScale) -> CGFloat { token.rawValue }
    public func space(_ token: SpaceScale) -> CGFloat { token.rawValue }
}
