import Foundation
import Observation

/// App 全局模型（devops#751 / devops#749 §4.2）：会话 + pending 跨 tab 交接
/// + 选中 tab（经 `router`）。小程序 storage 中转 hack（switchTab 不能带
/// query）在单进程 SwiftUI 下升级为 @Observable 属性，一次性消费语义保留。
@MainActor
@Observable
public final class AppModel {

    /// 启动认证状态机（app.ts checkAuth 骨架；onboarding 拦截归 PR-2 登录域）。
    public enum AuthPhase: Equatable, Sendable {
        case checking
        case loggedIn
        case loggedOut
    }

    public private(set) var phase: AuthPhase = .checking

    public let router = AppRouter()
    public let theme = ThemeManager()

    /// 登录成功后的回跳目标（401 / 冷开未登录时带 redirect，修丢上下文）。
    public internal(set) var loginRedirect: Route?

    /// 401 回登录页时预填的手机号（沿 #460 lastSmsPhone；真实登录表单归 PR-2）。
    public var prefilledPhone: String?

    // ── 跨 tab 交接（storage 中转的等价物，单次消费语义）────────────────
    public internal(set) var pendingCoachContext: PendingCoachContext?
    public internal(set) var pendingStrategyDraft: PendingStrategyDraft?

    private let api: APIClient
    private let tokens: any TokenStore

    public init(api: APIClient? = nil, tokens: (any TokenStore)? = nil) {
        let tokenStore = tokens ?? KeychainTokenStore()
        self.tokens = tokenStore
        self.api = api ?? APIClient(tokens: tokenStore)
        // 初始化完成后装配 401 会话失效回调（切全屏 Login + redirect）。
        // 全链 weak：回调由 api 持有，而 api 由 self 持有，强捕会成环。
        Task { [weak self] in
            guard let self else { return }
            await self.api.setSessionExpiredHandler { [weak self] in
                self?.handleSessionExpired()
            }
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
            _ = try await api.validateSession()
            phase = .loggedIn
            if let entry { router.reset(to: entry) }
        } catch let error as ApiError {
            if error.statusCode == 401 {
                loggedOut(withEntry: entry)
            } else {
                // 网络类失败：保留会话，交给数据页处理
                phase = .loggedIn
                if let entry { router.reset(to: entry) }
            }
        } catch {
            phase = .loggedIn
            if let entry { router.reset(to: entry) }
        }
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
        if let entry, !entry.isPublicLanding {
            loginRedirect = entry
        }
        phase = .loggedOut
    }

    /// APIClient 401 刷新链失败回调：切全屏 Login + 当前页作 redirect
    /// （对应 request.ts handleSessionExpired → redirectToLogin；微信免密
    /// 恢复整段不迁，devops#751 决议 2）。token 已由 APIClient 清空。
    private func handleSessionExpired() {
        let current = router.paths[router.selectedTab]?.last ?? router.selectedTab.root
        loginRedirect = current
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
}

/// 教练上下文交接（小程序 storage `coach.pendingContext`
/// {target: session|race, kickoff?} 的等价物；字段面 PR-4 教练域展开）。
public struct PendingCoachContext: Hashable, Sendable {
    public enum Target: String, Hashable, Sendable {
        case session
        case race
    }

    public var target: Target
    public var kickoffMessage: String?

    public init(target: Target, kickoffMessage: String? = nil) {
        self.target = target
        self.kickoffMessage = kickoffMessage
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
