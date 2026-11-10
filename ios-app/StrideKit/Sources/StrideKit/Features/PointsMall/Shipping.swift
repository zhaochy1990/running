import Foundation

// MARK: - 运费展示换算（utils/shipping.ts 直译，devops#938）—— 镜像服务端
// storage/points.go shippingFeeFor 的客户端口径：jzsh_fee 且收货省份 ∉ 江浙沪
// 才收 shipping_fee（分），其余一律免运（nationwide_free 及任何未知策略值都
// 免运，与服务端闭枚举回退一致）。
//
// 注意（#938 拍板 3）：iOS 免支付口径不做运费前置闸门，本函数仅用于确认抽屉
// 的运费行「包邮 / ¥N」展示与订单页运费快照展示——运营当前全国包邮，正常恒 0。

/// 江浙沪包邮块：地址簿存行政区划全称（含「省/市」后缀），裸名也认
/// （服务端 jzshProvinces 同款集合）。
private let jzshProvinces: Set<String> = ["江苏省", "浙江省", "上海市", "江苏", "浙江", "上海"]

/// 按收货省份算一单应收运费（分）。policy 缺省（旧后端无字段）按免运处理
/// —— 展示层永不比服务端多收。
public func shippingFeeFen(policy: String?, feeFen: Int, province: String) -> Int {
    guard policy == ShippingPolicy.jzshFee.rawValue, !jzshProvinces.contains(province) else { return 0 }
    return feeFen
}

/// 分 → 元字符串，去尾零：0→"0"，800→"8"，850→"8.5"，808→"8.08"。
public func formatFen(_ fen: Int) -> String {
    let raw = String(format: "%.2f", Double(fen) / 100)
    var result = raw
    if result.contains(".") {
        while result.hasSuffix("0") { result.removeLast() }
        if result.hasSuffix(".") { result.removeLast() }
    }
    return result.isEmpty ? "0" : result
}
