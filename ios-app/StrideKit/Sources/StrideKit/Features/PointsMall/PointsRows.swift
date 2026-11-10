import Foundation

// MARK: - 积分明细行纯逻辑（utils/pointDetailRows.ts 直译，devops#938）
//
// amount 服务端已带符号；created_at 为 UTC RFC3339，用户可读时间按上海墙钟
// 展示（timezone discipline）。

/// 流水类型 → 中文文案（expire 为保留位；adjust 按方向分流）。
private let pointTypeLabels: [String: String] = [
    "earn_checkin": "签到所得",
    "redeem": "兑换扣除",
    "expire": "过期扣除",
]

/// 明细行视图模型。
public struct PointDetailRow: Equatable, Identifiable, Sendable {
    public let id: String
    /// 类型文案。
    public let label: String
    /// MM-DD HH:mm（上海墙钟）。
    public let time: String
    /// 已带符号展示串：+10 / -120。
    public let delta: String
    /// 正变动（粉）true / 负变动（次要色）false。
    public let positive: Bool
    /// redeem 副行「订单号 R-xxx」；其余为空不渲染。
    public let ref: String
    /// 调分原因副行；空不渲染。
    public let remark: String
}

/// 流水 → 明细行（未知类型兜底「积分变动」）。adjust 按方向分流「系统增加 /
/// 系统扣除」：运营调分与 #904 超时关单退分同为 adjust，正向统一归「系统增加」。
public func toPointDetailRows(_ txs: [PointTransaction]) -> [PointDetailRow] {
    txs.map { tx in
        let label: String
        if tx.type == "adjust" {
            label = tx.amount >= 0 ? "系统增加" : "系统扣除"
        } else {
            label = pointTypeLabels[tx.type] ?? "积分变动"
        }
        return PointDetailRow(
            id: tx.id,
            label: label,
            time: pointDetailTimeLabel(tx.createdAt),
            delta: "\(tx.amount >= 0 ? "+" : "")\(tx.amount)",
            positive: tx.amount >= 0,
            ref: tx.type == "redeem" && !tx.ref.isEmpty ? "订单号 R-\(tx.ref)" : "",
            remark: tx.remark ?? ""
        )
    }
}

/// UTC RFC3339 → 上海墙钟「MM-DD HH:mm」（mp utils/format fmtShanghaiMdHm 同款）。
func pointDetailTimeLabel(_ iso: String) -> String {
    guard let wall = shanghaiWallClock(iso) else { return "" }
    let parts = wall.ymd.split(separator: "-").map(String.init)
    guard parts.count == 3 else { return wall.ymd }
    return "\(parts[1])-\(parts[2]) \(wall.hm)"
}

// MARK: - 兑换订单卡行纯逻辑（points-orders.ts toOrderRow 直译）

/// 订单状态 chip 展示态（四态；未知状态回落灰不猜绿）。
public struct OrderStatusChip: Equatable, Hashable, Sendable {
    public enum Style: Hashable, Sendable {
        /// 待支付（橙）。
        case unpaid
        /// 待发货（橙黄）。
        case pending
        /// 已发货（绿）。
        case shipped
        /// 已取消（灰；未知状态回落）。
        case cancelled
    }

    public let style: Style
    public let label: String
}

/// 四态 chip（Go 状态机 + 展示层未知回落 cancelled 灰）。
public func orderStatusChip(_ status: RedemptionStatus) -> OrderStatusChip {
    switch status {
    case RedemptionStates.pendingPayment: OrderStatusChip(style: .unpaid, label: "待支付")
    case RedemptionStates.pendingShipment: OrderStatusChip(style: .pending, label: "待发货")
    case RedemptionStates.shipped: OrderStatusChip(style: .shipped, label: "已发货")
    case RedemptionStates.cancelled: OrderStatusChip(style: .cancelled, label: "已取消")
    default: OrderStatusChip(style: .cancelled, label: "已取消")
    }
}

/// 订单卡视图模型（商品图由 product_id 映射，下架/无图回落占位色块）。
public struct OrderRow: Equatable, Identifiable, Sendable {
    public let id: String
    /// MM-DD HH:mm（上海墙钟）。
    public let date: String
    /// 商品图 URL；空 = 占位色块。
    public let imageURL: String
    public let name: String
    /// 寄达地「省 市 区」。
    public let destination: String
    /// 尺码快照；空 = 不渲染。
    public let skuLabel: String
    public let cost: Int
    public let chip: OrderStatusChip
    /// 运费行：包邮（绿）/ ¥N（兑换时刻快照，分→元）。
    public let feeFree: Bool
    public let feeText: String
    public let payPending: Bool
    public let cancelled: Bool
    public let shipped: Bool
    /// 快递公司；旧单缺省 = 只渲染快递单号行。
    public let courier: String
    public let trackingNo: String
}

/// 订单本体 → 卡片行。imgMap 为商品列表建 product_id → image_url 映射。
public func toOrderRow(_ r: PointRedemption, imgMap: [String: String]) -> OrderRow {
    let feeFen = r.shippingFeeSnapshot
    return OrderRow(
        id: r.id,
        date: pointDetailTimeLabel(r.createdAt),
        imageURL: imgMap[String(r.productID)] ?? "",
        name: r.quantity > 1 ? "\(r.productName) ×\(r.quantity)" : r.productName,
        destination: "\(r.province) \(r.city) \(r.district)",
        skuLabel: r.skuLabel ?? "",
        cost: r.pointsCost,
        chip: orderStatusChip(r.status),
        feeFree: feeFen <= 0,
        feeText: feeFen > 0 ? "¥\(formatFen(feeFen))" : "包邮",
        payPending: r.status == RedemptionStates.pendingPayment,
        cancelled: r.status == RedemptionStates.cancelled,
        shipped: r.status == RedemptionStates.shipped,
        courier: r.courierCompany ?? "",
        trackingNo: r.trackingNo ?? ""
    )
}

/// 商品列表 → product_id 字符串键的图片映射（无图商品不进表，查询 miss 即占位）。
public func productImageMap(_ products: [PointProduct]) -> [String: String] {
    var map: [String: String] = [:]
    for p in products {
        if let url = p.imageURL, !url.isEmpty { map[String(p.id)] = url }
    }
    return map
}

// MARK: - 商城商品卡/确认抽屉纯逻辑（points-mall.ts toMallProduct/calcSheetMaxQty 直译）

/// 商品卡视图模型：服务端字段 + 客户端推导的四态置灰位。
public struct MallProduct: Equatable, Identifiable, Sendable {
    public let id: Int
    public let name: String
    public let description: String
    public let imageURL: String
    public let price: Int
    /// 每人限 N 件（0 = 不限不展示）。
    public let limit: Int
    public let redeemed: Int
    /// 售罄（stock=0）：蒙层 + 灰钮。
    public let soldOut: Bool
    /// 达限（redeemed≥limit>0）：灰钮。
    public let limitHit: Bool
    /// by_sku = 抽屉选尺码；旧后端无 spec_mode → single 现网行为。
    public let bySku: Bool
    /// by_sku 的尺码行（sort_order ASC）；single 恒空。
    public let skus: [PointProductSku]
    /// 运费策略 + 运费（分）：抽屉按地址实时换算（透传展示）。
    public let policy: String?
    public let feeFen: Int
}

/// 商品卡四态推导：售罄（stock=0，by_sku 后端返 SKU 合计同口径）与达限
/// （redeemed≥limit>0）是两种置灰原因；旧后端无运费字段 → nil 按免运展示。
public func toMallProduct(_ p: PointProduct) -> MallProduct {
    MallProduct(
        id: p.id,
        name: p.name,
        description: p.description ?? "",
        imageURL: p.imageURL ?? "",
        price: p.pointsPrice,
        limit: p.perUserLimit,
        redeemed: p.redeemedCount,
        soldOut: p.stock <= 0,
        limitHit: p.perUserLimit > 0 && p.redeemedCount >= p.perUserLimit,
        bySku: p.specMode == .bySku,
        skus: p.skus ?? [],
        policy: p.shippingPolicy?.rawValue,
        feeFen: p.shippingFee
    )
}

/// 抽屉数量步进上限：限购余量封顶（不限购 99）；by_sku 选中码再取码 stock
/// （售罄码不可选，结果恒 ≥1；未选码时上限只受限购约束，提交另有闸门）。
public func calcSheetMaxQty(product: MallProduct, skuID: Int) -> Int {
    let base = product.limit > 0 ? max(1, product.limit - product.redeemed) : 99
    guard product.bySku, skuID > 0 else { return base }
    guard let sku = product.skus.first(where: { $0.id == skuID }) else { return base }
    return min(base, sku.stock)
}
