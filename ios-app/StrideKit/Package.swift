// swift-tools-version: 6.0
import PackageDescription

// StrideKit — iOS App 共享代码包（devops#764 PR-1 工程地基）。
//
// 结构（issue #764）：Core（主题/路由/网络/会话骨架）、Features（按域页面骨架）、
// Shared（跨域复用组件，按需增补）。
//
// 平台：iOS 17 为产品基线（@Observable 需 17，devops#748）。
// macOS 14 仅为了让 `swift test` 在宿主机直接跑（CI 与本机均无 iOS 模拟器
// 依赖；App target 本身只编 iOS）。iOS 专属 API 一律 `#if canImport(UIKit)`
// 或留在 App target。
let package = Package(
    name: "StrideKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "StrideKit", targets: ["StrideKit"]),
    ],
    targets: [
        .target(
            name: "StrideKit",
            resources: [
                // Geist Sans / Geist Mono 字体资产（自 mobile/assets/fonts 拷贝，
                // devops#753 决议 4：字体带入 Regular/Medium/Bold 三字重）。
                .copy("Resources/Fonts"),
            ]
        ),
        .testTarget(
            name: "StrideKitTests",
            dependencies: ["StrideKit"]
        ),
    ]
)
