import Foundation
import Observation

// 意见反馈双 tab ViewModel（devops#554，PR-7 收尾域 devops#770）：
// 会话列表 onShow 每次重拉（聊天页读即清后的未读态、新提交的会话都在
// 这里对齐）；路线 tab 首次进入挂载并保活（状态不丢）；深链 ?tab=roadmap
// 直达路线 tab。请求序号防过期响应。

@MainActor
@Observable
public final class FeedbackModel {

    public enum Tab: Hashable, Sendable {
        case feedback
        case roadmap
    }

    public private(set) var activeTab: Tab
    /// 路线 tab 首次进入后置 true 并保持挂载（hidden 切换，状态不丢）。
    public private(set) var roadmapMounted: Bool

    public private(set) var loading = true
    public private(set) var loadError = ""
    public private(set) var rows: [FeedbackConvRow] = []

    private var fetchSeq = 0
    private var app: AppModel?
    private var started = false

    public init(initialTab: FeedbackInitialTab?) {
        activeTab = initialTab == .roadmap ? .roadmap : .feedback
        roadmapMounted = initialTab == .roadmap
    }

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await fetchList()
    }

    public func switchTab(_ tab: Tab) {
        guard tab != activeTab else { return }
        activeTab = tab
        if tab == .roadmap { roadmapMounted = true }
    }

    public func fetchList() async {
        guard let app else { return }
        let seq = fetchSeq + 1
        fetchSeq = seq
        if rows.isEmpty { loading = true }
        do {
            let res = try await app.api.listFeedbacks()
            guard seq == fetchSeq else { return }
            rows = toConvRows(res.items, now: Date())
            loading = false
            loadError = ""
        } catch {
            guard seq == fetchSeq else { return }
            loading = false
            let message = (error as? ApiError)?.message ?? "加载失败"
            loadError = message.count > 20 ? "加载失败" : message
        }
    }
}
