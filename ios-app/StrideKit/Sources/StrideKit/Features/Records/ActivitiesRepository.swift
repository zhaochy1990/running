import Foundation

/// 记录域数据仓库（devops#766）：活动列表 + 活动详情两个端点，
/// 1:1 沿小程序 `services/activities.ts`（端点零新增，devops#749 §7.1）。
public final class ActivitiesRepository: Sendable {

    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    /// 拉取用户活动列表（limit/offset 分页；dateFrom/dateTo 本域未用不设）。
    public func list(userId: String, limit: Int, offset: Int) async throws -> ActivitiesListResponse {
        var path = "/api/\(Self.escaped(userId))/activities"
        path += "?limit=\(limit)&offset=\(offset)"
        return try await api.send(APIRequest(path: path), as: ActivitiesListResponse.self)
    }

    /// 拉取指定上海日期段（含边界）的活动：训练 tab 当日活动行 / 训练状态
    /// 16 周热力图详情共用（devops#768）。
    public func list(userId: String, dateFrom: String, dateTo: String, limit: Int, offset: Int) async throws -> ActivitiesListResponse {
        var path = "/api/\(Self.escaped(userId))/activities"
        path += "?limit=\(limit)&offset=\(offset)&date_from=\(dateFrom)&date_to=\(dateTo)"
        return try await api.send(APIRequest(path: path), as: ActivitiesListResponse.self)
    }

    /// 拉取单个活动详情（include=timeseries：轨迹地图与走势曲线需要）。
    public func detail(userId: String, labelId: String) async throws -> ActivityDetailResponse {
        let path = "/api/\(Self.escaped(userId))/activities/\(Self.escaped(labelId))?include=timeseries"
        return try await api.send(APIRequest(path: path), as: ActivityDetailResponse.self)
    }

    /// 路径段百分号编码（encodeURIComponent 等价：字母数字与 -_.~ 之外全转义）。
    private static func escaped(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? raw
    }
}
