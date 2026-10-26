import Foundation

/// 训练域数据仓库（devops#768 PR-5）：周计划 / 统一课表三源投影 / 手表推送 /
/// 自建课删除 / master-plan current / 训练状态数据面（health·hrv·zones·load）。
/// 端点 1:1 沿小程序 `services/plan.ts` / `master-plan.ts` / `health.ts`
/// （devops#749 §7.1 端点零新增）。
public final class TrainingRepository: Sendable {

    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    // MARK: - 周计划 / 统一课表

    /// 拉取某周（上海周目录名 `YYYY-MM-DD_MM-DD`，周一起始）的训练计划详情。
    public func weeklyPlan(userId: String, weekName: String) async throws -> WeeklyPlanDetail {
        let path = "/api/\(Self.escaped(userId))/plan/weeks/\(Self.escaped(weekName))"
        return try await api.send(APIRequest(path: path), as: WeeklyPlanDetail.self)
    }

    /// 统一课表投影：某日期段的三源 active 课次（weekly→custom→watch 排序）。
    public func planSessions(userId: String, dateFrom: String, dateTo: String) async throws -> [PlanSessionRow] {
        let path = "/api/users/me/plan/sessions?date_from=\(dateFrom)&date_to=\(dateTo)"
        let res = try await api.send(APIRequest(path: path), as: PlanSessionsResponse.self)
        return res.sessions
    }

    /// 推送计划 session 到手表（targetDate 范围 ±7 天，服务端校验）。
    public func pushPlannedSession(userId: String, date: String, sessionIndex: Int, targetDate: String) async throws {
        let path = "/api/\(Self.escaped(userId))/plan/sessions/\(Self.escaped(date))/\(sessionIndex)/push?target_date=\(targetDate)"
        _ = try await api.send(APIRequest(method: .post, path: path), as: PushWorkoutResponse.self)
    }

    /// 推送自建课到手表（未保存先保存的幂等链由调用方保证先后）。
    public func pushCustomWorkout(workoutId: String) async throws {
        let path = "/api/users/me/custom-workouts/\(Self.escaped(workoutId))/push"
        _ = try await api.send(APIRequest(method: .post, path: path), as: PushWorkoutResponse.self)
    }

    /// 删除自建课（软删：服务端归档该行）。响应是 204 空 body（workout.go
    /// deleteCustom），走原始 send 不做 JSON 解码。
    public func deleteCustomWorkout(workoutId: String) async throws {
        let path = "/api/users/me/custom-workouts/\(Self.escaped(workoutId))"
        _ = try await api.send(APIRequest(method: .delete, path: path))
    }

    // MARK: - master-plan

    /// 当前启用中的赛季计划；没有（404）返回 nil，其余错误原样抛出。
    public func currentMasterPlan(userId: String) async throws -> CurrentSeasonPlan? {
        let path = "/api/users/\(Self.escaped(userId))/master-plan/current"
        do {
            return try await api.send(APIRequest(path: path), as: CurrentSeasonPlan.self)
        } catch let error as ApiError where error.statusCode == 404 {
            return nil
        }
    }

    // MARK: - 训练状态数据面

    /// 健康记录 + HRV 快照 + RHR 基线（`GET /api/{user}/health?days=`）。
    public func health(userId: String, days: Int) async throws -> HealthResponse {
        try await api.send(APIRequest(path: "/api/\(Self.escaped(userId))/health?days=\(days)"), as: HealthResponse.self)
    }

    /// 逐日 HRV 记录（`GET /api/{user}/hrv?days=`）。
    public func hrv(userId: String, days: Int) async throws -> HrvResponse {
        try await api.send(APIRequest(path: "/api/\(Self.escaped(userId))/hrv?days=\(days)"), as: HrvResponse.self)
    }

    /// STRIDE 阈值 + 配速/心率区间（`GET /api/{user}/stride/zones`）。
    public func strideZones(userId: String) async throws -> StrideZonesResponse {
        try await api.send(APIRequest(path: "/api/\(Self.escaped(userId))/stride/zones"), as: StrideZonesResponse.self)
    }

    /// STRIDE 训练负荷 current + series（`GET /api/{user}/stride/training-load?days=`）。
    public func trainingLoad(userId: String, days: Int) async throws -> StrideTrainingLoadResponse {
        try await api.send(
            APIRequest(path: "/api/\(Self.escaped(userId))/stride/training-load?days=\(days)"),
            as: StrideTrainingLoadResponse.self
        )
    }

    /// 路径段百分号编码（encodeURIComponent 等价）。
    private static func escaped(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? raw
    }
}
