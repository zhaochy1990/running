import Foundation

/// auth-service 登录令牌响应（`/api/auth/login`、`/api/auth/sms/verify`、
/// `/api/auth/refresh` 同形：access/refresh/expires_in）。
public struct AuthTokenSet: Decodable, Sendable, Equatable {
    public let accessToken: String
    public let refreshToken: String
    public let expiresIn: Int

    public init(accessToken: String, refreshToken: String, expiresIn: Int) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresIn = expiresIn
    }

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case expiresIn = "expires_in"
    }
}

/// 登录域服务（PR-2，devops#752 决议）：SMS 验证码（scene=login，
/// login-or-register）+ 邮箱密码两通道，零后端新端点。
///
/// - `POST /api/auth/sms/send` `{phone, scene:"login"}` → 200 `{status:"ok"}`
/// - `POST /api/auth/sms/verify` `{phone, code, invite_code?}` → TokenSet
/// - `POST /api/auth/login` `{email, password}` → TokenSet
///
/// `sms/verify` 不返回 `registered`：新旧用户区分交给 onboarding 重定向链
/// （profile 未齐 → 引导，#419 决议 1）。invite_code 仅预留字段位
/// （门禁将来开门禁不用改客户端，#419 决议 3）；登录成功后把手机号写入
/// lastSmsPhone（401 回登录页预填，一键重发验证码，#419 决议 4）。
public final class AuthService: Sendable {

    private let api: APIClient
    private let tokens: any TokenStore
    /// UserDefaults 线程安全但未标 Sendable（SDK 缺标注），此处豁免。
    nonisolated(unsafe) private let defaults: UserDefaults

    /// lastSmsPhone 持久化 key（沿 Flutter App 约定 `stride.sms.phone.v1`）。
    public static let lastSmsPhoneKey = "stride.sms.phone.v1"

    public init(api: APIClient, tokens: (any TokenStore)? = nil, defaults: UserDefaults = .standard) {
        self.api = api
        self.tokens = tokens ?? KeychainTokenStore()
        self.defaults = defaults
    }

    // For unit tests: UserDefaults(suiteName:) 注入，用完清 suite。
    public var injectedDefaults: UserDefaults { defaults }

    /// 发送登录场景验证码（60s 冷却 / 日上限在服务端，违规回 429 机器码，
    /// 由 `AuthErrorMessages` 翻译；发送失败**不启动**倒计时由 UI 保证）。
    public func sendSmsCode(phone: String) async throws {
        struct SendResponse: Decodable { let status: String? }
        let body = try JSONEncoder().encode(["phone": phone, "scene": "login"])
        let data = try await api.send(
            APIRequest(method: .post, path: "/api/auth/sms/send", body: body, authorized: false, authBase: true)
        )
        guard let decoded = try? JSONDecoder().decode(SendResponse.self, from: data),
              decoded.status == "ok" else {
            throw ApiError(statusCode: 200, code: nil, detail: "验证码发送失败")
        }
    }

    /// 校验验证码并换取双 token（login-or-register：新手机号自动建号）。
    public func verifySmsCode(phone: String, code: String, inviteCode: String? = nil) async throws {
        var payload: [String: String] = ["phone": phone, "code": code]
        if let inviteCode, !inviteCode.isEmpty { payload["invite_code"] = inviteCode }
        let body = try JSONEncoder().encode(payload)
        let tokenSet = try await requestTokens(
            APIRequest(method: .post, path: "/api/auth/sms/verify", body: body, authorized: false, authBase: true)
        )
        await persist(tokenSet)
        defaults.set(phone, forKey: Self.lastSmsPhoneKey)
    }

    /// 邮箱密码登录（老用户通道；注册开放度维持 invite_code 可选，#419 决议 3）。
    public func login(email: String, password: String) async throws {
        let body = try JSONEncoder().encode(["email": email, "password": password])
        let tokenSet = try await requestTokens(
            APIRequest(method: .post, path: "/api/auth/login", body: body, authorized: false, authBase: true)
        )
        await persist(tokenSet)
    }

    /// 上次验证码登录的手机号（401 回登录页预填）。
    public func lastSmsPhone() -> String? {
        let value = defaults.string(forKey: Self.lastSmsPhoneKey)
        return (value?.isEmpty == false) ? value : nil
    }

    // MARK: - 私有

    private func requestTokens(_ request: APIRequest) async throws -> AuthTokenSet {
        let data = try await api.send(request)
        do {
            return try JSONDecoder().decode(AuthTokenSet.self, from: data)
        } catch {
            throw ApiError.decodeFailure(AuthTokenSet.self)
        }
    }

    private func persist(_ tokenSet: AuthTokenSet) async {
        await tokens.save(
            access: tokenSet.accessToken,
            refresh: tokenSet.refreshToken,
            expiresIn: TimeInterval(tokenSet.expiresIn)
        )
    }
}
