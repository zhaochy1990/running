import Foundation
import Observation

// MARK: - 积分明细 ViewModel（devops#938，mp pages/points-detail 直译；
// 余额大数字 + 流水倒序 cursor 分页；行纯逻辑在 PointsRows.toPointDetailRows）

@MainActor
@Observable
public final class PointsDetailModel {

    public private(set) var loading = true
    public private(set) var loadFailed = false
    public private(set) var balance = 0
    public private(set) var rows: [PointDetailRow] = []
    public private(set) var loadingMore = false
    public private(set) var hasMore = false

    /// toast 出口（分页失败）。
    public internal(set) var toastMessage: String?

    private var app: AppModel?
    private var cursor: String?
    private var started = false

    public init() {}

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await load()
    }

    public func reappear() async {
        guard started else { return }
        await load()
    }

    public func load() async {
        guard let app else { return }
        loading = rows.isEmpty
        loadFailed = false
        do {
            let res = try await app.api.pointsLedger()
            cursor = res.nextCursor
            balance = res.balance
            rows = toPointDetailRows(res.transactions)
            hasMore = res.nextCursor != nil
            loading = false
        } catch {
            loading = false
            loadFailed = rows.isEmpty
        }
    }

    public func loadMore() async {
        guard hasMore, !loadingMore, let app else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let res = try await app.api.pointsLedger(cursor: cursor)
            cursor = res.nextCursor
            rows += toPointDetailRows(res.transactions)
            hasMore = res.nextCursor != nil
        } catch {
            toastMessage = "加载失败，请稍后再试"
        }
    }
}
