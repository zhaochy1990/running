import Foundation
import Observation

// MARK: - 每日签到页 ViewModel（devops#938，mp pages/checkin/checkin.ts 直译；
// UI 权威 = #851 原型变体 A；数据整页单读 GET check-ins/status）
//
// 一步签到（#851 改判）：profile 行 POST 后带 gained 进页（Route 关联值承接），
// 页内 CTA 兜底重试；签到成功 → 浮动 +N → 静默刷新整页。d7_completed 驱动一次
// 彩蛋 pulse。游客遮罩不实现（根视图强登录，LEDGER 偏差 D-pts-1）。

@MainActor
@Observable
public final class CheckinModel {

    /// 断签（新一轮）hero 副文案两态。
    private static let heroSubDefault = "连续签到可以攒到更多积分哦～"
    private static let heroSubNewRound = "今天签到即开启新一轮，连签 7 天可得 11 分"

    public private(set) var loading = true
    public private(set) var loadFailed = false

    // hero / 日程卡
    public private(set) var streak = 0
    public private(set) var heroSub = CheckinModel.heroSubDefault
    public private(set) var canCheck = false
    public private(set) var checking = false
    public private(set) var ctaText = ""
    /// 断签重置横幅（米色，仅 streak=0 的今天）。
    public private(set) var showResetBanner = false
    /// D7 已签彩蛋横幅（粉，常驻）。
    public private(set) var showWinBanner = false
    /// 达成时刻的整排 pulse（2.2s 后摘除）。
    public private(set) var winPulse = false

    // 我的积分卡
    public private(set) var balance = 0
    public private(set) var cycleEarned = 0
    /// 刚签到的浮动 +N（0 = 不展示；1.6s 后复位）。
    public internal(set) var justGained = 0

    // 月历
    public private(set) var monthCheckedCount = 0
    public private(set) var board: MonthBoard?
    public var monthOpen = false {
        didSet { rebuildVisibleRows() }
    }
    public private(set) var visibleRows: [[MonthCell]] = []

    /// 签到成就卡 7 圆点（累计分值 + 是否达成）。
    public private(set) var milestones: [(cum: Int, hit: Bool, label: String)] =
        checkinCycleCumulative.enumerated().map { ($0.element, false, "第\($0.offset + 1)天") }

    /// 规则弹窗（hero「?」唤起）。
    public internal(set) var rulesVisible = false

    /// toast 出口（签到失败）。
    public internal(set) var toastMessage: String?

    private var app: AppModel?
    private var busy = false
    private var floatTask: Task<Void, Never>?
    private var pulseTask: Task<Void, Never>?
    /// 一步签到 redirect 进页带上的刚得分（首次加载成功后只放一次）。
    private var initialGained: Int
    /// 本次会话刚达成的 D7，驱动一次 pulse。
    private var justCompleted = false
    private var started = false

    public init(gained: Int?) {
        initialGained = gained ?? 0
    }

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await load()
    }

    /// 进页 / 回前台刷新（mp onShow）。silent=true 保留旧值（CTA 成功后的校准）。
    public func load(silent: Bool = false) async {
        guard let app else { return }
        if !silent {
            loading = true
            loadFailed = false
        }
        do {
            let st = try await app.api.checkInStatus()
            apply(st)
        } catch {
            if silent { return }
            loading = false
            loadFailed = true
        }
    }

    private func apply(_ st: CheckInStatus) {
        let board = buildMonthBoard(todayYmd: st.today.date, checkedPoints: checkedPointsMap(st))
        self.board = board

        let signedToday = !st.today.canCheckIn
        let cycle = st.cycle
        let checkedCount = cycle.filter { $0.status == .checked }.count
        let d7Signable = !signedToday && cycle.count == 7 && cycle[6].status == .today
        let d7Signed = signedToday && cycle.count == 7 && cycle[6].status == .checked

        // 断签横幅严格对齐原型：只在 streak 归零的今天亮（新周期第一天不亮）。
        let justCompleted = d7Signed && (self.justCompleted || initialGained > 0)
        self.justCompleted = false

        streak = st.streakDays
        heroSub = st.streakDays == 0 ? Self.heroSubNewRound : Self.heroSubDefault
        canCheck = st.today.canCheckIn
        ctaText = signedToday
            ? "今日已签到"
            : "签到 +\(st.today.rewardPreview)\(d7Signable ? " · 集齐本轮" : "")"
        showResetBanner = st.streakDays == 0
        showWinBanner = d7Signed
        winPulse = justCompleted
        balance = st.balance
        cycleEarned = cycleEarnedPoints(cycle)
        monthCheckedCount = board.checkedCount
        milestones = checkinCycleCumulative.enumerated().map {
            ($0.element, $0.offset < checkedCount, "第\($0.offset + 1)天")
        }
        loading = false
        loadFailed = false
        rebuildVisibleRows()

        if justCompleted {
            armPulse()
        }
        // 一步签到带分进页：以刚签到态呈现浮动 +N（只放一次）。
        if initialGained > 0 {
            let gained = initialGained
            initialGained = 0
            floatOnce(gained)
        }
    }

    private func rebuildVisibleRows() {
        guard let board, !board.rows.isEmpty else {
            visibleRows = []
            return
        }
        let week = board.weekIndex
        visibleRows = monthOpen ? board.rows : [board.rows[min(week, board.rows.count - 1)]]
    }

    // MARK: 签到（页内 CTA；幂等，重复回 +0 分快照）

    public func checkIn() async {
        guard !busy, canCheck else { return }
        busy = true
        checking = true
        defer {
            busy = false
            checking = false
        }
        do {
            let res = try await app?.api.createCheckIn()
            if let res {
                if res.pointsEarned > 0 {
                    floatOnce(res.pointsEarned)
                }
                if res.d7Completed {
                    justCompleted = true
                }
            }
            await load(silent: true)
        } catch {
            toastMessage = "签到失败，请稍后再试"
        }
    }

    // MARK: 浮动 +N / D7 pulse

    /// 浮动 +N 入场（1.4s 上飘淡出，1.6s 后复位；重复签到重置计时）。
    func floatOnce(_ points: Int) {
        floatTask?.cancel()
        justGained = points
        floatTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(1600))
            guard !Task.isCancelled else { return }
            self?.justGained = 0
        }
    }

    /// pulse 播完一轮即摘（月历重建节点不再重播）。
    private func armPulse() {
        pulseTask?.cancel()
        pulseTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(2200))
            guard !Task.isCancelled else { return }
            self?.winPulse = false
        }
    }

    public func showRules() { rulesVisible = true }
    public func hideRules() { rulesVisible = false }
}
