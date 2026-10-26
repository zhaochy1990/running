import Foundation
import Observation

// 赛事中心 ViewModel（devops#769，baseline §5.1 直译）：
// 整年拉全（per_page=100 + ≤50 页翻页兜底）；onShow 重拉真值（不跨页缓存）
// + 同键静默刷新（旧列表先行不闪屏）+ 请求序号防过期；年份/省份=服务端过滤；
// 类型/收藏=客户端过滤即点即效；星标乐观更新失败回滚。

@MainActor
@Observable
public final class RaceCenterModel {

    // MARK: - 视图状态

    public var loading = true
    /// 非空时顶部错误条（静默刷新失败保留旧列表）。
    public var error = ""
    public private(set) var groups: [RaceMonthGroup] = []
    public private(set) var viewCount = 0
    public private(set) var emptyText = ""

    public private(set) var years: [String] = []
    public var yearIndex = 1
    public var typeIndex = 0
    public var provinceIndex = 0
    /// 收藏 ☆ 开关：纯客户端过滤。
    public var favOnly = false
    public var toast: String?

    /// 省份下拉选项：全部 + 34 省。
    public private(set) var provinceNames: [String] = []

    // 实例级私有状态（页面销毁即弃，不跨页缓存）
    private var rows: [RaceCalendarRace] = []
    private var rowsKey = ""
    private var fetchingKey = ""
    private var pendingStars: Set<Int> = []
    private var fetchSeq = 0
    private var repo: RaceRepository?
    private var clock: () -> Date

    public init(now: @escaping () -> Date = { Date() }) {
        clock = now
    }

    // MARK: - 生命周期

    /// 首次可见：装配依赖 + 拉取。重复调用幂等。
    public func activate(app: AppModel) async {
        setupIfNeeded(app: app)
        await refresh()
    }

    private func setupIfNeeded(app: AppModel) {
        guard repo == nil else { return }
        repo = RaceRepository(api: app.api)
        years = raceYearOptions(now: clock())
        yearIndex = max(years.firstIndex(of: String(Shanghai.todayYMD(now: clock()).prefix(4))) ?? 0, 0)
        provinceNames = ["全部"] + raceProvinces
    }

    /// onShow 等价：每次进入（含返回、前台切回）重拉服务端真值。
    /// 已激活后才触发（首拉由 activate 负责）。
    public func onShowRefresh() async {
        guard repo != nil else { return }
        await refresh()
    }

    // MARK: - 拉取

    private var currentYear: String {
        years.indices.contains(yearIndex) ? years[yearIndex] : String(Shanghai.todayYMD(now: clock()).prefix(4))
    }

    private var currentProvince: String {
        provinceIndex > 0 && provinceNames.indices.contains(provinceIndex) ? provinceNames[provinceIndex] : ""
    }

    /// 拉取（或静默重拉）当前 年份×省份 的整年数据；同键在途时只发一次，
    /// 已有同键数据时旧列表先行（不转圈）。
    public func refresh() async {
        guard let repo else { return }
        let year = currentYear
        let province = currentProvince
        let key = "\(year)|\(province.isEmpty ? "all" : province)"
        guard fetchingKey != key else { return }
        fetchingKey = key
        fetchSeq += 1
        let seq = fetchSeq

        let silent = rowsKey == key && !rows.isEmpty
        if !silent {
            loading = true
            error = ""
        }
        do {
            let fetched = try await fetchYear(repo: repo, year: year, province: province)
            guard seq == fetchSeq else { return }
            fetchingKey = ""
            rows = fetched
            rowsKey = key
            loading = false
            applyView()
        } catch let e as ApiError {
            guard seq == fetchSeq else { return }
            fetchingKey = ""
            loading = false
            error = e.userMessage
            if !silent {
                rows = []
                rowsKey = ""
                applyView()
            }
        } catch {
            guard seq == fetchSeq else { return }
            fetchingKey = ""
            loading = false
            self.error = "加载失败，请稍后重试"
            if !silent {
                rows = []
                rowsKey = ""
                applyView()
            }
        }
    }

    /// 整年拉全（可选省份服务端过滤）：一页 100 场，不足 total 续页。
    private func fetchYear(repo: RaceRepository, year: String, province: String) async throws -> [RaceCalendarRace] {
        var out: [RaceCalendarRace] = []
        for page in 1...raceCalendarMaxPages {
            let res = try await repo.calendar(year: year, province: province.isEmpty ? nil : province, page: page)
            out.append(contentsOf: res.races)
            if res.races.isEmpty || out.count >= res.total { break }
        }
        return out
    }

    /// 用当前筛选条件重算 分组/计数/空态（纯同步，客户端过滤即点即效）。
    public func applyView() {
        let state = Self.viewState(
            rows: rows,
            year: currentYear,
            province: currentProvince,
            typeIndex: typeIndex,
            favOnly: favOnly,
            today: Shanghai.todayYMD(now: clock())
        )
        groups = state.groups
        viewCount = state.count
        emptyText = state.emptyText
    }

    // MARK: - 交互

    public func selectYear(_ index: Int) {
        guard index != yearIndex, years.indices.contains(index) else { return }
        yearIndex = index
        Task { await refresh() }
    }

    public func selectType(_ index: Int) {
        guard raceTypeOptions.indices.contains(index) else { return }
        typeIndex = index
        applyView()
    }

    /// 省份切换：服务端过滤，按 年份×省份 取数。
    public func selectProvince(_ index: Int) {
        guard index != provinceIndex, provinceNames.indices.contains(index) else { return }
        provinceIndex = index
        Task { await refresh() }
    }

    /// 收藏视图开关：纯客户端过滤。
    public func toggleFavOnly() {
        favOnly.toggle()
        applyView()
    }

    /// 行尾星标：乐观更新，服务端结果为准，失败回滚。
    public func toggleStar(_ id: Int) async {
        guard let repo, !pendingStars.contains(id),
              let index = rows.firstIndex(where: { $0.id == id }) else { return }
        let original = rows[index].favorited
        let next = !original
        pendingStars.insert(id)
        rows[index].favorited = next
        applyView()
        defer { pendingStars.remove(id) }
        do {
            let res = try await repo.toggleFavorite(raceId: id)
            rows[index].favorited = res.favorited
            applyView()
        } catch {
            rows[index].favorited = original
            applyView()
            toast = "收藏操作失败"
        }
    }

    public func clearToast() { toast = nil }

    // MARK: - 纯构建（单测面）

    /// 默认视图只看即将开跑；收藏视图与往年看整年（往年 upcoming 恒空）。
    public nonisolated static func viewState(
        rows: [RaceCalendarRace],
        year: String,
        province: String,
        typeIndex: Int,
        favOnly: Bool,
        today: String
    ) -> (groups: [RaceMonthGroup], count: Int, emptyText: String) {
        let token = raceTypeOptions.indices.contains(typeIndex) ? raceTypeOptions[typeIndex].token : ""
        let floor = (!favOnly && year >= String(today.prefix(4))) ? today : ""
        var inScope = rows
        if !floor.isEmpty {
            inScope = rows.filter { $0.raceDate >= floor }
        }
        let filtered = filterRaces(inScope, RaceFilter(type: token, favoritesOnly: favOnly))
        let groups = groupByMonth(filtered)

        var emptyText = ""
        if groups.isEmpty {
            if rows.isEmpty {
                emptyText = province.isEmpty
                    ? "\(year) 年暂无已发布赛事 · 下拉刷新"
                    : "\(province)暂无已发布赛事 · 换个省份或下拉刷新"
            } else if favOnly && typeIndex == 0 && province.isEmpty {
                emptyText = "还没有收藏的赛事 · 退出收藏筛选后点 ☆ 收藏"
            } else {
                emptyText = "当前筛选下没有赛事 · 换个条件试试"
            }
        }
        return (groups, filtered.count, emptyText)
    }
}

extension ApiError {
    /// 用户可见中文文案（赛事域口径：5xx 英文错误体不直出）。
    var userMessage: String {
        if statusCode >= 500 { return "加载失败，请稍后重试" }
        return detail.isEmpty ? "加载失败，请稍后重试" : detail
    }
}
