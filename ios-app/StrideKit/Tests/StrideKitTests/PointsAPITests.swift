import Foundation
import Testing
@testable import StrideKit

/// 积分商城域 APIClient 端点接线单测（devops#938）：路径/方法/请求体/解码/
/// cursor 透传/幂等键上送（契约 #937 §四 12 端点表中 iOS 消费的 11 个）。
@Suite struct PointsAPITests {

    @Test func checkInStatusDecodesFullEnvelope() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/check-ins/status", responses: [(200, jsonData("""
        {"today":{"date":"2026-11-10","can_check_in":true,"reward_preview":2,"would_start_new_cycle":false},
         "streak_days":4,"balance":37,
         "cycle":[{"position":1,"points":1,"status":"checked"},{"position":7,"points":3,"status":"today"}],
         "month":{"label":"2026-11","checked":[{"date":"2026-11-09","points":2}]}}
        """))])
        let (client, _) = makeTestClient(transport: transport)
        let st = try await client.checkInStatus()
        #expect(st.today.date == "2026-11-10")
        #expect(st.today.canCheckIn && st.today.rewardPreview == 2)
        #expect(st.streakDays == 4)
        #expect(st.balance == 37)
        #expect(st.cycle.count == 2)
        #expect(st.cycle[1].status == .today)
        #expect(st.month.checked.first?.points == 2)
        #expect(await transport.count(path: "/api/users/me/check-ins/status") == 1)
    }

    @Test func createCheckInPostsAndDecodes() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/check-ins", "POST", responses: [(200, jsonData("""
        {"already_checked_in":false,"streak_days":5,"cycle_position":5,"points_earned":2,"balance":39,"d7_completed":false}
        """))])
        let (client, _) = makeTestClient(transport: transport)
        let res = try await client.createCheckIn()
        #expect(!res.alreadyCheckedIn)
        #expect(res.pointsEarned == 2 && res.balance == 39)
        // 空 body POST（按日幂等语义在服务端）。
        #expect(await transport.calls(to: "/api/users/me/check-ins").first?.body == nil)
    }

    @Test func pointsLedgerCursorPassthrough() async throws {
        let transport = MockTransport()
        // 同一 plan 两条响应按命中次数顺序消费（首轮 / 翻页）。
        await transport.plan("/api/users/me/points", responses: [
            (200, jsonData("""
            {"balance":30,"transactions":[{"id":"t1","type":"earn_checkin","amount":1,"ref":"","remark":null,"created_at":"2026-11-09T02:03:04Z"}],"next_cursor":"c2"}
            """)),
            (200, jsonData("""
            {"balance":30,"transactions":[],"next_cursor":null}
            """)),
        ])
        let (client, _) = makeTestClient(transport: transport)
        let first = try await client.pointsLedger()
        #expect(first.balance == 30)
        #expect(first.transactions[0].type == "earn_checkin")
        #expect(first.nextCursor == "c2")
        let second = try await client.pointsLedger(cursor: "c2")
        #expect(second.transactions.isEmpty && second.nextCursor == nil)
        // cursor 原样透传进 query。
        #expect(await transport.calls(to: "/api/users/me/points").count == 2)
    }

    @Test func pointProductsDecodeSpecModesAndShipping() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/points/products", responses: [(200, jsonData("""
        {"products":[
          {"id":1,"name":"T 恤","description":"纯棉","image_url":"https://cos/1.png","points_price":50,
           "stock":3,"per_user_limit":2,"redeemed_count":1,"spec_mode":"by_sku",
           "skus":[{"id":11,"spec_value":"M","stock":2},{"id":12,"spec_value":"L","stock":0}],
           "shipping_policy":"jzsh_fee","shipping_fee":800},
          {"id":2,"name":"贴纸","points_price":10,"stock":9,"per_user_limit":0,"redeemed_count":0,
           "shipping_policy":"nationwide_free","shipping_fee":0}
        ]}
        """))])
        let (client, _) = makeTestClient(transport: transport)
        let res = try await client.pointProducts()
        let shirt = res.products[0]
        #expect(shirt.specMode == .bySku)
        #expect(shirt.skus?.count == 2)
        #expect(shirt.shippingPolicy == .jzshFee && shirt.shippingFee == 800)
        // 旧后端缺省字段解码不炸（spec_mode/skus/description/image_url 全可缺）。
        let sticker = res.products[1]
        #expect(sticker.specMode == nil && sticker.skus == nil)
    }

    @Test func createRedemptionSendsIdempotencyKeyAndSku() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/points/redemptions", "POST", responses: [(200, jsonData("""
        {"order":{"id":"uuid-9","product_id":1,"product_name":"T 恤","points_cost":100,"quantity":2,
          "status":"pending_shipment","sku_label":"M","courier_company":null,"tracking_no":null,
          "shipped_at":null,"shipping_fee_snapshot":0,"shipping_policy_snapshot":"nationwide_free",
          "payment_state":"free","paid_at":null,"receiver_name":"张三","receiver_phone":"13800000000",
          "province":"江苏省","city":"南京市","district":"玄武区","address_detail":"路 1 号",
          "created_at":"2026-11-09T02:03:04Z"},
         "balance":9,"replayed":false}
        """))])
        let (client, _) = makeTestClient(transport: transport)
        let res = try await client.createRedemption(
            productID: 1, addressID: 5, idempotencyKey: "ios-redeem-X", quantity: 2, skuID: 11
        )
        #expect(res.order.status == RedemptionStates.pendingShipment)
        #expect(res.order.skuLabel == "M")
        #expect(res.balance == 9 && !res.replayed)
        let body = try JSONSerialization.jsonObject(with: await transport.calls(to: "/api/users/me/points/redemptions")[0].body!) as! [String: Any]
        #expect(body["product_id"] as? Int == 1)
        #expect(body["address_id"] as? Int == 5)
        #expect(body["idempotency_key"] as? String == "ios-redeem-X")
        #expect(body["quantity"] as? Int == 2)
        #expect(body["sku_id"] as? Int == 11)
    }

    @Test func redemptionsListCursor() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/points/redemptions", responses: [(200, jsonData("""
        {"redemptions":[],"next_cursor":null}
        """))])
        let (client, _) = makeTestClient(transport: transport)
        let res = try await client.redemptions()
        #expect(res.redemptions.isEmpty && res.nextCursor == nil)
        _ = try await client.redemptions(cursor: "abc/def")
        let second = await transport.calls(to: "/api/users/me/points/redemptions")[1]
        #expect(second.url.query?.contains("cursor=abc%2Fdef") == true)
    }

    @Test func addressesCRUDPathsAndDefault() async throws {
        let transport = MockTransport()
        let address = """
        {"id":5,"receiver_name":"张三","receiver_phone":"13800000000","province":"江苏省",
         "city":"南京市","district":"玄武区","address_detail":"路 1 号","is_default":true,
         "created_at":"2026-11-09T02:03:04Z","updated_at":"2026-11-09T02:03:04Z"}
        """
        await transport.plan("/api/users/me/addresses", responses: [(200, jsonData("{\"addresses\":[\(address)]}"))])
        await transport.plan("/api/users/me/addresses", "POST", responses: [(200, jsonData(address))])
        await transport.plan("/api/users/me/addresses/5", "PATCH", responses: [(200, jsonData(address))])
        await transport.plan("/api/users/me/addresses/5", "DELETE", responses: [(204, Data())])
        await transport.plan("/api/users/me/addresses/5/default", "PATCH", responses: [(200, jsonData(address))])
        let (client, _) = makeTestClient(transport: transport)

        let list = try await client.listAddresses()
        #expect(list.addresses.count == 1 && list.addresses[0].isDefault)

        let payload = AddressPayload(receiverName: "张三", receiverPhone: "13800000000",
                                     province: "江苏省", city: "南京市", district: "玄武区",
                                     addressDetail: "路 1 号", isDefault: false)
        _ = try await client.createAddress(payload)
        let postBody = try JSONSerialization.jsonObject(with: await transport.calls(to: "/api/users/me/addresses")[1].body!) as! [String: Any]
        #expect(postBody["receiver_name"] as? String == "张三")
        #expect(postBody["is_default"] as? Bool == false)

        _ = try await client.updateAddress(id: 5, payload)
        #expect(await transport.count(path: "/api/users/me/addresses/5") == 1)

        try await client.deleteAddress(id: 5)
        #expect(await transport.count(path: "/api/users/me/addresses/5") == 2)

        _ = try await client.setAddressDefault(id: 5)
        #expect(await transport.count(path: "/api/users/me/addresses/5/default") == 1)
        // 设默认发空 JSON body（服务端契约 Record<string,never> 同款）。
        let defaultCall = await transport.calls(to: "/api/users/me/addresses/5/default")[0]
        #expect(defaultCall.body == Data("{}".utf8))
    }

    @Test func businessErrorCodeSurfacesForThreeWaySplit() async throws {
        // 兑换 409 业务码 → ApiError.code 透出（页面三分流依据）。
        let transport = MockTransport()
        await transport.plan("/api/users/me/points/redemptions", "POST", responses: [
            (409, jsonData("{\"detail\":\"insufficient points\",\"code\":\"insufficient_points\"}")),
        ])
        let (client, _) = makeTestClient(transport: transport)
        do {
            _ = try await client.createRedemption(productID: 1, addressID: 5, idempotencyKey: "k")
            #expect(Bool(false), "expected insufficient_points")
        } catch let error as ApiError {
            #expect(error.code == "insufficient_points")
            #expect(pointsErrorCopy(error, "兑换失败，请稍后再试") == "积分不足，去签到赚积分吧")
        }
    }

    @Test func checkInDuplicateIsSnapshotNotError() async throws {
        // 按日幂等：already_checked_in=true +0 分是正常 200 响应，非错误。
        let transport = MockTransport()
        await transport.plan("/api/users/me/check-ins", "POST", responses: [(200, jsonData("""
        {"already_checked_in":true,"streak_days":6,"cycle_position":6,"points_earned":0,"balance":37,"d7_completed":false}
        """))])
        let (client, _) = makeTestClient(transport: transport)
        let res = try await client.createCheckIn()
        #expect(res.alreadyCheckedIn && res.pointsEarned == 0)
    }
}
