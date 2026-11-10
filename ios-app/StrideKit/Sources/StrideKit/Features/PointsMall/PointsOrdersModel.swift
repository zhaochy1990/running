import Foundation
import Observation

// MARK: - 我的兑换 ViewModel（devops#938，mp pages/points-orders 直译；
// cursor 分页倒序 + 商品图映射 best-effort）
//
// 免支付裁剪（拍板 4）：「去支付」钮、?paid= 落账锚点、settle 轮询全不接；
// pending_payment 订单 chip 照显「待支付」+ 引导小程序文案（30 分钟不付自动
// 取消退分，无资金风险）；运费快照照显。

@MainActor
@Observable
public final class PointsOrdersModel {

    public private(set) var loading = true
    public private(set) var loadFailed = false
    public private(set) var orders: [OrderRow] = []
    public private(set) var loadingMore = false
    public private(set) var hasMore = false

    /// toast 出口（分页失败/复制成功）。
    public internal(set) var toastMessage: String?

    private var app: AppModel?
    private var cursor: String?
    private var imgMap: [String: String] = [:]
    private var started = false

    public init() {}

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await load()
    }

    /// onShow 等价（兑换成功弹卡「查看订单」进页后刷新最新态）。
    public func reappear() async {
        guard started else { return }
        await load()
    }

    public func load() async {
        guard let app else { return }
        loading = orders.isEmpty
        loadFailed = false
        do {
            // 商品列表只为补图：失败不挡订单列表（回落占位色块）。
            async let res = app.api.redemptions()
            async let products = app.api.pointProducts()
            let ordersRes = try await res
            let productsRes = try? await products
            if let productsRes {
                imgMap = productImageMap(productsRes.products)
            }
            cursor = ordersRes.nextCursor
            orders = ordersRes.redemptions.map { toOrderRow($0, imgMap: imgMap) }
            hasMore = ordersRes.nextCursor != nil
            loading = false
        } catch {
            loading = false
            loadFailed = orders.isEmpty
        }
    }

    public func loadMore() async {
        guard hasMore, !loadingMore, let app else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let res = try await app.api.redemptions(cursor: cursor)
            cursor = res.nextCursor
            orders += res.redemptions.map { toOrderRow($0, imgMap: imgMap) }
            hasMore = res.nextCursor != nil
        } catch {
            toastMessage = "加载失败，请稍后再试"
        }
    }

    /// 订单号复制（R- 前缀随展示带走；UIPasteboard 剪贴板）。
    public func copyOrderNo(_ row: OrderRow) {
        UIPasteboardCopier.copy("R-\(row.id)")
        toastMessage = "订单号已复制"
    }

    /// 快递单号复制（已发货订单）。
    public func copyTracking(_ row: OrderRow) {
        guard !row.trackingNo.isEmpty else { return }
        UIPasteboardCopier.copy(row.trackingNo)
        toastMessage = "快递单号已复制"
    }
}

#if canImport(UIKit)
import UIKit

/// 剪贴板薄封装（wx.setClipboardData 等价；macOS 测试宿主回落 no-op）。
@MainActor
enum UIPasteboardCopier {
    static var copy: (String) -> Void = { UIPasteboard.general.string = $0 }
}
#else
@MainActor
enum UIPasteboardCopier {
    static var copy: (String) -> Void = { _ in }
}
#endif
