import SwiftUI

/// 主题协议（devops#753 决议 2：token 层不硬编码，主题可配置）。
///
/// 1.0 唯一实现是 `LightTheme`（亮色默认）；1.x 开放用户主题选择时只需
/// 补暗色 token 实现与设置 UI，不动页面代码——页面只依赖本协议。
public protocol Theme: Sendable {
    /// 主题标识（持久化/切换用）。
    var identifier: String { get }

    // ── 颜色面（亮色 token 语义，逐项对应 Tokens.Hex）───────────────────
    var background: Color { get }
    var surface: Color { get }
    var foreground: Color { get }
    var foregroundSoft: Color { get }
    var muted: Color { get }
    var mutedTwo: Color { get }
    var border: Color { get }
    var borderSoft: Color { get }
    var accent: Color { get }
    var accentDeep: Color { get }
    var onAccent: Color { get }
    var accentTint: Color { get }
    var warning: Color { get }
    var danger: Color { get }
    var grid: Color { get }

    // ── 字体（Geist Sans / Geist Mono；锁固定字号）───────────────────────
    ///
    /// - Parameters:
    ///   - size: 字号 token（固定 pt，不做 Dynamic Type 相对刻度）。
    ///   - weight: Geist 三字重（Regular/Medium/Bold）。
    ///   - mono: 等宽（Geist Mono，数值/代码场景）。
    func font(_ size: FontScale, weight: GeistWeight, mono: Bool) -> Font

    // ── 尺度 ────────────────────────────────────────────────────────────
    func radius(_ token: RadiusScale) -> CGFloat
    func space(_ token: SpaceScale) -> CGFloat
}

/// Geist 字重（资产只有 Regular/Medium/Bold 三档，devops#753 决议 4）。
public enum GeistWeight: String, Sendable, CaseIterable {
    case regular
    case medium
    case bold

    var swiftUIWeight: Font.Weight {
        switch self {
        case .regular: .regular
        case .medium: .medium
        case .bold: .bold
        }
    }
}

public extension Theme {
    /// 便捷取字体（协议方法无默认参，落 extension 重载）。
    func font(_ size: FontScale) -> Font {
        font(size, weight: .regular, mono: false)
    }

    func font(_ size: FontScale, weight: GeistWeight) -> Font {
        font(size, weight: weight, mono: false)
    }

    func font(_ size: FontScale, mono: Bool) -> Font {
        font(size, weight: .regular, mono: mono)
    }
}
