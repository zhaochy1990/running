import Foundation
import Observation

// 「我」tab ViewModel（PR-7 收尾域 devops#770，baseline §2.4 直译）：
// 用户卡 / 手动同步行（POST sync incremental + 2s 轮询 + 页面卸载取消）/
// 菜单五行（含反馈未读红点）。onShow（进页 + tab 切回 + 回前台）刷新红点
// 与上次同步时间，失败静默保留现值。

/// 同步轮询间隔/超时（profile.ts / sync.ts 同口径：2s / 60min）。
private let pipelinePollInterval: Duration = .seconds(2)
private let pipelineTimeout: Duration = .seconds(60 * 60)

/// 「上次同步 Xm ago」相对时间（profile.ts relativeTime 同口径）。
public func relativeSyncAge(_ iso: String?, now: Date = Date()) -> String {
    guard let iso, let date = RFC3339.parse(iso) else { return "未同步" }
    let ms = max(0, now.timeIntervalSince(date) * 1000)
    let minutes = Int(ms / 60000)
    if minutes < 1 { return "刚刚" }
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h ago" }
    return "\(hours / 24)d ago"
}

@MainActor
@Observable
public final class ProfileHomeModel {

    /// 菜单行（导航目标 + 图标；副标题仅意见反馈行）。
    public struct MenuRow: Equatable, Identifiable, Sendable {
        public let id: String
        public let title: String
        public let systemImage: String
        public let subtitle: String?
        public let route: Route

        public init(id: String, title: String, systemImage: String, subtitle: String? = nil, route: Route) {
            self.id = id
            self.title = title
            self.systemImage = systemImage
            self.subtitle = subtitle
            self.route = route
        }
    }

    public static let menuRows: [MenuRow] = [
        MenuRow(id: "plan", title: "我的训练计划", systemImage: "calendar", route: .trainingPlan),
        MenuRow(id: "training-status", title: "训练状态", systemImage: "chart.line.uptrend.xyaxis", route: .trainingStatus),
        MenuRow(id: "race-center", title: "赛事中心", systemImage: "flag.2.crossed", route: .raceCenter),
        MenuRow(id: "my-races", title: "我的比赛", systemImage: "flag", route: .myRaces),
        // 2026-10-18 拍板：产品路线并入反馈页二级 tab；菜单只留一行，副标题带出路线。
        MenuRow(id: "feedback", title: "意见反馈", systemImage: "bubble.left.and.bubble.right",
                subtitle: "产品路线也在这里 · 每条我们都会看", route: .feedback(initialTab: nil)),
    ]

    /// 积分商城域入口两行（devops#938 拍板 1 方案 A，镜像 mp profile 菜单
    /// 前两行；右侧文案由 check-ins/status 一次请求喂饱）。
    public static let checkinMenuRow = MenuRow(id: "checkin", title: "每日签到", systemImage: "checkmark.seal", route: .checkin(gained: nil))
    public static let mallMenuRow = MenuRow(id: "points-mall", title: "积分商城", systemImage: "bag", route: .pointsMall)

    /// 每日签到行右侧文案（可签「今日 +N 分」粉 / 已签「已签」灰）。
    public internal(set) var checkinRight = ""
    public internal(set) var checkinSigned = false
    /// 积分商城行右侧文案（「N 分」余额，粉）。
    public internal(set) var mallRight = ""
    /// 一步签到进行中（行禁点防双击）。
    public private(set) var checkinBusy = false

    public private(set) var name: String
    public private(set) var email: String
    public private(set) var avatarURL: String?
    public private(set) var tag: String

    /// 意见反馈入口红点（total_unread，99+ 截断），0 隐藏；失败静默保留现值。
    public private(set) var feedbackUnread = 0
    public var feedbackUnreadBadge: String {
        guard feedbackUnread > 0 else { return "" }
        return feedbackUnread > 99 ? "99+" : "\(feedbackUnread)"
    }

    public private(set) var syncing = false
    public private(set) var lastSyncText = "未同步"

    /// toast 出口（同步成功/失败；>15 字截断语义在调用侧统一）。
    public internal(set) var toastMessage: String?

    private var app: AppModel?
    private var pollTask: Task<PipelineRun, Error>?
    private var started = false

    public init() {
        name = "跑步爱好者"
        email = ""
        tag = ""
    }

    // MARK: - 生命周期（onShow 三场景合一）

    /// tab 首次可见装配（waitForAuth 等价）；重复调用幂等。
    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await refresh()
    }

    /// onShow 等价：刷新身份（onboarding/profile-edit 回来可能改名）+ 红点 + 上次同步
    /// + 签到/商城两行右侧文案（devops#938）。
    public func refresh() async {
        guard let app else { return }
        if let me = app.me {
            applyIdentity(me)
        }
        await refreshLastSync()
        await refreshFeedbackUnread()
        await refreshCheckinRight()
    }

    private func applyIdentity(_ me: MeUser) {
        name = me.displayTitle ?? "跑步爱好者"
        email = me.email ?? ""
        avatarURL = me.avatarURL
        tag = "STRIDE 会员"
    }

    // MARK: - 红点 / 上次同步

    public func refreshFeedbackUnread() async {
        guard let app else { return }
        guard let _ = app.me?.id else { return }
        do {
            let res = try await app.api.listFeedbacks()
            feedbackUnread = res.totalUnread
        } catch {
            // 保留现值；临时网络错误不弹窗
        }
    }

    public func refreshLastSync() async {
        guard let app, app.me != nil else {
            lastSyncText = "未同步"
            return
        }
        do {
            let info = try await app.api.watchInfo()
            lastSyncText = info.lastSyncAt.map { "上次同步 \(relativeSyncAge($0))" } ?? "未同步"
        } catch {
            // 保留上次值；临时网络错误不打断页面
        }
    }

    // MARK: 积分商城域入口（devops#938）

    /// 每日签到/积分商城两行右侧文案：一次 check-ins/status 同响应喂饱
    /// （今日 +N 分 / 已签；N 分余额）；失败静默保留现值。
    public func refreshCheckinRight() async {
        guard let app, app.me?.id != nil else { return }
        do {
            let st = try await app.api.checkInStatus()
            checkinRight = st.today.canCheckIn ? "今日 +\(st.today.rewardPreview) 分" : "已签"
            checkinSigned = !st.today.canCheckIn
            mallRight = "\(st.balance) 分"
        } catch {
            // 保留现值；临时网络错误不弹窗
        }
    }

    /// 一步签到（#851 改判，mp checkinTap 直译）：点行即 POST（按日幂等），
    /// 成功带 gained 进签到页以刚签到态呈现；POST 失败仍进页（可签态），
    /// 页内 CTA 兜底重试。
    public func checkinTap() async {
        guard !checkinBusy else { return }
        checkinBusy = true
        defer { checkinBusy = false }
        guard let app else { return }
        var gained: Int?
        if let res = try? await app.api.createCheckIn() {
            gained = res.pointsEarned
        }
        app.router.push(.checkin(gained: gained))
    }

    // MARK: - 手动同步（POST incremental + 轮询 + 卸载取消）

    public func startManualSync() async {
        guard !syncing else { return }
        guard let app, let userId = app.me?.id else {
            toastMessage = "请先登录"
            return
        }
        syncing = true
        do {
            let result = try await app.api.triggerIncrementalSync(user: userId)
            guard !result.runId.isEmpty else {
                throw ApiError(statusCode: 0, code: nil, detail: "同步任务创建失败")
            }
            let run = try await pollRun(result.runId)
            await refreshLastSync()
            toastMessage = run.status == "done" ? "同步成功" : "同步失败"
        } catch is CancellationError {
            // 页面卸载取消：不弹 toast（profile.ts cancelled 分支）
            syncing = false
            return
        } catch {
            let message = (error as? ApiError)?.detail ?? "同步失败"
            toastMessage = message.count > 15 ? "同步失败" : message
        }
        syncing = false
    }

    /// 页面卸载取消轮询（profile.ts onUnload → pollHandle.cancel()）。
    public func cancelSync() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollRun(_ runId: String) async throws -> PipelineRun {
        let task = Task { [weak self] () throws -> PipelineRun in
            var waited: Duration = .zero
            while true {
                guard let self, let app = self.app else {
                    throw CancellationError()
                }
                let run = try await app.api.pipelineRun(runId)
                if run.isDone || run.isFailed { return run }
                try Task.checkCancellation()
                try await Task.sleep(for: pipelinePollInterval)
                waited += pipelinePollInterval
                if waited >= pipelineTimeout {
                    throw ApiError(statusCode: 0, code: nil, detail: "同步超时")
                }
            }
        }
        pollTask = task
        defer { pollTask = nil }
        return try await task.value
    }
}
