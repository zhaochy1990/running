import Foundation
import Testing
@testable import StrideKit

/// APIClient 骨架测试：头部约定 / 双格式错误 / 401 单飞刷新 / 会话失效链。
@Suite struct APIClientTests {

    // MARK: - 测试基建

    /// 按调用序返回的 mock transport（actor，天然并发安全）：
    /// `plan["path|METHOD"] = [响应…]` 依序出队，耗尽后重复最后一个；
    /// 未配置的路径恒 404 空体。记录全部请求供断言。
    actor MockTransport: HTTPTransport {
        struct Call {
            let url: URL
            let method: String
            let headers: [String: String]
        }

        private var plan: [String: [(Int, Data)]] = [:]
        private var hits: [String: Int] = [:]
        private var calls: [Call] = []

        init() {}

        func plan(_ path: String, _ method: String = "GET", responses: [(Int, Data)]) {
            plan["\(path)|\(method)"] = responses
        }

        func count(path: String) -> Int {
            hits[path] ?? 0
        }

        func calls(to path: String) -> [Call] {
            calls.filter { $0.url.path == path }
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let key = request.url!.path + "|" + (request.httpMethod ?? "GET")
            hits[request.url!.path, default: 0] += 1
            let n = hits[request.url!.path]!
            var headers: [String: String] = [:]
            request.allHTTPHeaderFields.map { headers.merge($0) { _, new in new } }
            calls.append(Call(url: request.url!, method: request.httpMethod ?? "GET", headers: headers))
            let responses = plan[key] ?? [(404, Data())]
            let (status, body) = responses[min(n - 1, responses.count - 1)]
            let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (body, http)
        }
    }

    private func makeClient(
        transport: HTTPTransport,
        tokens: (any TokenStore)? = nil
    ) -> (APIClient, InMemoryTokenStore) {
        let store = tokens as? InMemoryTokenStore ?? InMemoryTokenStore()
        let client = APIClient(
            config: APIConfig(
                baseURL: URL(string: "https://api.test")!,
                authBaseURL: URL(string: "https://auth.test")!,
                clientID: "app_test"
            ),
            tokens: store,
            transport: transport
        )
        return (client, store)
    }

    private func jsonData(_ string: String) -> Data { Data(string.utf8) }

    // MARK: - 头部与成功面

    @Test func attachesProtocolHeaders() async throws {
        let transport = MockTransport()
        let (client, store) = makeClient(transport: transport)
        await store.save(access: "acc-1", refresh: "ref-1", expiresIn: 300)
        await transport.plan("/api/users/me", responses: [(200, jsonData(#"{"id":"u1","email":"a@b.c"}"#))])

        let user = try await client.validateSession()
        #expect(user.id == "u1")

        let call = try #require(await transport.calls(to: "/api/users/me").first)
        #expect(call.headers["Content-Type"] == "application/json")
        #expect(call.headers["X-Client-Id"] == "app_test")
        #expect(call.headers["Authorization"] == "Bearer acc-1")
    }

    @Test func publicRequestOmitsBearerAndSkipsRefresh() async throws {
        let transport = MockTransport()
        let (client, store) = makeClient(transport: transport)
        await store.save(access: "acc-1", refresh: "ref-1", expiresIn: 300)
        await transport.plan("/api/declarations/user_agreement", responses: [(401, Data())])

        // 公开端点 401 = 普通 ApiError，不触发刷新链（request.ts auth:false 分支）
        await #expect(throws: ApiError.self) {
            _ = try await client.send(APIRequest(path: "/api/declarations/user_agreement", authorized: false))
        }
        #expect(await transport.count(path: "/api/auth/refresh") == 0)
        let call = await transport.calls(to: "/api/declarations/user_agreement").first
        #expect(call?.headers["Authorization"] == nil)
    }

    // MARK: - 错误归一

    @Test func throwsDualFormatApiError() async {
        let transport = MockTransport()
        await transport.plan("/api/activities", responses: [(404, jsonData(#"{"detail":"无活动","code":"not_found"}"#))])
        let (client, _) = makeClient(transport: transport)

        do {
            _ = try await client.send(APIRequest(path: "/api/activities", authorized: false))
            Issue.record("应抛错")
        } catch let error as ApiError {
            #expect(error.statusCode == 404)
            #expect(error.code == "not_found")
            #expect(error.detail == "无活动")
        } catch {
            Issue.record("错误类型不对：\(error)")
        }
    }

    // MARK: - 401 刷新链

    @Test func refreshesThenRetriesWithNewToken() async throws {
        let transport = MockTransport()
        let (client, store) = makeClient(transport: transport)
        await store.save(access: "stale", refresh: "ref-1", expiresIn: 0)
        // /me 第 1 次 401（stale），第 2 次 200（acc-2）
        await transport.plan("/api/users/me", responses: [
            (401, jsonData(#"{"detail":"expired"}"#)),
            (200, jsonData(#"{"id":"u1"}"#)),
        ])
        await transport.plan("/api/auth/refresh", "POST", responses: [
            (200, jsonData(#"{"access_token":"acc-2","refresh_token":"ref-2","expires_in":900}"#)),
        ])

        let user = try await client.validateSession()
        #expect(user.id == "u1")

        // 重试请求带新 token；刷新后双 token 落库
        let retry = await transport.calls(to: "/api/users/me")[1]
        #expect(retry.headers["Authorization"] == "Bearer acc-2")
        #expect(await store.accessToken() == "acc-2")
        #expect(await store.refreshToken() == "ref-2")
    }

    @Test func singleFlightRefreshForConcurrent401s() async throws {
        let transport = MockTransport()
        let (client, store) = makeClient(transport: transport)
        await store.save(access: "stale", refresh: "ref-1", expiresIn: 0)
        // 两个业务端点各自：首问 401、重试 200；refresh 恒 200
        await transport.plan("/api/a", responses: [(401, Data()), (200, jsonData("[]"))])
        await transport.plan("/api/b", responses: [(401, Data()), (200, jsonData("[]"))])
        await transport.plan("/api/auth/refresh", "POST", responses: [
            (200, jsonData(#"{"access_token":"acc-2","refresh_token":"ref-2","expires_in":900}"#)),
        ])

        async let a = client.send(APIRequest(path: "/api/a"))
        async let b = client.send(APIRequest(path: "/api/b"))
        _ = try await (a, b)

        // 并发 401 → refresh 只发生一次（单飞），两请求各自重试成功
        #expect(await transport.count(path: "/api/auth/refresh") == 1)
        #expect(await transport.count(path: "/api/a") == 2)
        #expect(await transport.count(path: "/api/b") == 2)
    }

    @Test func sessionExpiryClearsTokensAndNotifies() async throws {
        let transport = MockTransport()
        let flag = Flag()
        let (client, store) = makeClient(transport: transport)
        await client.setSessionExpiredHandler { await flag.trip() }
        await store.save(access: "stale", refresh: "ref-1", expiresIn: 0)
        await transport.plan("/api/users/me", responses: [(401, Data())])
        await transport.plan("/api/auth/refresh", "POST", responses: [
            (401, jsonData(#"{"error":"invalid_grant","message":"过期"}"#)),
        ])

        do {
            _ = try await client.validateSession()
            Issue.record("应抛错")
        } catch let error as ApiError {
            #expect(error == ApiError.sessionExpired)
        }
        // Keychain 已清空、回调已触发（对应 handleSessionExpired → Login）
        #expect(await store.accessToken() == nil)
        #expect(await store.refreshToken() == nil)
        #expect(await flag.isTripped)
    }

    // MARK: - 辅助

    /// MainActor 回调旗标（actor 化避免并发写竞争）。
    actor Flag {
        private(set) var tripped = false
        func trip() { tripped = true }
        var isTripped: Bool { tripped }
    }
}
