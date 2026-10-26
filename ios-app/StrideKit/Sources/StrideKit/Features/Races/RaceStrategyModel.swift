import Foundation
import Observation

// 比赛策略报告页 ViewModel（devops#769，baseline §5.3 直译）：版本 pills
// （目标最快在前、dirty 先确认丢弃）；行内编辑 blur 落值 + 用时=距离×配速
// 自动重算；补给增删改；保存按 target 键控覆盖；删除删空回未生成态；
// 草稿（教练卡片经 AppModel.pendingStrategyDraft 交接）本地渲染 + 应用落库。

@MainActor
@Observable
public final class RaceStrategyModel {

    // MARK: - 视图状态

    public var loading = true
    public var error = ""
    public private(set) var view: StrategyViewData?
    public private(set) var raceDayText = ""
    /// 版本切换 pills（非草稿且已有版本时显示）。
    public private(set) var versions: [(target: String, active: Bool)] = []
    public private(set) var draft = false
    public private(set) var dirty = false
    public private(set) var saving = false
    public private(set) var applying = false
    public private(set) var deleting = false
    public private(set) var updatedAtText = ""
    public var toast: String?

    /// 版本切换前的 dirty 确认（view 弹确认框）。
    public internal(set) var pendingSwitchTarget: String?
    /// 删除当前版本前的确认。
    public var confirmDelete = false

    // MARK: - 私有

    public let raceId: Int
    private var detail: RaceDetail?
    private var base: RaceStrategyContent?
    private var draftStrategy: RaceStrategyContent?
    private var versionList: [RaceStrategyVersion] = []
    private var activeTarget = ""
    private var activeVersionId = 0
    private var initialTarget: String?
    private var repo: RaceRepository?

    public init(raceId: Int, target: String?) {
        self.raceId = raceId
        initialTarget = target
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
        // 教练聊天卡片交接的草稿（raceId 匹配才消费）：进草稿模式。
        if let pending = app.takePendingStrategyDraft(), pending.raceId == raceId,
           let content = try? JSONDecoder().decode(RaceStrategyContent.self, from: pending.payload) {
            draftStrategy = content
        }
        await refresh()
    }

    public func refresh() async {
        guard let repo else { return }
        loading = true
        error = ""
        if let draftContent = draftStrategy {
            // 草稿模式：跳过 GET（服务端没有这版），只取赛事元信息。
            do {
                let fetched = try await repo.detail(raceId: raceId)
                detail = fetched
                base = draftContent
                view = toStrategyView(draftContent)
                draft = true
                raceDayText = raceDayLabel(fetched.raceDate)
                dirty = false
                updatedAtText = ""
                loading = false
            } catch {
                loading = false
                self.error = "加载失败，请稍后重试"
            }
            return
        }
        // 已保存态：赛事详情 + 全部策略版本双请求。
        do {
            async let detailTask = repo.detail(raceId: raceId)
            async let versionsTask = repo.strategies(raceId: raceId)
            let (fetched, versions) = try await (detailTask, versionsTask)
            detail = fetched
            if versions.isEmpty {
                loading = false
                error = "策略尚未生成：回到赛事详情，和教练聊一聊生成初稿"
                return
            }
            let requested = initialTarget.flatMap { t in versions.first(where: { $0.targetFinishTime == t }) }
            let initial = requested ?? latestStrategyVersion(versions)
            if let initial {
                applyVersion(initial, versions: versions, detail: fetched)
            }
            loading = false
        } catch let e as ApiError {
            loading = false
            self.error = e.userMessage
        } catch {
            loading = false
            self.error = "加载失败，请稍后重试"
        }
    }

    /// 把选中版本落到页面状态：视图 + pills + 时间戳。
    private func applyVersion(_ version: RaceStrategyVersion, versions: [RaceStrategyVersion], detail: RaceDetail) {
        versionList = versions
        activeTarget = version.targetFinishTime
        activeVersionId = version.id
        base = version.content
        view = toStrategyView(version.content)
        draft = false
        dirty = false
        updatedAtText = strategyUpdatedAtLabel(version.updatedAt)
        raceDayText = raceDayLabel(detail.raceDate)
        self.versions = versions.map { ($0.targetFinishTime, $0.targetFinishTime == version.targetFinishTime) }
    }

    // MARK: - 版本切换（dirty 先确认丢弃）

    public func requestVersionSwitch(_ target: String) {
        guard !target.isEmpty, target != activeTarget else { return }
        if dirty {
            pendingSwitchTarget = target
            return
        }
        performVersionSwitch(to: target)
    }

    public func confirmSwitchDiscard() {
        guard let target = pendingSwitchTarget else { return }
        pendingSwitchTarget = nil
        performVersionSwitch(to: target)
    }

    private func performVersionSwitch(to target: String) {
        guard let detail, let next = versionList.first(where: { $0.targetFinishTime == target }) else { return }
        applyVersion(next, versions: versionList, detail: detail)
    }

    // MARK: - 行内编辑（blur 落值 + 自动重算）

    public func patchPaceRow(_ index: Int, pace: String? = nil, note: String? = nil) {
        guard var v = view, index >= 0, index < v.paceRows.count else { return }
        if let pace { v.paceRows[index].pace = pace }
        if let note { v.paceRows[index].note = note }
        v.paceRows = recomputePaceTimes(v.paceRows)
        view = v
        dirty = true
    }

    public func patchFuelingRow(_ index: Int, timePoint: String? = nil, content: String? = nil) {
        guard var v = view, index >= 0, index < v.fuelingRows.count else { return }
        if let timePoint { v.fuelingRows[index].timePoint = timePoint }
        if let content { v.fuelingRows[index].content = content }
        view = v
        dirty = true
    }

    public func addFuelingRow() {
        guard var v = view else { return }
        v.fuelingRows.append(FuelingRowView(index: v.fuelingRows.count, timePoint: "", content: ""))
        view = v
        dirty = true
    }

    public func removeFuelingRow(_ index: Int) {
        guard var v = view, index >= 0, index < v.fuelingRows.count else { return }
        v.fuelingRows.remove(at: index)
        v.fuelingRows = v.fuelingRows.enumerated().map { i, row in
            var row = row
            row.index = i
            return row
        }
        view = v
        dirty = true
    }

    // MARK: - 保存 / 应用 / 删除

    /// 保存编辑（覆盖当前目标版本；dirty 时可用）。
    public func save() async {
        guard let repo, let view, let base, dirty, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let res = try await repo.saveStrategy(
                raceId: raceId,
                body: SaveRaceStrategyBody(itemType: view.itemType, content: fromStrategyView(view, base: base))
            )
            // 同步版本时间戳：后续删除切版时 latestStrategyVersion 才准。
            versionList = versionList.map { v in
                v.targetFinishTime == activeTarget
                    ? RaceStrategyVersion(id: v.id, targetFinishTime: v.targetFinishTime, itemType: v.itemType, content: v.content, updatedAt: res.updatedAt)
                    : v
            }
            dirty = false
            updatedAtText = strategyUpdatedAtLabel(res.updatedAt)
            toast = "已保存"
        } catch {
            toast = "保存失败，请重试"
        }
    }

    /// 草稿模式底部主按钮：PUT 落库为该目标版本，转已保存态。
    public func applyDraft() async {
        guard let repo, let view, let base, !applying else { return }
        applying = true
        defer { applying = false }
        do {
            let res = try await repo.saveStrategy(
                raceId: raceId,
                body: SaveRaceStrategyBody(itemType: view.itemType, content: fromStrategyView(view, base: base))
            )
            draftStrategy = nil
            initialTarget = res.targetFinishTime.isEmpty ? view.targetTime : res.targetFinishTime
            toast = "已应用"
            await refresh()
        } catch {
            toast = "应用失败，请重试"
        }
    }

    /// 删除当前选中的目标版本（其它版本不动）。
    public func deleteActiveVersion() async {
        guard let repo, let detail, !activeTarget.isEmpty, !deleting else { return }
        deleting = true
        defer { deleting = false }
        do {
            try await repo.deleteStrategy(raceId: raceId, targetFinishTime: activeTarget)
            let remaining = versionList.filter { $0.targetFinishTime != activeTarget }
            if remaining.isEmpty {
                versionList = []
                activeTarget = ""
                activeVersionId = 0
                versions = []
                view = nil
                updatedAtText = ""
                error = "策略尚未生成：回到赛事详情，和教练聊一聊生成初稿"
                return
            }
            if let next = latestStrategyVersion(remaining) {
                applyVersion(next, versions: remaining, detail: detail)
            }
        } catch {
            toast = "删除失败，请重试"
        }
    }

    // MARK: - 和教练调整 / 分享

    /// hero 主按钮：带 race target 回教练 tab（草稿经 AppModel.pending 交接）。
    public func coachTap(app: AppModel) {
        guard let view else { return }
        app.pendingCoachContext = PendingCoachContext(
            target: CoachTarget(kind: .race, raceEventId: raceId, itemType: view.itemType),
            label: "\(view.raceName) · \(view.itemTypeLabel)",
            kickoff: "我已经有一份「\(view.raceName)」的比赛策略（目标 \(view.targetTime)），想和你聊聊怎么调整"
        )
        app.router.selectedTab = .coach
    }

    /// 分享目标（#506）：已落库版本 → 只读落地页 owner+race+version 三元组；
    /// 草稿/无版本行 id → 赛事详情页（报告页是私有产物）。
    public func shareTarget(app: AppModel) -> URL? {
        guard view != nil, raceId > 0 else { return nil }
        let base = app.api.config.shareBaseURL
        if !draft, activeVersionId != 0, let owner = app.me?.id {
            return base.appending(path: "/pages/race-center/strategy-share/strategy-share")
                .appending(queryItems: [
                    URLQueryItem(name: "user", value: owner),
                    URLQueryItem(name: "id", value: String(raceId)),
                    URLQueryItem(name: "version", value: String(activeVersionId)),
                ])
        }
        return base.appending(path: "/pages/race-center/detail")
            .appending(queryItems: [URLQueryItem(name: "id", value: String(raceId))])
    }

    public func clearToast() { toast = nil }
}
