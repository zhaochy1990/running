import Foundation

// MARK: - 意见反馈服务层（devops#554 契约，PR-7 收尾域 devops#770）
//
// 后端契约 `internal/api/feedback.go`：
//
//	POST   /api/users/me/feedback-images        传图拿 cos_key（multipart `file`，单张 ≤10MB）
//	POST   /api/users/me/feedbacks              提交（≤9 图）
//	GET    /api/users/me/feedbacks              会话列表（无分页；total_unread 喂「我的」页红点）
//	GET    /api/users/me/feedbacks/{id}         线程详情（服务端读即清官方回复未读）
//	POST   /api/users/me/feedbacks/{id}/replies 追问（已关闭 → 409 feedback_closed）
//
// client_version 静默注入（#554 定稿：bug/suggestion 一律 services 层带，
// 页面零展示）；小程序为 `wxmp/{version}`，iOS 同款 `ios/{version}`（≤32 字符）。

/// 反馈类型（与 Go storage.FeedbackTypeBug/Suggestion 一致）。
public enum FeedbackType: String, Codable, Sendable, CaseIterable {
    case bug
    case suggestion
}

/// 反馈状态三态。
public enum FeedbackStatus: String, Codable, Sendable {
    case open
    case replied
    case closed
}

/// 会话列表行（`GET /api/users/me/feedbacks` 的 items）。
public struct FeedbackItem: Decodable, Sendable, Equatable {
    public let id: Int
    public let type: FeedbackType
    public let content: String
    /// COS object key（仅提交用；展示用详情里的 image_urls）。
    public let images: [String]
    public let status: FeedbackStatus
    /// 已采纳关联的产品路线 feature id，null = 未采纳。
    public let adoptedFeatureId: Int?
    /// UTC RFC3339（展示前必须转上海墙钟，见 FeedbackRows）。
    public let createdAt: String
    /// 最新一回合（官方或本人），null = 还没人回复。
    public let lastReply: LastReply?
    /// 官方有未读回复。
    public let unread: Bool

    public struct LastReply: Decodable, Sendable, Equatable {
        public let author: String
        public let content: String
        public let createdAt: String

        enum CodingKeys: String, CodingKey {
            case author, content
            case createdAt = "created_at"
        }

        public init(author: String, content: String, createdAt: String) {
            self.author = author
            self.content = content
            self.createdAt = createdAt
        }
    }

    enum CodingKeys: String, CodingKey {
        case id, type, content, images, status, unread
        case adoptedFeatureId = "adopted_feature_id"
        case createdAt = "created_at"
        case lastReply = "last_reply"
    }
}

public struct FeedbackListResponse: Decodable, Sendable, Equatable {
    public let totalUnread: Int
    public let items: [FeedbackItem]

    enum CodingKeys: String, CodingKey {
        case totalUnread = "total_unread"
        case items
    }
}

/// 线程里的一个回合。author: user（右侧气泡）/ admin（左侧「STRIDE 团队」）。
public struct FeedbackReply: Decodable, Sendable, Equatable {
    public let id: Int
    public let author: String
    public let content: String
    /// UTC RFC3339。
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, author, content
        case createdAt = "created_at"
    }
}

/// 线程详情（`GET /api/users/me/feedbacks/{id}`；打开即服务端读即清未读）。
public struct FeedbackDetailResponse: Decodable, Sendable, Equatable {
    public struct Detail: Decodable, Sendable, Equatable {
        public let id: Int
        public let type: FeedbackType
        public let content: String
        /// 服务端由 cos_key 建好的公开 URL。
        public let imageUrls: [String]
        public let status: FeedbackStatus
        public let adoptedFeatureId: Int?
        public let createdAt: String

        enum CodingKeys: String, CodingKey {
            case id, type, content, status
            case imageUrls = "image_urls"
            case adoptedFeatureId = "adopted_feature_id"
            case createdAt = "created_at"
        }
    }

    public let feedback: Detail
    public let replies: [FeedbackReply]
}

// MARK: - APIClient 反馈域端点

extension APIClient {

    /// 客户端版本号（`ios/{version}`；≤32 字符与 Go binding max 一致，
    /// 开发态 version 为空回落 build 号，再兜底 unknown）。
    public static func feedbackClientVersion(bundle: Bundle = .main) -> String {
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let raw = "ios/\(version ?? build ?? "unknown")"
        return String(raw.prefix(32))
    }

    /// 提交反馈（≤9 张图的 cos_key 必须是本人上传得到的；client_version
    /// 静默注入，页面零展示）。
    @discardableResult
    public func submitFeedback(type: FeedbackType, content: String, images: [String],
                               clientVersion: String = APIClient.feedbackClientVersion()) async throws -> FeedbackItem {
        struct SubmitBody: Encodable {
            let type: FeedbackType
            let content: String
            let images: [String]
            let clientVersion: String

            enum CodingKeys: String, CodingKey {
                case type, content, images
                case clientVersion = "client_version"
            }
        }
        let body = try JSONEncoder().encode(
            SubmitBody(type: type, content: content, images: images, clientVersion: clientVersion)
        )
        return try await send(APIRequest(method: .post, path: "/api/users/me/feedbacks", body: body), as: FeedbackItem.self)
    }

    /// 我的反馈会话列表（无分页；total_unread 喂「我的」页红点）。
    public func listFeedbacks() async throws -> FeedbackListResponse {
        try await send(APIRequest(path: "/api/users/me/feedbacks"), as: FeedbackListResponse.self)
    }

    /// 线程详情；服务端读即清官方回复的未读。
    public func feedbackDetail(id: Int) async throws -> FeedbackDetailResponse {
        try await send(APIRequest(path: "/api/users/me/feedbacks/\(id)"), as: FeedbackDetailResponse.self)
    }

    /// 追问一条回复；已关闭的会话后端回 409 feedback_closed。
    @discardableResult
    public func replyFeedback(id: Int, content: String) async throws -> FeedbackReply {
        let body = try JSONEncoder().encode(["content": content])
        return try await send(
            APIRequest(method: .post, path: "/api/users/me/feedbacks/\(id)/replies", body: body),
            as: FeedbackReply.self
        )
    }
}
