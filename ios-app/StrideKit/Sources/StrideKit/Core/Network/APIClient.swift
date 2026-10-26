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

    public init(method: Method = .get, path: String, body: Data? = nil, authorized: Bool = true) {
        self.method = method
        self.path = path
        self.body = body
        self.authorized = authorized
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

    public private(set) var config: APIConfig
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
    private func makeURLRequest(base: URL, path: String, method: String, body: Data?) -> URLRequest {
        var urlRequest = URLRequest(url: base.appending(path: path))
        urlRequest.httpMethod = method
        urlRequest.httpBody = body
        urlRequest.timeoutInterval = config.timeout
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(config.clientID, forHTTPHeaderField: "X-Client-Id")
        return urlRequest
    }

    private func perform(_ request: APIRequest, overridingToken: String? = nil) async throws -> (data: Data, response: HTTPURLResponse) {
        var urlRequest = makeURLRequest(
            base: config.baseURL, path: request.path,
            method: request.method.rawValue, body: request.body
        )
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

/// `GET /api/users/me` 返回面（骨架取会话验证所需最小字段；登录域 PR-2 展开）。
public struct MeUser: Decodable, Hashable, Sendable {
    public let id: String
    public let email: String?
    public let displayName: String?

    public init(id: String, email: String? = nil, displayName: String? = nil) {
        self.id = id
        self.email = email
        self.displayName = displayName
    }

    enum CodingKeys: String, CodingKey {
        case id, email
        case displayName = "display_name"
    }
}
