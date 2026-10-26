import Foundation
import Testing
@testable import StrideKit

/// 登录域服务测试：SMS 通道（scene=login + login-or-register）、邮箱密码、
/// lastSmsPhone 预填、invite_code 预留（devops#752 决议）。
@Suite struct AuthServiceTests {

    @Test func sendSmsPostsLoginSceneAndExpectsOk() async throws {
        let transport = MockTransport()
        await transport.plan("/api/auth/sms/send", "POST", responses: [(200, jsonData(#"{"status":"ok"}"#))])
        let (client, _) = makeTestClient(transport: transport)

        let service = AuthService(api: client, tokens: InMemoryTokenStore(), defaults: makeTestDefaults("auth-send"))
        try await service.sendSmsCode(phone: "13800138000")

        let call = try #require(await transport.calls(to: "/api/auth/sms/send").first)
        #expect(call.url.host == "auth.test")
        let body = try #require(JSONSerialization.jsonObject(with: call.body ?? Data()) as? [String: String])
        #expect(body["phone"] == "13800138000")
        #expect(body["scene"] == "login")
        // 登录端点不带 Bearer（authorized:false），X-Client-Id 仍随行
        #expect(call.headers["Authorization"] == nil)
        #expect(call.headers["X-Client-Id"] == "app_test")
    }

    @Test func sendSmsCooldownSurfacesMachineCode() async {
        let transport = MockTransport()
        await transport.plan("/api/auth/sms/send", "POST", responses: [
            (429, jsonData(#"{"error":"sms_send_cooldown","message":"too fast"}"#)),
        ])
        let (client, _) = makeTestClient(transport: transport)
        let service = AuthService(api: client, tokens: InMemoryTokenStore(), defaults: makeTestDefaults("auth-cooldown"))

        do {
            try await service.sendSmsCode(phone: "13800138000")
            Issue.record("应抛错")
        } catch let error as ApiError {
            #expect(error.code == "sms_send_cooldown")
            #expect(AuthErrorMessages.message(for: error).contains("频繁"))
        } catch {
            Issue.record("错误类型不对：\(error)")
        }
    }

    @Test func sendSmsNonOkStatusIsFailure() async {
        let transport = MockTransport()
        await transport.plan("/api/auth/sms/send", "POST", responses: [(200, jsonData(#"{"status":"queued"}"#))])
        let (client, _) = makeTestClient(transport: transport)
        let service = AuthService(api: client, tokens: InMemoryTokenStore(), defaults: makeTestDefaults("auth-queued"))

        await #expect(throws: ApiError.self) {
            try await service.sendSmsCode(phone: "13800138000")
        }
    }

    @Test func verifySmsSavesTokensAndLastSmsPhone() async throws {
        let transport = MockTransport()
        await transport.plan("/api/auth/sms/verify", "POST", responses: [
            (200, jsonData(#"{"access_token":"acc-1","refresh_token":"ref-1","expires_in":900,"user":{"id":"u1"}}"#)),
        ])
        let (client, store) = makeTestClient(transport: transport)
        let defaults = makeTestDefaults("auth-verify")
        let service = AuthService(api: client, tokens: store, defaults: defaults)

        try await service.verifySmsCode(phone: "13912345678", code: "123456")

        #expect(await store.accessToken() == "acc-1")
        #expect(await store.refreshToken() == "ref-1")
        #expect(service.lastSmsPhone() == "13912345678")

        // verify 失败（码错）不落库、不写手机号
        await transport.plan("/api/auth/sms/verify", "POST", responses: [
            (400, jsonData(#"{"error":"sms_code_invalid","message":"wrong"}"#)),
        ])
        let defaults2 = makeTestDefaults("auth-verify-fail")
        let service2 = AuthService(api: client, tokens: store, defaults: defaults2)
        await #expect(throws: ApiError.self) {
            try await service2.verifySmsCode(phone: "13912345678", code: "000000")
        }
        #expect(service2.lastSmsPhone() == nil)
    }

    @Test func verifyForwardsOptionalInviteCode() async throws {
        let transport = MockTransport()
        await transport.plan("/api/auth/sms/verify", "POST", responses: [
            (200, jsonData(#"{"access_token":"a","refresh_token":"r","expires_in":60}"#)),
        ])
        let (client, _) = makeTestClient(transport: transport)
        let service = AuthService(api: client, tokens: InMemoryTokenStore(), defaults: makeTestDefaults("auth-invite"))

        try await service.verifySmsCode(phone: "13800138000", code: "123456", inviteCode: "STRIDE")

        let body = try #require(JSONSerialization.jsonObject(with: await transport.calls(to: "/api/auth/sms/verify").first!.body!) as? [String: String])
        #expect(body["invite_code"] == "STRIDE")
    }

    @Test func emailLoginSavesTokens() async throws {
        let transport = MockTransport()
        await transport.plan("/api/auth/login", "POST", responses: [
            (200, jsonData(#"{"access_token":"acc-e","refresh_token":"ref-e","expires_in":900}"#)),
        ])
        let (client, store) = makeTestClient(transport: transport)
        let service = AuthService(api: client, tokens: store, defaults: makeTestDefaults("auth-email"))

        try await service.login(email: "a@b.c", password: "secret123")
        #expect(await store.accessToken() == "acc-e")

        // 邮箱登录不写 lastSmsPhone
        #expect(service.lastSmsPhone() == nil)

        let call = try #require(await transport.calls(to: "/api/auth/login").first)
        let body = try #require(JSONSerialization.jsonObject(with: call.body ?? Data()) as? [String: String])
        #expect(body["email"] == "a@b.c")
        #expect(body["password"] == "secret123")
    }
}
