import CoreText
import Foundation
import SwiftUI

/// Geist Sans / Geist Mono 字体注册与取用。
///
/// 资产在包资源 `Resources/Fonts`（Regular/Medium/Bold 各一，devops#753
/// 决议 4），App 启动时经 CoreText 注册后即可用 PostScript 名取用：
/// `Geist-Regular` / `Geist-Medium` / `Geist-Bold` / `GeistMono-*`。
public enum GeistFonts {

    /// 进程内只注册一次。
    private static let registration: Void = {
        let names = [
            "Geist-Regular", "Geist-Medium", "Geist-Bold",
            "GeistMono-Regular", "GeistMono-Medium", "GeistMono-Bold",
        ]
        for name in names {
            guard let url = Bundle.module.url(forResource: name, withExtension: "ttf", subdirectory: "Fonts") else {
                assertionFailure("字体资产缺失：\(name).ttf")
                continue
            }
            var error: Unmanaged<CFError>?
            guard CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) else {
                // 重复注册等场景下按失败处理会误伤，注册结果由单测兜底。
                continue
            }
        }
    }()

    /// 注册包内 Geist 字体（幂等）。App 启动 / 首次取字体时调用。
    public static func registerIfNeeded() {
        _ = registration
    }

    /// 固定字号 Geist 字体（`.custom(size:)` 本身不随 Dynamic Type 缩放）。
    public static func font(size: Double, weight: GeistWeight = .regular, mono: Bool = false) -> Font {
        registerIfNeeded()
        let postScriptName = (mono ? "GeistMono" : "Geist") + "-" + weight.rawValue.capitalized
        return Font.custom(postScriptName, size: size)
    }
}
