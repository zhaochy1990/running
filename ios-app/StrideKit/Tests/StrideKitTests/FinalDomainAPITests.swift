import Foundation
import Testing
@testable import StrideKit

/// PR-7 收尾域 API 面（devops#770）：反馈端点族（client_version 静默注入 /
/// 两段式上传 multipart / 409 语义）、产品路线端点族、手动同步（incremental
/// 无幂等键）、手表三端点、注销、数据面 profile PATCH。
@Suite @MainActor struct FinalDomainAPITests {

    private func makeClient() async -> (APIClient, MockTransport, InMemoryTokenStore) {
        let transport = MockTransport()
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        return (client, transport, store)
    }

    // MARK: - 反馈域

    @Test func clientVersionIsIosPrefixAndCapped() {
        let bundle = Bundle(for: BundleFinder.self)
        let version = APIClient.feedbackClientVersion(bundle: bundle)
        #expect(version.hasPrefix("ios/"))
        #expect(version.count <= 32)
    }

    private final class BundleFinder {}

    @Test func submitFeedbackInjectsClientVersionSilently() async throws {
        let (client, transport, _) = await makeClient()
        await transport.plan("/api/users/me/feedbacks", "POST", responses: [(
            200, jsonData(#"{"id":1,"type":"bug","content":"崩溃","images":[],"status":"open","adopted_feature_id":null,"created_at":"2026-10-26T03:00:00Z","unread":false}"#)
        )])
        _ = try await client.submitFeedback(type: .bug, content: "崩溃", images: ["k1"], clientVersion: "ios/1.2.3")
        let call = await transport.calls(to: "/api/users/me/feedbacks").first
        let body = try #require(call?.body)
        let sent = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect(sent?["client_version"] as? String == "ios/1.2.3")
        #expect(sent?["images"] as? [String] == ["k1"])
        #expect(sent?["type"] as? String == "bug")
    }

    @Test func uploadFeedbackImagePostsMultipartAndReturnsCosKey() async throws {
        let (client, transport, _) = await makeClient()
        await transport.plan("/api/users/me/feedback-images", "POST", responses: [(
            200, jsonData(#"{"cos_key":"feedback/u1/abc.png"}"#)
        )])
        let key = try await client.uploadFeedbackImage(Data([0xFF, 0xD8, 0xFF]))
        #expect(key == "feedback/u1/abc.png")
        let call = await transport.calls(to: "/api/users/me/feedback-images").first
        let contentType = try #require(call?.headers["Content-Type"])
        #expect(contentType.hasPrefix("multipart/form-data; boundary="))
        let body = try #require(call?.body)
        let raw = String(decoding: body, as: UTF8.self)
        #expect(raw.contains("name=\"file\""))
        #expect(call?.headers["Authorization"] == "Bearer acc")
    }

    @Test func replyFeedbackSurfacesClosed409() async throws {
        let (client, transport, _) = await makeClient()
        await transport.plan("/api/users/me/feedbacks/5/replies", "POST", responses: [(
            409, jsonData(#"{"detail":"反馈已关闭","code":"feedback_closed"}"#)
        )])
        do {
            _ = try await client.replyFeedback(id: 5, content: "追问")
            Issue.record("应抛 409")
        } catch let error as ApiError {
            #expect(error.statusCode == 409)
            #expect(error.code == "feedback_closed")
        }
    }

    // MARK: - 产品路线

    @Test func roadmapEndpointsHitContractPaths() async throws {
        let (client, transport, _) = await makeClient()
        let roadmapBody = """
        {"summary":{"my_votes":1,"total_votes":42,"released_count":3},
         "backlog":[{"id":1,"title":"想法","summary":"概述","description":"# 描述","category":"训练",
                     "is_new":true,"votes":12,"voted":true}],
         "accepted":[],"released":[]}
        """
        await transport.plan("/api/roadmap", responses: [(200, jsonData(roadmapBody))])
        let res = try await client.roadmap()
        #expect(res.backlog.count == 1)
        #expect(res.backlog[0].voted)

        await transport.plan("/api/roadmap/features/1/vote", "POST", responses: [(200, jsonData(#"{"feature_id":1,"voted":true}"#))])
        let vote = try await client.voteRoadmapFeature(1)
        #expect(vote.voted)

        await transport.plan("/api/roadmap/features/1/vote", "DELETE", responses: [(200, jsonData(#"{"feature_id":1,"voted":false}"#))])
        let unvote = try await client.unvoteRoadmapFeature(1)
        #expect(!unvote.voted)
    }

    // MARK: - 手动同步（#425：incremental 无 Idempotency-Key）

    @Test func manualSyncPostsIncrementalWithoutIdempotencyKey() async throws {
        let (client, transport, _) = await makeClient()
        await transport.plan("/api/u1/sync", "POST", responses: [(202, jsonData(#"{"run_id":"r9"}"#))])
        let result = try await client.triggerIncrementalSync(user: "u1")
        #expect(result.runId == "r9")
        let call = try #require(await transport.calls(to: "/api/u1/sync").last)
        #expect(call.headers["Idempotency-Key"] == nil)
        let body = try #require(call.body)
        let sent = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect(sent?["mode"] as? String == "incremental")
    }

    // MARK: - 手表

    @Test func watchEndpointsRoundtrip() async throws {
        let (client, transport, _) = await makeClient()
        await transport.plan("/api/users/me/watch", responses: [(
            200, jsonData(#"{"provider":"garmin","provider_display_name":"Garmin","logged_in":true,"email":"a@g.com","device":"Forerunner 965","last_sync_at":"2026-10-26T02:00:00Z","capabilities":["workout_query","schedule_push"]}"#)
        )])
        let info = try await client.watchInfo()
        #expect(info.provider == "garmin")
        #expect(info.capabilities.count == 2)

        await transport.plan("/api/users/me/watch/login", "POST", responses: [(200, jsonData(#"{"ok":true}"#))])
        try await client.watchLogin(provider: "garmin", email: "a@g.com", password: "pw", region: "cn")
        let login = try #require(await transport.calls(to: "/api/users/me/watch/login").last)
        let sent = try JSONSerialization.jsonObject(with: login.body!) as? [String: Any]
        #expect(sent?["region"] as? String == "cn")

        await transport.plan("/api/users/me/watch", "DELETE", responses: [(200, jsonData(#"{"ok":true,"provider":"garmin"}"#))])
        try await client.disconnectWatch()
    }

    // MARK: - 注销（#759 决议 2）

    @Test func deleteAccountHitsAuthBase() async throws {
        let (client, transport, _) = await makeClient()
        await transport.plan("/api/users/me", "DELETE", responses: [(204, Data())])
        try await client.deleteAccount()
        let call = try #require(await transport.calls(to: "/api/users/me").last)
        #expect(call.method == "DELETE")
        // auth-service 域
        #expect(call.url.host == "auth.test")
    }

    // MARK: - 数据面 profile PATCH（ADR 0013 失败回读链路）

    @Test func patchMyProfileReturnsServerProfile() async throws {
        let (client, transport, _) = await makeClient()
        await transport.plan("/api/users/me/profile", "PATCH", responses: [(
            200, jsonData(#"{"ok":true,"profile":{"display_name":"跑者","dob":"1990-01-01","sex":"male","height_cm":175,"weight_kg":65,"running_age_range":"1y_3y"}}"#)
        )])
        let profile = try await client.patchMyProfile(ProfilePatch(weightKg: 65))
        #expect(profile.weightKg == 65)
        #expect(profile.runningAgeRange == "1y_3y")
    }

    @Test func myProfileDecodesNullableCoreAndTopLevelAgeRange() throws {
        let json = """
        {"id":"u1","display_name":"跑者","running_age_range":"unknown",
         "profile":null,"onboarding":{"watch_ready":false,"profile_ready":false,"completed_at":null},
         "features":{"sync_data_at_onboarding":true}}
        """
        let data = try JSONDecoder().decode(MyProfile.self, from: Data(json.utf8))
        #expect(data.profile == nil)
        #expect(data.runningAgeRange == "unknown")
        #expect(data.syncEnabled)
        #expect(!data.profileReady)
    }

    // MARK: - 分享落地域

    @Test func sharedWorkoutDecodesRunSpecByShape() throws {
        let json = """
        {"kind":"run","name":"节奏课","summary":"乳酸阈","date":"2026-10-28",
         "spec":{"name":"节奏课","date":"2026-10-28","note":null,
                 "blocks":[{"repeat":1,"steps":[
                    {"step_kind":"work","duration":{"kind":"distance_m","value":5000},
                     "target":{"kind":"pace_s_km","low":300,"high":320},"note":null}]}]},
         "total_distance_m":8000,"total_duration_s":1680,"estimated_dose":88.5}
        """
        let workout = try JSONDecoder().decode(SharedWorkout.self, from: Data(json.utf8))
        #expect(workout.spec != nil)
        #expect(workout.strengthSpec == nil)
        #expect(workout.spec?.blocks.count == 1)
    }

    @Test func saveBodyCarriesSpecAsRawJSONAndSaveToken() throws {
        let spec = """
        {"name":"课","date":"2026-10-28","note":null,"blocks":[]}
        """
        let body = SaveCustomWorkoutBody(
            date: "2026-10-29", kind: "run", name: "课", summary: "",
            spec: Data(spec.utf8), totalDistanceM: 8000, totalDurationS: 1680,
            estimatedDose: 88.5, saveToken: "shared-w1"
        )
        let data = try body.encoded()
        let sent = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(sent?["save_token"] as? String == "shared-w1")
        #expect((sent?["spec"] as? [String: Any])?["name"] as? String == "课")
        #expect(sent?["total_distance_m"] as? Double == 8000)
    }

    @Test func coachShareDecodesSnapshotWithCardEnvelope() async throws {
        let (client, transport, _) = await makeClient()
        let json = """
        {"status":"active","sharer_name":"阿跑","message_count":4,
         "created_at":"2026-10-21T18:30:00Z","wxacode_url":null,
         "messages":[
           {"role":"user","content":"帮我排课"},
           {"role":"assistant","content":"**好的**","card":{"$type":"race-strategy","data":{"race_name":"上马","item_type":"Marathon","target_finish_time":"3:59:59","pace_segments":[{"segment":"0-5km","pace":"5:40/km","segment_time":"28:20","cumulative_time":"28:20"}],"fueling_plan":[]}}}]}
        """
        await transport.plan("/api/coach-shares/sid1", responses: [(200, jsonData(json))])
        let snapshot = try await client.coachShare(sid: "sid1")
        #expect(snapshot.messageCount == 4)
        #expect(snapshot.messages[1].card?.type == "race-strategy")

        let rows = buildCoachShareMessages(snapshot.messages)
        #expect(rows[0].role == .user)
        #expect(rows[1].card != nil)
        #expect(rows[1].rendersMarkdown == false) // race-strategy 卡替代正文
    }

    @Test func coachShareRowDegradesActionCardsToMarkdown() async throws {
        let (client, transport, _) = await makeClient()
        let json = """
        {"status":"active","message_count":1,"created_at":"2026-10-21T18:30:00Z","wxacode_url":null,
         "messages":[
           {"role":"assistant","content":"存好了",
            "card":{"$type":"custom-workout","data":{"save_token":"t","date":"2026-10-28","kind":"run","name":"课","summary":"","blocks":[]}}}]}
        """
        await transport.plan("/api/coach-shares/sid2", responses: [(200, jsonData(json))])
        let snapshot = try await client.coachShare(sid: "sid2")
        let rows = buildCoachShareMessages(snapshot.messages)
        // 动作卡对只读者无意义 → 降级 markdown 气泡
        #expect(rows[0].card == nil)
        #expect(rows[0].rendersMarkdown)
    }
}
