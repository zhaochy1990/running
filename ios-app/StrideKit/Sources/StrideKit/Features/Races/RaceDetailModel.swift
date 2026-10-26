import Foundation
import Observation

// 赛事详情 ViewModel（devops#769，baseline §5.2 直译）：详情与计划/策略并行
// 拉取（计划/策略失败不阻塞详情）；报名时间轴完成态按今天推算；报名选择器
// （底部 sheet）：项目 chips + 状态单选，点状态即提交（同态纯确认不发写；
// 删除 404 幂等收尾；PUT 缺省保留）；星标乐观+作废在途刷新；策略卡两态。

@MainActor
@Observable
public final class RaceDetailModel {

    public enum Tab: Int, CaseIterable, Sendable {
        case summary = 0, items = 1, course = 2, trip = 3

        var title: String {
            switch self {
            case .summary: "概要"
            case .items: "项目"
            case .course: "赛道"
            case .trip: "出行"
            }
        }
    }

    // MARK: - 视图状态

    public var loading = true
    /// 非空时整页只渲染错误条（含未登录 / 赛事不存在）。
    public var error = ""
    public private(set) var view: RaceDetailViewData?
    public private(set) var starred = false
    public var tabIndex: Tab = .summary
    public private(set) var signupButton = "未报名"
    public private(set) var signupAvailable = false
    public var toast: String?

    // 报名选择器（底部 sheet）
    public var sheetOpen = false
    public private(set) var sheetChips: [RaceChip] = []
    public var sheetItem = ""
    public private(set) var sheetStates: [(value: String, label: String, current: Bool)] = []

    // 策略卡（内容调研过才显示）
    public private(set) var strategyEntry = false
    public private(set) var strategySummary: (target: String, count: Int, updatedAt: String)?

    // 赛道 tab 站点卡展开态
    public var courseOpen: Set<String> = []

    // MARK: - 私有

    public let raceId: Int
    private var detail: RaceDetail?
    private var plan: (itemType: String, state: RacePlanState)?
    private var planPending = false
    private var starPending = false
    private var fetchSeq = 0
    private var repo: RaceRepository?
    private var clock: () -> Date

    public init(raceId: Int, now: @escaping () -> Date = { Date() }) {
        self.raceId = raceId
        clock = now
    }

    // MARK: - 生命周期

    public func activate(app: AppModel) async {
        guard repo == nil else { return }
        repo = RaceRepository(api: app.api)
        guard raceId > 0 else {
            loading = false
            error = "赛事不存在"
            return
        }
        await refresh()
    }

    /// onShow 自愈（登录回来 / 从策略页返回）：已加载过才补拉。
    public func onShowRefresh() async {
        guard repo != nil, !loading else { return }
        await refresh()
    }

    private var today: String { Shanghai.todayYMD(now: clock()) }

    // MARK: - 拉取

    public func refresh() async {
        guard let repo else { return }
        loading = true
        error = ""
        fetchSeq += 1
        let seq = fetchSeq

        // 详情与计划/策略并行；计划与策略失败不阻塞详情（按钮按未报名、
        // 策略卡按未生成展示）。
        async let plansTask: [RacePlan]? = try? repo.plans()
        async let versionsTask: [RaceStrategyVersion]? = try? repo.strategies(raceId: raceId)

        let fetched: RaceDetail
        do {
            fetched = try await repo.detail(raceId: raceId)
        } catch let e as ApiError {
            guard seq == fetchSeq else { return }
            loading = false
            error = e.statusCode == 404 ? "赛事不存在或已下架" : e.userMessage
            return
        } catch {
            guard seq == fetchSeq else { return }
            loading = false
            self.error = "加载失败，请稍后重试"
            return
        }
        let plans = await plansTask ?? []
        let summary = Self.strategySummary(await versionsTask ?? [])
        guard seq == fetchSeq else { return }

        detail = fetched
        plan = plans.first(where: { $0.raceId == raceId }).map { ($0.itemType, $0.state) }
        view = toRaceDetailView(fetched, today: today)
        starred = fetched.favorited
        signupAvailable = !itemChips(fetched.items).isEmpty
        strategyEntry = fetched.strategyAvailable
        strategySummary = summary
        courseOpen = []
        // 赛道 tab 缺席（无赛道内容）时回退概要。
        if view?.course.available == false, tabIndex == .course { tabIndex = .summary }
        applyPlan()
        loading = false
    }

    private static func strategySummary(_ versions: [RaceStrategyVersion]) -> (target: String, count: Int, updatedAt: String)? {
        guard let latest = latestStrategyVersion(versions) else { return nil }
        return (latest.targetFinishTime.isEmpty ? "—" : latest.targetFinishTime,
                versions.count,
                strategyUpdatedAtLabel(latest.updatedAt))
    }

    /// 报名按钮文案。
    private func applyPlan() {
        signupButton = planButtonLabel(itemType: plan?.itemType ?? "", state: plan?.state)
    }

    /// 有效 tab（赛道缺席时隐藏）。
    public var tabs: [Tab] {
        (view?.course.available ?? false) ? Tab.allCases : Tab.allCases.filter { $0 != .course }
    }

    // MARK: - 星标

    public func toggleStar() async {
        guard let repo, let detail, !starPending else { return }
        starPending = true
        // 作废在途刷新：其响应里的 favorited 是点星前的旧值。
        fetchSeq += 1
        let next = !detail.favorited
        self.detail?.favorited = next
        starred = next
        defer { starPending = false }
        do {
            let res = try await repo.toggleFavorite(raceId: detail.id)
            self.detail?.favorited = res.favorited
            starred = res.favorited
        } catch {
            self.detail?.favorited = !next
            starred = !next
            toast = "收藏操作失败"
        }
    }

    // MARK: - 报名选择器

    /// 打开选择器：项目 chip 预选当前计划的项目（否则第一枚）。
    public func openSheet() {
        guard signupAvailable, let detail else { return }
        let chips = itemChips(detail.items)
        let current = plan.flatMap { p in chips.contains(where: { $0.token == p.itemType }) ? p.itemType : nil } ?? chips.first?.token ?? ""
        sheetItem = current
        sheetChips = chips
        let state = plan?.state
        sheetStates = racePlanStateOptions.map { ($0.value, $0.label, $0.value == state?.rawValue) }
        sheetOpen = true
    }

    public func selectChip(_ token: String) {
        guard !token.isEmpty, token != sheetItem else { return }
        sheetItem = token
    }

    /// 选择状态即提交：'none'=删计划，五态=PUT；同态纯确认不发写。
    public func chooseState(_ value: String) async {
        guard let repo, !planPending else { return }
        if let plan, value != "none", value == plan.state.rawValue, sheetItem == plan.itemType {
            sheetOpen = false
            return
        }
        if value == "none", plan == nil {
            sheetOpen = false
            return
        }
        planPending = true
        defer { planPending = false }
        do {
            if value == "none" {
                do {
                    try await repo.deletePlan(raceId: raceId)
                } catch let e as ApiError where e.statusCode == 404 {
                    // 计划可能已被别处删掉：按已取消收尾而不是报错。
                }
                plan = nil
                toast = "已取消追踪"
            } else if let state = RacePlanState(rawValue: value) {
                let res = try await repo.upsertPlan(raceId: raceId, body: RacePlanUpsertBody(itemType: sheetItem, state: state))
                plan = (res.itemType, res.state)
                toast = "已更新报名状态"
            } else {
                return
            }
            // 作废在途刷新：其计划列表是提交前的旧快照。
            fetchSeq += 1
            sheetOpen = false
            applyPlan()
        } catch {
            toast = "报名状态更新失败"
        }
    }

    // MARK: - 策略卡与导航

    /// 策略卡：已生成 → 报告页；未生成 → 带 race target 进教练会话。
    public func strategyTap(app: AppModel) {
        guard let detail else { return }
        if strategySummary != nil {
            app.router.push(.raceStrategy(id: raceId, target: nil))
            return
        }
        let chips = itemChips(detail.items)
        let itemType = plan?.itemType ?? chips.first?.token
        guard let itemType, detail.strategyAvailable else { return }
        let name = detail.nameCn ?? detail.name
        let abbr = typeAbbr(itemType)
        app.pendingCoachContext = PendingCoachContext(
            target: CoachTarget(kind: .race, raceEventId: raceId, itemType: itemType),
            label: "\(name) · \(abbr.isEmpty ? itemType : abbr)",
            // 按钮即意图：进会话自动发出，教练主动开场确认。
            kickoff: "我想和你聊聊「\(name)」的比赛策略"
        )
        // reLaunch 等价：切教练 tab（栈保留语义，devops#751 决议 4）。
        app.router.selectedTab = .coach
    }

    // MARK: - 赛道

    public func toggleCourse(_ key: String) {
        if courseOpen.contains(key) { courseOpen.remove(key) } else { courseOpen.insert(key) }
    }

    public func clearToast() { toast = nil }
}
