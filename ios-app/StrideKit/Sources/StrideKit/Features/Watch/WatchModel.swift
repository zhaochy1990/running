import Foundation
import Observation

// 手表管理 ViewModel（PR-7 收尾域 devops#770，#425 决议直译 + baseline §8.1）：
// 双品牌（COROS/Garmin）绑定/解绑/绑定态展示全复刻；region 选择器仅
// Garmin 分支显示（cn 默认；COROS 后端 token 自动探测，不让用户选）；
// Garmin 表单加 MFA 提示；绑定成功 → toast + 回读 + fire-and-forget
// ensureSync + 跳 onboarding 看进度；解绑内联确认卡（数据保留提示）；
// ?provider=coros|garmin 直达品牌表单。

@MainActor
@Observable
public final class WatchModel {

    public enum Screen: Equatable, Sendable {
        case loading
        case loaded
        case error
    }

    public private(set) var screen: Screen = .loading
    public private(set) var info = WatchInfo(provider: nil, providerDisplayName: nil,
                                              loggedIn: false, email: nil, device: nil,
                                              lastSyncAt: nil, capabilities: [])

    public var connected: Bool { info.loggedIn && info.provider != nil }
    public var providerDisplayName: String { info.providerDisplayName ?? info.provider ?? "" }
    public var lastSyncText: String {
        info.lastSyncAt.map { "上次同步 \(relativeSyncAge($0))" } ?? "未同步"
    }

    // ── 登录表单 ───────────────────────────────────────────────────────
    public internal(set) var connectProvider: WatchProvider?
    public var email = ""
    public var password = ""
    public var region: WatchRegion = .cn
    public private(set) var connecting = false
    public private(set) var disconnecting = false
    /// 解绑内联确认卡（非模态，#425 决议「内联确认卡片」）。
    public var showDisconnectConfirm = false

    public internal(set) var errorMessage = ""
    public internal(set) var successMessage = ""
    public internal(set) var toastMessage: String?

    /// Garmin 占位「邮箱」/ COROS「邮箱或手机号」（#425 实施清单）。
    public var emailPlaceholder: String {
        connectProvider == .garmin ? "邮箱" : "邮箱或手机号"
    }

    public var isGarmin: Bool { connectProvider == .garmin }

    public var canConnect: Bool {
        !connecting && connectProvider != nil
            && !email.trimmingCharacters(in: .whitespaces).isEmpty
            && !password.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var app: AppModel?
    private var started = false

    public init(provider: WatchProvider?) {
        connectProvider = provider
    }

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await fetchWatch()
    }

    public func fetchWatch() async {
        guard let app else { return }
        screen = .loading
        do {
            info = try await app.api.watchInfo()
            screen = .loaded
        } catch {
            screen = .error
        }
    }

    public func selectProvider(_ provider: WatchProvider) {
        connectProvider = provider
        errorMessage = ""
    }

    public func backToProviders() {
        connectProvider = nil
        errorMessage = ""
    }

    // MARK: - 绑定

    /// 绑定成功 → 清表单 + toast + 回读 + ensureSync(fire-and-forget) +
    /// 跳 onboarding（进度交给 onboarding 页续跑；不等待 ensureSync 结果，
    /// 不值得为它加一次往返延迟——watch.ts 同款）。
    public func connect() async {
        guard canConnect, let app, let provider = connectProvider else { return }
        connecting = true
        errorMessage = ""
        defer { connecting = false }
        do {
            try await app.api.watchLogin(provider: provider.rawValue,
                                          email: email.trimmingCharacters(in: .whitespaces),
                                          password: password,
                                          region: region.rawValue)
            email = ""
            password = ""
            connectProvider = nil
            toastMessage = "绑定成功"
            await fetchWatch()
            if let userId = app.me?.id {
                let sync = OnboardingSyncService(api: app.api)
                Task.detached {
                    // fire-and-forget：同步页会重试（catch 只吞不扰）。
                    _ = try? await sync.ensureSync(userID: userId)
                }
            }
            app.presentOnboardingAfterWatchBind()
        } catch {
            // Go watch/login 失败用 `error` 字段返回可读文案，优先展示避免裸 status。
            let apiError = error as? ApiError
            if let code = apiError?.code, !code.isEmpty {
                errorMessage = code
            } else if !(apiError?.detail.isEmpty ?? true) {
                errorMessage = apiError!.detail
            } else {
                errorMessage = "登录失败，请检查账号密码"
            }
        }
    }

    // MARK: - 解绑

    public func confirmDisconnect() async {
        guard let app, !disconnecting else { return }
        disconnecting = true
        defer { disconnecting = false }
        do {
            try await app.api.disconnectWatch()
            showDisconnectConfirm = false
            toastMessage = "已解除绑定"
            await fetchWatch()
        } catch {
            errorMessage = "解除绑定失败，请重试"
        }
    }
}
