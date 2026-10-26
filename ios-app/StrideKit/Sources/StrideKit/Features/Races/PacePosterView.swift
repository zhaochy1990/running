import SwiftUI

// 配速卡海报（devops#769，规格照 #420 / #757 决议；形态按 LEDGER D-poster-1
// 定稿：声明式海报 View + ImageRenderer，600 × 动态高，深色底 + 黄绿顶线 +
// 目标 + 分段表——品牌分享资产自带深色视觉，D-theme-1 例外）。
// 预览 sheet + 显式「保存 / 分享」按钮（iOS 无长按保存惯例）。

/// 海报画布尺寸：600 × (360 + 行数 × 56)。
public enum PacePosterLayout {
    public static let width: Double = 600
    public static let rowHeight: Double = 56
    public static let baseHeight: Double = 360

    public static func height(rowCount: Int) -> Double {
        baseHeight + Double(rowCount) * rowHeight
    }
}

/// 海报色板（照 #420 canvas 配方，固定深色，不复用亮色主题 token）。
public enum PacePosterPalette {
    public static let background = Color(hex: 0x0A0A0B)
    public static let lime = Color(hex: 0xD8FF3E)
    public static let muted = Color(hex: 0x8A8A8C)
    public static let fg = Color(hex: 0xF2F2F3)
    public static let soft = Color(hex: 0xB9B9BC)
}

/// 海报本体（声明式布局，导出走 ImageRenderer scale 2）。
public struct PacePosterView: View {

    let data: StrategyViewData
    let raceDayText: String

    public init(data: StrategyViewData, raceDayText: String) {
        self.data = data
        self.raceDayText = raceDayText
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            PacePosterPalette.background
            VStack(alignment: .leading, spacing: 0) {
                // 元信息 / 赛名 / 目标（纵向 260pt 区）
                Text("\(raceDayText) · \(data.itemTypeLabel)")
                    .font(.system(size: 20))
                    .foregroundStyle(PacePosterPalette.muted)
                Text(data.raceName)
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(PacePosterPalette.fg)
                    .padding(.top, 18)
                Text("目标成绩")
                    .font(.system(size: 20))
                    .foregroundStyle(PacePosterPalette.muted)
                    .padding(.top, 26)
                Text(data.targetTime)
                    .font(.system(size: 56, weight: .bold))
                    .foregroundStyle(PacePosterPalette.lime)
                    .padding(.top, 8)

                // 表头 + 分隔线
                HStack(spacing: 0) {
                    header("分段", width: 214)
                    header("配速", width: 160)
                    header("累计")
                }
                .padding(.top, 30)
                Rectangle()
                    .fill(Color.white.opacity(0.2))
                    .frame(height: 1)
                    .padding(.top, 12)

                // 分段行（每行 56pt）
                ForEach(data.paceRows) { row in
                    HStack(spacing: 0) {
                        Text(row.segment)
                            .font(.system(size: 22))
                            .foregroundStyle(PacePosterPalette.fg)
                            .lineLimit(1)
                            .frame(width: 214, alignment: .leading)
                        Text(row.pace)
                            .font(.system(size: 22))
                            .foregroundStyle(PacePosterPalette.fg)
                            .lineLimit(1)
                            .frame(width: 160, alignment: .leading)
                        Text(row.cumulativeTime)
                            .font(.system(size: 22))
                            .foregroundStyle(PacePosterPalette.soft)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: PacePosterLayout.rowHeight)
                }

                Spacer(minLength: 0)
                Text("STRIDE · 比赛策略")
                    .font(.system(size: 18))
                    .foregroundStyle(PacePosterPalette.muted)
                    .padding(.bottom, 28)
            }
            .padding(.horizontal, 36)
            .padding(.top, 44)
        }
        .frame(
            width: PacePosterLayout.width,
            height: PacePosterLayout.height(rowCount: data.paceRows.count),
            alignment: .topLeading
        )
    }

    private func header(_ text: String, width: CGFloat? = nil) -> some View {
        Text(text)
            .font(.system(size: 20))
            .foregroundStyle(PacePosterPalette.muted)
            .frame(width: width, alignment: .leading)
    }
}

extension Color {
    /// `0xRRGGBB` → Color（海报固定色板，不复用亮色主题 token）。
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// 海报预览 sheet：缩放预览 + 显式保存/分享按钮。
struct PacePosterSheet: View {

    @Environment(AppModel.self) private var app
    let data: StrategyViewData
    let raceDayText: String
    /// 导出图缓存：ImageRenderer 不便宜，ShareLink item/preview 与保存共用一份。
    @State private var exported: Image?

    var body: some View {
        let t = app.theme.current
        VStack(spacing: t.space(.lg)) {
            Capsule().fill(t.border).frame(width: 36, height: 4).padding(.top, t.space(.sm))
            Text("配速卡")
                .font(t.font(.fs15, weight: .bold))
                .foregroundStyle(t.foreground)
            posterPreview
            if let exported {
                posterActions(exported)
                    .padding(.bottom, t.space(.lg))
            }
        }
        .frame(maxWidth: .infinity)
        .background(t.background)
        .onAppear { if exported == nil { exported = renderPosterImage() } }
    }

    /// 显式保存（iOS）/分享按钮行（D-poster-1）。
    @ViewBuilder
    private func posterActions(_ exported: Image) -> some View {
        let t = app.theme.current
        HStack(spacing: t.space(.md)) {
            #if canImport(UIKit)
            Button {
                savePosterToPhotos()
            } label: {
                posterButtonLabel("保存", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.plain)
            #endif
            ShareLink(
                item: exported,
                preview: SharePreview(strategyShareTitle(data), image: exported)
            ) {
                posterButtonLabel("分享", systemImage: "square.and.arrow.up")
            }
        }
    }

    private var posterPreview: some View {
        GeometryReader { proxy in
            let t = app.theme.current
            let scale = min(
                max((proxy.size.width - t.space(.xl)) / PacePosterLayout.width, 0),
                max((proxy.size.height - t.space(.xl)) / PacePosterLayout.height(rowCount: data.paceRows.count), 0)
            )
            PacePosterView(data: data, raceDayText: raceDayText)
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
                .clipShape(RoundedRectangle(cornerRadius: t.radius(.md)))
                .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        }
        .frame(maxHeight: .infinity)
    }

    private func posterButtonLabel(_ title: String, systemImage: String) -> some View {
        let t = app.theme.current
        return HStack(spacing: 6) {
            Image(systemName: systemImage).font(.system(size: 14, weight: .medium))
            Text(title).font(t.font(.fs14, weight: .bold))
        }
        .foregroundStyle(t.onAccent)
        .padding(.horizontal, t.space(.xxl))
        .padding(.vertical, t.space(.sm))
        .background(Capsule().fill(t.accent))
    }

    // MARK: - 导出（ImageRenderer scale 2，打开 sheet 时渲染一次）

    private func renderPosterImage() -> Image {
        let renderer = ImageRenderer(content: PacePosterView(data: data, raceDayText: raceDayText))
        renderer.scale = 2
        #if canImport(UIKit)
        if let ui = renderer.uiImage { return Image(uiImage: ui) }
        #elseif canImport(AppKit)
        if let ns = renderer.nsImage { return Image(nsImage: ns) }
        #endif
        return Image(systemName: "xmark.circle")
    }

    private func savePosterToPhotos() {
        #if canImport(UIKit)
        guard let ui = renderUIImage() else { return }
        UIImageWriteToSavedPhotosAlbum(ui, nil, nil, nil)
        #endif
    }

    #if canImport(UIKit)
    private func renderUIImage() -> UIImage? {
        let renderer = ImageRenderer(content: PacePosterView(data: data, raceDayText: raceDayText))
        renderer.scale = 2
        return renderer.uiImage
    }
    #endif
}
