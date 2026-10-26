import Foundation
import Observation

// 记录 tab 列表 ViewModel（devops#766，baseline §2.2 直译）：
// 月份折叠分组（月头统计行、默认本月展开）、分页（100/页 offset 累计）、
// 失败静默保持空态。分组构建为纯静态函数，单测直接覆盖。

/// 每次拉取的活动条数（分页步长）。
public let activitiesPageSize = 100

@MainActor
@Observable
public final class ActivitiesModel {

    // MARK: - 视图数据

    public struct ActivityRow: Equatable, Identifiable, Sendable {
        public let labelId: String
        public let name: String
        public let date: String
        public let systemImage: String
        /// 路线缩略图（后端预渲染 PNG）；nil = 无图，回退运动图标；
        /// var：加载失败时置 nil 触发回退（小程序 onThumbError 同款）。
        public var thumbURL: URL?
        public let distanceKm: String
        public let duration: String
        public let pace: String
        public let avgHr: String
        public let load: String

        public var id: String { labelId }
    }

    public struct MonthGroup: Equatable, Identifiable, Sendable {
        /// YYYY-MM
        public let monthKey: String
        public let label: String
        public var expanded: Bool
        public var count: String
        public var km: String
        public var duration: String
        public var rows: [ActivityRow]

        public var id: String { monthKey }
    }

    public private(set) var loading = true
    public private(set) var monthGroups: [MonthGroup] = []
    public private(set) var hasMore = false
    public private(set) var loadingMore = false
    /// 完全没有活动记录时空态卡标题。
    public let emptyTitle = "暂无活动记录"

    private var currentMonth: String
    private var loadedCount = 0
    private var repo: ActivitiesRepository?
    private var userId = ""
    private var started = false

    public init(now: Date = Date()) {
        currentMonth = Shanghai.todayYM(now: now)
    }

    // MARK: - 生命周期

    /// 首次可见时装配依赖并拉取（waitForAuth 等价：等会话 settle 再发请求，
    /// 防首屏 401）。重复调用幂等。
    public func activate(app: AppModel) async {
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        userId = app.me?.id ?? ""
        guard !userId.isEmpty else {
            loading = false
            return
        }
        await fetch()
    }

    // MARK: - 拉取

    /// 下拉刷新 / 首拉：offset 归零。失败静默保持空态（无错误条）。
    public func fetch() async {
        guard let repo, !userId.isEmpty else {
            loading = false
            return
        }
        do {
            let res = try await repo.list(userId: userId, limit: activitiesPageSize, offset: 0)
            monthGroups = Self.monthGroups(from: res, currentMonth: currentMonth)
            loadedCount = res.activities.count
            hasMore = res.activities.count < res.total
        } catch {
            // 拉取失败保持空态（已加载内容在刷新失败时同样保留）。
        }
        loading = false
        loadingMore = false
    }

    /// 加载更早一页：合并进已有分组（已有组追加行、新月份新增组折叠）。
    public func loadMore() async {
        guard let repo, !userId.isEmpty, hasMore, !loadingMore else { return }
        loadingMore = true
        do {
            let res = try await repo.list(userId: userId, limit: activitiesPageSize, offset: loadedCount)
            monthGroups = Self.merged(existing: monthGroups, with: res)
            loadedCount += res.activities.count
            hasMore = loadedCount < res.total
        } catch {
            // 加载失败仅停止 loading 态，保留已加载内容。
        }
        loadingMore = false
    }

    // MARK: - 交互

    /// 月份头点击折叠 / 展开。
    public func toggleMonth(_ key: String) {
        monthGroups = monthGroups.map { g in
            var g = g
            if g.monthKey == key { g.expanded.toggle() }
            return g
        }
    }

    /// 缩略图加载失败（网络 / 对象被清理）时回退运动图标，不留空白圆槽。
    public func clearThumb(_ labelId: String) {
        monthGroups = monthGroups.map { g in
            var g = g
            g.rows = g.rows.map { r in
                var r = r
                if r.labelId == labelId, r.thumbURL != nil { r.thumbURL = nil }
                return r
            }
            return g
        }
    }

    // MARK: - 纯构建（单测面）

    /// 一页活动 → 月份倒序分组，默认本月展开；月汇总优先后端整月统计。
    public nonisolated static func monthGroups(from res: ActivitiesListResponse, currentMonth: String) -> [MonthGroup] {
        var byMonth: [String: [Activity]] = [:]
        for a in res.activities {
            let key = String(a.date.prefix(7))
            guard key.count == 7 else { continue }
            byMonth[key, default: []].append(a)
        }
        return byMonth.keys.sorted().reversed().map { monthKey in
            let acts = byMonth[monthKey]!
            let s = summary(from: res, monthKey: monthKey, fallback: acts)
            return MonthGroup(
                monthKey: monthKey,
                label: Shanghai.monthLabel(monthKey),
                expanded: monthKey == currentMonth,
                count: String(s.count),
                km: s.km,
                duration: s.duration,
                rows: acts.map(row)
            )
        }
    }

    /// 下一页（更早）活动合并进已有分组：新月份新增组（折叠），
    /// 月汇总幂等刷新（后端整月统计优先）。
    public nonisolated static func merged(existing: [MonthGroup], with res: ActivitiesListResponse) -> [MonthGroup] {
        var groups = existing.map { g in
            var g = g
            g.rows = Array(g.rows)
            return g
        }
        var byMonth = Dictionary(uniqueKeysWithValues: groups.map { ($0.monthKey, $0) })
        let order = groups.map(\.monthKey)

        var newKeys: [String] = []
        for a in res.activities {
            let key = String(a.date.prefix(7))
            guard key.count == 7 else { continue }
            if byMonth[key] == nil {
                byMonth[key] = MonthGroup(
                    monthKey: key, label: Shanghai.monthLabel(key), expanded: false,
                    count: "0", km: "—", duration: "—", rows: []
                )
                newKeys.append(key)
            }
            byMonth[key]!.rows.append(row(a))
        }

        // 先建的月份组按倒序排在后面，新月份组按首次出现顺序（活动流本身
        // 新→旧，即月份降序）追加在末尾——与小程序 mergeMonthGroups 一致。
        var keys = order
        keys.append(contentsOf: newKeys)

        let summaries = res.monthlySummaries ?? [:]
        return keys.map { key in
            var g = byMonth[key]!
            if let ms = summaries[key] {
                g.count = String(ms.activityCount)
                g.km = ms.totalRunKm > 0 ? String(format: "%.1f", ms.totalRunKm) : "—"
                g.duration = ms.durationS > 0 ? Fmt.durationShort(ms.durationS) : "—"
            } else {
                let acts = res.activities.filter { String($0.date.prefix(7)) == key }
                if !acts.isEmpty {
                    let s = summarize(acts)
                    g.count = String(s.count)
                    g.km = s.km
                    g.duration = s.duration
                }
            }
            return g
        }
    }

    private struct Summary {
        let count: Int
        let km: String
        let duration: String
    }

    /// 优先后端每月聚合（整月统计，不只本页）；缺失时回退本页当月活动。
    private nonisolated static func summary(from res: ActivitiesListResponse, monthKey: String, fallback acts: [Activity]) -> Summary {
        if let ms = res.monthlySummaries?[monthKey] {
            return Summary(
                count: ms.activityCount,
                km: ms.totalRunKm > 0 ? String(format: "%.1f", ms.totalRunKm) : "—",
                duration: ms.durationS > 0 ? Fmt.durationShort(ms.durationS) : "—"
            )
        }
        return summarize(acts)
    }

    private nonisolated static func summarize(_ acts: [Activity]) -> Summary {
        let km = acts.reduce(0) { $0 + ($1.distanceM ?? 0) / 1000 }
        let dur = acts.reduce(0) { $0 + ($1.durationS ?? 0) }
        return Summary(
            count: acts.count,
            km: km > 0 ? String(format: "%.1f", km) : "—",
            duration: dur > 0 ? Fmt.durationShort(dur) : "—"
        )
    }

    /// 活动行（名称缺失回退 sport_name，再兜底「活动」，避免空行）。
    private nonisolated static func row(_ a: Activity) -> ActivityRow {
        let name: String = {
            if let n = a.name?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
            if let s = a.sportName?.trimmingCharacters(in: .whitespaces), !s.isEmpty { return s }
            return "活动"
        }()
        return ActivityRow(
            labelId: a.labelId,
            name: name,
            date: Shanghai.dateLabel(fromYMD: a.date),
            systemImage: SportDisplay.systemImage(forSportName: a.sportName),
            thumbURL: a.thumbUrl.flatMap(URL.init(string:)),
            distanceKm: a.distanceKm > 0 ? Fmt.km(a.distanceM) : "—",
            duration: Fmt.durationShort(a.durationS),
            pace: Fmt.pace(a.avgPaceSKm),
            avgHr: a.avgHr != nil ? Fmt.intStr(a.avgHr) : "—",
            // 优先展示 STRIDE 自身计算的负荷；缺失回退手表上报值。
            load: Fmt.dose(a.strideTrainingDose ?? a.trainingLoad)
        )
    }
}
