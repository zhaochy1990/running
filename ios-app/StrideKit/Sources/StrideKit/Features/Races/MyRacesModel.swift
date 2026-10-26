import Foundation
import Observation

// 我的比赛 ViewModel（devops#769，baseline §5.4 直译）：双 tab（plans 默认 /
// results）各自独立 loading/error + 请求序号；混排卡（官方/自定义/offboarded/
// 已结束沉底）；状态 chips + 行程勾选乐观更新 + 在飞补丁防并发读打回；
// 成绩行长按 contextMenu（改名/恢复活动名/清除识别二次确认）。

@MainActor
@Observable
public final class MyRacesModel {

    public enum Tab: String, CaseIterable, Sendable {
        case plans
        case results

        var title: String {
            switch self {
            case .plans: "我的赛事"
            case .results: "我的成绩"
            }
        }
    }

    // MARK: - 视图状态（双 tab 独立三态）

    public var activeTab: Tab = .plans

    // 我的成绩
    public var loading = true
    public var error = ""
    public private(set) var rows: [RaceResultRow] = []
    public private(set) var summary = ""

    // 我的赛事
    public var plansLoading = true
    public var plansError = ""
    public private(set) var mixRows: [MyRaceRow] = []

    public var toast: String?

    /// 成绩行改名 alert 目标（labelId + 回显当前名）。
    public var renameTarget: (labelId: String, current: String)?
    /// 「这不是这场比赛」二次确认目标（labelId + 官方赛名）。
    public var pendingClearMatch: String?

    // MARK: - 私有

    private var repo: RaceRepository?
    private var userId = ""
    private var today: String { Shanghai.todayYMD() }
    /// 在飞写请求（键=行 key → 乐观合并闭包）：防连点 + 并发读不打回乐观态。
    private var inflight: [String: (MyRaceRow) -> MyRaceRow] = [:]
    /// 自定义比赛全字段（id → 聚合下发原行）：PUT 全量更新与编辑回显用。
    private var customById: [Int: CustomRace] = [:]
    /// 成绩行原始数据：长按菜单回显与本地回落名用。
    private var raceByLabel: [String: RaceResultItem] = [:]
    private var fetchSeq = 0
    private var resultsSeq = 0

    public init() {}

    // MARK: - 生命周期

    public func activate(app: AppModel) async {
        guard repo == nil else { return }
        repo = RaceRepository(api: app.api)
        await app.waitUntilSessionSettled()
        userId = app.me?.id ?? ""
        guard !userId.isEmpty else {
            loading = false
            plansLoading = false
            error = "请先登录"
            plansError = "请先登录"
            return
        }
        await fetchResults()
        await refreshPlans()
    }

    /// onShow 双 tab 重拉。
    public func onShowRefresh() async {
        guard repo != nil else { return }
        await fetchResults()
        await refreshPlans()
    }

    // MARK: - 我的成绩

    public func fetchResults() async {
        guard let repo, !userId.isEmpty else { return }
        resultsSeq += 1
        let seq = resultsSeq
        loading = true
        error = ""
        do {
            let races = try await repo.results(userId: userId)
            guard seq == resultsSeq else { return }
            raceByLabel = Dictionary(uniqueKeysWithValues: races.map { ($0.labelId, $0) })
            let pb = pbLabelIds(races)
            rows = races.map { toResultRow($0, isPb: pb.contains($0.labelId)) }
            summary = resultSummary(rows)
            loading = false
        } catch let e as ApiError {
            guard seq == resultsSeq else { return }
            loading = false
            self.error = e.userMessage
        } catch {
            guard seq == resultsSeq else { return }
            loading = false
            self.error = "加载失败，请稍后重试"
        }
    }

    // MARK: - 我的赛事（聚合）

    public func refreshPlans() async {
        guard let repo, !userId.isEmpty else { return }
        fetchSeq += 1
        let seq = fetchSeq
        plansLoading = true
        plansError = ""
        do {
            let items = try await repo.myRaces()
            guard seq == fetchSeq else { return }
            for item in items where item.source == .custom {
                if let race = item.race { customById[race.id] = race }
            }
            // GET 若赶在 PUT 落库前返回，快照还是旧态：叠加在飞乐观补丁。
            mixRows = toMyRaceRows(items, today: today).map { row in
                inflight[row.id].map { $0(row) } ?? row
            }
            plansLoading = false
        } catch let e as ApiError {
            guard seq == fetchSeq else { return }
            plansLoading = false
            self.plansError = e.userMessage
        } catch {
            guard seq == fetchSeq else { return }
            plansLoading = false
            self.plansError = "加载失败，请稍后重试"
        }
    }

    // MARK: - 官方卡：状态流转 / 行程勾选

    /// 状态 chip 三态流转（点当前态无效；未中签是旁路，只能从详情选择器进）。
    public func togglePlanState(raceId: Int, next: RacePlanState) async {
        guard let repo,
              let row = mixRows.first(where: { $0.id == "o-\(raceId)" }),
              case .official(_, let card) = row,
              !card.offboarded, card.state != next else { return }
        let key = "o-\(raceId)"
        guard inflight[key] == nil else { return }
        let prev = card.state
        let patch = planStatePatch(next)
        inflight[key] = { mergeMyRaceRow($0, state: patch) }
        patchRow(key) { mergeMyRaceRow($0, state: patch) }
        defer { inflight[key] = nil }
        do {
            try await repo.upsertPlan(raceId: raceId, body: RacePlanUpsertBody(itemType: card.itemToken, state: next))
        } catch {
            inflight[key] = nil
            let rollback = planStatePatch(prev)
            patchRow(key) { mergeMyRaceRow($0, state: rollback) }
            toast = "状态更新失败"
        }
    }

    /// 行程布尔勾选：显式传反值覆盖（hotel/transit）。
    public func toggleTrip(raceId: Int, field: RaceTripField) async {
        guard let repo,
              let row = mixRows.first(where: { $0.id == "o-\(raceId)" }),
              case .official(_, let card) = row,
              !card.offboarded else { return }
        let key = "o-\(raceId)"
        guard inflight[key] == nil else { return }
        let current = field == .hotel ? card.hotel : card.transit
        let next = !current
        func merge(_ row: MyRaceRow) -> MyRaceRow {
            field == .hotel ? mergeMyRaceRow(row, hotel: next) : mergeMyRaceRow(row, transit: next)
        }
        inflight[key] = merge
        patchRow(key, merge)
        defer { inflight[key] = nil }
        do {
            try await repo.upsertPlan(
                raceId: raceId,
                body: RacePlanUpsertBody(
                    itemType: card.itemToken,
                    state: card.state,
                    hotel: field == .hotel ? next : nil,
                    transit: field == .transit ? next : nil
                )
            )
        } catch {
            inflight[key] = nil
            patchRow(key) { row in
                field == .hotel ? mergeMyRaceRow(row, hotel: current) : mergeMyRaceRow(row, transit: current)
            }
            toast = "保存失败"
        }
    }

    // MARK: - 自定义卡：状态切换 / 编辑 / 删除

    /// 想跑 ↔ 已报名 两态切换：PUT 全量更新，必须带聚合下发的全字段。
    public func toggleCustomState(rowKey: String, next: CustomRaceState) async {
        guard let repo,
              let row = mixRows.first(where: { $0.id == rowKey }),
              case .custom(_, let card) = row,
              let raw = customById[card.rowId],
              !card.done, card.state != next else { return }
        guard inflight[rowKey] == nil else { return }
        let patch = customStatePatch(next)
        inflight[rowKey] = { mergeMyRaceRow($0, customState: patch) }
        patchRow(rowKey) { mergeMyRaceRow($0, customState: patch) }
        defer { inflight[rowKey] = nil }
        do {
            try await repo.updateCustomRace(id: card.rowId, customRaceBody(raw, state: next))
            customById[card.rowId]?.state = next
        } catch {
            inflight[rowKey] = nil
            let rollback = customStatePatch(card.state)
            patchRow(rowKey) { mergeMyRaceRow($0, customState: rollback) }
            toast = "状态更新失败"
        }
    }

    /// 编辑回显：聚合原行经 AppModel 交接给表单（eventChannel 等价物）。
    public func editCustom(app: AppModel, rowKey: String) {
        guard let row = mixRows.first(where: { $0.id == rowKey }),
              case .custom(_, let card) = row,
              let raw = customById[card.rowId] else { return }
        app.pendingCustomRaceEdit = raw
        app.router.push(.customRaceForm)
    }

    public func deleteCustom(rowKey: String) async {
        guard let repo,
              let row = mixRows.first(where: { $0.id == rowKey }),
              case .custom(_, let card) = row else { return }
        do {
            try await repo.deleteCustomRace(id: card.rowId)
            customById[card.rowId] = nil
            inflight[rowKey] = nil
            mixRows.removeAll { $0.id == rowKey }
        } catch {
            toast = "删除失败"
        }
    }

    // MARK: - 成绩行 contextMenu 动作

    /// 手输名（空串=清除）；就地同步内存行（连续长按回显新手输名）。
    public func renameRace(labelId: String, to name: String) async {
        guard let repo, !userId.isEmpty else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        do {
            try await repo.setDisplayName(userId: userId, labelId: labelId, name: trimmed)
            raceByLabel[labelId]?.displayName = trimmed.isEmpty ? nil : trimmed
            // await 期间列表可能已重拉（该行或已不在）：fallback 现取现用，不强制解包。
            let fallback = raceByLabel[labelId].map(raceDisplayName) ?? ""
            patchResultRow(labelId) { row in
                row.hasCustom = !trimmed.isEmpty
                row.name = trimmed.isEmpty ? (fallback.isEmpty ? row.bandLabel : fallback) : trimmed
            }
            toast = "已保存"
        } catch {
            toast = "保存失败"
        }
    }

    /// 恢复活动名：PATCH 空串清掉手输名。
    public func restoreRaceName(labelId: String) async {
        guard let repo, !userId.isEmpty, let raw = raceByLabel[labelId] else { return }
        do {
            try await repo.setDisplayName(userId: userId, labelId: labelId, name: "")
            raceByLabel[labelId]?.displayName = nil
            let fallback = raw.raceName ?? raw.name
            patchResultRow(labelId) { row in
                row.hasCustom = false
                if let fallback {
                    row.name = fallback
                } else if row.name.isEmpty {
                    row.name = row.bandLabel
                }
            }
            toast = "已恢复活动名"
        } catch {
            toast = "恢复失败"
        }
    }

    /// 「这不是这场比赛」：二次确认后清除识别（断开官方关联，手输名保留）。
    public func clearRaceMatch(labelId: String) async {
        guard let repo, !userId.isEmpty, let raw = raceByLabel[labelId] else { return }
        do {
            try await repo.clearCalendarMatch(userId: userId, labelId: labelId)
            raceByLabel[labelId]?.raceName = nil
            patchResultRow(labelId) { row in
                row.isAuto = false
                row.cnBadgeText = ""
                row.waBadgeText = ""
                if let custom = raw.displayName {
                    row.name = custom
                } else if let activity = raw.name {
                    row.name = activity
                } else {
                    row.name = row.bandLabel
                }
            }
            toast = "已清除识别"
            await fetchResults()
        } catch {
            toast = "操作失败"
        }
    }

    // MARK: - 工具

    private func patchRow(_ key: String, _ merge: (MyRaceRow) -> MyRaceRow) {
        mixRows = mixRows.map { $0.id == key ? merge($0) : $0 }
    }

    private func patchResultRow(_ labelId: String, _ mutate: (inout RaceResultRow) -> Void) {
        rows = rows.map { row in
            guard row.labelId == labelId else { return row }
            var copy = row
            mutate(&copy)
            return copy
        }
    }

    public func clearToast() { toast = nil }

    /// 当前成绩行显示名（改名 alert 回显）。
    public func resultName(_ labelId: String) -> String {
        rows.first(where: { $0.labelId == labelId })?.name ?? ""
    }
}

/// 行程勾选字段。
public enum RaceTripField: String, CaseIterable, Sendable {
    case hotel
    case transit
}
