import Foundation

// MARK: - onboarding 同步三件套（devops#418 决议 2 / #461）

/// 同步 run 的本地指针 + 幂等键存取。键名与 Web / 小程序同名
/// （shared_preferences 等价 UserDefaults），两端对照排查能对上；
/// 带 userId 是因为可以换账号。
public protocol OnboardingRunStore: Sendable {
    func runPointer(userID: String) async -> String?
    func saveRunPointer(userID: String, runID: String) async
    func clearRunPointer(userID: String) async
    func startKey(userID: String) async -> String?
    func saveStartKey(userID: String, _ key: String) async
    func clearStartKey(userID: String) async
}

/// UserDefaults 实现（`stride:onboarding-run:{uid}` / `stride:onboarding-start-key:{uid}`）。
public struct UserDefaultsOnboardingRunStore: OnboardingRunStore {

    /// UserDefaults 线程安全但未标 Sendable（SDK 缺标注），此处豁免。
    nonisolated(unsafe) private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func runPointer(userID: String) async -> String? {
        string("stride:onboarding-run:\(userID)")
    }

    public func saveRunPointer(userID: String, runID: String) async {
        defaults.set(runID, forKey: "stride:onboarding-run:\(userID)")
    }

    public func clearRunPointer(userID: String) async {
        defaults.removeObject(forKey: "stride:onboarding-run:\(userID)")
    }

    public func startKey(userID: String) async -> String? {
        string("stride:onboarding-start-key:\(userID)")
    }

    public func saveStartKey(userID: String, _ key: String) async {
        defaults.set(key, forKey: "stride:onboarding-start-key:\(userID)")
    }

    public func clearStartKey(userID: String) async {
        defaults.removeObject(forKey: "stride:onboarding-start-key:\(userID)")
    }

    private func string(_ key: String) -> String? {
        let value = defaults.string(forKey: key)
        return (value?.isEmpty == false) ? value : nil
    }
}

/// ensureSync 的结果落点。
public enum SyncPhase: Equatable, Sendable {
    /// 部署开关关闭（只关同步，不影响完成）。
    case disabled
    /// 未绑表（回绑表步）。
    case noWatch
    /// run 在跑（含 60min 超时 pending 前的常态）。
    case running
    case done
    case failed
}

public struct SyncOutcome: Equatable, Sendable {
    public let phase: SyncPhase
    public let runID: String?
    public let message: String?

    public init(phase: SyncPhase, runID: String? = nil, message: String? = nil) {
        self.phase = phase
        self.runID = runID
        self.message = message
    }
}

/// onboarding 同步服务——镜像小程序 `services/onboarding.ts` 状态机：
///
/// 1. 完成（complete）：只要求基础档案（ADR 0013），资料保存成功即可标记。
/// 2. 数据同步（sync）：绑表之后触发的 full sync，**不是**完成的前置。
///
/// `ensureSync` 五段链：部署开关 → 有表 → 本地指针三分（valid 复用 /
/// transient 保留指针按原 runId 轮询 / invalid 清除）→ 认领别端 run →
/// 触发（幂等键**先落盘再发请求**，超时/丢响应时下次进来复用同一把 key，
/// 服务端 uq 去重返回已建 run 而不是再建一个）。
public struct OnboardingSyncService: Sendable {

    /// onboarding pipeline 的名字（Go catalog.PipelineOnboarding）。
    public static let onboardingPipelineName = "onboarding"

    private let api: APIClient
    private let store: any OnboardingRunStore

    public init(api: APIClient, store: (any OnboardingRunStore)? = nil) {
        self.api = api
        self.store = store ?? UserDefaultsOnboardingRunStore()
    }

    /// 读 onboarding 状态（复用 GET /api/users/me/profile）。
    public func status() async throws -> MyProfile {
        try await api.myProfile()
    }

    /// 标记完成（资料已保存时调用；服务端幂等，失败由页面重进自愈）。
    public func markComplete() async throws {
        try await api.completeOnboarding()
    }

    /// 幂等入口：确保该用户有一个正在跑的同步 run，返回当前该走的状态。
    public func ensureSync(userID: String) async throws -> SyncOutcome {
        let profile = try await status()
        if !profile.syncEnabled {
            return SyncOutcome(phase: .disabled)
        }
        if !profile.watchReady {
            return SyncOutcome(phase: .noWatch)
        }

        // 1) 本地指针三分
        if let stored = await store.runPointer(userID: userID) {
            let lookup = await lookupRun(stored)
            if lookup.verdict == .valid, let run = lookup.run {
                return Self.outcome(from: run)
            }
            if lookup.verdict == .transient {
                // 查不动（服务端抖了）：保留指针，让页面继续按这个 runId 轮询
                return SyncOutcome(phase: .running, runID: stored)
            }
            await store.clearRunPointer(userID: userID)
        }

        // 2) 认领别端已起的 run（换设备 / 小程序、Web 先起过）。
        //    只认非 failed 的：failed 需要用户主动重试；done 的正好认领展示结果。
        if let existing = try? await api.userPipelines(userID).first(where: { $0.pipelineName == Self.onboardingPipelineName && !$0.isFailed }) {
            await store.saveRunPointer(userID: userID, runID: existing.runId)
            return Self.outcome(from: existing)
        }

        // 3) 触发：幂等键先落盘再发请求（理由见类注释）
        let key = await startKey(userID: userID)
        let result = try await api.triggerSync(user: userID, idempotencyKey: key)
        await store.saveRunPointer(userID: userID, runID: result.runId)
        // run 已建出来，key 使命结束（只防「重复创建」）；清掉它，失败后
        // 重试才算一次新尝试、才会起新 run。
        await store.clearStartKey(userID: userID)
        return SyncOutcome(phase: .running, runID: result.runId)
    }

    /// 失败后重试：清指针与旧 key，确保起一个**新** run（否则幂等键会把
    /// 失败的 run 带回来）。
    public func retrySync(userID: String) async throws -> SyncOutcome {
        await store.clearRunPointer(userID: userID)
        await store.clearStartKey(userID: userID)
        return try await ensureSync(userID: userID)
    }

    // MARK: - 私有

    private enum Verdict { case valid, invalid, transient }
    private struct Lookup {
        let verdict: Verdict
        let run: PipelineRun?
    }

    private func lookupRun(_ runId: String) async -> Lookup {
        do {
            let run = try await api.pipelineRun(runId)
            if run.pipelineName != Self.onboardingPipelineName {
                return Lookup(verdict: .invalid, run: nil)
            }
            return Lookup(verdict: .valid, run: run)
        } catch let error as ApiError {
            // 4xx = 服务端明确不认这个 run（不存在 / 不属于我）→ 指针作废重开；
            // 5xx 与网络异常是暂时性的 → 保留指针，免得白扔一个已跑了很久的 full sync。
            if (400..<500).contains(error.statusCode) {
                return Lookup(verdict: .invalid, run: nil)
            }
            return Lookup(verdict: .transient, run: nil)
        } catch {
            return Lookup(verdict: .transient, run: nil)
        }
    }

    private func startKey(userID: String) async -> String {
        if let existing = await store.startKey(userID: userID) {
            return existing
        }
        let key = "app-onboarding-\(userID)-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString)"
        await store.saveStartKey(userID: userID, key)
        return key
    }

    private static func outcome(from run: PipelineRun) -> SyncOutcome {
        if run.isFailed {
            return SyncOutcome(phase: .failed, runID: run.runId, message: run.errorMessage ?? "同步失败")
        }
        if run.isDone {
            return SyncOutcome(phase: .done, runID: run.runId)
        }
        return SyncOutcome(phase: .running, runID: run.runId)
    }
}
