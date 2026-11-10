import Foundation
import Testing
@testable import StrideKit

/// 积分商城域纯逻辑单测（devops#938）：月历布局 / 运费换算 / 明细行 / 订单行 /
/// 商品四态与抽屉上限 / 幂等键 / 错误码文案 / 表单校验 / 级联选择器数据 /
/// 路由白名单解析（镜像 mp utils/*.check.mts 的 node 自检面）。
@Suite struct PointsDomainTests {

    // MARK: - 签到月历（utils/checkinCalendar.check.mts 镜像）

    @Test func cycleConstantsMatchGoCycleRewards() {
        // 与 Go storage.cycleRewards 逐字对齐（devops#847）；累计表为前缀和。
        #expect(checkinCycleRewards == [1, 1, 1, 1, 2, 2, 3])
        #expect(checkinCycleCumulative == [1, 2, 3, 4, 6, 8, 11])
        var sum = 0
        let running = checkinCycleRewards.map { sum += $0; return sum }
        #expect(running == checkinCycleCumulative)
    }

    @Test func monthBoardMondayStartWithPadding() {
        // 2026-11-01 是周日：周一起始 → 前月（10 月）补 6 格，第一行末格是 1 号。
        let board = buildMonthBoard(todayYmd: "2026-11-10", checkedPoints: ["2026-11-01": 1, "2026-11-09": 2])
        #expect(board.rows.count == 6)
        #expect(board.rows.allSatisfy { $0.count == 7 })
        #expect(board.rows[0].dropLast(1).allSatisfy { $0.state == .other && $0.date.isEmpty })
        // 11-01 是第 1 行第 7 格（周一…周日），已签。
        #expect(board.rows[0][6].date == "2026-11-01")
        #expect(board.rows[0][6].state == .checked)
        #expect(board.rows[0][6].pts == 1)
        // 今天 11-10（周二）在第 3 行（9 号周一开行），未签 = today 态。
        #expect(board.rows[2].contains { $0.date == "2026-11-10" && $0.state == .today })
        // 今天之前未签的日子 = missed；之后 = future。
        let miss = board.rows.flatMap(\.self).first { $0.date == "2026-11-02" }
        #expect(miss?.state == .missed)
        let future = board.rows.flatMap(\.self).first { $0.date == "2026-11-11" }
        #expect(future?.state == .future)
        // 已签天数客户端计数（只算当月，补位不算）。
        #expect(board.checkedCount == 2)
        // weekIndex = (lead + todayDay - 1) / 7 = (6 + 10 - 1)/7 = 2。
        #expect(board.weekIndex == 2)
    }

    @Test func monthBoardFirstOfMonthMondayNoPadding() {
        // 2026-06-01 恰是周一：无前月补位，第一行第一格即 1 号。
        let board = buildMonthBoard(todayYmd: "2026-06-15", checkedPoints: [:])
        #expect(board.rows[0][0].date == "2026-06-01")
        #expect(board.rows[0][0].state == .missed)
        #expect(board.weekIndex == 2)
    }

    @Test func monthBoardTrailingPaddingCompletesRows() {
        let board = buildMonthBoard(todayYmd: "2026-02-28", checkedPoints: [:])
        #expect(board.rows.flatMap(\.self).count % 7 == 0)
        // 2026-02 共 28 天且 2/1 周日 → lead=6，总格数 34 → 尾部再补 1 格成 35
        // （补位合计 7 = 前 6 + 后 1）。
        #expect(board.rows.flatMap(\.self).filter { $0.date.isEmpty }.count == 7)
    }

    @Test func cycleEarnedSumsOnlyCheckedCells() {
        let cells: [CheckInCycleCell] = [
            .init(position: 1, points: 1, status: .checked),
            .init(position: 2, points: 1, status: .checked),
            .init(position: 3, points: 1, status: .today),
            .init(position: 4, points: 1, status: .upcoming),
            .init(position: 5, points: 2, status: .upcoming),
            .init(position: 6, points: 2, status: .upcoming),
            .init(position: 7, points: 3, status: .upcoming),
        ]
        #expect(cycleEarnedPoints(cells) == 2)
    }

    // MARK: - 运费换算（utils/shipping.check.mts 镜像）

    @Test func shippingFeeJzshBlocklist() {
        let fee = 800
        // 江浙沪（全称/裸名）免运。
        for province in ["江苏省", "浙江省", "上海市", "江苏", "浙江", "上海"] {
            #expect(shippingFeeFen(policy: "jzsh_fee", feeFen: fee, province: province) == 0)
        }
        // 江浙沪外收 shipping_fee。
        #expect(shippingFeeFen(policy: "jzsh_fee", feeFen: fee, province: "广东省") == 800)
        #expect(shippingFeeFen(policy: "jzsh_fee", feeFen: fee, province: "北京市") == 800)
        // nationwide_free 及未知策略值恒免运（与服务端闭枚举回退一致）。
        #expect(shippingFeeFen(policy: "nationwide_free", feeFen: fee, province: "广东省") == 0)
        #expect(shippingFeeFen(policy: nil, feeFen: fee, province: "广东省") == 0)
        #expect(shippingFeeFen(policy: "unknown_policy", feeFen: fee, province: "广东省") == 0)
    }

    @Test func formatFenStripsTrailingZeros() {
        #expect(formatFen(0) == "0")
        #expect(formatFen(800) == "8")
        #expect(formatFen(850) == "8.5")
        #expect(formatFen(808) == "8.08")
    }

    // MARK: - 明细行（utils/pointDetailRows.check.mts 镜像）

    @Test func pointDetailRowLabelsAndRefs() {
        func tx(_ type: String, _ amount: Int, ref: String = "", remark: String? = nil) -> PointTransaction {
            PointTransaction(id: type + String(amount), type: type, amount: amount, ref: ref, remark: remark, createdAt: "2026-11-09T02:03:04Z")
        }
        let rows = toPointDetailRows([
            tx("earn_checkin", 2),
            tx("redeem", -120, ref: "uuid-1"),
            tx("adjust", 5, remark: "活动补发"),
            tx("adjust", -3),
            tx("expire", -1),
            tx("future_type", 9),
        ])
        #expect(rows[0].label == "签到所得")
        #expect(rows[0].delta == "+2")
        #expect(rows[0].positive)
        #expect(rows[1].label == "兑换扣除")
        #expect(rows[1].ref == "订单号 R-uuid-1")
        #expect(rows[2].label == "系统增加")
        #expect(rows[2].remark == "活动补发")
        #expect(rows[3].label == "系统扣除")
        #expect(rows[4].label == "过期扣除")
        #expect(rows[5].label == "积分变动")
        // 上海墙钟：UTC 02:03 → 上海 10:03。
        #expect(rows[0].time == "11-09 10:03")
    }

    // MARK: - 订单行（points-orders toOrderRow 直译面）

    @Test func orderRowMapsStatusChipsAndFee() {
        func order(_ status: String, fee: Int = 0, quantity: Int = 1, courier: String? = nil) -> PointRedemption {
            PointRedemption(
                id: "o1", productID: 3, productName: "羊毛袜", pointsCost: 100,
                quantity: quantity, status: status, skuLabel: nil,
                courierCompany: courier, trackingNo: "SF123", shippedAt: nil,
                shippingFeeSnapshot: fee, shippingPolicySnapshot: nil,
                receiverName: "张三", receiverPhone: "13800000000",
                province: "江苏省", city: "南京市", district: "玄武区",
                addressDetail: "中山东路 1 号", createdAt: "2026-11-09T02:03:04Z"
            )
        }
        let unpaid = toOrderRow(order("pending_payment"), imgMap: [:])
        #expect(unpaid.chip.label == "待支付")
        #expect(unpaid.payPending)
        #expect(unpaid.feeFree && unpaid.feeText == "包邮")

        let shipped = toOrderRow(order("shipped", fee: 800, quantity: 2, courier: "顺丰速运"), imgMap: ["3": "https://cos/img.png"])
        #expect(shipped.chip.label == "已发货")
        #expect(!shipped.feeFree && shipped.feeText == "¥8")
        #expect(shipped.name == "羊毛袜 ×2")
        #expect(shipped.destination == "江苏省 南京市 玄武区")
        #expect(shipped.imageURL == "https://cos/img.png")
        #expect(shipped.courier == "顺丰速运")

        let cancelled = toOrderRow(order("cancelled"), imgMap: [:])
        #expect(cancelled.cancelled)

        // 未知状态回落灰（已取消），不猜绿。
        let unknown = toOrderRow(order("mystery"), imgMap: [:])
        #expect(unknown.chip.label == "已取消")
        #expect(unknown.chip.style == .cancelled)
    }

    // MARK: - 商品四态与抽屉上限（points-mall toMallProduct/calcSheetMaxQty）

    @Test func mallProductStates() {
        func product(stock: Int, limit: Int, redeemed: Int, specMode: String? = "single",
                     skus: [PointProductSku]? = nil, policy: String? = "nationwide_free", fee: Int = 0) -> PointProduct {
            PointProduct(
                id: 1, name: "T 恤", description: nil, imageURL: nil, pointsPrice: 50,
                stock: stock, perUserLimit: limit, redeemedCount: redeemed,
                specMode: specMode.flatMap(ProductSpecMode.init(rawValue:)), skus: skus,
                shippingPolicy: policy.flatMap(ShippingPolicy.init(rawValue:)), shippingFee: fee
            )
        }
        var m = toMallProduct(product(stock: 10, limit: 0, redeemed: 0))
        #expect(!m.soldOut && !m.limitHit && !m.bySku)
        m = toMallProduct(product(stock: 0, limit: 0, redeemed: 0))
        #expect(m.soldOut)
        m = toMallProduct(product(stock: 10, limit: 3, redeemed: 3))
        #expect(m.limitHit && !m.soldOut)
        // by_sku：skus 透传、限购余量封顶步进。
        m = toMallProduct(product(stock: 5, limit: 3, redeemed: 1, specMode: "by_sku",
                                  skus: [.init(id: 9, specValue: "M", stock: 2)]))
        #expect(m.bySku && m.skus.count == 1)
        #expect(calcSheetMaxQty(product: m, skuID: 0) == 2) // limit 3 - redeemed 1
        #expect(calcSheetMaxQty(product: m, skuID: 9) == 2) // min(2, 码 stock 2)
        // 不限购 99。
        m = toMallProduct(product(stock: 10, limit: 0, redeemed: 0))
        #expect(calcSheetMaxQty(product: m, skuID: 0) == 99)
        // 运费字段透传。
        m = toMallProduct(product(stock: 1, limit: 0, redeemed: 0, policy: "jzsh_fee", fee: 500))
        #expect(m.policy == "jzsh_fee" && m.feeFen == 500)
    }

    // MARK: - 幂等键 / 错误码文案

    @Test func idempotencyKeyStyle() {
        let key = newRedemptionIdempotencyKey()
        #expect(key.hasPrefix("ios-redeem-"))
        #expect(key != newRedemptionIdempotencyKey())
    }

    @Test func pointsErrorCopyMapsNineCodes() {
        let codes = [
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
        for (code, copy) in codes {
            let error = ApiError(statusCode: 409, code: code, detail: "raw")
            #expect(pointsErrorCopy(error, "fallback") == copy)
        }
        // 未识别码 / 无码网络错误回落 fallback。
        #expect(pointsErrorCopy(ApiError(statusCode: 500, code: "boom", detail: ""), "fallback") == "fallback")
        #expect(pointsErrorCopy(ApiError(statusCode: 0, code: nil, detail: ""), "fallback") == "fallback")
    }

    // MARK: - 地址表单校验（address-form 前端校验直译）

    @Test func addressFormValidation() {
        var form = AddressFormModel.Form()
        #expect(AddressFormModel.validate(form) == "请填写完整的收货信息")
        form.name = "张三"
        #expect(AddressFormModel.validate(form) == "请填写完整的收货信息")
        form.phone = "13800000000"
        form.province = "江苏省"
        form.city = "南京市"
        form.district = "玄武区"
        form.detail = "中山东路 1 号"
        #expect(AddressFormModel.validate(form) == nil)
        form.phone = "23800000000"
        #expect(AddressFormModel.validate(form) == "请输入正确的手机号")
        form.phone = "1380000000"
        #expect(AddressFormModel.validate(form) == "请输入正确的手机号")
        form.phone = "1380000000a"
        #expect(AddressFormModel.validate(form) == "请输入正确的手机号")
    }

    // MARK: - 省市区级联选择器数据（拍板 2）

    @Test func regionTreeCoversAllProvinces() {
        let provinces = RegionPickerData.provinces
        #expect(!provinces.isEmpty)
        #expect(provinces.count >= 31)
        #expect(provinces.contains("江苏省"))
        #expect(provinces.contains("浙江省"))
        #expect(provinces.contains("上海市"))
        // 排序稳定（字典序）。
        #expect(provinces == provinces.sorted())
    }

    @Test func regionCascadeLevels() {
        let jsCities = RegionPickerData.cities(province: "江苏省")
        #expect(jsCities.contains("南京市") && jsCities.contains("苏州市"))
        let njDistricts = RegionPickerData.districts(province: "江苏省", city: "南京市")
        #expect(!njDistricts.isEmpty)
        // 直辖市：市级名 = 省名（生成时已把「市辖区/县」替换，微信 picker 同款展示）。
        let shCities = RegionPickerData.cities(province: "上海市")
        #expect(shCities.contains("上海市"))
        #expect(RegionPickerData.districts(province: "上海市", city: "上海市").contains("黄浦区"))
        // 不设区地级市（东莞）：本数据集落成镇街级区划，逐级选择正常；
        // 回退 [市名] 仅在区级为空的兜底分支（mp 空第三列同款口径）。
        let dgDistricts = RegionPickerData.districts(province: "广东省", city: "东莞市")
        #expect(!dgDistricts.isEmpty)
        // 未知省市回空（不产生脏选项）。
        #expect(RegionPickerData.cities(province: "不存在省").isEmpty)
        #expect(RegionPickerData.districts(province: "江苏省", city: "不存在市").isEmpty)
    }

    // MARK: - 规则文案（品牌/平台词改写，拍板 5）

    @Test func rulesCopyUsesStrideWiseAndAppContext() {
        for doc in [checkinRulesDocument, mallRulesDocument] {
            let all = ([doc.title] + doc.blocks.map(\.text)).joined()
            #expect(all.contains("StrideWise"))
            #expect(!all.contains("砺跑"))
            #expect(!all.contains("小程序"))
            #expect(!all.contains("微信"))
        }
        #expect(checkinRulesDocument.title == "StrideWise 签到福利规则")
        #expect(mallRulesDocument.title == "StrideWise 积分商城兑换规则")
    }

    // MARK: - 路由白名单（6 个新 case）

    private func url(_ pathAndQuery: String) -> URL {
        URL(string: "https://stride-running.cn\(pathAndQuery)")!
    }

    @Test func parsesPointsDomainRoutes() {
        #expect(Route(url: url("/pages/checkin/checkin?gained=5")) == .checkin(gained: 5))
        #expect(Route(url: url("/pages/checkin/checkin")) == .checkin(gained: nil))
        #expect(Route(url: url("/pages/points-mall/points-mall")) == .pointsMall)
        #expect(Route(url: url("/pages/points-orders/points-orders")) == .pointsOrders)
        #expect(Route(url: url("/pages/points-detail/points-detail")) == .pointsDetail)
        #expect(Route(url: url("/pages/addresses/addresses?mode=pick")) == .addresses(pick: true))
        #expect(Route(url: url("/pages/addresses/addresses")) == .addresses(pick: false))
        #expect(Route(url: url("/pages/address-form/address-form?id=7")) == .addressForm(id: 7))
        #expect(Route(url: url("/pages/address-form/address-form")) == .addressForm(id: nil))
    }

    @Test func rejectsPointsDomainBadQueries() {
        // 未知参数拒绝（白名单语义更严）。
        #expect(Route(url: url("/pages/points-mall/points-mall?foo=1")) == nil)
        #expect(Route(url: url("/pages/points-orders/points-orders?paid=x")) == nil)
        #expect(Route(url: url("/pages/addresses/addresses?mode=pick&selected=1")) == nil)
        #expect(Route(url: url("/pages/address-form/address-form?id=abc")) == nil)
    }

    @Test func pointsDomainRouteRoundTripAndHomeTab() {
        let samples: [Route] = [
            .checkin(gained: 5),
            .checkin(gained: nil),
            .pointsMall,
            .pointsOrders,
            .pointsDetail,
            .addresses(pick: true),
            .addresses(pick: false),
            .addressForm(id: 7),
            .addressForm(id: nil),
        ]
        for route in samples {
            let path = route.pathWithQuery
            #expect(Route(url: url(path)) == route, "\(path) should round trip")
            #expect(route.homeTab == .profile)
        }
    }
}
