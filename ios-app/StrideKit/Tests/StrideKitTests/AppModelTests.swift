import Foundation
import Testing
@testable import StrideKit

/// AppModel 启动决策树与跨 tab 交接（app.ts checkAuth 骨架等价）。
@MainActor
@Suite struct AppModelTests {

    private func makeModel(
        transport: APIClientTests.MockTransport? = nil,
        tokens: InMemoryTokenStore = InMemoryTokenStore()
    ) -> (AppModel, InMemoryTokenStore) {
        let t = transport ?? APIClientTests.MockTransport()
        let api = APIClient(
            config: APIConfig(
                baseURL: URL(string: "https://api.test")!,
                authBaseURL: URL(string: "https://auth.test")!,
                clientID: "app_test"
            ),
            tokens: tokens,
            transport: t
        )
        return (AppModel(api: api, tokens: tokens), tokens)
    }

    private func json(_ s: String) -> Data { Data(s.utf8) }

    // MARK: - bootstrap 决策树

    @Test func noTokensGoesToLogin() async {
        let (model, _) = makeModel()
        await model.bootstrap()
        #expect(model.phase == .loggedOut)
    }

    @Test func coldEntryStoredAsRedirectWhenLoggedOut() async {
        let (model, _) = makeModel()
        await model.bootstrap(entry: .activityDetail(labelId: "abc"))
        #expect(model.phase == .loggedOut)
        #expect(model.loginRedirect == .activityDetail(labelId: "abc"))
    }

    @Test func validSessionGoesLoggedInAndLandsEntry() async throws {
        let transport = APIClientTests.MockTransport()
        await transport.plan("/api/users/me", responses: [(200, json(#"{"id":"u1"}"#))])
        let (model, tokens) = makeModel(transport: transport)
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 900)

        await model.bootstrap(entry: .raceDetail(id: 7))
        #expect(model.phase == .loggedIn)
        // 深链落点：非 tab 根 → 选中归属 tab 且栈顶为目标页
        #expect(model.router.selectedTab == .profile)
        #expect(model.router.paths[.profile] == [.raceDetail(id: 7)])
    }

    @Test func authFailureGoesToLoginAndClearsTokens() async throws {
        let transport = APIClientTests.MockTransport()
        await transport.plan("/api/users/me", responses: [(401, Data())])
        await transport.plan("/api/auth/refresh", "POST", responses: [(401, Data())])
        let (model, tokens) = makeModel(transport: transport)
        await tokens.save(access: "stale", refresh: "stale", expiresIn: 0)

        await model.bootstrap(entry: .trainingStatus)
        #expect(model.phase == .loggedOut)
        #expect(model.loginRedirect == .trainingStatus)
        #expect(await tokens.accessToken() == nil)
    }

    @Test func networkFailureKeepsSession() async {
        // 网络类失败保会话不误登出（baseline §0.2）
        final class FailingTransport: HTTPTransport, @unchecked Sendable {
            func data(for request: URLRequest) async throws -> (Data, URLResponse) {
                throw URLError(.notConnectedToInternet)
            }
        }
        let tokens = InMemoryTokenStore()
        let api = APIClient(
            config: APIConfig(baseURL: URL(string: "https://api.test")!, authBaseURL: URL(string: "https://api.test")!, clientID: "app_test"),
            tokens: tokens,
            transport: FailingTransport()
        )
        let model = AppModel(api: api, tokens: tokens)
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 900)

        await model.bootstrap()
        #expect(model.phase == .loggedIn)
    }

    // MARK: - open(url:) 深链

    @Test func openURLParsesAndLands() async throws {
        // makeModel 注入的空 transport 对 /api/users/me 回 404（非 401）
        // → 网络类保留会话 → loggedIn，深链可落
        let (model, tokens) = makeModel()
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 900)

        await model.bootstrap()
        model.open(URL(string: "https://stride-running.cn/pages/race-center/detail?id=9")!)
        #expect(model.router.paths[.profile] == [.raceDetail(id: 9)])
    }

    @Test func openUnknownURLIsIgnored() async {
        let (model, tokens) = makeModel()
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 900)
        await model.bootstrap()
        model.open(URL(string: "https://stride-running.cn/pages/plan/plan")!)
        #expect(model.router.paths[.profile] == nil)
    }

    // MARK: - 跨 tab 交接（单次消费语义）

    @Test func pendingCoachContextConsumedOnce() {
        let (model, _) = makeModel()
        model.pendingCoachContext = PendingCoachContext(target: .race, kickoffMessage: "我想聊聊上马")
        let taken = model.takePendingCoachContext()
        #expect(taken == PendingCoachContext(target: .race, kickoffMessage: "我想聊聊上马"))
        #expect(model.takePendingCoachContext() == nil)
    }

    @Test func pendingStrategyDraftConsumedOnce() {
        let (model, _) = makeModel()
        model.pendingStrategyDraft = PendingStrategyDraft(raceId: 7, payload: Data("{}".utf8))
        #expect(model.takePendingStrategyDraft()?.raceId == 7)
        #expect(model.takePendingStrategyDraft() == nil)
    }
}
