import Foundation

/// API 归一错误（devops#749 §7.1，1:1 沿小程序 `services/request.ts ApiError`）。
///
/// 双格式归一：数据面错误体 `{detail, code}`；auth-service 错误体
/// `{error, message}`。
public struct ApiError: Error, Hashable, Sendable {

    public let statusCode: Int
    public let code: String?
    public let detail: String

    /// 展示用消息（对应 request.ts `super(body.message || body.detail || 兜底)`）。
    public var message: String {
        if !detail.isEmpty { return detail }
        return "Request failed with status \(statusCode)"
    }

    public init(statusCode: Int, code: String?, detail: String) {
        self.statusCode = statusCode
        self.code = code
        self.detail = detail
    }

    /// 2xx 但响应体解码失败（客户端契约漂移的显式信号，不带伪状态码）。
    public static func decodeFailure(_ type: Any.Type) -> ApiError {
        ApiError(statusCode: 200, code: "decode_failed", detail: "响应解码失败：\(type)")
    }

    /// 会话失效兜底（401 刷新链失败后抛出；对应 request.ts
    /// `{detail: 'Session expired', code: 'session_expired'}`）。
    public static let sessionExpired = ApiError(statusCode: 401, code: "session_expired", detail: "Session expired")

    /// 从响应体归一构造。体为空/不可解码 → 纯状态码错误。
    public static func make(statusCode: Int, body: Data?) -> ApiError {
        struct ErrorBody: Decodable {
            let detail: String?
            let code: String?
            let error: String?
            let message: String?
        }
        guard let body,
              let decoded = try? JSONDecoder().decode(ErrorBody.self, from: body) else {
            return ApiError(statusCode: statusCode, code: nil, detail: "")
        }
        let code = decoded.code ?? decoded.error
        let detail = decoded.detail ?? decoded.message ?? ""
        return ApiError(statusCode: statusCode, code: code, detail: detail)
    }
}

extension ApiError: CustomStringConvertible {
    public var description: String {
        "ApiError(\(statusCode), code: \(code ?? "-"), detail: \(detail.isEmpty ? "-" : detail))"
    }
}
