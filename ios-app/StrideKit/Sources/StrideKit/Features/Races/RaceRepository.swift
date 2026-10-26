import Foundation

/// 赛事域数据仓库（devops#769）：日历/收藏/详情 + 计划 CRUD + 策略 CRUD +
/// 自定义比赛 CRUD + 我的成绩，1:1 沿小程序五个 services 的端点面
/// （端点零新增，devops#749 §7.1）。
public final class RaceRepository: Sendable {

    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    // MARK: - 日历与收藏（race-center.ts）

    /// 拉一页已发布赛事（按 race_date 升序）；province 为省名原文（服务端精确匹配）。
    public func calendar(year: String, province: String?, page: Int, perPage: Int = 100) async throws -> RaceCalendarResponse {
        var q = "year=\(Self.query(year))&scope=all&page=\(page)&per_page=\(perPage)"
        if let province, !province.isEmpty { q += "&province=\(Self.query(province))" }
        return try await api.send(APIRequest(path: "/api/race-calendar?\(q)"), as: RaceCalendarResponse.self)
    }

    /// 收藏星标切换，返回服务端最终状态（并发点击时以此为准）。
    public func toggleFavorite(raceId: Int) async throws -> RaceFavoriteToggleResponse {
        try await api.send(
            APIRequest(method: .post, path: "/api/users/me/race-favorites/\(raceId)/toggle"),
            as: RaceFavoriteToggleResponse.self
        )
    }

    /// 一场已发布赛事的详情；未发布/不存在均 404。
    public func detail(raceId: Int) async throws -> RaceDetail {
        try await api.send(APIRequest(path: "/api/race-calendar/\(raceId)"), as: RaceDetail.self)
    }

    // MARK: - 参赛计划（race-plans.ts）

    /// 我的全部计划（按比赛日升序）。
    public func plans() async throws -> [RacePlan] {
        let res = try await api.send(APIRequest(path: "/api/users/me/race-plans"), as: RacePlanListResponse.self)
        return res.plans
    }

    /// 创建/更新一条计划（项目+状态成对；hotel/transit 缺省保留）。
    public func upsertPlan(raceId: Int, body: RacePlanUpsertBody) async throws -> RacePlanUpsertResult {
        let data = try JSONEncoder().encode(body)
        return try await api.send(
            APIRequest(method: .put, path: "/api/users/me/race-plans/\(raceId)", body: data),
            as: RacePlanUpsertResult.self
        )
    }

    /// 取消追踪；计划不存在时后端答 404，调用方按已取消收尾（幂等）。
    public func deletePlan(raceId: Int) async throws {
        _ = try await api.send(APIRequest(method: .delete, path: "/api/users/me/race-plans/\(raceId)"))
    }

    // MARK: - 比赛策略（race-strategy.ts）

    /// 全部策略版本（目标最快在前）；未生成时空数组（200）。
    public func strategies(raceId: Int) async throws -> [RaceStrategyVersion] {
        let res = try await api.send(
            APIRequest(path: "/api/users/me/race-strategies/\(raceId)"),
            as: RaceStrategyListResponse.self
        )
        return res.strategies
    }

    /// 保存手动编辑/应用草稿：content.targetFinishTime 是版本键（同目标覆盖）。
    public func saveStrategy(raceId: Int, body: SaveRaceStrategyBody) async throws -> SaveRaceStrategyResult {
        let data = try JSONEncoder().encode(body)
        return try await api.send(
            APIRequest(method: .put, path: "/api/users/me/race-strategies/\(raceId)", body: data),
            as: SaveRaceStrategyResult.self
        )
    }

    /// 删除某个目标的版本（其它版本不动）。
    public func deleteStrategy(raceId: Int, targetFinishTime: String) async throws {
        let path = "/api/users/me/race-strategies/\(raceId)?target=\(Self.query(targetFinishTime))"
        _ = try await api.send(APIRequest(method: .delete, path: path))
    }

    // MARK: - 自定义比赛与聚合（custom-races.ts）

    /// 聚合列表：官方计划卡 + 自定义卡混排（未结束升序、已结束沉底，后端排好）。
    public func myRaces() async throws -> [MyRaceItem] {
        let res = try await api.send(APIRequest(path: "/api/users/me/my-races"), as: MyRaceAggregateResponse.self)
        return res.items
    }

    public func createCustomRace(_ body: CustomRaceBody) async throws {
        let data = try JSONEncoder().encode(body)
        _ = try await api.send(APIRequest(method: .post, path: "/api/users/me/custom-races", body: data))
    }

    /// 全量更新（缺省可选字段会被清空——body 侧显式 null/空串）。
    public func updateCustomRace(id: Int, _ body: CustomRaceBody) async throws {
        let data = try JSONEncoder().encode(body)
        _ = try await api.send(APIRequest(method: .put, path: "/api/users/me/custom-races/\(id)", body: data))
    }

    /// 物理删除；id 非本人或不存在时 404，调用方按已删除处理。
    public func deleteCustomRace(id: Int) async throws {
        _ = try await api.send(APIRequest(method: .delete, path: "/api/users/me/custom-races/\(id)"))
    }

    // MARK: - 我的成绩（races.ts）

    /// 已确认比赛列表（新→旧）；明细 join 自 activities。
    public func results(userId: String) async throws -> [RaceResultItem] {
        let res = try await api.send(
            APIRequest(path: "/api/\(Self.escaped(userId))/races"),
            as: RacesResponse.self
        )
        return res.races
    }

    /// 设置手输名；空串 = 清除（后端 trim 后落 NULL）。204。
    public func setDisplayName(userId: String, labelId: String, name: String) async throws {
        let body = try JSONEncoder().encode(["display_name": name])
        _ = try await api.send(
            APIRequest(method: .patch, path: "/api/\(Self.escaped(userId))/races/\(Self.escaped(labelId))", body: body)
        )
    }

    /// 清除日历识别（「这不是这场比赛」）：断开关联并记 user_cleared。204。
    public func clearCalendarMatch(userId: String, labelId: String) async throws {
        _ = try await api.send(
            APIRequest(method: .delete, path: "/api/\(Self.escaped(userId))/races/\(Self.escaped(labelId))/calendar-match")
        )
    }

    // MARK: - 转义

    /// query 值百分号编码（encodeURIComponent 等价）。
    private static func query(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? raw
    }

    /// 路径段百分号编码。
    private static func escaped(_ raw: String) -> String {
        query(raw)
    }
}
