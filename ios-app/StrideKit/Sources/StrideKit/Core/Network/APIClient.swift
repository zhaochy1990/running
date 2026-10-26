import Foundation
import os

/// HTTP 传输抽象（测试注入用；URLSession 提供生产实现）。
/// 返回 `URLResponse` 与 URLSession 原生签名一致，消费点统一经
/// `httpResponse` 下转拿状态码。
public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: HTTPTransport {}

extension HTTPTransport {
    /// 下转 + 非空响应兜底（http(s) 请求的 URLResponse 恒为 HTTPURLResponse）。
    func data(forHTTP request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ApiError(statusCode: 0, code: "non_http_response", detail: "非 HTTP 响应")
        }
        return (data, http)
    }
}

/// API 请求描述（沿小程序 `services/request.ts RequestOptions` 的实测面）。
public struct APIRequest: Sendable {
    public enum Method: String, Sendable {
        case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
    }

    public var method: Method
    /// 相对路径（拼到 `config.baseURL`），如 `/api/users/me`。
    public var path: String
    public var body: Data?
    /// 是否带 Bearer 并启用 401 刷新链（公开落地端点传 false）。
    public var authorized: Bool
    /// 走 auth-service base（同域分流下与 baseURL 同值；显式标记，登录域
    /// 端点 `/api/auth/*`、`/api/users/me` 身份面用它，分域部署时不改调用点）。
    public var authBase: Bool
    /// 追加请求头（如同步触发的 `Idempotency-Key`）。
    public var headers: [String: String]

    public init(
        method: Method = .get,
        path: String,
        body: Data? = nil,
        authorized: Bool = true,
        authBase: Bool = false,
        headers: [String: String] = [:]
    ) {
        self.method = method
        self.path = path
        self.body = body
        self.authorized = authorized
        self.authBase = authBase
        self.headers = headers
    }
}

/// 请求层底座（devops#749 §7.1，1:1 沿小程序 `services/request.ts` 语义）：
///
/// - 头部：`Content-Type: application/json` + `X-Client-Id` + `Bearer`
/// - 401 → refresh **单飞**（并发 401 共享同一刷新）→ 重试一次
/// - 刷新失败 → 清 Keychain → `sessionExpiredHandler`（AppModel 切全屏
///   Login + redirect 回跳；微信免密恢复链路不迁，devops#751 决议 2）
/// - 错误体双格式归一 `ApiError`
///
/// 日志只打方法+路径+状态码（小程序侧的 body 脱敏日志在骨架期直接不落
/// body，敏感字段零出口；域票需要 body 排障时再带 redact 清单补）。
public actor APIClient {

    /// 环境配置（不可变、Sendable → nonisolated 可同步读；分享链接等
    /// MainActor 场景免 await，devops#769）。
    public nonisolated let config: APIConfig
    private let tokens: any TokenStore
    private let transport: any HTTPTransport
    private var refreshTask: Task<String, Error>?
    private var sessionExpiredHandler: (@MainActor @Sendable () async -> Void)?
    private let log = Logger(subsystem: "com.lipaotech.stridewise", category: "api")

    public init(
        config: APIConfig = APIConfig(),
        tokens: any TokenStore,
        transport: any HTTPTransport = URLSession.shared
    ) {
        self.config = config
        self.tokens = tokens
        self.transport = transport
    }

    /// 装配会话失效回调（AppModel 初始化完成后注入，避免构造期 self 捕获）。
    public func setSessionExpiredHandler(_ handler: @escaping @MainActor @Sendable () async -> Void) {
        sessionExpiredHandler = handler
    }

    /// 主动登出/注销后清 Keychain（退出登录与 DELETE 账号共用；
    /// `userStore.clear` 的 token 面）。
    public func clearTokens() async {
        await tokens.clear()
    }

    // MARK: - 公开请求面

    public func send(_ request: APIRequest) async throws -> Data {
        let response = try await sendRaw(request)
        return response.data
    }

    public func send<Value: Decodable>(_ request: APIRequest, as type: Value.Type) async throws -> Value {
        let data = try await send(request)
        do {
            return try JSONDecoder().decode(Value.self, from: data)
        } catch {
            throw ApiError.decodeFailure(Value.self)
        }
    }

    /// 当前用户（会话验证；`GET /api/users/me`，auth-service）。
    public func validateSession() async throws -> MeUser {
        try await send(APIRequest(path: "/api/users/me"), as: MeUser.self)
    }

    // MARK: - 核心流程

    private func sendRaw(_ request: APIRequest) async throws -> (data: Data, response: HTTPURLResponse) {
        let first = try await perform(request)
        if (200..<300).contains(first.response.statusCode) {
            log.debug("← \(first.response.statusCode) \(request.method.rawValue) \(request.path)")
            return first
        }
        guard first.response.statusCode == 401, request.authorized else {
            throw ApiError.make(statusCode: first.response.statusCode, body: first.data)
        }

        // 401 → 单飞刷新 → 原请求重试一次
        let newToken: String
        do {
            newToken = try await refreshedAccessToken()
        } catch {
            await tokens.clear()
            log.warning("会话失效：已清 token，交由 App 层切登录页")
            if let sessionExpiredHandler {
                await sessionExpiredHandler()
            }
            throw ApiError.sessionExpired
        }
        let retry = try await perform(request, overridingToken: newToken)
        if (200..<300).contains(retry.response.statusCode) {
            log.debug("← \(retry.response.statusCode) \(request.method.rawValue) \(request.path)（refresh 后重试成功）")
            return retry
        }
        throw ApiError.make(statusCode: retry.response.statusCode, body: retry.data)
    }

    /// 统一 URLRequest 底座：方法/超时/Content-Type/X-Client-Id（协议头部约定）。
    ///
    /// path 内可携带 `?a=b` query（沿用调用点拼串惯例）：`URL.appending(path:)`
    /// 会把 `?` 编成 `%3F` 破坏 query，这里拆开经 URLComponents 重组——
    /// 顺带修复记录域 `?include=timeseries` / `?limit=&offset=` 的既有缺陷
    /// （PR-7 收尾域落地时发现，服务端此前会把整段当路径 404）。
    private func makeURLRequest(base: URL, path: String, method: String, body: Data?) -> URLRequest {
        let url: URL
        if let questionMark = path.firstIndex(of: "?") {
            var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
            components.path = String(path[path.startIndex..<questionMark])
            components.percentEncodedQuery = String(path[path.index(after: questionMark)...])
            url = components.url ?? base.appending(path: path)
        } else {
            url = base.appending(path: path)
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.httpBody = body
        urlRequest.timeoutInterval = config.timeout
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(config.clientID, forHTTPHeaderField: "X-Client-Id")
        return urlRequest
    }

    private func perform(_ request: APIRequest, overridingToken: String? = nil) async throws -> (data: Data, response: HTTPURLResponse) {
        var urlRequest = makeURLRequest(
            base: request.authBase ? config.authBaseURL : config.baseURL,
            path: request.path,
            method: request.method.rawValue,
            body: request.body
        )
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        if request.authorized {
            let token: String?
            if let overridingToken {
                token = overridingToken
            } else {
                token = await tokens.accessToken()
            }
            if let token {
                urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
        }
        log.debug("→ \(request.method.rawValue) \(request.path)")
        return try await transport.data(forHTTP: urlRequest)
    }

    // MARK: - 头像上传（wx.uploadFile 的 URLSession 等价，PR-2 登录域）

    /// 上传头像到 auth-service（`POST {auth}/api/users/me/avatar`，
    /// multipart 字段名 `file`，auth-service 写 COS 后回 `{avatar_url}`；
    /// 小程序 services/profile.ts uploadAvatar 的等价实现）。
    public func uploadAvatar(_ imageData: Data, mimeType: String = "image/jpeg") async throws -> String {
        let boundary = "stride-\(UUID().uuidString)"
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"avatar\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var urlRequest = makeURLRequest(
            base: config.authBaseURL, path: "/api/users/me/avatar",
            method: "POST", body: body
        )
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token = await tokens.accessToken() {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        log.debug("→ POST /api/users/me/avatar（multipart）")
        let (data, response) = try await transport.data(forHTTP: urlRequest)
        guard (200..<300).contains(response.statusCode) else {
            throw ApiError.make(statusCode: response.statusCode, body: data)
        }
        struct AvatarResponse: Decodable {
            let avatarURL: String
            enum CodingKeys: String, CodingKey { case avatarURL = "avatar_url" }
        }
        do {
            return try JSONDecoder().decode(AvatarResponse.self, from: data).avatarURL
        } catch {
            throw ApiError.decodeFailure(AvatarResponse.self)
        }
    }

    // MARK: - 反馈图片上传（wx.uploadFile 的 URLSession 等价，PR-7 收尾域）

    /// 上传一张反馈图片，返回后端 cos_key（`POST /api/users/me/feedback-images`，
    /// multipart 字段名 `file`，「先传拿 key 再提交」两段式的前段；单张 ≤10MB
    /// 由调用方过滤——小程序 chooseMedia 跳过超限图的语义）。
    public func uploadFeedbackImage(_ imageData: Data, mimeType: String = "image/jpeg") async throws -> String {
        let boundary = "stride-\(UUID().uuidString)"
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"feedback\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var urlRequest = makeURLRequest(
            base: config.baseURL, path: "/api/users/me/feedback-images",
            method: "POST", body: body
        )
        urlRequest.timeoutInterval = 60
        urlRequest.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token = await tokens.accessToken() {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        log.debug("→ POST /api/users/me/feedback-images（multipart）")
        let (data, response) = try await transport.data(forHTTP: urlRequest)
        guard (200..<300).contains(response.statusCode) else {
            throw ApiError.make(statusCode: response.statusCode, body: data)
        }
        struct CosKeyResponse: Decodable {
            let cosKey: String
            enum CodingKeys: String, CodingKey { case cosKey = "cos_key" }
        }
        do {
            return try JSONDecoder().decode(CosKeyResponse.self, from: data).cosKey
        } catch {
            throw ApiError.decodeFailure(CosKeyResponse.self)
        }
    }

    // MARK: - 刷新单飞（request.ts refreshPromise 等价）

    private func refreshedAccessToken() async throws -> String {
        if let refreshTask {
            return try await refreshTask.value
        }
        let task = Task<String, Error> { try await performRefresh() }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    private struct RefreshResponse: Decodable {
        let access_token: String
        let refresh_token: String
        let expires_in: Int
    }

    private func performRefresh() async throws -> String {
        guard let refreshToken = await tokens.refreshToken() else {
            throw ApiError(statusCode: 0, code: "no_refresh_token", detail: "无 refresh token")
        }
        let body = try JSONEncoder().encode(["refresh_token": refreshToken])
        let urlRequest = makeURLRequest(
            base: config.authBaseURL, path: "/api/auth/refresh",
            method: "POST", body: body
        )
        let (data, response) = try await transport.data(forHTTP: urlRequest)
        guard response.statusCode == 200 else {
            throw ApiError.make(statusCode: response.statusCode, body: data)
        }
        let refreshed = try JSONDecoder().decode(RefreshResponse.self, from: data)
        await tokens.save(access: refreshed.access_token, refresh: refreshed.refresh_token, expiresIn: TimeInterval(refreshed.expires_in))
        return refreshed.access_token
    }
}

/// `GET /api/users/me` 返回面（auth-service `UserProfile` 镜像：身份面的
/// name/avatar_url 全 optional；`display_name` 是数据面镜像字段，身份优先）。
public struct MeUser: Decodable, Hashable, Sendable {
    public let id: String
    public let email: String?
    public let name: String?
    public let avatarURL: String?
    public let displayName: String?

    /// 展示名（身份 name 优先，display_name 镜像兜底）。
    public var displayTitle: String? {
        if let name, !name.isEmpty { return name }
        if let displayName, !displayName.isEmpty { return displayName }
        return nil
    }

    public init(id: String, email: String? = nil, name: String? = nil,
                avatarURL: String? = nil, displayName: String? = nil) {
        self.id = id
        self.email = email
        self.name = name
        self.avatarURL = avatarURL
        self.displayName = displayName
    }

    enum CodingKeys: String, CodingKey {
        case id, email, name
        case avatarURL = "avatar_url"
        case displayName = "display_name"
    }
}
