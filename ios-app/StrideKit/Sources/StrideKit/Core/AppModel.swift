import Foundation
import Observation

/// App 全局模型（devops#751 / devops#749 §4.2）：会话 + pending 跨 tab 交接
/// + 选中 tab（经 `router`）。小程序 storage 中转 hack（switchTab 不能带
/// query）在单进程 SwiftUI 下升级为 @Observable 属性，一次性消费语义保留。
@MainActor
@Observable
public final class AppModel {

    /// 启动认证状态机（app.ts checkAuth + PR-2 登录域 onboarding 拦截）。
    public enum AuthPhase: Equatable, Sendable {
        case checking
        case loggedIn
        /// 档案未齐 / 刚注册：全屏 onboarding（app.ts
        /// routeToOnboardingIfProfileMissing 的 reLaunch 等价）。
        case onboarding
        case loggedOut
    }

    public private(set) var phase: AuthPhase = .checking

    public let router = AppRouter()
    public let theme = ThemeManager()

    /// 当前用户（checkAuth 验证成功后落位；记录域等数据页取 `me.id` 拼
    /// `/api/{user}/...` 路径，等价小程序 `userStore.getState().user.id`）。
    public private(set) var me: MeUser?

    /// 数据域共享的请求客户端（各 Repository 以此构造，401 刷新单飞全局一份）。
    public let api: APIClient

    /// 登录成功后的回跳目标（401 / 冷开未登录时带 redirect，修丢上下文）。
    public internal(set) var loginRedirect: Route?

    /// 401 回登录页时预填的手机号（沿 #460 lastSmsPhone）。
    public var prefilledPhone: String?

    /// 登录域服务（SMS 验证码 / 邮箱密码，PR-2）。
    public let auth: AuthService

    // ── 跨 tab 交接（storage 中转的等价物，单次消费语义）────────────────
    public internal(set) var pendingCoachContext: PendingCoachContext?
    public internal(set) var pendingStrategyDraft: PendingStrategyDraft?
    /// 自定义比赛编辑回显（小程序 navigateTo eventChannel 的等价物，
    /// devops#769；Route 表定稿「AppModel 交接，非 query」）。
    public internal(set) var pendingCustomRaceEdit: CustomRace?

    private let tokens: any TokenStore

    /// coach 通道客户端（SSE 流式 + 会话 JSON；独立 401 单飞，devops#767）。
    public let coach: CoachClient

    public init(api: APIClient? = nil, tokens: (any TokenStore)? = nil, coach: CoachClient? = nil) {
        let tokenStore = tokens ?? KeychainTokenStore()
        self.tokens = tokenStore
        let client = api ?? APIClient(tokens: tokenStore)
        self.api = client
        self.auth = AuthService(api: client, tokens: tokenStore)
        self.coach = coach ?? CoachClient(tokens: tokenStore)
        // 初始化完成后装配 401 会话失效回调（切全屏 Login + redirect）。
        // 全链 weak：回调由 api 持有，而 api 由 self 持有，强捕会成环。
        Task { [weak self] in
            guard let self else { return }
            await self.api.setSessionExpiredHandler { [weak self] in
                self?.handleSessionExpired()
            }
            await self.coach.setSessionExpiredHandler { [weak self] in
                self?.handleSessionExpired()
            }
        }
    }

    /// Onboarding 页装配（RootView 全屏态创建）。
    public func makeOnboardingModel() -> OnboardingModel {
        OnboardingModel(api: api) { [weak self] in
            self?.finishOnboarding()
        }
    }

    // MARK: - 启动（app.ts checkAuth 决策树骨架）

    /// 冷启动引导。`entry` = 深链/分享回流解析出的落点（可为 nil）。
    ///
    /// - 有 token → `GET /api/users/me` 服务端验证（不信本地过期时间）
    /// - 验证失败（401 刷新链已尽）→ 清 token → 全屏 Login（entry 非
    ///   公开落地页则作 redirect）
    /// - 网络类失败 → 保留会话不误登出（baseline §0.2）
    /// - 无 token → Login（同上 redirect 规则；公开落地页免登录浏览形态
    ///   归分享深链票 #758，骨架期登录后可达）
    public func bootstrap(entry: Route? = nil) async {
        phase = .checking
        #if DEBUG
        // 骨架验收/开发演示钩子：模拟器带 -StrideSkeletonLoggedIn 启动时
        // 直接进入已登录态（跳过 checkAuth 网络验证），用于四 tab 空壳走查。
        if ProcessInfo.processInfo.arguments.contains("-StrideSkeletonLoggedIn") {
            phase = .loggedIn
            if let entry { router.reset(to: entry) }
            return
        }
        #endif
        let access = await tokens.accessToken()
        let refresh = await tokens.refreshToken()
        let hasToken = access != nil || refresh != nil
        guard hasToken else {
            loggedOut(withEntry: entry)
            return
        }
        do {
            me = try await api.validateSession()
            phase = .loggedIn
            if let entry { router.reset(to: entry) }
            _ = try await api.validateSession()
            await resolveLandingAfterSession(entry: entry)
        } catch let error as ApiError {
            if error.statusCode == 401 {
                loggedOut(withEntry: entry)
            } else {
                // 网络类失败：保留会话，交给数据页处理
                await enterLoggedIn(entry: entry)
            }
        } catch {
            await enterLoggedIn(entry: entry)
        }
    }

    /// 等待启动认证 settle（`userStore.waitForAuth()` 等价）：数据页首屏
    /// 请求在登录完成前发出会被 401，等 `phase` 离开 `.checking` 再发。
    public func waitUntilSessionSettled() async {
        while phase == .checking {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// 会话有效后的落点：profileReady 启动拦截（app.ts
    /// routeToOnboardingIfProfileMissing）——档案未齐 → 全屏 onboarding
    /// （entry 透传 redirect）；查询失败放行（网络抖动不该把用户从首页拽走）。
    private func resolveLandingAfterSession(entry: Route?) async {
        if let profile = try? await api.myProfile(), !profile.profileReady {
            if let entry, !entry.isPublicLanding {
                loginRedirect = entry
            }
            phase = .onboarding
            return
        }
        await enterLoggedIn(entry: entry)
    }

    private func enterLoggedIn(entry: Route?) async {
        phase = .loggedIn
        if let entry { router.reset(to: entry) }
    }

    // MARK: - 登录域落点（PR-2，#752 决议 / login.ts navigateAfterLogin）

    /// 登录成功分支：redirect 回跳优先；无 redirect 查档案——新注册/
    /// 档案未齐 → onboarding（透传 redirect），老用户 → 教练 tab；
    /// 档案查询失败放行教练 tab（`sms/verify` 不回 registered，新旧用户
    /// 区分由 onboarding 重定向链天然覆盖，#419 决议 1）。
    public func handleLoginSuccess() async {
        if let redirect = loginRedirect {
            loginRedirect = nil
            phase = .loggedIn
            router.reset(to: redirect)
            return
        }
        if let profile = try? await api.myProfile(), !profile.profileReady {
            me = MeUser(id: profile.id, displayName: profile.displayName)
            phase = .onboarding
            return
        }
        await refreshMeIfMissing()
        enterHome()
    }

    /// onboarding 完成离场（完成 / 跳过 / 先进入首页 共用）：redirect 回跳
    /// 或教练 tab（onboarding.ts:160-167）。
    public func finishOnboarding() {
        if let redirect = loginRedirect {
            loginRedirect = nil
            router.reset(to: redirect)
        } else {
            router.reset(to: .coach)
        }
        phase = .loggedIn
    }

    private func enterHome() {
        router.reset(to: .coach)
        phase = .loggedIn
    }

    /// 登录域离线落位后补 me（数据页 `me.id` 依赖；bootstrap 路径已由
    /// validateSession 落位）。
    private func refreshMeIfMissing() async {
        guard me == nil else { return }
        me = try? await api.validateSession()
    }

    /// 深链 / 分享回流入口（onOpenURL 冷热启动统一）。
    public func open(_ url: URL) {
        guard let route = Route(url: url) else { return }
        applyIncoming(route)
    }

    private func applyIncoming(_ route: Route) {
        switch phase {
        case .loggedIn:
            router.reset(to: route)
        case .onboarding:
            // 引导中已登录：非公开深链只暂存 redirect（完成引导后回跳），
            // 不能把用户拽回登录页。
            if route.isPublicLanding {
                router.reset(to: route)
            } else {
                loginRedirect = route
            }
        case .checking, .loggedOut:
            if route.isPublicLanding {
                router.reset(to: route)
            } else {
                loginRedirect = route
                phase = .loggedOut
            }
        }
    }

    private func loggedOut(withEntry entry: Route?) {
        me = nil
        if let entry, !entry.isPublicLanding {
            loginRedirect = entry
        }
        phase = .loggedOut
    }

    /// APIClient 401 刷新链失败回调：切全屏 Login + 当前页作 redirect
    /// （对应 request.ts handleSessionExpired → redirectToLogin；微信免密
    /// 恢复整段不迁，devops#751 决议 2）。token 已由 APIClient 清空。
    /// 预填上次验证码手机号（#419 决议 4，一键重发不自动发）。
    private func handleSessionExpired() {
        let current = router.paths[router.selectedTab]?.last ?? router.selectedTab.root
        loginRedirect = current
        me = nil
        prefilledPhone = auth.lastSmsPhone()
        phase = .loggedOut
    }

    // MARK: - 跨 tab 交接（单次消费）

    /// 消费挂起的教练上下文（coach tab onShow 等价物）。
    public func takePendingCoachContext() -> PendingCoachContext? {
        defer { pendingCoachContext = nil }
        return pendingCoachContext
    }

    /// 消费挂起的策略草稿（strategy 页 onShow 等价物）。
    public func takePendingStrategyDraft() -> PendingStrategyDraft? {
        defer { pendingStrategyDraft = nil }
        return pendingStrategyDraft
    }

    /// 消费挂起的自定义比赛编辑行（表单页 onAppear 等价物）。
    public func takePendingCustomRaceEdit() -> CustomRace? {
        defer { pendingCustomRaceEdit = nil }
        return pendingCustomRaceEdit
    }

    // MARK: - PR-7 收尾域动作（profile-edit / watch / 落地页 CTA）

    /// 数据页回读到最新身份（profile 页 onShow / profile-edit 保存后）。
    public func updateIdentity(_ user: MeUser) {
        me = user
    }

    /// 退出登录（profile-edit modal 确认后；`userStore.clear` + reLaunch login
    /// 等价：清 Keychain 由 APIClient 的 token 面统一处理）。
    public func logout() async {
        await api.clearTokens()
        me = nil
        phase = .loggedOut
    }

    /// 注销账号（#759 决议 2：DELETE /api/users/me → 清 Keychain → Login；
    /// auth-service 原子清理 + 四步审计，失败保留会话由页面提示）。
    public func deleteAccount() async throws {
        try await api.deleteAccount()
        await logout()
    }

    /// 绑表成功后跳 onboarding 看同步进度（watch.ts redirectTo onboarding 等价；
    /// onboarding 页 onShow 重算落点并续跑轮询，已完成 onboarding 的用户同样
    /// 看得到进度）。
    public func presentOnboardingAfterWatchBind() {
        phase = .onboarding
    }

    /// 落地页未登录 CTA → 登录流（login?redirect=本页 等价；#692 回跳白名单
    /// 链路）：记录回跳目标并切全屏 Login。
    public func requestLogin(redirect: Route) {
        loginRedirect = redirect
        phase = .loggedOut
    }
}

/// 教练上下文交接（小程序 storage `coach.pendingContext` 的等价物；
/// PR-4 教练域定稿：机器可读 target + 展示标签 + 可选 kickoff 首条消息——
/// 入口按钮已把意图说清时替用户自动发出，教练主动开场确认，兼作会话标题。
/// 训练域 PR-5（devops#768）消费 session kind（date + session_index）交接）。
public struct PendingCoachContext: Hashable, Sendable {
    public var target: CoachTarget
    public var label: String?
    public var kickoff: String?

    public init(target: CoachTarget, label: String? = nil, kickoff: String? = nil) {
        self.target = target
        self.label = label
        self.kickoff = kickoff
    }
}

/// 策略草稿交接（小程序 storage `pendingStrategyDraft` 的等价物；
/// 草稿字段面由赛事域票 PR-6 定稿，骨架期以不透明 JSON 承载）。
public struct PendingStrategyDraft: Hashable, Sendable {
    public var raceId: Int
    public var payload: Data

    public init(raceId: Int, payload: Data) {
        self.raceId = raceId
        self.payload = payload
    }
}
