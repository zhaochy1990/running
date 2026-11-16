import Foundation
import Observation

/// Onboarding 单页三步状态机（PR-2 登录域，devops#752/#418/#461 决议；
/// 镜像小程序 `pages/onboarding/onboarding.ts` 与 Flutter 版控制器）。
///
/// 五视图：loading / profile / watch / sync / ready。落点每次进入页面
/// （视图 task）与前台恢复（scenePhase active）时 `refresh()` 重算，所以
/// 续跑是天然的：App 必然会在 24 分钟的同步中途被杀，每次回来都按
/// profile_ready / watch_ready 重新落到该去的那一步。资料齐但完成标记没
/// 写上（上次 complete 失败）会补一次，自愈；完成只发生在资料步
/// （ADR 0013），绑表与同步是可选动作。
@MainActor
@Observable
public final class OnboardingModel {

    public enum Step: Equatable, Sendable {
        case loading, profile, watch, sync, ready
    }

    // ── 落点 ─────────────────────────────────────────────────────────────
    public private(set) var step: Step = .loading

    // ── 资料步（六字段 + 头像，OPTIONS 展示与 VALUES 提交分离）──────────
    public var displayName: String = ""
    public var dob: String?
    public var sex: ProfileSex?
    public var heightText: String = ""
    public var weightText: String = ""
    public var runningAge: RunningAgeRange?
    /// PhotosPicker 选中的头像原图（保存时上传；nil = 未选）。
    public var avatarData: Data?
    public private(set) var saving = false
    public var formError: String?

    // ── 绑表步 ───────────────────────────────────────────────────────────
    public var watchProvider: WatchProvider?
    public var watchEmail: String = ""
    public var watchPassword: String = ""
    public var watchRegion: WatchRegion = .cn
    public private(set) var connecting = false
    public var watchError: String?

    // ── 同步步（旧 full-run 管线：六步百分比）───────────────────────────
    public private(set) var syncText = "正在准备同步…"
    public private(set) var percent = 0
    public var syncError: String?
    /// 轮询到达 60min 上限但 run 还在跑（不是失败）：让用户先走，下次进来续跑。
    public private(set) var syncPending = false

    // ── 同步步（session 模式，devops#1016：不跑管线、不显示六步百分比）──
    /// 双开关（sync_data_at_onboarding && onboarding_sync_session）都开才为
    /// true；提交步据此走 session 入口，关闭时旧 full-run 流程原样保留。
    public private(set) var sessionMode = false
    /// session 提交相位（Web SessionSubmitStep 的 Phase 等价）；nil = 旧流程。
    public enum SessionPhase: Equatable, Sendable {
        /// POST 创建中。
        case creating
        /// 已建未持久化（waiting_legacy 等）：GET 轮询到 shell_ready 再进。
        case adopting
        /// shell_ready 已确认，正在 profile-only 完成并进首页。
        case entering
        /// 创建失败（后台没有任何任务在跑，不假报运行中）。
        case createFailed
        /// 完成标记写入失败（session 已就绪，只差重走进入）。
        case enterFailed
    }
    public private(set) var sessionPhase: SessionPhase?
    public private(set) var sessionError: String?

    /// 完成引导回调（AppModel：redirect 回跳 / coach 首页）。
    public let onFinish: @MainActor () -> Void

    private let api: APIClient
    private let sync: OnboardingSyncService
    private var pollTask: Task<Void, Never>?
    private var sessionPollTask: Task<Void, Never>?
    private var deadline: Date?
    /// session adopting 轮询间隔（Web SESSION_POLL_MS 同款 5s；测试注短）。
    private let sessionPollInterval: Duration

    /// 轮询 2s（devops#418 端点表）；60min 上限（生产实测均值 24min 最长 51min）。
    private static let pollInterval: Duration = .seconds(2)
    private static let pollTimeout: TimeInterval = 60 * 60

    public init(
        api: APIClient,
        runStore: (any OnboardingRunStore)? = nil,
        sessionPollInterval: Duration = .seconds(5),
        onFinish: @escaping @MainActor () -> Void
    ) {
        self.api = api
        self.sync = OnboardingSyncService(api: api, store: runStore)
        self.sessionPollInterval = sessionPollInterval
        self.onFinish = onFinish
    }

    // MARK: - 落点重算（唯一的落点决策）

    /// 每次进页面 / 前台恢复都按服务端状态重算该停在哪一步。
    public func refresh() async {
        cancelPoll()
        cancelSessionPoll()
        formError = nil
        watchError = nil
        syncError = nil
        syncPending = false
        sessionError = nil
        step = .loading

        let profile: MyProfile
        do {
            profile = try await sync.status()
        } catch {
            step = .profile
            formError = "加载失败，请检查网络后重试"
            return
        }

        if !profile.profileReady {
            if profile.displayName?.isEmpty == false { displayName = profile.displayName ?? "" }
            step = .profile
            return
        }
        // 资料齐但完成标记没写上（上次 complete 失败 / 别端没走完）→ 补一次自愈。
        if !profile.completed {
            try? await sync.markComplete()
        }
        if !profile.watchReady {
            sessionMode = Self.sessionCapable(profile)
            step = .watch
            return
        }
        // 双开关开 → session 提交步（绑表后可靠创建即进首页，进度交全局
        // banner）；关 → 旧 full-run 流程原样（含本地指针三分与认领）。
        if Self.sessionCapable(profile) {
            sessionMode = true
            await startSessionSubmit(userID: profile.id)
        } else {
            sessionMode = false
            sessionPhase = nil
            do {
                try await applySyncOutcome(sync.ensureSync(userID: profile.id))
            } catch {
                step = .sync
                syncError = "同步启动失败，请重试"
            }
        }
    }

    // MARK: - 资料保存（完成只发生在这一步，ADR 0013）

    public func saveProfile() async {
        guard !saving else { return }
        let missing = ProfileFormValidation.missingFields(
            displayName: displayName,
            dob: dob,
            sex: sex,
            heightText: heightText,
            weightText: weightText,
            runningAge: runningAge
        )
        if !missing.isEmpty {
            formError = "还差：\(missing.map(\.rawValue).joined(separator: "、"))"
            return
        }

        saving = true
        formError = nil
        defer { saving = false }

        // 头像可选：上传失败不阻断建档（best-effort，同 markComplete 自愈哲学；
        // 头像是身份装饰，六字段档案才是 canonical 步）。
        if let avatarData {
            if let url = try? await api.uploadAvatar(avatarData) {
                try? await api.updateAvatarURL(url)
            }
        }

        let input = ProfileInput(
            displayName: displayName.trimmingCharacters(in: .whitespaces),
            dob: dob ?? "",
            sex: sex?.rawValue ?? "",
            heightCm: Double(heightText) ?? 0,
            weightKg: Double(weightText) ?? 0,
            runningAgeRange: runningAge?.rawValue ?? ""
        )
        do {
            try await api.postProfile(input)
        } catch let error as ApiError {
            formError = error.statusCode >= 500 ? "服务端异常，请稍后重试" : (error.detail.isEmpty ? "保存失败，请重试" : error.detail)
            return
        } catch {
            formError = "网络异常，请检查网络后重试"
            return
        }
        try? await sync.markComplete()
        await refresh()
    }

    // MARK: - 绑表（可跳过）

    public func bindWatch() async {
        guard !connecting else { return }
        guard let provider = watchProvider else {
            watchError = "请先选择手表品牌"
            return
        }
        let email = watchEmail.trimmingCharacters(in: .whitespaces)
        guard !email.isEmpty, !watchPassword.isEmpty else {
            watchError = "请填写账号与密码"
            return
        }

        connecting = true
        watchError = nil
        defer { connecting = false }

        do {
            try await api.watchLogin(provider: provider.rawValue, email: email, password: watchPassword, region: watchRegion.rawValue)
        } catch let error as ApiError {
            watchError = Self.watchErrorMessage(error, provider: provider)
            return
        } catch {
            watchError = "网络异常，请检查网络后重试"
            return
        }
        watchPassword = ""

        do {
            let userID = try await currentUserID()
            if sessionMode {
                // session 模式：绑表即创建/认领 session（不触发旧 full-run），
                // shell_ready 后 profile-only 完成进首页。
                await startSessionSubmit(userID: userID)
            } else {
                try await applySyncOutcome(sync.ensureSync(userID: userID))
            }
        } catch {
            step = .sync
            if sessionMode {
                // 错误必须落在 session 视图可见的字段上（创建失败不假报运行中）
                sessionPhase = .createFailed
                sessionError = "网络异常，请检查网络后重试。"
            } else {
                syncError = "同步启动失败，请重试"
            }
        }
    }

    /// 「稍后再说，先逛逛」：直接进首页（完成态已由资料步保证）。
    public func skipToHome() {
        onFinish()
    }

    // MARK: - 同步（session 提交，devops#1016）

    /// 双开关判定：总同步开关 + session rollout 开关同时开（任一缺失按关，
    /// 与 Web OnboardingWizard 同口径；能力跟随服务端开关，客户端不自作主张）。
    private static func sessionCapable(_ profile: MyProfile) -> Bool {
        profile.syncEnabled && (profile.features?.onboardingSyncSession ?? false)
    }

    /// session 提交步入口：POST 原子创建/认领（幂等，多端并发同一个
    /// session）；shell_ready（session 与派发意图均已持久化）确认前**不**
    /// 宣称后台在同步；确认后 profile-only 完成进首页，进度交全局 banner。
    private func startSessionSubmit(userID: String) async {
        step = .sync
        cancelSessionPoll()
        sessionPhase = .creating
        sessionError = nil
        do {
            let view = try await api.createOnboardingSyncSession(retry: false)
            if view.shellReady {
                await enterAppFromSession()
            } else {
                // waiting_legacy 等：服务端正在接管已有任务，不是失败——
                // 轮只读 GET 到可靠持久化再进。
                waitForShellReady()
            }
        } catch let error as ApiError {
            if error.statusCode == 403 {
                // 开关在落位与提交之间被关掉：入口已不存在，回退旧 full-run。
                sessionMode = false
                sessionPhase = nil
                do {
                    try await applySyncOutcome(sync.ensureSync(userID: userID))
                } catch {
                    step = .sync
                    syncError = "同步启动失败，请重试"
                }
                return
            }
            sessionPhase = .createFailed
            sessionError = error.code == "no_watch_provider"
                ? "尚未绑定手表，请返回上一步完成绑定。"
                : "同步任务创建失败，请重试。"
        } catch {
            sessionPhase = .createFailed
            sessionError = "网络错误，同步任务创建失败，请重试。"
        }
    }

    /// 创建失败后的「重试创建」（视图按钮）：重走同一提交链。
    public func retrySessionCreate() async {
        guard sessionMode, sessionPhase == .createFailed else { return }
        let userID = (try? await currentUserID()) ?? ""
        await startSessionSubmit(userID: userID)
    }

    /// 只读 GET 轮到 shell_ready（网络抖动继续等；离开页面/前台恢复由
    /// refresh 重算接管）。
    private func waitForShellReady() {
        sessionPhase = .adopting
        sessionPollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if await self.sessionAdoptTick() == false { return }
                try? await Task.sleep(for: self.sessionPollInterval)
            }
        }
    }

    private func sessionAdoptTick() async -> Bool {
        do {
            let view = try await api.onboardingSyncSession()
            if view.shellReady {
                await enterAppFromSession()
                return false
            }
            return true
        } catch {
            // 网络抖动：保留 adopting 状态继续轮询。
            return true
        }
    }

    /// shell_ready 后的进入：profile-only 完成（空 body，绝不带 run_id——
    /// session 的 recent run 不喂给旧 finalizer）→ 进首页。
    private func enterAppFromSession() async {
        sessionPhase = .entering
        sessionError = nil
        do {
            try await sync.markComplete()
            onFinish()
        } catch {
            sessionPhase = .enterFailed
            sessionError = "无法完成初始化，请检查网络后重试。"
        }
    }

    /// 进入失败的「重试进入」（视图按钮）：只重走完成+进首页，不重建 session。
    public func retryEnterApp() async {
        guard sessionMode, sessionPhase == .enterFailed else { return }
        await enterAppFromSession()
    }

    private func cancelSessionPoll() {
        sessionPollTask?.cancel()
        sessionPollTask = nil
    }

    // MARK: - 同步（旧 full-run 管线）

    public func retrySync() async {
        guard let userID = try? await currentUserID() else { return }
        syncError = nil
        syncPending = false
        do {
            try await applySyncOutcome(sync.retrySync(userID: userID))
        } catch {
            syncError = "重试失败，请稍后再试"
        }
    }

    private func applySyncOutcome(_ outcome: SyncOutcome) async throws {
        switch outcome.phase {
        case .disabled, .done:
            step = .ready
        case .noWatch:
            step = .watch
        case .running:
            if let runID = outcome.runID {
                startPolling(runID)
            } else {
                step = .sync
                syncError = "同步启动失败，请重试"
            }
        case .failed:
            step = .sync
            syncError = outcome.message ?? "同步失败"
        }
    }

    private func startPolling(_ runID: String) {
        cancelPoll()
        step = .sync
        percent = 0
        syncText = "正在准备同步…"
        syncError = nil
        syncPending = false
        deadline = Date().addingTimeInterval(Self.pollTimeout)
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let keepGoing = await self.pollTick(runID)
                if !keepGoing { return }
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
    }

    /// 单次轮询；返回是否继续。
    private func pollTick(_ runID: String) async -> Bool {
        if let deadline, Date() >= deadline {
            // 60 分钟上限不是失败：pipeline 还在跑，让用户先走，
            // 下次进页面靠本地指针接着续跑。
            syncPending = true
            syncText = "还在同步中"
            return false
        }
        let run: PipelineRun
        do {
            run = try await api.pipelineRun(runID)
        } catch let error as ApiError {
            syncError = error.detail.isEmpty ? "同步失败" : error.detail
            return false
        } catch {
            // 网络抖动：保留轮询
            return true
        }
        if run.isDone {
            percent = 100
            step = .ready
            return false
        }
        if run.isFailed {
            syncError = run.errorMessage ?? "同步失败"
            return false
        }
        let progress = RunProgress(run: run)
        syncText = "第 \(progress.stepIndex)/\(progress.stepTotal) 步 · \(progress.label)"
        percent = progress.percent
        return true
    }

    private func cancelPoll() {
        pollTask?.cancel()
        pollTask = nil
        deadline = nil
    }

    /// 当前 userId（状态源已在 refresh 拿过；这里兜底再取一次）。
    private func currentUserID() async throws -> String {
        try await api.myProfile().id
    }

    /// 绑表错误文案（后端把认证/网络错误折叠成 400 防枚举；区域错误提示切换）。
    private static func watchErrorMessage(_ error: ApiError, provider: WatchProvider) -> String {
        let raw = error.detail.isEmpty ? "绑定失败，请重试" : error.detail
        guard error.statusCode == 400 || error.statusCode == 401 else { return raw }
        let lower = raw.lowercased()
        if lower.contains("region") || raw.contains("区域") || raw.contains("地区") {
            return "请切换区域后重试"
        }
        let brand = provider == .garmin ? "Garmin" : "COROS"
        return "邮箱或密码错误，请核对 \(brand) 账号"
    }
}
