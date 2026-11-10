import Foundation
import Observation

// MARK: - 地址簿 ViewModel（devops#938，mp pages/addresses 直译；
// 双模式：管理（「收货地址」）与单选（pick，「选择地址」，点卡回传商城抽屉））
//
// 操作行：设为默认（服务端清同用户其余默认位）/ 复制（即时克隆不抢默认位）/
// 编辑 / 删除（无二次确认，原型拍板）；_busy 实例锁防双击；上限 10 条由
// address_limit_reached 错误码透出。

@MainActor
@Observable
public final class AddressesModel {

    /// 地址卡视图模型（抖音式分层展示）。
    public struct AddressRow: Equatable, Identifiable, Sendable {
        public let id: Int
        public let name: String
        public let phone: String
        /// 「省 市 区」灰行。
        public let region: String
        /// 详细地址（粗体行）。
        public let detail: String
        public let province: String
        public let city: String
        public let district: String
        public let isDefault: Bool
        public let selected: Bool
    }

    public let pickMode: Bool

    public private(set) var loading = true
    public private(set) var loadFailed = false
    public private(set) var addresses: [AddressRow] = []

    /// toast 出口。
    public internal(set) var toastMessage: String?

    private var app: AppModel?
    private var pickSelected = 0
    private var busy = false
    private var started = false

    public init(pickMode: Bool) {
        self.pickMode = pickMode
    }

    public func activate(app: AppModel) async {
        self.app = app
        // 单选模式初始高亮 = 商城抽屉当前选中（AppModel 交接面）。
        pickSelected = app.addressPick?.selectedID ?? 0
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await load()
    }

    /// onShow 等价（表单保存返回刷新；silent 保旧值）。
    public func reappear() async {
        guard started, !addresses.isEmpty || loadFailed else { return }
        await load(silent: true)
    }

    public func load(silent: Bool = false) async {
        guard let app else { return }
        if !silent {
            loading = true
            loadFailed = false
        }
        do {
            let res = try await app.api.listAddresses()
            addresses = res.addresses.map { a in
                AddressRow(
                    id: a.id,
                    name: a.receiverName,
                    phone: a.receiverPhone,
                    region: "\(a.province) \(a.city) \(a.district)",
                    detail: a.addressDetail,
                    province: a.province,
                    city: a.city,
                    district: a.district,
                    isDefault: a.isDefault,
                    selected: pickMode && a.id == pickSelected
                )
            }
            loading = false
            loadFailed = false
        } catch {
            if silent { return }
            loading = false
            loadFailed = true
        }
    }

    // MARK: 单选模式：点卡回传（mp eventChannel addressSelected 等价）

    public func pick(_ id: Int) {
        guard pickMode, let app else { return }
        app.addressPick?.onPick(id)
        app.addressPick = nil
        app.router.pop()
    }

    // MARK: 管理操作（设默认/复制/删除；busy 锁防双击）

    public func setDefault(_ id: Int) async {
        guard !busy, let app else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await app.api.setAddressDefault(id: id)
            toastMessage = "已设为默认"
            await load(silent: true)
        } catch {
            toastMessage = pointsErrorCopy(error, "设置失败，请稍后再试")
        }
    }

    /// 复制：即时克隆一条新地址（is_default=false 防抢默认位）。
    public func copy(_ id: Int) async {
        guard !busy, let app else { return }
        guard let row = addresses.first(where: { $0.id == id }) else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await app.api.createAddress(
                AddressPayload(
                    receiverName: row.name,
                    receiverPhone: row.phone,
                    province: row.province,
                    city: row.city,
                    district: row.district,
                    addressDetail: row.detail,
                    isDefault: false
                )
            )
            toastMessage = "已复制"
            await load(silent: true)
        } catch {
            toastMessage = pointsErrorCopy(error, "复制失败，请稍后再试")
        }
    }

    /// 删除（无二次确认，原型拍板）。
    public func delete(_ id: Int) async {
        guard !busy, let app else { return }
        busy = true
        defer { busy = false }
        do {
            try await app.api.deleteAddress(id: id)
            toastMessage = "已删除"
            await load(silent: true)
        } catch {
            toastMessage = pointsErrorCopy(error, "删除失败，请稍后再试")
        }
    }
}
