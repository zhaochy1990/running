import Foundation

/// API 环境配置（沿小程序 `constants/config.ts` 的 PROD 口径）。
public struct APIConfig: Sendable {

    public var baseURL: URL
    public var authBaseURL: URL
    /// coach_agent_api 独立域名（PROD 与数据面同域；DEV 指向本地 8889，
    /// `constants/config.ts` COACH_BASE_URLS）。
    public var coachBaseURL: URL
    public var clientID: String
    /// 普通请求超时（config.ts REQUEST_TIMEOUT = 15s）。
    public var timeout: TimeInterval
    /// coach SSE 空闲超时（URLSession timeoutInterval = 数据间静默期，每到
    /// 数据即重置）：服务端无心跳，长工具静默期分钟级（#421 决议：勿照抄
    /// 60s；Flutter 版 120s 同源）。
    public var coachIdleTimeout: TimeInterval
    /// coach 单 turn 总上限：服务端预算 10 分钟，客户端放宽到 11 分钟保证
    /// 服务端失败文案先于客户端超时到达（MP coach.ts timeout 660s 同源）。
    public var coachTotalTimeout: TimeInterval

    public init(
        baseURL: URL = URL(string: "https://api.stride-running.cn")!,
        authBaseURL: URL = URL(string: "https://api.stride-running.cn")!,
        coachBaseURL: URL = URL(string: "https://api.stride-running.cn")!,
        clientID: String = "app_62978bf2803346878a2e4805",
        timeout: TimeInterval = 15,
        coachIdleTimeout: TimeInterval = 120,
        coachTotalTimeout: TimeInterval = 660
    ) {
        self.baseURL = baseURL
        self.authBaseURL = authBaseURL
        self.coachBaseURL = coachBaseURL
        self.clientID = clientID
        self.timeout = timeout
        self.coachIdleTimeout = coachIdleTimeout
        self.coachTotalTimeout = coachTotalTimeout
    }
}
