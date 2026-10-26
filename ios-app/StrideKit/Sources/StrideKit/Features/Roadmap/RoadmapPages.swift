import SwiftUI
import Observation

/// 产品路线页（路径兼容薄壳，2026-10-18 拍板）：路线 UI 在 RoadmapPanelView
/// （与反馈页二级 tab 共用），本页只保留标题与容器，让
/// /pages/product-roadmap/product-roadmap 路径继续可用。
public struct ProductRoadmapView: View {

    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        ScrollView {
            RoadmapPanelView()
        }
        .background(model.theme.current.background)
        .navigationTitle("产品路线")
        .inlineNavigationTitle()
    }
}

/// 路线想法详情 ViewModel：markdown 正文只在详情页渲染；draft 404 分流。
@MainActor
@Observable
public final class RoadmapDetailModel {

    public private(set) var loading = true
    public private(set) var title = ""
    public private(set) var markdown = ""
    /// 404 =「这个想法不存在或已下线」；其余 =「加载失败，请稍后重试」。
    public private(set) var failedStatus: Int?

    private let featureId: Int
    private var app: AppModel?

    public init(featureId: Int) {
        self.featureId = featureId
    }

    public func activate(app: AppModel) async {
        self.app = app
        await load()
    }

    public func load() async {
        guard let app, featureId > 0 else {
            loading = false
            failedStatus = 404
            return
        }
        loading = true
        failedStatus = nil
        do {
            let feature = try await app.api.roadmapFeature(featureId)
            title = feature.title
            markdown = feature.description
            loading = false
        } catch let error as ApiError {
            loading = false
            failedStatus = error.statusCode
        } catch {
            loading = false
            failedStatus = -1
        }
    }
}

/// 路线想法详情页：标题 + markdown 正文（MarkdownText；mp-html 的
/// SwiftUI 方案，declaration 同款）。
public struct RoadmapDetailView: View {

    @Environment(AppModel.self) private var model
    @State private var detail: RoadmapDetailModel

    public init(featureId: Int) {
        _detail = State(initialValue: RoadmapDetailModel(featureId: featureId))
    }

    public var body: some View {
        let theme = model.theme.current
        Group {
            if detail.loading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let status = detail.failedStatus {
                VStack(spacing: theme.space(.md)) {
                    Text(status == 404 ? "这个想法不存在或已下线" : "加载失败，请稍后重试")
                        .font(theme.font(.fs14))
                        .foregroundStyle(theme.muted)
                    Button("重试") {
                        Task { await detail.load() }
                    }
                    .font(theme.font(.fs14, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: theme.space(.lg)) {
                        Text(detail.title)
                            .font(theme.font(.fs20, weight: .bold))
                            .foregroundStyle(theme.foreground)
                        MarkdownText(detail.markdown, theme: theme)
                    }
                    .padding(theme.space(.lg))
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .background(theme.background)
        .navigationTitle("路线想法")
        .inlineNavigationTitle()
        .task { await detail.activate(app: model) }
    }
}
