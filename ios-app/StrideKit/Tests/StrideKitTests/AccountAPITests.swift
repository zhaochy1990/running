import Foundation
import Testing
@testable import StrideKit

/// 账号域端点测试：profile 状态源 / 六字段建档 / complete / 绑表 / 同步
/// 触发（Idempotency-Key）/ pipeline 轮询与认领 / 声明公开拉取 / 头像上传。
@Suite struct AccountAPITests {

    @Test func myProfileDecodesOnboardingStateAndFlags() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(
            200,
            jsonData(#"{"id":"u1","display_name":"跑者","running_age_range":"1y_3y","profile":null,"onboarding":{"watch_ready":true,"profile_ready":false,"completed_at":null},"features":{"sync_data_at_onboarding":true}}"#)
        )])
        let (client, _) = makeTestClient(transport: transport)

        let profile = try await client.myProfile()
        #expect(profile.id == "u1")
        #expect(!profile.profileReady)
        #expect(profile.watchReady)
        #expect(!profile.completed)
        #expect(profile.syncEnabled)
    }

    @Test func missingFeaturesMeansSyncDisabled() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [
            (200, jsonData(#"{"id":"u1","onboarding":{"watch_ready":true,"profile_ready":true,"completed_at":"2026-10-01T00:00:00Z"}}"#)),
        ])
        let (client, _) = makeTestClient(transport: transport)

        let profile = try await client.myProfile()
        // 字段缺失按「关」处理（宁可不动 24 分钟的 pipeline）
        #expect(profile.syncEnabled == false)
        #expect(profile.completed)
    }

    @Test func postProfileSendsSixSnakeCaseFields() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", "POST", responses: [(200, jsonData("{}"))])
        let (client, _) = makeTestClient(transport: transport)

        try await client.postProfile(ProfileInput(
            displayName: "跑者", dob: "1990-05-01", sex: "male",
            heightCm: 178, weightKg: 70, runningAgeRange: "3y_plus"
        ))

        let body = try #require(JSONSerialization.jsonObject(with: await transport.calls(to: "/api/users/me/profile").first!.body!) as? [String: Any])
        #expect(body["display_name"] as? String == "跑者")
        #expect(body["dob"] as? String == "1990-05-01")
        #expect(body["sex"] as? String == "male")
        #expect(body["height_cm"] as? Double == 178)
        #expect(body["weight_kg"] as? Double == 70)
        #expect(body["running_age_range"] as? String == "3y_plus")
    }

    @Test func completeOnboardingPostsEmptyBody() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/complete", "POST", responses: [(200, jsonData(#"{"state":"already-complete"}"#))])
        let (client, _) = makeTestClient(transport: transport)

        try await client.completeOnboarding()
        #expect(await transport.count(path: "/api/users/me/onboarding/complete") == 1)
    }

    @Test func triggerSyncCarriesIdempotencyKeyAndDecodesDeduplicated() async throws {
        let transport = MockTransport()
        await transport.plan("/api/u1/sync", "POST", responses: [
            (200, jsonData(#"{"run_id":"run-9","pipeline_name":"onboarding","deduplicated":true}"#)),
        ])
        let (client, _) = makeTestClient(transport: transport)

        let result = try await client.triggerSync(user: "u1", idempotencyKey: "app-onboarding-u1-1")
        #expect(result.runId == "run-9")
        #expect(result.deduplicated == true)

        let call = try #require(await transport.calls(to: "/api/u1/sync").first)
        #expect(call.headers["Idempotency-Key"] == "app-onboarding-u1-1")
        let body = try #require(JSONSerialization.jsonObject(with: call.body ?? Data()) as? [String: String])
        #expect(body["mode"] == "full")
    }

    @Test func pipelineRunDecodesStepsAndTerminalStates() async throws {
        let transport = MockTransport()
        await transport.plan("/api/pipelines/run-1", responses: [(
            200,
            jsonData(#"{"run_id":"run-1","pipeline_name":"onboarding","status":"running","current_step":2,"steps":[{"name":"sync","status":"done"},{"name":"race_detection","status":"running"},{"name":"calibration","status":"pending"}],"error_message":null}"#)
        )])
        let (client, _) = makeTestClient(transport: transport)

        let run = try await client.pipelineRun("run-1")
        #expect(!run.isDone && !run.isFailed)
        #expect(run.currentStep == 2)
        #expect(run.steps.map(\.name) == ["sync", "race_detection", "calibration"])
    }

    @Test func userPipelinesListsRuns() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/u1/pipelines", responses: [(
            200,
            jsonData(#"{"pipelines":[{"run_id":"run-2","pipeline_name":"onboarding","status":"failed","current_step":0,"steps":[]},{"run_id":"run-1","pipeline_name":"onboarding","status":"running","current_step":1,"steps":[]}]}"#)
        )])
        let (client, _) = makeTestClient(transport: transport)

        let runs = try await client.userPipelines("u1")
        #expect(runs.count == 2)
        #expect(runs[0].isFailed)
        #expect(runs[1].status == "running")
    }

    @Test func declarationIsPublicFetch() async throws {
        let transport = MockTransport()
        await transport.plan("/api/declarations/user_agreement", responses: [(
            200, jsonData(##"{"title":"用户协议","content_markdown":"# 条款\n正文"}"##)
        )])
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)

        let doc = try await client.declaration(.userAgreement)
        #expect(doc.title == "用户协议")
        #expect(doc.contentMarkdown.contains("条款"))

        // 公开端点：走数据面 base、不带 Bearer（auth:false）
        let call = try #require(await transport.calls(to: "/api/declarations/user_agreement").first)
        #expect(call.url.host == "api.test")
        #expect(call.headers["Authorization"] == nil)

        // 404 →「该声明尚未发布」判定素材
        await transport.plan("/api/declarations/privacy_policy", responses: [(404, Data())])
        do {
            _ = try await client.declaration(.privacyPolicy)
            Issue.record("应抛错")
        } catch let error as ApiError {
            #expect(error.statusCode == 404)
        } catch {
            Issue.record("错误类型不对：\(error)")
        }
    }

    @Test func uploadAvatarBuildsMultipartAndDecodesURL() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/avatar", "POST", responses: [
            (200, jsonData(#"{"avatar_url":"https://cos.example/a.jpg"}"#)),
        ])
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)

        let url = try await client.uploadAvatar(Data([0xFF, 0xD8, 0xFF]))
        #expect(url == "https://cos.example/a.jpg")

        let call = try #require(await transport.calls(to: "/api/users/me/avatar").first)
        #expect(call.url.host == "auth.test")
        #expect(call.headers["Authorization"] == "Bearer acc")
        #expect((call.headers["Content-Type"] ?? "").hasPrefix("multipart/form-data; boundary="))
        let bodyText = String(decoding: call.body ?? Data(), as: UTF8.self)
        #expect(bodyText.contains("name=\"file\""))
        #expect(bodyText.contains("filename=\"avatar\""))
    }

    @Test func updateAvatarURLPatchesAuthIdentity() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me", "PATCH", responses: [
            (200, jsonData(#"{"id":"u1"}"#)),
        ])
        let (client, _) = makeTestClient(transport: transport)

        try await client.updateAvatarURL("https://cos.example/a.jpg")
        let call = try #require(await transport.calls(to: "/api/users/me").first)
        #expect(call.url.host == "auth.test")
        let body = try #require(JSONSerialization.jsonObject(with: call.body ?? Data()) as? [String: String])
        #expect(body["avatar_url"] == "https://cos.example/a.jpg")
    }

    @Test func watchLoginPostsProviderAndRegion() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/watch/login", "POST", responses: [(200, jsonData("{}"))])
        let (client, _) = makeTestClient(transport: transport)

        try await client.watchLogin(provider: "garmin", email: "g@x.com", password: "pw", region: "global")
        let body = try #require(JSONSerialization.jsonObject(with: await transport.calls(to: "/api/users/me/watch/login").first!.body!) as? [String: String])
        #expect(body["provider"] == "garmin")
        #expect(body["region"] == "global")
    }
}
