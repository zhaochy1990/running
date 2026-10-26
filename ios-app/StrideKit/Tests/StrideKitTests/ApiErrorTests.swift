import Foundation
import Testing
@testable import StrideKit

@Suite struct ApiErrorTests {

    @Test func normalizesDataPlaneFormat() {
        // 数据面 {detail, code}
        let body = #"{"detail":"活动不存在","code":"not_found"}"#.data(using: .utf8)!
        let error = ApiError.make(statusCode: 404, body: body)
        #expect(error.statusCode == 404)
        #expect(error.code == "not_found")
        #expect(error.detail == "活动不存在")
        #expect(error.message == "活动不存在")
    }

    @Test func normalizesAuthServiceFormat() {
        // auth-service {error, message}
        let body = #"{"error":"invalid_grant","message":"验证码错误"}"#.data(using: .utf8)!
        let error = ApiError.make(statusCode: 400, body: body)
        #expect(error.statusCode == 400)
        #expect(error.code == "invalid_grant")
        #expect(error.detail == "验证码错误")
        #expect(error.message == "验证码错误")
    }

    @Test func fallsBackWhenBodyMissingOrUndecodable() {
        #expect(ApiError.make(statusCode: 500, body: nil).message == "Request failed with status 500")
        #expect(ApiError.make(statusCode: 500, body: Data("<html>".utf8)).message == "Request failed with status 500")
        // detail 优先于兜底文案；code 缺失为 nil
        let body = #"{"detail":"bad"}"#.data(using: .utf8)!
        #expect(ApiError.make(statusCode: 422, body: body).code == nil)
    }

    @Test func sessionExpiredFactory() {
        #expect(ApiError.sessionExpired.statusCode == 401)
        #expect(ApiError.sessionExpired.code == "session_expired")
    }
}

@Suite struct TokensTests {

    @Test func rpxToPtIsHalf() {
        // devops#749 §2.1：375 基准，rpx/2
        #expect(Tokens.rpx(24) == 12)
        #expect(Tokens.rpx(750) == 375)
        #expect(Tokens.rpx(1) == 0.5)
    }

    @Test func scalesMirrorFlutterTokens() {
        // 字号刻度 = tokens.dart fs10…fsDisplay64
        #expect(FontScale.fs10.rawValue == 10)
        #expect(FontScale.fs15.rawValue == 15)
        #expect(FontScale.fs22.rawValue == 22)
        #expect(FontScale.fsDisplay64.rawValue == 64)
        // 圆角 = radiusSm 8 / Md 12 / Lg 14 / Xl 24 / Pill 100 / Phone 44
        #expect(RadiusScale.sm.rawValue == 8)
        #expect(RadiusScale.md.rawValue == 12)
        #expect(RadiusScale.lg.rawValue == 14)
        #expect(RadiusScale.xl.rawValue == 24)
        #expect(RadiusScale.pill.rawValue == 100)
        #expect(RadiusScale.phone.rawValue == 44)
        // 间距 = spaceXs 4 … space3xl 32
        #expect(SpaceScale.xs.rawValue == 4)
        #expect(SpaceScale.md.rawValue == 12)
        #expect(SpaceScale.xxxl.rawValue == 32)
    }

    @Test func accentFamilyIsLotusPink() {
        // 藕粉主题（dark.wxss --color-accent 族）
        #expect(Tokens.Hex.accent == 0xFF6363)
        #expect(Tokens.Hex.onAccent == 0xFFFFFF)
        #expect(Tokens.Hex.accentDeep != Tokens.Hex.accent) // 加深前阶独立存在
    }

    @Test func lightThemeExposesTokenFace() {
        let theme = LightTheme()
        #expect(theme.identifier == "light")
        _ = theme.background; _ = theme.surface; _ = theme.foreground
        _ = theme.foregroundSoft; _ = theme.muted; _ = theme.mutedTwo
        _ = theme.border; _ = theme.borderSoft; _ = theme.accent
        _ = theme.accentDeep; _ = theme.onAccent; _ = theme.accentTint
        _ = theme.warning; _ = theme.danger; _ = theme.grid
        _ = theme.font(.fs15)
        _ = theme.font(.fs13, weight: .medium)
        _ = theme.font(.fs22, weight: .bold, mono: true)
        #expect(theme.radius(.sm) == 8)
        #expect(theme.space(.lg) == 16)
    }
}
