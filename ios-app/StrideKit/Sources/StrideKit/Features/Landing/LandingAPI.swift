import Foundation

// MARK: - 分享落地域 API（PR-7 收尾域 devops#770，规格 #758 拍板 2）
//
// 三个公开免登录端点（PUBLIC_ENTRY_PAGES 语义）+ 保存/推送链（workout-share
// 双 CTA）。端点零新增（mapping.md §0）。

/// `GET /api/workouts/shared/{user}/{workout}` 响应（免登录公开读）。
/// spec 按 kind 分流解码（run=blocks / strength=exercises），原样 JSON 保存
/// （保存链回传 upsert 端点）。
public struct SharedWorkout: Decodable, Sendable, Equatable {
    public let kind: String
    public let name: String
    public let summary: String?
    /// 分享者（A）的原排期日，上海本地 YYYY-MM-DD。
    public let date: String
    public let spec: RunWorkoutSpec?
    public let strengthSpec: StrengthWorkoutSpec?
    public let totalDistanceM: Double?
    public let totalDurationS: Double?
    public let estimatedDose: Double?

    enum CodingKeys: String, CodingKey {
        case kind, name, summary, date, spec
        case totalDistanceM = "total_distance_m"
        case totalDurationS = "total_duration_s"
        case estimatedDose = "estimated_dose"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(String.self, forKey: .kind)
        name = try container.decode(String.self, forKey: .name)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        date = try container.decodeIfPresent(String.self, forKey: .date) ?? ""
        totalDistanceM = try container.decodeIfPresent(Double.self, forKey: .totalDistanceM)
        totalDurationS = try container.decodeIfPresent(Double.self, forKey: .totalDurationS)
        estimatedDose = try container.decodeIfPresent(Double.self, forKey: .estimatedDose)
        // 存量内容可能剥离判别符（#584 前），按 kind + 形状分流而不是只信 kind。
        if kind == "run", let run = try? container.decode(RunWorkoutSpec.self, forKey: .spec),
           !run.blocks.isEmpty {
            spec = run
            strengthSpec = nil
        } else if kind == "strength", let strength = try? container.decode(StrengthWorkoutSpec.self, forKey: .spec),
                  !strength.exercises.isEmpty {
            spec = nil
            strengthSpec = strength
        } else {
            spec = try? container.decode(RunWorkoutSpec.self, forKey: .spec)
            strengthSpec = try? container.decode(StrengthWorkoutSpec.self, forKey: .spec)
        }
    }

    public init(kind: String, name: String, summary: String?, date: String,
                spec: RunWorkoutSpec?, strengthSpec: StrengthWorkoutSpec?,
                totalDistanceM: Double?, totalDurationS: Double?, estimatedDose: Double?) {
        self.kind = kind
        self.name = name
        self.summary = summary
        self.date = date
        self.spec = spec
        self.strengthSpec = strengthSpec
        self.totalDistanceM = totalDistanceM
        self.totalDurationS = totalDurationS
        self.estimatedDose = estimatedDose
    }
}

// MARK: - 自建课 upsert / 推送（workout-share 双 CTA 保存链）

/// `POST /api/users/me/custom-workouts` 保存体（save_token 幂等；分享课
/// 用 `shared-{workoutId}`，重放同 token 更新同一行）。spec 是公开端点
/// 响应里的不透明 JSON 对象，原样透传（JSONSerialization 往返，无损）。
///（不走 Codable：Data 字段会被合成编码成 base64 串，序列化只经 `encoded()`。）
public struct SaveCustomWorkoutBody: Sendable, Equatable {
    public let date: String
    public let kind: String
    public let name: String
    public let summary: String
    /// 不透明 spec JSON（公开端点响应原样透传）。
    public let spec: Data?
    public let totalDistanceM: Double?
    public let totalDurationS: Double?
    public let estimatedDose: Double?
    public let saveToken: String

    public init(date: String, kind: String, name: String, summary: String, spec: Data?,
                totalDistanceM: Double?, totalDurationS: Double?, estimatedDose: Double?, saveToken: String) {
        self.date = date
        self.kind = kind
        self.name = name
        self.summary = summary
        self.spec = spec
        self.totalDistanceM = totalDistanceM
        self.totalDurationS = totalDurationS
        self.estimatedDose = estimatedDose
        self.saveToken = saveToken
    }

    /// JSONSerialization 组包（spec 以 JSON 值嵌入而不是 base64 字符串）。
    public func encoded() throws -> Data {
        var dict: [String: Any] = [
            "date": date,
            "kind": kind,
            "name": name,
            "summary": summary,
            "save_token": saveToken,
        ]
        if let spec, let object = try? JSONSerialization.jsonObject(with: spec) {
            dict["spec"] = object
        } else {
            dict["spec"] = NSNull()
        }
        dict["total_distance_m"] = totalDistanceM ?? NSNull()
        dict["total_duration_s"] = totalDurationS ?? NSNull()
        dict["estimated_dose"] = estimatedDose ?? NSNull()
        guard JSONSerialization.isValidJSONObject(dict) else {
            throw ApiError(statusCode: 0, code: "invalid_body", detail: "课表保存内容不合法")
        }
        return try JSONSerialization.data(withJSONObject: dict)
    }
}

/// `POST /api/users/me/custom-workouts` 响应（统一课表行，保存链取 workout_id）。
public struct SavedCustomWorkout: Decodable, Sendable, Equatable {
    public let workoutId: String

    enum CodingKeys: String, CodingKey {
        case workoutId = "workout_id"
    }
}

/// `POST /api/users/me/custom-workouts/{id}/push` 响应（取 push 成败即可）。
public struct PushCustomWorkoutResponse: Decodable, Sendable, Equatable {
    public let ok: Bool
}

// MARK: - 教练对话分享快照（coach-share 阅读端）

/// `GET /api/coach-shares/{sid}` 消息行（与 coach 历史同形：user 纯文本 /
/// assistant markdown + 卡片信封）。卡片信封沿用 coach 域口径：JSONSerialization
/// 取原始 JSON 后经 `CoachCardWire.parse` 宽松解析（不合格回 nil）。
public struct CoachShareMessage: Sendable, Equatable {
    public enum Role: String, Sendable {
        case user
        case assistant
    }

    public let role: Role
    public let content: String
    public let card: CoachCardWire?

    public init(role: Role, content: String, card: CoachCardWire? = nil) {
        self.role = role
        self.content = content
        self.card = card
    }
}

/// `GET /api/coach-shares/{sid}` 200 快照：30 天过期（410）在服务端读取时
/// 计算，频控 60/min/IP（429）。
public struct CoachShareSnapshot: Sendable, Equatable {
    public let status: String
    public let sharerName: String?
    public let messageCount: Int
    public let createdAt: String
    public let wxacodeURL: String?
    public let messages: [CoachShareMessage]

    public init(status: String, sharerName: String?, messageCount: Int,
                createdAt: String, wxacodeURL: String?, messages: [CoachShareMessage]) {
        self.status = status
        self.sharerName = sharerName
        self.messageCount = messageCount
        self.createdAt = createdAt
        self.wxacodeURL = wxacodeURL
        self.messages = messages
    }
}

// MARK: - 比赛策略只读分享（strategy-share，#506 三元组）
//
// 策略内容块复用赛事域 `RaceStrategyContent`（PR-6 定稿的
// coach_contract RaceStrategySchema 镜像），视图构建复用 `toStrategyView`
// （Features/Races/StrategyDisplay.swift）——报告页与只读落地页同一套语言。

/// `GET /api/race-strategies/shared/{user}/{race}/{version}` 的响应：一版策略 + 渲染上下文。
public struct SharedRaceStrategyResponse: Decodable, Sendable, Equatable {
    public struct RaceContext: Decodable, Sendable, Equatable {
        public let name: String
        public let raceDate: String

        enum CodingKeys: String, CodingKey {
            case name
            case raceDate = "race_date"
        }
    }

    public struct StrategyVersion: Decodable, Sendable, Equatable {
        public let content: RaceStrategyContent
    }

    public let race: RaceContext
    public let strategy: StrategyVersion
}

// MARK: - APIClient 分享落地域端点

extension APIClient {

    /// 分享课公开读（免登录；端点任何 miss 都回 404 →「该分享已失效」）。
    public func sharedWorkout(user: String, workout: String) async throws -> SharedWorkout {
        try await send(
            APIRequest(path: "/api/workouts/shared/\(Self.escapedPath(user))/\(Self.escapedPath(workout))", authorized: false),
            as: SharedWorkout.self
        )
    }

    /// 保存自建课（save_token 幂等 upsert：重放同一 token 更新同一行）。
    public func saveCustomWorkout(_ body: SaveCustomWorkoutBody) async throws -> SavedCustomWorkout {
        let data = try body.encoded()
        return try await send(
            APIRequest(method: .post, path: "/api/users/me/custom-workouts", body: data),
            as: SavedCustomWorkout.self
        )
    }

    /// 推送自建课到手表（未保存先保存的幂等链由调用方保证先后）。
    public func pushCustomWorkout(workoutId: String, targetDate: String?) async throws {
        let path = "/api/users/me/custom-workouts/\(Self.escapedPath(workoutId))/push"
            + (targetDate.map { "?target_date=\($0)" } ?? "")
        _ = try await send(
            APIRequest(method: .post, path: path),
            as: PushCustomWorkoutResponse.self
        )
    }

    /// 教练对话分享快照公开读（免登录；404 不存在 / 410 过期由调用方分流）。
    /// 卡片信封经 JSONSerialization 原样取回再交 CoachCardWire.parse（与 coach
    /// 域 fetchHistory 同口径；Codable 拿不到原始子树 JSON）。
    public func coachShare(sid: String) async throws -> CoachShareSnapshot {
        let data = try await send(
            APIRequest(path: "/api/coach-shares/\(Self.escapedPath(sid))", authorized: false)
        )
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messageRows = object["messages"] as? [[String: Any]] else {
            throw ApiError.decodeFailure(CoachShareSnapshot.self)
        }
        let messages = messageRows.compactMap { row -> CoachShareMessage? in
            guard let content = row["content"] as? String else { return nil }
            return CoachShareMessage(
                role: (row["role"] as? String) == "user" ? .user : .assistant,
                content: content,
                card: CoachCardWire.parse(row["card"].flatMap { try? JSONSerialization.data(withJSONObject: $0) })
            )
        }
        return CoachShareSnapshot(
            status: (object["status"] as? String) ?? "active",
            sharerName: object["sharer_name"] as? String,
            messageCount: (object["message_count"] as? Int) ?? messages.count,
            createdAt: (object["created_at"] as? String) ?? "",
            wxacodeURL: object["wxacode_url"] as? String,
            messages: messages
        )
    }

    /// 比赛策略只读分享公开读（免登录；链接三元组即访问边界）。
    public func sharedRaceStrategy(user: String, raceId: Int, versionId: Int) async throws -> SharedRaceStrategyResponse {
        try await send(
            APIRequest(path: "/api/race-strategies/shared/\(Self.escapedPath(user))/\(raceId)/\(versionId)", authorized: false),
            as: SharedRaceStrategyResponse.self
        )
    }

    /// 路径段百分号编码（encodeURIComponent 等价）。
    static func escapedPath(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))) ?? raw
    }
}
