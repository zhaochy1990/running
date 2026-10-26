import SwiftUI

/// 设计 token 数值常量（devops#753 决议 4）。
///
/// 数值体系骨架沿 Flutter `mobile/lib/core/theme/tokens.dart` 的三套刻度
/// （字号/圆角/间距）逐项平移；accent 族替换为藕粉 `#ff6363` 体系
/// （决议 3，Flutter 冻结代码里的绿 #1FAD5B 是旧 mock，弃用）。
public enum Tokens {

    /// 颜色 hex 常量。除 accent 族外与 tokens.dart 一致；
    /// accent 族出处：小程序 `styles/dark.wxss`（藕粉主题唯一事实源）。
    public enum Hex {
        // 亮色基底（tokens.dart）
        public static let background: UInt32 = 0xF7F9FB
        public static let surface: UInt32 = 0xFFFFFF
        public static let foreground: UInt32 = 0x2C3340
        public static let foregroundSoft: UInt32 = 0x4A5260
        public static let muted: UInt32 = 0x6B7280
        public static let mutedTwo: UInt32 = 0xAAB1BD
        public static let border: UInt32 = 0xDFE3EA
        public static let borderSoft: UInt32 = 0xEBEEF3
        public static let warning: UInt32 = 0xD89A3D
        public static let danger: UInt32 = 0xD74331
        public static let grid: UInt32 = 0xEFF2F6

        // accent 藕粉族（dark.wxss --color-accent 族 + 决议 3 衍生）
        /// 品牌藕粉（dark.wxss `--color-accent`）。
        public static let accent: UInt32 = 0xFF6363
        /// 亮底上作文字用的加深前阶（#753 决议 3：仅对比度需要，不发明新色系；
        /// #ff6363 在白底上对比度 2.9:1 不足正文标准，同色相加深至 4.5:1 AA）。
        public static let accentDeep: UInt32 = 0xD04545
        /// accent 上的前景（dark.wxss `--color-on-accent`）。
        public static let onAccent: UInt32 = 0xFFFFFF
        /// accent 浅底 tint（对应 tokens.dart accentFg 的角色：accent 元素的浅色衬底）。
        public static let accentTint: UInt32 = 0xFFECEC
    }

    /// rpx → pt 换算（devops#749 §2.1：375 基准，rpx/2，
    /// SwiftUI 不做屏宽比例缩放）。
    public static func rpx(_ value: Double) -> CGFloat {
        CGFloat(value / 2)
    }

    /// `0xRRGGBB` → SwiftUI Color（sRGB）。
    public static func color(_ hex: UInt32) -> Color {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        return Color(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

/// 字号刻度（tokens.dart fs10…fsDisplay64 平移）。
/// 锁固定字号（#753 决议 5：不支持 Dynamic Type），全部经
/// `Theme.font(_:_:mono:)` 落为 `.custom(_:size:)` 固定尺寸。
public enum FontScale: Double, Sendable, CaseIterable {
    case fs10 = 10
    case fs11 = 11
    case fs12 = 12
    case fs13 = 13
    case fs14 = 14
    case fs15 = 15
    case fs18 = 18
    case fs20 = 20
    case fs22 = 22
    case fsDisplay40 = 40
    case fsDisplay48 = 48
    case fsDisplay64 = 64
}

/// 圆角刻度（tokens.dart radiusNone…radiusPhone 平移）。
public enum RadiusScale: CGFloat, Sendable, CaseIterable {
    case none = 0
    case sm = 8
    case md = 12
    case lg = 14
    case xl = 24
    case pill = 100
    case phone = 44
}

/// 间距刻度（tokens.dart spaceXs…space3xl 平移）。
public enum SpaceScale: CGFloat, Sendable, CaseIterable {
    case xs = 4
    case sm = 8
    case md = 12
    case lg = 16
    case xl = 20
    case xxl = 24
    case xxxl = 32
}
