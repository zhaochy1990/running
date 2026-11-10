import Foundation

// MARK: - 积分商城域服务层（devops#938，契约 #937 §四 12 端点表；镜像 mp
// services/checkin.ts + services/points.ts 的 DTO 面）
//
// iOS 消费 11 个端点（pay 端点 wx.login code→openid 物理不可用，明确不接）；
// 全部 Bearer 走现有 APIClient（401 刷新单飞链自动复用）；幂等语义照 mp：
// 签到按日幂等（重复回 already_checked_in +0 分非错误），兑换按
// idempotency_key 重放原单（replayed=true 零副作用）。

// MARK: 签到（services/checkin.ts 镜像）

/// POST /api/users/me/check-ins 响应（Go checkInResponse）。
public struct CheckInResult: Decodable, Hashable, Sendable {
    /// 当日重复签到为 true：重复快照 +0 分，不是错误（#847 item 8）。
    public let alreadyCheckedIn: Bool
    public let streakDays: Int
    public let cyclePosition: Int
    public let pointsEarned: Int
    public let balance: Int
    /// 本次签到集齐 7 天一轮（客户端彩蛋 #851）。
    public let d7Completed: Bool

    enum CodingKeys: String, CodingKey {
        case alreadyCheckedIn = "already_checked_in"
        case streakDays = "streak_days"
        case cyclePosition = "cycle_position"
        case pointsEarned = "points_earned"
        case balance
        case d7Completed = "d7_completed"
    }
}

/// 7 格本轮进度单元格（GET status 的 cycle 数组项）。
public struct CheckInCycleCell: Decodable, Hashable, Sendable {
    public enum Status: String, Decodable, Sendable {
        case checked
        case today
        case upcoming
    }

    public let position: Int
    /// 已签格 = 得分快照，未签格 = 该位置的奖励预览。
    public let points: Int
    public let status: Status

    enum CodingKeys: String, CodingKey { case position, points, status }
}

/// GET /api/users/me/check-ins/status 整页单读（签到页 / profile 两行右侧文案同源；
/// balance 是本仓唯一积分余额读点）。
public struct CheckInStatus: Decodable, Hashable, Sendable {
    public struct Today: Decodable, Hashable, Sendable {
        /// 服务器上海日历日 YYYY-MM-DD。
        public let date: String
        public let canCheckIn: Bool
        /// 下一次签到（今天或明天）能拿的分。
        public let rewardPreview: Int
        /// 下一次签到将开启新一轮（断签 / 昨日集齐 D7）。
        public let wouldStartNewCycle: Bool

        enum CodingKeys: String, CodingKey {
            case date
            case canCheckIn = "can_check_in"
            case rewardPreview = "reward_preview"
            case wouldStartNewCycle = "would_start_new_cycle"
        }
    }

    public struct Month: Decodable, Hashable, Sendable {
        public struct Entry: Decodable, Hashable, Sendable {
            public let date: String
            public let points: Int
        }

        /// 今天所在月 YYYY-MM。
        public let label: String
        public let checked: [Entry]
    }

    public let today: Today
    public let streakDays: Int
    /// 恒 7 格。
    public let cycle: [CheckInCycleCell]
    public let balance: Int
    public let month: Month

    enum CodingKeys: String, CodingKey {
        case today, cycle, balance, month
        case streakDays = "streak_days"
    }
}

// MARK: 商品 / 订单 / 流水 / 地址（services/points.ts 镜像）

/// 商品运费策略（服务端闭枚举；未知值按免运展示，与服务端回退一致）。
public enum ShippingPolicy: String, Decodable, Hashable, Sendable {
    case nationwideFree = "nationwide_free"
    case jzshFee = "jzsh_fee"
}

/// by_sku 商品的一条规格行（devops#909）。
public struct PointProductSku: Decodable, Hashable, Sendable, Identifiable {
    public let id: Int
    /// 尺码文案（如 M / L），订单 sku_label 快照的来源。
    public let specValue: String
    public let stock: Int

    enum CodingKeys: String, CodingKey {
        case id, stock
        case specValue = "spec_value"
    }
}

/// 商品规格模式（devops#910）：by_sku = 抽屉选尺码；旧后端缺省视同 single。
public enum ProductSpecMode: String, Decodable, Hashable, Sendable {
    case single
    case bySku = "by_sku"
}

public struct PointProduct: Decodable, Hashable, Sendable, Identifiable {
    public let id: Int
    public let name: String
    public let description: String?
    /// COS 直链；V1 admin 上传管道未建时为空 → 页面渲染占位色块。
    public let imageURL: String?
    public let pointsPrice: Int
    /// by_sku 商品 = SKU 合计（仅展示）；single = 真库存。
    public let stock: Int
    /// 0 = 不限购（#849 改判）。
    public let perUserLimit: Int
    public let redeemedCount: Int
    /// 缺省视同 single（旧后端兼容）。
    public let specMode: ProductSpecMode?
    /// by_sku 才带（sort_order ASC）；缺省 = 不渲染尺码区。
    public let skus: [PointProductSku]?
    public let shippingPolicy: ShippingPolicy?
    /// 运费（分）。
    public let shippingFee: Int

    enum CodingKeys: String, CodingKey {
        case id, name, description, stock, skus
        case imageURL = "image_url"
        case pointsPrice = "points_price"
        case perUserLimit = "per_user_limit"
        case redeemedCount = "redeemed_count"
        case specMode = "spec_mode"
        case shippingPolicy = "shipping_policy"
        case shippingFee = "shipping_fee"
    }
}

public struct PointProductsResponse: Decodable, Hashable, Sendable {
    public let products: [PointProduct]
}

/// 订单状态机（Go #904）：带运费单 pending_payment →（支付回调）pending_shipment
/// → shipped 终态；免运单直接 pending_shipment；pending_payment 超时 30 分钟
/// worker 关单 → cancelled 终态积分退回。iOS 免支付口径：pending_payment 不做
/// 专门 UI（拍板 4），chip 照显 + 引导小程序文案。保持原始字符串：服务端未来
/// 新增状态不炸解码，展示层回落灰 chip（mp 同口径）。
public typealias RedemptionStatus = String

/// 订单状态常量（RedemptionStatus 字符串面）。
public enum RedemptionStates {
    public static let pendingPayment = "pending_payment"
    public static let pendingShipment = "pending_shipment"
    public static let shipped = "shipped"
    public static let cancelled = "cancelled"
}

/// 订单本体（收货六列为兑换时刻快照）。
public struct PointRedemption: Decodable, Hashable, Sendable, Identifiable {
    /// 公开订单号（UUID），展示时加 "R-" 前缀。
    public let id: String
    public let productID: Int
    public let productName: String
    public let pointsCost: Int
    /// 数量（旧客户端缺省 = 1）。
    public let quantity: Int
    public let status: RedemptionStatus
    /// 尺码快照；single/旧单缺省 = 不展示。
    public let skuLabel: String?
    public let courierCompany: String?
    public let trackingNo: String?
    public let shippedAt: String?
    /// 运费快照（分）与策略快照。
    public let shippingFeeSnapshot: Int
    public let shippingPolicySnapshot: ShippingPolicy?
    public let receiverName: String
    public let receiverPhone: String
    public let province: String
    public let city: String
    public let district: String
    public let addressDetail: String
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, status, quantity
        case productID = "product_id"
        case productName = "product_name"
        case pointsCost = "points_cost"
        case skuLabel = "sku_label"
        case courierCompany = "courier_company"
        case trackingNo = "tracking_no"
        case shippedAt = "shipped_at"
        case shippingFeeSnapshot = "shipping_fee_snapshot"
        case shippingPolicySnapshot = "shipping_policy_snapshot"
        case receiverName = "receiver_name"
        case receiverPhone = "receiver_phone"
        case province, city, district
        case addressDetail = "address_detail"
        case createdAt = "created_at"
    }
}

public struct RedemptionsResponse: Decodable, Hashable, Sendable {
    public let redemptions: [PointRedemption]
    /// null = 到底（倒序最后一页）。
    public let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case redemptions
        case nextCursor = "next_cursor"
    }
}

/// POST redemptions 响应：订单本体 + 扣分后余额 + 是否幂等重放。
public struct RedemptionCreateResult: Decodable, Hashable, Sendable {
    public let order: PointRedemption
    public let balance: Int
    public let replayed: Bool
}

/// 流水类型（earn_checkin/redeem V1 产生；expire/adjust 留位——adjust 含运营
/// 调分与超时关单退分）。保持原始字符串：服务端未来新增类型不炸解码，
/// 展示层统一兜底「积分变动」（mp 同口径）。
public typealias PointTransactionType = String

public struct PointTransaction: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let type: PointTransactionType
    /// 已带符号：earn_checkin 正 / redeem 负（服务端写入时定号）。
    public let amount: Int
    /// redeem = 订单号（UUID，渲染 R- 前缀）；其余为空。
    public let ref: String
    /// 调分原因（运营后台必填）；其余为空。
    public let remark: String?
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, type, amount, ref, remark
        case createdAt = "created_at"
    }
}

/// 明细分页信封 {balance, transactions, next_cursor}（服务端 50 条/页倒序）。
public struct PointsLedgerResponse: Decodable, Hashable, Sendable {
    public let balance: Int
    public let transactions: [PointTransaction]
    public let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case balance, transactions
        case nextCursor = "next_cursor"
    }
}

public struct UserAddress: Decodable, Hashable, Sendable, Identifiable {
    public let id: Int
    public let receiverName: String
    public let receiverPhone: String
    public let province: String
    public let city: String
    public let district: String
    public let addressDetail: String
    /// 服务端保证至多一条默认。
    public let isDefault: Bool
    public let createdAt: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, province, city, district
        case receiverName = "receiver_name"
        case receiverPhone = "receiver_phone"
        case addressDetail = "address_detail"
        case isDefault = "is_default"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct AddressesResponse: Decodable, Hashable, Sendable {
    public let addresses: [UserAddress]
}

/// 新建/更新地址的请求体（七项契约字段；更新走 Partial 语义可只传变更字段）。
public struct AddressPayload: Encodable, Hashable, Sendable {
    public var receiverName: String
    public var receiverPhone: String
    public var province: String
    public var city: String
    public var district: String
    public var addressDetail: String
    public var isDefault: Bool

    public init(receiverName: String, receiverPhone: String, province: String,
                city: String, district: String, addressDetail: String, isDefault: Bool) {
        self.receiverName = receiverName
        self.receiverPhone = receiverPhone
        self.province = province
        self.city = city
        self.district = district
        self.addressDetail = addressDetail
        self.isDefault = isDefault
    }

    enum CodingKeys: String, CodingKey {
        case province, city, district
        case receiverName = "receiver_name"
        case receiverPhone = "receiver_phone"
        case addressDetail = "address_detail"
        case isDefault = "is_default"
    }
}

// MARK: - APIClient 积分商城域端点（11 个，全 Bearer）

extension APIClient {

    /// 一步签到（按日幂等：重复回 already_checked_in=true 快照 +0 分）。
    @discardableResult
    public func createCheckIn() async throws -> CheckInResult {
        try await send(APIRequest(method: .post, path: "/api/users/me/check-ins"), as: CheckInResult.self)
    }

    /// 签到页整页状态（today/cycle/balance/month；profile 两行右侧文案同源）。
    public func checkInStatus() async throws -> CheckInStatus {
        try await send(APIRequest(path: "/api/users/me/check-ins/status"), as: CheckInStatus.self)
    }

    /// 积分余额 + 流水倒序分页（cursor 透传，next_cursor=null 到底）。
    public func pointsLedger(cursor: String? = nil) async throws -> PointsLedgerResponse {
        let path = "/api/users/me/points" + (cursor.map { "?cursor=\(Self.urlEncode($0))" } ?? "")
        return try await send(APIRequest(path: path), as: PointsLedgerResponse.self)
    }

    /// 商城商品列表（active，含本人 redeemed_count / skus / 运费策略）。
    public func pointProducts() async throws -> PointProductsResponse {
        try await send(APIRequest(path: "/api/users/me/points/products"), as: PointProductsResponse.self)
    }

    /// 兑换（服务端幂等：idempotency_key 命中重放已有订单零副作用；by_sku 缺
    /// sku_id → 409 sku_required；quantity 1-99）。
    @discardableResult
    public func createRedemption(productID: Int, addressID: Int, idempotencyKey: String,
                                 quantity: Int = 1, skuID: Int = 0) async throws -> RedemptionCreateResult {
        struct Body: Encodable {
            let productID: Int
            let addressID: Int
            let idempotencyKey: String
            let quantity: Int
            let skuID: Int

            enum CodingKeys: String, CodingKey {
                case quantity
                case productID = "product_id"
                case addressID = "address_id"
                case idempotencyKey = "idempotency_key"
                case skuID = "sku_id"
            }
        }
        let body = try JSONEncoder().encode(
            Body(productID: productID, addressID: addressID, idempotencyKey: idempotencyKey,
                 quantity: quantity, skuID: skuID)
        )
        return try await send(
            APIRequest(method: .post, path: "/api/users/me/points/redemptions", body: body),
            as: RedemptionCreateResult.self
        )
    }

    /// 我的兑换倒序分页。
    public func redemptions(cursor: String? = nil) async throws -> RedemptionsResponse {
        let path = "/api/users/me/points/redemptions" + (cursor.map { "?cursor=\(Self.urlEncode($0))" } ?? "")
        return try await send(APIRequest(path: path), as: RedemptionsResponse.self)
    }

    /// 地址簿列表（服务端保证至多一条默认）。
    public func listAddresses() async throws -> AddressesResponse {
        try await send(APIRequest(path: "/api/users/me/addresses"), as: AddressesResponse.self)
    }

    /// 新建地址（≤10 条，超限 409 address_limit_reached）。
    @discardableResult
    public func createAddress(_ payload: AddressPayload) async throws -> UserAddress {
        let body = try JSONEncoder().encode(payload)
        return try await send(APIRequest(method: .post, path: "/api/users/me/addresses", body: body), as: UserAddress.self)
    }

    /// 更新地址（Partial：可只传变更字段；全字段构造由调用方决定）。
    @discardableResult
    public func updateAddress(id: Int, _ payload: AddressPayload) async throws -> UserAddress {
        let body = try JSONEncoder().encode(payload)
        return try await send(
            APIRequest(method: .patch, path: "/api/users/me/addresses/\(id)", body: body),
            as: UserAddress.self
        )
    }

    /// 删除地址（无二次确认，原型拍板）。
    public func deleteAddress(id: Int) async throws {
        _ = try await send(APIRequest(method: .delete, path: "/api/users/me/addresses/\(id)"))
    }

    /// 设默认（服务端同事务清同用户其余默认位）。
    @discardableResult
    public func setAddressDefault(id: Int) async throws -> UserAddress {
        let body = try JSONEncoder().encode([String: String]())
        return try await send(
            APIRequest(method: .patch, path: "/api/users/me/addresses/\(id)/default", body: body),
            as: UserAddress.self
        )
    }

    /// query 透传编码（cursor 为服务端不透明 token；encodeURIComponent 等价，
    /// 仅 RFC3986 unreserved 字符不转义）。
    static func urlEncode(_ raw: String) -> String {
        raw.addingPercentEncoding(
            withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        ) ?? raw
    }
}

// MARK: - 业务错误码文案（points.go 契约码 → 中文，mp pointsErrorCopy 原样移植）

/// 兑换/地址侧业务码 → 中文文案映射（409/404/503 → ApiError.code）。
private let redeemErrorCopy: [String: String] = [
    "insufficient_points": "积分不足，去签到赚积分吧",
    "limit_reached": "已达每人限购上限",
    "out_of_stock": "手慢了，商品已售罄",
    "sku_required": "请先选择尺码",
    "sku_invalid": "商品规格有变化，请重新选择",
    "product_inactive": "商品已下架",
    "address_not_found": "收货地址不存在，请重新选择",
    "address_limit_reached": "收货地址最多 10 条",
    "payment_unavailable": "支付通道暂未开放，请稍后再试",
]

/// 业务码命中返回映射文案；未识别码 / 网络层错误回落 fallback（mp 同语义）。
public func pointsErrorCopy(_ error: Error, _ fallback: String) -> String {
    if let apiError = error as? ApiError, let code = apiError.code {
        if let copy = redeemErrorCopy[code] { return copy }
    }
    return fallback
}

/// 兑换幂等键（每次打开确认抽屉生成一个，网络失败重试复用，成功/业务拒绝后
/// 换新——断网重试不会双扣）。iOS 前缀 `ios-redeem-` 区分来源便于服务端排障。
public func newRedemptionIdempotencyKey() -> String {
    "ios-redeem-\(UUID().uuidString)"
}
