import Foundation

/// API 环境配置（沿小程序 `constants/config.ts` 的 PROD 口径；
/// auth 与数据面同域分流，coach 对话域票据 PR-4 再补独立 DEV 地址）。
public struct APIConfig: Sendable {

    public var baseURL: URL
    public var authBaseURL: URL
    public var clientID: String
    /// 普通请求超时（config.ts REQUEST_TIMEOUT = 15s；coach turn 600s 单列，PR-4）。
    public var timeout: TimeInterval

    public init(
        baseURL: URL = URL(string: "https://api.stride-running.cn")!,
        authBaseURL: URL = URL(string: "https://api.stride-running.cn")!,
        clientID: String = "app_62978bf2803346878a2e4805",
        timeout: TimeInterval = 15
    ) {
        self.baseURL = baseURL
        self.authBaseURL = authBaseURL
        self.clientID = clientID
        self.timeout = timeout
    }
}
