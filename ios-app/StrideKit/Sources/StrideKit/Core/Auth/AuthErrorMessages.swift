import Foundation

/// auth-service 错误码 → 中文文案（devops#752 / #419 决议，18 码全集）。
///
/// auth-service 错误体是 `{error, message}`（机器码 + 服务端英文描述），
/// 机器码全集来自 Go 侧 `internal/apperror`。客户端只按 `error` 映射中文；
/// 映射不认识的码回落到服务端 message，再回落到通用文案（覆盖未来新增
/// 但尚未进表的码）。与小程序 `services/auth.ts BIND_ERROR_MESSAGES`、
/// Flutter `auth_error_messages.dart` 三端同表。
public enum AuthErrorMessages {

    /// 18 个机器码 → 中文（sms 六 / phone 三 / 登录族 / refresh 族）。
    public static let table: [String: String] = [
        // SMS 验证码（/api/auth/sms/send + /api/auth/sms/verify）
        "sms_code_invalid": "验证码错误，请重试",
        "sms_code_expired": "验证码已过期，请重新获取",
        "sms_attempts_exceeded": "尝试次数过多，请重新获取验证码",
        "sms_send_cooldown": "操作过于频繁，请 1 分钟后再试",
        "sms_daily_limit": "今日验证码发送次数已达上限，请明天再试",
        "sms_not_configured": "短信服务暂不可用，请稍后再试",
        "sms_provider_error": "短信发送失败，请稍后再试",

        // 手机号（绑定/解绑面；登录页只会碰到 phone_not_registered）
        "phone_not_registered": "该手机号尚未注册",
        "phone_already_bound": "该手机号已绑定其他账号",
        "phone_not_bound": "该手机号未绑定",

        // 登录族
        "invalid_credentials": "邮箱或密码错误",
        "user_disabled": "账号已被停用，请联系客服",
        "invalid_invite_code": "邀请码无效",
        "invite_code_already_used": "邀请码已被使用",
        "service_unavailable": "服务暂时不可用，请稍后再试",

        // refresh 族（会话失效）
        "invalid_token": "登录已过期，请重新登录",
        "token_revoked": "登录已失效，请重新登录",
        "refresh_token_expired": "登录已过期，请重新登录",
    ]

    /// 把 auth-service 错误翻译成给用户看的中文。
    /// - Parameters:
    ///   - code: 错误体里的 `error` 机器码。
    ///   - server: 服务端 `message` 原文（兜底展示）。
    public static func message(code: String?, server: String? = nil) -> String {
        if let code, let mapped = table[code] { return mapped }
        if let server, !server.trimmingCharacters(in: .whitespaces).isEmpty { return server }
        return "操作失败，请稍后再试"
    }

    /// `ApiError` 便捷入口（`code` 已由 APIClient 从 `error`/`code` 双格式归一）。
    public static func message(for error: ApiError) -> String {
        message(code: error.code, server: error.detail.isEmpty ? nil : error.detail)
    }
}
