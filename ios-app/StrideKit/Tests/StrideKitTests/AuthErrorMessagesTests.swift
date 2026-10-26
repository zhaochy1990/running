import Foundation
import Testing
@testable import StrideKit

/// 18 错误码中文层（devops#752 决议 / #419 决议，照搬 #460 表）。
@Suite struct AuthErrorMessagesTests {

    @Test func tableCoversAllEighteenCodes() {
        #expect(AuthErrorMessages.table.count == 18)
        // 每族抽一个代表码
        for code in ["sms_code_invalid", "phone_not_registered", "invalid_credentials", "refresh_token_expired"] {
            #expect(AuthErrorMessages.table[code] != nil)
        }
    }

    @Test func mapsKnownCodeToChinese() {
        #expect(AuthErrorMessages.message(code: "sms_send_cooldown") == "操作过于频繁，请 1 分钟后再试")
        #expect(AuthErrorMessages.message(code: "invalid_credentials") == "邮箱或密码错误")
        #expect(AuthErrorMessages.message(code: "user_disabled") == "账号已被停用，请联系客服")
    }

    @Test func fallsBackToServerMessageForUnknownCode() {
        #expect(AuthErrorMessages.message(code: "brand_new_code", server: "server says hi") == "server says hi")
        #expect(AuthErrorMessages.message(code: "brand_new_code", server: "  ") != "  ")
    }

    @Test func genericFallbackWhenNothingUsable() {
        #expect(AuthErrorMessages.message(code: nil, server: nil) == "操作失败，请稍后再试")
        #expect(AuthErrorMessages.message(code: "brand_new_code") == "操作失败，请稍后再试")
    }

    @Test func apiErrorConvenienceUsesNormalizedCode() {
        // auth-service 错误体 {error, message} → APIClient 归一为 code/detail
        let error = ApiError(statusCode: 401, code: "invalid_token", detail: "token is invalid")
        #expect(AuthErrorMessages.message(for: error) == "登录已过期，请重新登录")

        // 数据面 {detail, code} 同样工作
        let dataFace = ApiError(statusCode: 422, code: nil, detail: "参数错误")
        #expect(AuthErrorMessages.message(for: dataFace) == "参数错误")
    }
}
