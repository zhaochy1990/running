import Foundation
import Observation

/// 全局首次同步 session 状态（devops#1016 / epic #1004 T12；Web
/// OnboardingSyncStatusProvider 的 SwiftUI 等价）。
///
/// 一个只读 GET 轮询器，被首页所有页面共享：**绝不创建 session**（创建只
/// 发生一次，在 onboarding 提交步）**且绝不写任何东西**——worker 在服务端，
/// 退出 App / 切后台 / 换设备回来看到的是同一个 session，本模型只观察。
///
/// 停轮三态：终态（链不再自行推进）、404（尚无 session——session 前的老
/// 用户，banner 永不出现）、403（双开关关闭——原禁用语义）。瞬态错误保留
/// 上一视图继续轮询（后台失败不清已展示的近期数据或完成标记）。
@MainActor
@Observable
public final class OnboardingSyncStatusModel {

    /// 当前只读视图（nil = 无 session / 未配置 / 已重置）。
    public private(set) var view: OnboardingSyncSessionView?
    public private(set) var retrying = false
    public private(set) var retryError: String?
    /// 用户点「忽略」（failed / completed_with_gaps 的 banner 可关掉）。
    public internal(set) var dismissed = false

    /// banner 可见性（与 Web shouldHideBanner 同口径）：无视图/已忽略/
    /// completed / superseded 隐藏；failed 与 completed_with_gaps 保留。
    public var shouldShowBanner: Bool {
        guard let view, !dismissed else { return false }
        return view.state != "superseded" && (view.state != "completed" || view.readiness.historicalAnalysis != .notStarted
            || view.stages.contains { $0.gaps?.contains { ($0.healthHistoryDays ?? 0) > 0 } == true })
    }

    private var api: APIClient?
    private var pollTask: Task<Void, Never>?
    /// 轮询代数：区分「循环自然退出」与「stopPolling 取消」，避免旧任务
    /// 迟到的收尾清掉新任务的引用（重试恢复轮询的关键）。
    private var pollGeneration = 0
    private let pollInterval: Duration

    /// - Parameter pollInterval: GET 轮询间隔（Web 同款默认 5s；测试注短）。
    public init(pollInterval: Duration = .seconds(5)) {
        self.pollInterval = pollInterval
    }

    /// 绑定 API 客户端（AppModel 装配；未配置时 startPolling 为 no-op）。
    public func configure(api: APIClient) {
        self.api = api
    }

    /// 开始（或恢复）只读轮询。幂等：已在轮询则不重入。
    public func startPolling() {
        guard api != nil, pollTask == nil else { return }
        pollGeneration += 1
        let generation = pollGeneration
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let keepGoing = await self.pollTick()
                if !keepGoing { break }
                try? await Task.sleep(for: self.pollInterval)
            }
            // 自然退出（终态/404/403）：释放引用，让 retry 能重启轮询。
            self?.pollLoopEnded(generation: generation)
        }
    }

    /// 停轮（保留最后视图；登出/换号用 reset）。
    public func stopPolling() {
        pollGeneration += 1
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollLoopEnded(generation: Int) {
        guard generation == pollGeneration else { return }
        pollTask = nil
    }

    /// 清空全部状态（登出 / 会话失效 / 换账号）：停轮 + 视图/忽略/错误归零，
    /// 避免把上一个账号的同步进度展示给下一个账号。
    public func reset() {
        stopPolling()
        view = nil
        dismissed = false
        retryError = nil
        retrying = false
    }

    /// 显式重试入口（banner 的「重试失败项」）：POST {retry:true} 只恢复
    /// 未完成的工作，成功抓取过的范围服务端不重拉；非终态即恢复轮询。
    public func retry() async {
        guard !retrying, let api else { return }
        retrying = true
        retryError = nil
        defer { retrying = false }
        do {
            let next = try await api.createOnboardingSyncSession(retry: true)
            view = next
            dismissed = false
            if OnboardingSessionDisplay.shouldPoll(next) {
                startPolling()
            }
        } catch {
            retryError = "重试失败，请稍后再试"
        }
    }

    public func dismiss() {
        dismissed = true
    }

    /// 单次轮询；返回是否继续。
    private func pollTick() async -> Bool {
        guard let api else { return false }
        do {
            let next = try await api.onboardingSyncSession()
            view = next
            return OnboardingSessionDisplay.shouldPoll(next)
        } catch let error as ApiError {
            // 404 = 尚无 session（session 前老用户）；403 = 双开关关闭（入口
            // 不存在）。两者静默停轮，banner 永不出现，旧语义原样保留。
            if error.statusCode == 404 || error.statusCode == 403 {
                view = nil
                return false
            }
            // 401 由 APIClient 刷新链处理；其余（5xx/网络抖动）保留上一视图。
            return true
        } catch {
            return true
        }
    }
}
