import Foundation

// MARK: - 产品路线服务层（devops#551 契约 #515，PR-7 收尾域 devops#770）
//
//	GET    /api/roadmap                    summary + 三区分组（一次拉全，后端已排序）
//	GET    /api/roadmap/features/{id}      详情（markdown 正文；draft 404）
//	POST   /api/roadmap/features/{id}/vote 投票（幂等；仅 Backlog 可投，否则 409 not_votable）
//	DELETE /api/roadmap/features/{id}/vote 撤销（幂等）
//
// 投票/撤销后由页面本地重排，不重拉列表（devops#553；纯逻辑在 RoadmapRows）。

/// `GET /api/roadmap` 的 summary 聚合块。
public struct RoadmapSummary: Decodable, Sendable, Equatable {
    public let myVotes: Int
    public let totalVotes: Int
    public let releasedCount: Int

    enum CodingKeys: String, CodingKey {
        case myVotes = "my_votes"
        case totalVotes = "total_votes"
        case releasedCount = "released_count"
    }
}

/// 一个可投票的 Backlog 想法。voted 是调用者自己的投票状态。
public struct RoadmapBacklogItem: Decodable, Sendable, Equatable {
    public let id: Int
    public let title: String
    /// 列表概述（≤50 字），可能为空（存量行，客户端兜底截断描述）。
    public let summary: String?
    /// 详细描述（可含 markdown），只在详情页渲染。
    public let description: String
    public let category: String
    /// 创建 ≤7 天（Asia/Shanghai）派生的新想法徽章。
    public let isNew: Bool
    public let votes: Int
    public let voted: Bool

    enum CodingKeys: String, CodingKey {
        case id, title, summary, description, category, votes, voted
        case isNew = "is_new"
    }
}

/// 一个已排期（Accepted）想法；票数只读、实时。
public struct RoadmapAcceptedItem: Decodable, Sendable, Equatable {
    public let id: Int
    public let title: String
    public let summary: String?
    public let description: String
    public let category: String
    /// 预计上线说明（如 2026.11），可能为空。
    public let plannedNote: String
    public let votes: Int

    enum CodingKeys: String, CodingKey {
        case id, title, summary, description, category, votes
        case plannedNote = "planned_note"
    }
}

/// 一个已上线（Released）想法；票数是发布时的快照，恒定。
public struct RoadmapReleasedItem: Decodable, Sendable, Equatable {
    public let id: Int
    public let title: String
    public let summary: String?
    public let description: String
    /// 上海时区 RFC3339。
    public let releasedAt: String
    public let votesSnapshot: Int

    enum CodingKeys: String, CodingKey {
        case id, title, summary, description
        case releasedAt = "released_at"
        case votesSnapshot = "votes_snapshot"
    }
}

public struct RoadmapResponse: Decodable, Sendable, Equatable {
    public let summary: RoadmapSummary
    public let backlog: [RoadmapBacklogItem]
    public let accepted: [RoadmapAcceptedItem]
    public let released: [RoadmapReleasedItem]
}

/// POST/DELETE vote 的响应：操作后的最终状态（幂等）。
public struct RoadmapVoteResult: Decodable, Sendable, Equatable {
    public let featureId: Int
    public let voted: Bool

    enum CodingKeys: String, CodingKey {
        case featureId = "feature_id"
        case voted
    }
}

/// 详情页数据（`GET /api/roadmap/features/{id}`）。draft 不外露（404）。
public struct RoadmapFeatureDetail: Decodable, Sendable, Equatable {
    public let id: Int
    public let title: String
    public let summary: String
    /// 详细描述，markdown，详情页唯一正文。
    public let description: String
    public let category: String
    public let status: String
    public let plannedNote: String
    /// 上海时区 RFC3339，未上线为 null。
    public let releasedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, summary, description, category, status
        case plannedNote = "planned_note"
        case releasedAt = "released_at"
    }
}

// MARK: - APIClient 产品路线端点

extension APIClient {

    /// 拉取产品路线全量（summary + backlog/accepted/released，后端已排序）。
    public func roadmap() async throws -> RoadmapResponse {
        try await send(APIRequest(path: "/api/roadmap"), as: RoadmapResponse.self)
    }

    /// 拉取一个想法的详情（详情页渲染 markdown 正文；draft 404）。
    public func roadmapFeature(_ featureId: Int) async throws -> RoadmapFeatureDetail {
        try await send(APIRequest(path: "/api/roadmap/features/\(featureId)"), as: RoadmapFeatureDetail.self)
    }

    /// 给一个想法投票（幂等；重复调用结果一致，弱网重试安全）。
    public func voteRoadmapFeature(_ featureId: Int) async throws -> RoadmapVoteResult {
        try await send(
            APIRequest(method: .post, path: "/api/roadmap/features/\(featureId)/vote"),
            as: RoadmapVoteResult.self
        )
    }

    /// 撤回对一个想法的投票（幂等）。
    public func unvoteRoadmapFeature(_ featureId: Int) async throws -> RoadmapVoteResult {
        try await send(
            APIRequest(method: .delete, path: "/api/roadmap/features/\(featureId)/vote"),
            as: RoadmapVoteResult.self
        )
    }
}
