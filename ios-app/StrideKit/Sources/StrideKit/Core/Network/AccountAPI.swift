import Foundation

// MARK: - 账号域 API 模型（Go 活契约的客户端镜像，devops#418 端点表 / #747 §1）

/// `GET /api/users/me/profile` 的 onboarding 状态块。
public struct OnboardingState: Decodable, Sendable, Equatable {
    /// 已绑表。
    public let watchReady: Bool
    /// 基础档案六字段已建（ADR 0013 必填）。
    public let profileReady: Bool
    /// 完成时间；nil = 尚未完成（解绑手表会被服务端重置回 nil）。
    public let completedAt: String?

    enum CodingKeys: String, CodingKey {
        case watchReady = "watch_ready"
        case profileReady = "profile_ready"
        case completedAt = "completed_at"
    }
}

/// 部署侧特性开关块（`features`；只取 onboarding 用到的）。
public struct ProfileFeatureFlags: Decodable, Sendable, Equatable {
    /// config.yml 的 sync-data-at-onboarding：onboarding 时是否同步数据。
    /// 缺失按「关」处理——宁可不动 24 分钟的 pipeline，不在开关未知时乱触发。
    public let syncDataAtOnboarding: Bool?

    enum CodingKeys: String, CodingKey {
        case syncDataAtOnboarding = "sync_data_at_onboarding"
    }
}

/// `GET /api/users/me/profile` 响应（onboarding 状态源 + userId）。
public struct MyProfile: Decodable, Sendable, Equatable {
    public let id: String
    public let displayName: String?
    /// 顶层跑龄档（profile 未建立时的兜底展示档位）。
    public let runningAgeRange: String?
    /// 身体档案核心六字段；nil = 尚未建立（整表 POST 建立）。
    public let profile: ProfileCore?
    public let onboarding: OnboardingState?
    public let features: ProfileFeatureFlags?

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case runningAgeRange = "running_age_range"
        case profile
        case onboarding, features
    }

    public var profileReady: Bool { onboarding?.profileReady ?? false }
    public var watchReady: Bool { onboarding?.watchReady ?? false }
    public var completed: Bool { onboarding?.completedAt != nil }
    /// 部署开关（缺失按关）。
    public var syncEnabled: Bool { features?.syncDataAtOnboarding ?? false }
}

/// `POST /api/users/me/profile` 整表建档（六字段，与 Go `profileInput`
/// 严格一致——token 是提交值，中文标签只在 UI 层展示，直接传中文会 422）。
public struct ProfileInput: Encodable, Sendable, Equatable {
    public var displayName: String
    public var dob: String
    public var sex: String
    public var heightCm: Double
    public var weightKg: Double
    public var runningAgeRange: String

    public init(displayName: String, dob: String, sex: String, heightCm: Double, weightKg: Double, runningAgeRange: String) {
        self.displayName = displayName
        self.dob = dob
        self.sex = sex
        self.heightCm = heightCm
        self.weightKg = weightKg
        self.runningAgeRange = runningAgeRange
    }

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case dob, sex
        case heightCm = "height_cm"
        case weightKg = "weight_kg"
        case runningAgeRange = "running_age_range"
    }
}

/// pipeline 单步（Go `runStateResponse.steps[]`）。
public struct PipelineStep: Decodable, Sendable, Equatable {
    public let name: String
    public let status: String
}

/// pipeline run（轮询 / 认领共用形状）。
public struct PipelineRun: Decodable, Sendable, Equatable {
    public let runId: String
    public let pipelineName: String
    /// queued | running | done | failed
    public let status: String
    /// 正在跑第几步（下标基）。
    public let currentStep: Int
    public let steps: [PipelineStep]
    public let errorMessage: String?

    public var isDone: Bool { status == "done" }
    public var isFailed: Bool { status == "failed" }

    enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case pipelineName = "pipeline_name"
        case status
        case currentStep = "current_step"
        case steps
        case errorMessage = "error_message"
    }
}

/// `POST /api/{user}/sync` 响应（202 新建 / 200 deduplicated 复用）。
/// `deduplicated` 仅复用时出现（缺键 = 新建）。
public struct TriggerSyncResult: Decodable, Sendable, Equatable {
    public let runId: String
    public let deduplicated: Bool?

    enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case deduplicated
    }
}

/// `GET /api/declarations/{docType}` 响应（公开免登录）。
public struct DeclarationDoc: Decodable, Sendable, Equatable {
    public let title: String?
    public let contentMarkdown: String

    enum CodingKeys: String, CodingKey {
        case title
        case contentMarkdown = "content_markdown"
    }
}

// MARK: - PR-7 收尾域模型（devops#770：ADR 0013 身体档案面 / 手表 / 手动同步 / 注销）

/// 数据面 `GET /api/users/me/profile` 的 `profile` 核心六字段（ADR 0013；
/// null = 尚未建立，POST 整表建立后才可逐字段 PATCH）。
public struct ProfileCore: Decodable, Sendable, Equatable {
    public let displayName: String
    public let dob: String
    public let sex: String
    public let heightCm: Double
    public let weightKg: Double
    public let runningAgeRange: String

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case dob, sex
        case heightCm = "height_cm"
        case weightKg = "weight_kg"
        case runningAgeRange = "running_age_range"
    }
}

/// `PATCH /api/users/me/profile` 逐字段可提交面（省略即不变；身体段失焦保存用）。
public struct ProfilePatch: Encodable, Sendable, Equatable {
    public var dob: String?
    public var sex: String?
    public var heightCm: Double?
    public var weightKg: Double?
    public var runningAgeRange: String?

    public init(dob: String? = nil, sex: String? = nil,
                heightCm: Double? = nil, weightKg: Double? = nil, runningAgeRange: String? = nil) {
        self.dob = dob
        self.sex = sex
        self.heightCm = heightCm
        self.weightKg = weightKg
        self.runningAgeRange = runningAgeRange
    }

    enum CodingKeys: String, CodingKey {
        case dob, sex
        case heightCm = "height_cm"
        case weightKg = "weight_kg"
        case runningAgeRange = "running_age_range"
    }
}

/// `GET /api/users/me/watch` 响应（镜像 Go `watchInfoResponse`，#425 契约：
/// 未绑定 200 全 null）。
public struct WatchInfo: Decodable, Sendable, Equatable {
    public let provider: String?
    public let providerDisplayName: String?
    public let loggedIn: Bool
    public let email: String?
    public let device: String?
    public let lastSyncAt: String?
    public let capabilities: [String]

    public init(provider: String?, providerDisplayName: String?, loggedIn: Bool,
                email: String?, device: String?, lastSyncAt: String?, capabilities: [String]) {
        self.provider = provider
        self.providerDisplayName = providerDisplayName
        self.loggedIn = loggedIn
        self.email = email
        self.device = device
        self.lastSyncAt = lastSyncAt
        self.capabilities = capabilities
    }

    enum CodingKeys: String, CodingKey {
        case provider
        case providerDisplayName = "provider_display_name"
        case loggedIn = "logged_in"
        case email
        case device = "device"
        case lastSyncAt = "last_sync_at"
        case capabilities
    }
}

// MARK: - APIClient 账号域端点（devops#418 端点表全量承接）

extension APIClient {

    /// onboarding 状态源（兼 userId 提取）。
    public func myProfile() async throws -> MyProfile {
        try await send(APIRequest(path: "/api/users/me/profile"), as: MyProfile.self)
    }

    /// 整表建档（置 profile_ready，顺带镜像 display_name 到身份面）。
    public func postProfile(_ input: ProfileInput) async throws {
        let body = try JSONEncoder().encode(input)
        _ = try await send(APIRequest(method: .post, path: "/api/users/me/profile", body: body))
    }

    /// 标记 onboarding 完成（空 body 幂等；ADR 0013 资料步即 complete）。
    public func completeOnboarding() async throws {
        _ = try await send(APIRequest(method: .post, path: "/api/users/me/onboarding/complete", body: Data("{}".utf8)))
    }

    /// 绑表（多 provider 统一端点，替代 legacy /coros/login；region 对
    /// Garmin 生效：cn | global）。
    public func watchLogin(provider: String, email: String, password: String, region: String) async throws {
        struct WatchLoginBody: Encodable {
            let provider: String
            let email: String
            let password: String
            let region: String
        }
        let body = try JSONEncoder().encode(WatchLoginBody(provider: provider, email: email, password: password, region: region))
        _ = try await send(APIRequest(method: .post, path: "/api/users/me/watch/login", body: body))
    }

    /// 触发 full sync（body 只认 `{mode}`；`Idempotency-Key` 重复触发被
    /// 服务端去重返已有 run——202 新建 / 200 deduplicated）。
    public func triggerSync(user: String, idempotencyKey: String) async throws -> TriggerSyncResult {
        let body = try JSONEncoder().encode(["mode": "full"])
        return try await send(
            APIRequest(
                method: .post,
                path: "/api/\(user)/sync",
                body: body,
                headers: ["Idempotency-Key": idempotencyKey]
            ),
            as: TriggerSyncResult.self
        )
    }

    /// 读单个 run（onboarding 轮询，2s 间隔）。
    public func pipelineRun(_ runId: String) async throws -> PipelineRun {
        try await send(APIRequest(path: "/api/pipelines/\(runId)"), as: PipelineRun.self)
    }

    /// 列用户 run（新的在前；认领别端已起的 onboarding run）。
    public func userPipelines(_ user: String) async throws -> [PipelineRun] {
        struct PipelinesBody: Decodable { let pipelines: [PipelineRun] }
        let body = try await send(APIRequest(path: "/api/users/\(user)/pipelines"), as: PipelinesBody.self)
        return body.pipelines
    }

    /// 声明正文（公开免登录；docType 白名单由 `DeclarationType` 收口）。
    public func declaration(_ docType: DeclarationType) async throws -> DeclarationDoc {
        try await send(
            APIRequest(path: "/api/declarations/\(docType.rawValue)", authorized: false),
            as: DeclarationDoc.self
        )
    }

    /// 头像 URL 回写身份面（`PATCH {auth}/api/users/me {avatar_url}`；
    /// 小程序 services/profile.ts updateProfile 的等价实现）。
    public func updateAvatarURL(_ url: String) async throws {
        let body = try JSONEncoder().encode(["avatar_url": url])
        _ = try await send(APIRequest(method: .patch, path: "/api/users/me", body: body, authBase: true))
    }

    // MARK: - PR-7 收尾域端点（devops#770：ADR 0013 双面 / 手表 / 手动同步 / 注销）

    /// 昵称回写身份面（`PATCH {auth}/api/users/me {name}`；昵称失焦自动保存）。
    public func updateDisplayName(_ name: String) async throws {
        let body = try JSONEncoder().encode(["name": name])
        _ = try await send(APIRequest(method: .patch, path: "/api/users/me", body: body, authBase: true))
    }

    /// 已建立 profile 的逐字段更新（`PATCH /api/users/me/profile`；
    /// 失败由调用方回读服务端值，防界面停在未保存态）。
    @discardableResult
    public func patchMyProfile(_ patch: ProfilePatch) async throws -> ProfileCore {
        let body = try JSONEncoder().encode(patch)
        struct PatchResponse: Decodable { let profile: ProfileCore }
        return try await send(
            APIRequest(method: .patch, path: "/api/users/me/profile", body: body),
            as: PatchResponse.self
        ).profile
    }

    /// 手表状态（`GET /api/users/me/watch`；未绑定 200 全 null）。
    public func watchInfo() async throws -> WatchInfo {
        try await send(APIRequest(path: "/api/users/me/watch"), as: WatchInfo.self)
    }

    /// 解绑手表（`DELETE /api/users/me/watch`；已同步数据保留）。
    public func disconnectWatch() async throws {
        _ = try await send(APIRequest(method: .delete, path: "/api/users/me/watch"))
    }

    /// 「我」页手动同步（`POST /api/{user}/sync {mode:"incremental"}`，
    /// #425 决议：**无 Idempotency-Key**——幂等键仅 onboarding full 用；
    /// 202 新建 / 200 deduplicated 复用同形）。
    public func triggerIncrementalSync(user: String) async throws -> TriggerSyncResult {
        let body = try JSONEncoder().encode(["mode": "incremental"])
        return try await send(
            APIRequest(method: .post, path: "/api/\(user)/sync", body: body),
            as: TriggerSyncResult.self
        )
    }

    /// 注销账号（App Store 5.1.1(v) 硬要求，#759 决议 2：profile-edit 底部
    /// 危险区二次确认后调用；auth-service 原子清理 + 四步审计）。
    public func deleteAccount() async throws {
        _ = try await send(APIRequest(method: .delete, path: "/api/users/me", authBase: true))
    }
}
