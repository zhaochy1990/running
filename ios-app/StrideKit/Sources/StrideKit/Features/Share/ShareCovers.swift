import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// PR-8 分享出向的两个 5:4 封面（devops#771；小程序 canvas 封面的声明式直译，
// mapping §5「首选声明式海报 View」）：教练多选气泡封面、自建课深色封面。
// 配速卡海报（第三个 canvas 产物）已在 PR-6 落地（PacePosterView），本票只接
// 分享面板。色板为分享资产自带深色视觉（同配速卡海报，D-theme-1 例外）。

// MARK: - 色板（照小程序 canvas 配方固定深色，不复用亮色主题 token）

enum ShareCoverPalette {
    static let accent = Color(hex: 0xFF6363)
    static let bubbleBackground = Color(hex: 0x101111)
    static let assistantBubble = Color(hex: 0x2A2B2E)
    static let assistantText = Color(hex: 0xE3E2E5)
    static let workoutBackground = Color(hex: 0x0A0A0B)
    static let muted = Color(hex: 0x8A8A8C)
    static let fg = Color(hex: 0xF2F2F3)
    static let metricValue = Color(hex: 0xFF9D9A)
    static let metricBlock = Color(red: 1, green: 99 / 255, blue: 99 / 255, opacity: 0.12)
}

// MARK: - 纯函数（coach.ts plainExcerpt / coverLines 直译，可单测）

/// 封面节选：剥 markdown 装饰字符、折叠空白、去首尾、60 字截断。
public func coverExcerpt(_ text: String) -> String {
    let stripped = text.replacingOccurrences(
        of: "[#*`>|_~]",
        with: "",
        options: .regularExpression
    )
    let collapsed = stripped.replacingOccurrences(
        of: #"\s+"#,
        with: " ",
        options: .regularExpression
    )
    return String(collapsed.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
}

/// 气泡折行：每行 16 字，最多两行，超长省略号收尾（coach.ts coverLines）。
public func coverLines(_ text: String) -> [String] {
    let chars = Array(text)
    let perLine = 16
    guard !chars.isEmpty else { return [] }
    if chars.count <= perLine * 2 {
        let first = String(chars[0..<min(perLine, chars.count)])
        let second = chars.count > perLine ? String(chars[perLine...]) : ""
        return [first, second].filter { !$0.isEmpty }
    }
    let head = String(chars[0..<perLine])
    let tail = String(chars[perLine..<(perLine * 2 - 1)]) + "…"
    return [head, tail]
}

// MARK: - 教练多选气泡封面（coach.ts drawShareCover 直译）

/// 5:4 暗底纯气泡封面：前两条所选对话节选（藕粉顶线、无品牌字样），
/// user 气泡藕粉右对齐、assistant 灰底左对齐。
public struct CoachBubbleCoverView: View {

    public static let width: Double = 500
    public static let height: Double = 400

    public struct Pick: Equatable, Sendable {
        public let isUser: Bool
        public let lines: [String]

        public init(isUser: Bool, lines: [String]) {
            self.isUser = isUser
            self.lines = lines
        }
    }

    /// 前两条所选（canvas 同款 slice(0,2)）。
    public let picks: [Pick]

    public init(picks: [Pick]) {
        self.picks = Array(picks.prefix(2))
    }

    /// 消息流 → 前两条所选的节选折行投影（模型层持有、视图层出图）。
    /// View 协议整体 @MainActor：模型/测试从任意隔离域调用，显式 nonisolated。
    nonisolated public static func picks(messages: [CoachMessage]) -> [Pick] {
        messages
            .filter(\.selected)
            .prefix(2)
            .map { Pick(isUser: $0.role == .user, lines: coverLines(coverExcerpt($0.content))) }
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            ShareCoverPalette.bubbleBackground
            VStack(spacing: 18) {
                ForEach(Array(picks.enumerated()), id: \.offset) { _, pick in
                    bubble(pick)
                        .frame(maxWidth: Self.width - 72, alignment: pick.isUser ? .trailing : .leading)
                }
            }
            .padding(.horizontal, 36)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .overlay(alignment: .top) {
            ShareCoverPalette.accent.frame(height: 6)
        }
        .frame(width: Self.width, height: Self.height)
    }

    private func bubble(_ pick: Pick) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(pick.lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(.system(size: 22))
                    .foregroundStyle(pick.isUser ? ShareCoverPalette.bubbleBackground : ShareCoverPalette.assistantText)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 13)
        .background(
            pick.isUser ? AnyShapeStyle(ShareCoverPalette.accent) : AnyShapeStyle(ShareCoverPalette.assistantBubble),
            in: RoundedRectangle(cornerRadius: 14)
        )
    }
}

// MARK: - 自建课深色封面（workout-detail.ts drawShareCover 直译）

/// 5:4 深色封面：藕粉顶线 + 品牌 label + 课名（最多两行）+ 双指标色块。
/// 接线点在训练域课表页（PR-5 #768），本票落组件与出图。
public struct WorkoutDarkCoverView: View {

    public static let width: Double = 500
    public static let height: Double = 400

    public struct Metric: Equatable, Sendable {
        public let value: String
        public let label: String

        public init(value: String, label: String) {
            self.value = value
            self.label = label
        }
    }

    public let name: String
    /// 取前两项（跑课=距离/总时长、力量课=预计时长/动作，与页内 stat 同源）。
    public let metrics: [Metric]

    public init(name: String, metrics: [Metric]) {
        self.name = name
        self.metrics = Array(metrics.prefix(2))
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            ShareCoverPalette.workoutBackground
            VStack(alignment: .leading, spacing: 0) {
                Text(ShareCopy.workoutCoverBrand)
                    .font(.system(size: 20))
                    .foregroundStyle(ShareCoverPalette.muted)
                Text(name)
                    .font(.system(size: 40, weight: .bold))
                    .foregroundStyle(ShareCoverPalette.fg)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .padding(.top, 26)
                Spacer(minLength: 0)
                HStack(spacing: 24) {
                    ForEach(Array(metrics.enumerated()), id: \.offset) { _, metric in
                        metricBlock(metric)
                    }
                }
                .frame(height: 104)
            }
            .padding(.horizontal, 36)
            .padding(.top, 36)
            .padding(.bottom, 36)
        }
        .overlay(alignment: .top) {
            ShareCoverPalette.accent.frame(height: 6)
        }
        .frame(width: Self.width, height: Self.height)
    }

    private func metricBlock(_ metric: Metric) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(metric.value)
                .font(.system(size: 40, weight: .bold))
                .foregroundStyle(ShareCoverPalette.metricValue)
            Text(metric.label)
                .font(.system(size: 20))
                .foregroundStyle(ShareCoverPalette.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(24)
        .background(ShareCoverPalette.metricBlock)
    }
}

// MARK: - 出图（等价 canvas dpr=2 + canvasToTempFilePath，ImageRenderer scale 2）

/// 平台图包装（系统分享面板 items 直接吃平台图；跨 UIKit/AppKit 编译）。
public struct ShareCoverImage: @unchecked Sendable {
    #if canImport(UIKit)
    public let image: UIImage
    public init(_ image: UIImage) { self.image = image }
    #elseif canImport(AppKit)
    public let image: NSImage
    public init(_ image: NSImage) { self.image = image }
    #endif
}

/// 仅视图层调用（macOS 无 GUI 测试宿主上 ImageRenderer 会 trap，模型/测试
/// 一律不碰）。
@MainActor
public enum ShareCoverRenderer {

    /// 渲染失败（视图无法栅格化）返回 nil，调用方按无封面分享（fail-soft）。
    public static func render(_ view: some View) -> ShareCoverImage? {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        #if canImport(UIKit)
        return renderer.uiImage.map(ShareCoverImage.init)
        #elseif canImport(AppKit)
        return renderer.nsImage.map(ShareCoverImage.init)
        #endif
    }
}

/// 出向矩阵「图+文案+链接」整组的系统分享面板 items（PR-8 全站唯一组装点：
/// 封面在前、文案居中、链接收尾；封面/链接缺省自动少一项 fail-soft）。
public enum ShareItemsBuilder {

    public static func items(cover: ShareCoverImage?, title: String, url: URL?) -> [Any] {
        var items: [Any] = []
        if let cover { items.append(cover.image) }
        items.append(title)
        if let url { items.append(url) }
        return items
    }
}
