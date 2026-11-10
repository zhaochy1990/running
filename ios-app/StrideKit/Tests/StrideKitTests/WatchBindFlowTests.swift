import Foundation
import Testing
@testable import StrideKit

/// 绑表成功落点（devops#940，mp 59dd9d71 watch.ts redirect 透传等价）：
/// 带 redirect（来源页）→ dismiss 回来源，栈与来源页状态原样保留（落地页
/// onAppear 续推链不丢）；不带 → 维持默认跳全屏 onboarding 看同步进度。
/// onboarding 绑表步为内联绑定（OnboardingModel.bindWatch），天然留在
/// onboarding 续跑 sync，不经 WatchView，不在本套覆盖面。
@Suite @MainActor struct WatchBindFlowTests {

    private func loggedInApp(_ transport: MockTransport) async -> AppModel {
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        await transport.plan("/api/users/me", responses: [(200, jsonData(#"{"id":"u1","email":"a@b.c"}"#))])
        await transport.plan("/api/users/me/profile", responses: [(
            200, jsonData(#"{"id":"u1","onboarding":{"watch_ready":true,"profile_ready":true,"completed_at":"2026-09-01"},"features":{}}"#)
        )])
        let model = AppModel(api: client, tokens: store)
        try? await Task.sleep(for: .milliseconds(20))
        await model.bootstrap()
        return model
    }

    private func planWatchEndpoints(_ transport: MockTransport) async {
        await transport.plan("/api/users/me/watch", responses: [(
            200, jsonData(#"{"provider":null,"provider_display_name":null,"logged_in":false,"email":null,"device":null,"last_sync_at":null,"capabilities":[]}"#)
        )])
        await transport.plan("/api/users/me/watch/login", "POST", responses: [(200, jsonData(#"{"ok":true}"#))])
    }

    /// 品牌表单填好并提交（selectProvider/email/password 均公开面）。
    private func connect(_ watch: WatchModel) async {
        watch.selectProvider(.coros)
        watch.email = "a@b.c"
        watch.password = "pw"
        await watch.connect()
    }

    // MARK: - 来源一：profile-edit（设置页手表绑定行）

    @Test func bindFromProfileEditPopsBackToProfileEdit() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        await planWatchEndpoints(transport)

        app.router.selectedTab = .profile
        app.router.push(.profileEdit)
        app.router.push(.watch(provider: nil, redirect: .profileEdit))
        let watch = WatchModel(provider: nil, redirect: .profileEdit)
        await watch.activate(app: app)

        await connect(watch)
        #expect(watch.toastMessage == "绑定成功")
        // dismiss 回来源：栈回到 [profileEdit]，不再硬跳全屏 onboarding
        #expect(app.router.paths[.profile] == [.profileEdit])
        #expect(app.phase == .loggedIn)
    }

    // MARK: - 来源二：workout-share 落地页（推送手表 → 去绑定 → 回页续推）

    @Test func bindFromLandingPopsBackToLandingForResume() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        await planWatchEndpoints(transport)

        let landing = Route.workoutShare(user: "u1", workout: "w1")
        app.router.selectedTab = .coach
        app.router.push(landing)
        app.router.push(.watch(provider: nil, redirect: landing))
        let watch = WatchModel(provider: nil, redirect: landing)
        await watch.activate(app: app)

        await connect(watch)
        // 落地页原地保留（@State 续推意图不丢，onAppear 触发 resumeIfNeeded）
        #expect(app.router.paths[.coach] == [landing])
        #expect(app.phase == .loggedIn)
    }

    // MARK: - 默认（无 redirect）：维持旧行为跳 onboarding

    @Test func bindWithoutRedirectStillPresentsOnboarding() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        await planWatchEndpoints(transport)

        app.router.push(.watch(provider: nil, redirect: nil))
        let watch = WatchModel(provider: nil, redirect: nil)
        await watch.activate(app: app)

        await connect(watch)
        #expect(app.phase == .onboarding)
    }

    // MARK: - 深链直达带 redirect（栈下非来源）：reLaunch 等价落来源

    @Test func bindFromDeepLinkWithRedirectResetsToSource() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        await planWatchEndpoints(transport)

        let landing = Route.workoutShare(user: "u1", workout: "w1")
        app.router.reset(to: .watch(provider: nil, redirect: landing))
        let watch = WatchModel(provider: nil, redirect: landing)
        await watch.activate(app: app)

        await connect(watch)
        // 栈下不是来源（watch 即栈顶根）→ reset 全栈重建落来源（reLaunch 等价）
        #expect(app.router.selectedTab == .coach)
        #expect(app.router.paths[.coach] == [landing])
        #expect(app.phase == .loggedIn)
    }
}
