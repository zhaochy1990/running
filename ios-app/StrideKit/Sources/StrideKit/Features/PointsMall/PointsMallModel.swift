import Foundation
import Observation

// MARK: - 积分商城 ViewModel（devops#938，mp pages/points-mall 直译；
// UI 权威 = #852 原型变体 A 横排大卡）
//
// 数据 = #884 products/redemptions/addresses + #883 check-ins/status（余额唯一
// 读点）。确认抽屉：尺码（by_sku）/ 数量步进 / 地址单选 / 运费行透传展示 /
// 余额三态。免支付口径（拍板 3/4）：不接 pay 端点、无运费闸门、无
// pending_payment 支付分支——提交响应若异常带 pending_payment（运营配出运费>0
// 的兜底面）只 toast 引导 + 静默刷新，不开成功弹卡。

@MainActor
@Observable
public final class PointsMallModel {

    /// 抽屉地址行视图模型（首行姓名+手机号、次行完整地址）。
    public struct SheetAddress: Equatable, Identifiable, Sendable {
        public let id: Int
        public let name: String
        public let phone: String
        public let addr: String
    }

    public private(set) var loading = true
    public private(set) var loadFailed = false
    public private(set) var balance = 0
    public private(set) var products: [MallProduct] = []

    // 确认抽屉
    public internal(set) var sheetVisible = false
    public private(set) var sheetProduct: MallProduct?
    public private(set) var sheetQty = 1
    public private(set) var sheetMaxQty = 99
    public private(set) var sheetSkuID = 0
    public private(set) var sheetAddresses: [SheetAddress] = []
    public private(set) var sheetSelectedID = 0
    public private(set) var sheetAfter = 0
    public private(set) var sheetLack = 0
    public private(set) var sheetInsufficient = false
    public private(set) var sheetNoAddress = false
    public internal(set) var sheetSubmitting = false
    /// 运费行「包邮」/「¥N」/未选地址「—」（拍板 3：透传展示，不做闸门）。
    public private(set) var sheetFeeText = "—"
    public private(set) var sheetFeeFree = false

    /// 兑换成功居中弹卡。
    public internal(set) var okVisible = false
    public private(set) var okName = ""
    public private(set) var okSku = ""
    public private(set) var okCost = 0
    public private(set) var okBalance = 0

    /// 兑换规则弹窗。
    public internal(set) var rulesVisible = false

    /// toast 出口。
    public internal(set) var toastMessage: String?

    private var app: AppModel?
    private var addresses: [UserAddress] = []
    /// 本次兑换尝试的幂等键：抽屉打开生成，网络失败重试复用，成功/业务拒绝后换新。
    private var idemKey = ""
    private var started = false

    public init() {}

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await load()
    }

    /// onShow 等价（进页 / 从地址管理·签到页返回）：有数据走静默刷新，
    /// 抽屉开着时以最新地址簿/余额重算（商品快照不实时进抽屉，#910 评审定版，
    /// 由提交时 409 兜底）。
    public func reappear() async {
        guard started, !products.isEmpty || loadFailed else { return }
        await load(silent: true)
    }

    public func load(silent: Bool = false) async {
        guard let app else { return }
        if !silent {
            loading = true
            loadFailed = false
        }
        do {
            async let status = app.api.checkInStatus()
            async let products = app.api.pointProducts()
            async let addressesCall = app.api.listAddresses()
            let (st, productsRes, addrRes) = try await (status, products, addressesCall)
            self.addresses = addrRes.addresses
            balance = st.balance
            self.products = productsRes.products.map(toMallProduct)
            loading = false
            loadFailed = false
            if sheetVisible {
                refreshSheet()
            }
        } catch {
            if silent { return }
            loading = false
            loadFailed = true
        }
    }

    // MARK: 抽屉

    public func openSheet(product: MallProduct) {
        sheetProduct = product
        // 每次打开抽屉换新幂等键：上一次尝试已终结（成功/拒绝/放弃）。
        idemKey = newRedemptionIdempotencyKey()
        sheetVisible = true
        sheetQty = 1
        sheetMaxQty = calcSheetMaxQty(product: product, skuID: 0)
        sheetSkuID = 0
        sheetSubmitting = false
        okVisible = false
        okSku = ""
        refreshSheet()
    }

    public func closeSheet() {
        guard !sheetSubmitting else { return }
        sheetVisible = false
        sheetProduct = nil
    }

    /// 以最新地址簿/余额重算抽屉（默认地址预选、剩余/不足三态、运费/合计）。
    func refreshSheet() {
        guard let product = sheetProduct, sheetVisible else { return }
        let sheetAddresses = addresses.map { a in
            SheetAddress(
                id: a.id,
                name: a.receiverName,
                phone: a.receiverPhone,
                addr: "\(a.province) \(a.city) \(a.district) \(a.addressDetail)"
            )
        }
        var selectedID = sheetSelectedID
        if !sheetAddresses.contains(where: { $0.id == selectedID }) {
            // 首选默认地址；选中项被删后回落默认；无地址置 0。
            selectedID = addresses.first(where: { $0.isDefault })?.id ?? 0
        }
        let total = product.price * sheetQty
        let after = balance - total
        let insufficient = after < 0
        // 运费只与选中地址的省份有关（每单固定，不随数量翻倍，同服务端口径）；
        // 未选地址显示 —，切换地址即时刷新。免支付口径：仅展示不做闸门。
        let selected = addresses.first { $0.id == selectedID }
        let feeFen = selected.map { shippingFeeFen(policy: product.policy, feeFen: product.feeFen, province: $0.province) } ?? 0
        self.sheetAddresses = sheetAddresses
        self.sheetSelectedID = selectedID
        self.sheetNoAddress = sheetAddresses.isEmpty
        self.sheetAfter = insufficient ? 0 : after
        self.sheetLack = insufficient ? -after : 0
        self.sheetInsufficient = insufficient
        self.sheetFeeFree = selected == nil || feeFen <= 0
        self.sheetFeeText = selected != nil ? (feeFen > 0 ? "¥\(formatFen(feeFen))" : "包邮") : "—"
    }

    /// 尺码点选：提交中/售罄码（stock=0）/重复点选忽略；切换联动步进上限并夹取数量。
    public func selectSku(_ id: Int) {
        guard let product = sheetProduct, product.bySku, !sheetSubmitting, id != sheetSkuID else { return }
        guard let sku = product.skus.first(where: { $0.id == id }), sku.stock > 0 else { return }
        let maxQty = calcSheetMaxQty(product: product, skuID: id)
        sheetSkuID = id
        sheetMaxQty = maxQty
        sheetQty = min(sheetQty, maxQty)
        refreshSheet()
    }

    public func stepQty(_ delta: Int) {
        let next = sheetQty + delta
        guard next >= 1, next <= sheetMaxQty else { return }
        sheetQty = next
        refreshSheet()
    }

    public func selectAddress(_ id: Int) {
        sheetSelectedID = id
        refreshSheet()
    }

    /// 「管理地址 ›」：带当前选中进单选模式（AppModel 交接 = mp eventChannel
    /// addressSelected 等价，同 custom-race-form 先例），挑完回调刷新抽屉。
    public func manageAddresses() {
        guard let app else { return }
        let selectedID = sheetSelectedID
        app.addressPick = AddressPickHandoff(selectedID: selectedID) { [weak self] id in
            guard let self else { return }
            self.sheetSelectedID = id
            self.refreshSheet()
        }
        app.router.push(.addresses(pick: true))
    }

    /// 还没有收货地址 → 直接去管理模式新增（单选模式不显示新增钮）。
    public func addAddress() {
        app?.router.push(.addresses(pick: false))
    }

    /// 兑换确认按钮可点条件（按钮置灰的口径与 mp 一致；免支付口径不做运费闸门）。
    public var sheetConfirmEnabled: Bool {
        guard let product = sheetProduct else { return false }
        guard !sheetNoAddress, !sheetInsufficient, !sheetSubmitting, sheetSelectedID > 0 else { return false }
        // by_sku 未选码拦截；码表空（后端回归兜底态）放行给服务端 sku_required 拦。
        return !(product.bySku && !product.skus.isEmpty && sheetSkuID == 0)
    }

    public func confirmRedemption() async {
        guard let app, let product = sheetProduct, !idemKey.isEmpty, sheetConfirmEnabled else { return }
        sheetSubmitting = true
        do {
            let res = try await app.api.createRedemption(
                productID: product.id,
                addressID: sheetSelectedID,
                idempotencyKey: idemKey,
                quantity: sheetQty,
                skuID: sheetSkuID
            )
            // 幂等键已消费（重放同样算）：下一次兑换必须换新 key。
            idemKey = newRedemptionIdempotencyKey()
            sheetVisible = false
            sheetSubmitting = false
            sheetProduct = nil
            if res.order.status == RedemptionStates.pendingPayment {
                // 免支付兜底面（拍板 4：无待支付分支，按异常态处理）：
                // 运营配出运费>0 时订单留待支付，30 分钟超时自动关单退分，
                // 积分零损失；引导去小程序完成支付，不开成功弹卡。
                balance = res.balance
                toastMessage = "本单需支付运费，已为你保留订单，请前往小程序完成支付"
                await load(silent: true)
                return
            }
            okVisible = true
            okName = res.order.productName
            okSku = res.order.skuLabel ?? ""
            okCost = res.order.pointsCost
            okBalance = res.balance
            balance = res.balance
            // 静默刷新商品列表：库存/已兑人数跟着走（四态即时校准）。
            await load(silent: true)
        } catch {
            sheetSubmitting = false
            toastMessage = pointsErrorCopy(error, "兑换失败，请稍后再试")
            guard let code = (error as? ApiError)?.code else {
                return // 网络错误保留幂等键，重试同一订单不会双扣
            }
            // 商品态失效（售罄/达限/下架/尺码行失效）：关抽屉回列表，静默刷新校准四态。
            if code == "limit_reached" || code == "out_of_stock" || code == "product_inactive" || code == "sku_invalid" {
                sheetVisible = false
                sheetProduct = nil
                await load(silent: true)
                return
            }
            // 余额被别端花掉 / 地址被别端删：留在抽屉，静默刷新自动翻不足态/回落默认地址。
            if code == "insufficient_points" || code == "address_not_found" {
                await load(silent: true)
            }
        }
    }

    public func closeOkCard() { okVisible = false }
    public func showRules() { rulesVisible = true }
    public func hideRules() { rulesVisible = false }
}
