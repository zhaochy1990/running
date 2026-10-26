import Foundation
import Testing
@testable import StrideKit

/// 登录成功分支与启动 onboarding 拦截（devops#752 决议；login.ts
/// navigateAfterLogin + app.ts routeToOnboardingIfProfileMissing）。
@Suite @MainActor struct AppModelLandingTests {

    private func makeModel(_ transport: MockTransport) async -> AppModel {
        let (client, store) = makeTestClient(transport: transport)
        let model = AppModel(api: client, tokens: store)
        // 等 init 里的 sessionExpiredHandler 装配完成（Task 异步一跳）
        try? await Task.sleep(for: .milliseconds(20))
        return model
    }

    private func meOK(_ transport: MockTransport) async {
        await transport.plan("/api/users/me", responses: [(200, jsonData(#"{"id":"u1","email":"a@b.c"}"#))])
    }

    private func profileBody(ready: Bool) -> Data {
        jsonData(#"{"id":"u1","onboarding":{"watch_ready":true,"profile_ready":\#(ready),"completed_at":\#(ready ? "\"2026-10-01\"" : "null")},"features":{}}"#)
    }

    // MARK: - bootstrap 拦截（老账号补档案通道）

    @Test func bootstrapWithoutTokenStaysLoggedOut() async throws {
        let transport = MockTransport()
        let model = await makeModel(transport)
        await model.bootstrap()
        #expect(model.phase == .loggedOut)
    }

    @Test func bootstrapWithTokenAndMissingProfileRoutesToOnboarding() async throws {
        let transport = MockTransport()
        await meOK(transport)
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(ready: false))])
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        let model = AppModel(api: client, tokens: store)

        await model.bootstrap()
        #expect(model.phase == .onboarding)
    }

    @Test func bootstrapProfileReadyEntersLoggedIn() async throws {
        let transport = MockTransport()
        await meOK(transport)
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(ready: true))])
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        let model = AppModel(api: client, tokens: store)

        await model.bootstrap()
        #expect(model.phase == .loggedIn)
    }

    @Test func bootstrapProfileFetchFailureLetsUserThrough() async throws {
        let transport = MockTransport()
        await meOK(transport)
        await transport.plan("/api/users/me/profile", responses: [(500, Data())])
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        let model = AppModel(api: client, tokens: store)

        // 查询失败放行：网络抖动不该把用户从首页拽走
        await model.bootstrap()
        #expect(model.phase == .loggedIn)
    }

    // MARK: - 登录成功分支

    @Test func loginSuccessOldUserLandsOnCoachTab() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(ready: true))])
        let model = await makeModel(transport)

        await model.handleLoginSuccess()
        #expect(model.phase == .loggedIn)
        #expect(model.router.selectedTab == .coach)
    }

    @Test func loginSuccessFreshProfileGoesOnboarding() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(ready: false))])
        let model = await makeModel(transport)

        // 新注册（档案未齐）→ onboarding（sms/verify 不回 registered，靠档案链判定）
        await model.handleLoginSuccess()
        #expect(model.phase == .onboarding)
    }

    @Test func loginSuccessRedirectWinsOverProfileCheck() async throws {
        let transport = MockTransport()
        // 即使档案未齐，redirect 也优先回跳（login.ts navigateAfterLogin 顺序）
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(ready: false))])
        let model = await makeModel(transport)
        model.setLoginRedirectForTesting(.activities)

        await model.handleLoginSuccess()
        #expect(model.phase == .loggedIn)
        #expect(model.router.selectedTab == .activities)
        // redirect 一次性消费
        #expect(model.loginRedirect == nil)
    }

    @Test func loginSuccessProfileFetchFailureFallsToCoach() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(404, Data())])
        let model = await makeModel(transport)

        await model.handleLoginSuccess()
        #expect(model.phase == .loggedIn)
        #expect(model.router.selectedTab == .coach)
    }

    // MARK: - onboarding 离场

    @Test func finishOnboardingHonorsRedirect() async throws {
        let transport = MockTransport()
        let model = await makeModel(transport)
        model.setLoginRedirectForTesting(.watch(provider: .coros))

        model.finishOnboarding()
        #expect(model.phase == .loggedIn)
        #expect(model.router.selectedTab == .profile)
        #expect(model.router.paths[.profile]?.last == .watch(provider: .coros))
        #expect(model.loginRedirect == nil)
    }

    @Test func finishOnboardingDefaultsToCoach() async throws {
        let transport = MockTransport()
        let model = await makeModel(transport)
        model.finishOnboarding()
        #expect(model.phase == .loggedIn)
        #expect(model.router.selectedTab == .coach)
        #expect(model.router.paths[.coach]?.isEmpty != false)
    }

    // MARK: - onboarding 模型工厂

    @Test func makeOnboardingModelWiresFinishToAppModel() async throws {
        let transport = MockTransport()
        let model = await makeModel(transport)

        let onboarding = model.makeOnboardingModel()
        await onboarding.refresh() // 无网（404）→ 资料步 + 加载失败文案
        #expect(onboarding.step == .profile)
        #expect(onboarding.formError != nil)

        onboarding.skipToHome()
        #expect(model.phase == .loggedIn)
        #expect(model.router.selectedTab == .coach)
    }
}

// 测试钩子：loginRedirect / phase 是 internal(set) 或 private(set)
extension AppModel {
    func setLoginRedirectForTesting(_ route: Route?) {
        loginRedirect = route
    }
}

extension AppModelLandingTests {
    @Test func deepLinkDuringOnboardingDefersInsteadOfLogout() async throws {
        let transport = MockTransport()
        await meOK(transport)
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(ready: false))])
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        let model = AppModel(api: client, tokens: store)

        // 冷开带 token + 档案未齐 → onboarding 全屏（老账号补档案通道）
        await model.bootstrap()
        #expect(model.phase == .onboarding)

        // 引导中已登录：非公开深链只暂存 redirect，不把用户拽回登录页
        model.open(URL(string: "https://stride-running.cn/pages/race-center/race-center")!)
        #expect(model.phase == .onboarding)
        #expect(model.loginRedirect == .raceCenter)

        // 完成引导 → 回跳深链目标
        model.finishOnboarding()
        #expect(model.phase == .loggedIn)
        #expect(model.router.selectedTab == .profile)
    }
}
