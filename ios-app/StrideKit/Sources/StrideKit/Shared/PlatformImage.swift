#if canImport(UIKit)
import SwiftUI
import UIKit

/// 跨平台头像预览：Data → Image（macOS 宿主编译兜底 NSImage）。
enum PlatformImage {
    static func image(data: Data) -> Image? {
        UIImage(data: data).map { Image(uiImage: $0) }
    }
}
#elseif canImport(AppKit)
import SwiftUI
import AppKit

enum PlatformImage {
    static func image(data: Data) -> Image? {
        NSImage(data: data).map { Image(nsImage: $0) }
    }
}
#endif
