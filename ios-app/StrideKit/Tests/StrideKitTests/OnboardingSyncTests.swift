import Foundation
import Testing
@testable import StrideKit

/// 同步三件套测试：指针三分（valid 复用 / transient 保留 / invalid 清除）、
/// 认领别端 run、幂等键先落盘、失败重试起新 run（devops#418 决议 2）。
@Suite struct OnboardingSyncTests {

    private func profileBody(profileReady: Bool = true, watchReady: Bool = true,
                             completed: Bool = true, syncEnabled: Bool? = nil) -> Data {
        let completedAt = completed ? "\"2026-10-01T00:00:00Z\"" : "null"
        let features: String
        if let syncEnabled {
            features = #"{"sync_data_at_onboarding":\#(syncEnabled)}"#
        } else {
            features = "{}"
        }
        return jsonData(#"{"id":"u1","onboarding":{"watch_ready":\#(watchReady),"profile_ready":\#(profileReady),"completed_at":\#(completedAt)},"features":\#(features)}"#)
    }

    private func runBody(_ id: String, status: String, pipeline: String = "onboarding",
                         step: Int = 0, errorMessage: String? = nil) -> Data {
        let err = errorMessage.map { "\"\($0)\"" } ?? "null"
        return jsonData(#"{"run_id":"\#(id)","pipeline_name":"\#(pipeline)","status":"\#(status)","current_step":\#(step),"steps":[{"name":"sync","status":"done"},{"name":"race_detection","status":"pending"}],"error_message":\#(err)}"#)
    }

    // MARK: - 部署开关与有表

    @Test func disabledFlagShortCircuits() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(syncEnabled: false))])
        let (client, _) = makeTestClient(transport: transport)
        let service = OnboardingSyncService(api: client, store: InMemoryOnboardingRunStore())

        let outcome = try await service.ensureSync(userID: "u1")
        #expect(outcome.phase == .disabled)
        // 开关关闭不碰同步面
        #expect(await transport.count(path: "/api/u1/sync") == 0)
    }

    @Test func noWatchGoesBackToWatchStep() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(watchReady: false, syncEnabled: true))])
        let (client, _) = makeTestClient(transport: transport)
        let service = OnboardingSyncService(api: client, store: InMemoryOnboardingRunStore())

        let outcome = try await service.ensureSync(userID: "u1")
        #expect(outcome.phase == .noWatch)
    }

    // MARK: - 指针三分

    @Test func validPointerReusesRunWithoutTrigger() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(syncEnabled: true))])
        await transport.plan("/api/pipelines/run-7", responses: [(200, runBody("run-7", status: "running", step: 1))])
        let (client, _) = makeTestClient(transport: transport)
        let store = InMemoryOnboardingRunStore()
        await store.saveRunPointer(userID: "u1", runID: "run-7")
        let service = OnboardingSyncService(api: client, store: store)

        let outcome = try await service.ensureSync(userID: "u1")
        #expect(outcome.phase == .running)
        #expect(outcome.runID == "run-7")
        #expect(await transport.count(path: "/api/u1/sync") == 0)
        #expect(await store.runPointer(userID: "u1") == "run-7")
    }

    @Test func transientLookupKeepsPointerAndPollsSameRun() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(syncEnabled: true))])
        await transport.plan("/api/pipelines/run-8", responses: [(500, Data())])
        let (client, _) = makeTestClient(transport: transport)
        let store = InMemoryOnboardingRunStore()
        await store.saveRunPointer(userID: "u1", runID: "run-8")
        let service = OnboardingSyncService(api: client, store: store)

        // 5xx = 暂时性：保留指针按原 runId 轮询，不触发新 run
        let outcome = try await service.ensureSync(userID: "u1")
        #expect(outcome.phase == .running)
        #expect(outcome.runID == "run-8")
        #expect(await transport.count(path: "/api/u1/sync") == 0)
        #expect(await store.runPointer(userID: "u1") == "run-8")
    }

    @Test func invalidPointerIsClearedThenClaimsExistingRun() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(syncEnabled: true))])
        await transport.plan("/api/pipelines/run-old", responses: [(404, Data())])
        await transport.plan("/api/users/u1/pipelines", responses: [(
            200,
            jsonData(#"{"pipelines":[{"run_id":"run-2","pipeline_name":"weekly","status":"running","current_step":0,"steps":[]},{"run_id":"run-3","pipeline_name":"onboarding","status":"running","current_step":1,"steps":[]}]}"#)
        )])
        let (client, _) = makeTestClient(transport: transport)
        let store = InMemoryOnboardingRunStore()
        await store.saveRunPointer(userID: "u1", runID: "run-old")
        let service = OnboardingSyncService(api: client, store: store)

        // 4xx 指针作废 → 清除 → 认领别端的 onboarding run（跳过非 onboarding 的）
        let outcome = try await service.ensureSync(userID: "u1")
        #expect(outcome.phase == .running)
        #expect(outcome.runID == "run-3")
        #expect(await store.runPointer(userID: "u1") == "run-3")
        #expect(await transport.count(path: "/api/u1/sync") == 0)
    }

    @Test func failedRunIsNotClaimed() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(syncEnabled: true))])
        await transport.plan("/api/users/u1/pipelines", responses: [(
            200,
            jsonData(#"{"pipelines":[{"run_id":"run-f","pipeline_name":"onboarding","status":"failed","current_step":0,"steps":[],"error_message":"boom"}]}"#)
        )])
        await transport.plan("/api/u1/sync", "POST", responses: [
            (202, jsonData(#"{"run_id":"run-new","pipeline_name":"onboarding"}"#)),
        ])
        let (client, _) = makeTestClient(transport: transport)
        let service = OnboardingSyncService(api: client, store: InMemoryOnboardingRunStore())

        // failed 不认领 → 触发新 run
        let outcome = try await service.ensureSync(userID: "u1")
        #expect(outcome.phase == .running)
        #expect(outcome.runID == "run-new")
    }

    // MARK: - 幂等键先落盘

    @Test func triggerWritesKeyBeforeRequestAndClearsAfter() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(syncEnabled: true))])
        await transport.plan("/api/u1/sync", "POST", responses: [
            (202, jsonData(#"{"run_id":"run-1","pipeline_name":"onboarding"}"#)),
        ])
        let (client, _) = makeTestClient(transport: transport)
        let store = InMemoryOnboardingRunStore()
        let service = OnboardingSyncService(api: client, store: store)

        let outcome = try await service.ensureSync(userID: "u1")
        #expect(outcome.runID == "run-1")

        // 成功后：指针指向新 run，幂等键已清（重试才算新尝试）
        #expect(await store.runPointer(userID: "u1") == "run-1")
        #expect(await store.startKey(userID: "u1") == nil)

        let call = try #require(await transport.calls(to: "/api/u1/sync").first)
        #expect(call.headers["Idempotency-Key"]?.isEmpty == false)
    }

    @Test func triggerFailureKeepsKeyForNextEntry() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(syncEnabled: true))])
        await transport.plan("/api/u1/sync", "POST", responses: [(500, Data())])
        let (client, _) = makeTestClient(transport: transport)
        let store = InMemoryOnboardingRunStore()
        let service = OnboardingSyncService(api: client, store: store)

        await #expect(throws: ApiError.self) {
            _ = try await service.ensureSync(userID: "u1")
        }
        // 触发失败（超时/5xx）：幂等键保留 —— 下次进来复用同一把 key，
        // 服务端去重返回已创建的 run 而不是再建一个
        #expect(await store.startKey(userID: "u1") != nil)
        #expect(await store.runPointer(userID: "u1") == nil)
    }

    @Test func retryClearsPointerAndKeyForFreshRun() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [
            (200, profileBody(syncEnabled: true)),
            (200, profileBody(syncEnabled: true)),
        ])
        // 旧 run 已 failed：指针 lookup 得 failed → outcome failed
        await transport.plan("/api/pipelines/run-f", responses: [(200, runBody("run-f", status: "failed", errorMessage: "boom"))])
        await transport.plan("/api/users/u1/pipelines", responses: [(
            200,
            jsonData(#"{"pipelines":[{"run_id":"run-f","pipeline_name":"onboarding","status":"failed","current_step":0,"steps":[]}]}"#)
        )])
        await transport.plan("/api/u1/sync", "POST", responses: [
            (202, jsonData(#"{"run_id":"run-2","pipeline_name":"onboarding"}"#)),
        ])
        let (client, _) = makeTestClient(transport: transport)
        let store = InMemoryOnboardingRunStore()
        await store.saveRunPointer(userID: "u1", runID: "run-f")
        await store.saveStartKey(userID: "u1", "stale-key")
        let service = OnboardingSyncService(api: client, store: store)

        let first = try await service.ensureSync(userID: "u1")
        #expect(first.phase == .failed)
        #expect(first.message == "boom")

        // retry：清指针+清 key → 起新 run（不带旧 key）
        let retried = try await service.retrySync(userID: "u1")
        #expect(retried.phase == .running)
        #expect(retried.runID == "run-2")
        let calls = await transport.calls(to: "/api/u1/sync")
        #expect(calls.last?.headers["Idempotency-Key"] != "stale-key")
    }

    // MARK: - 指针库键名（与 Web/小程序同名对照）

    @Test func userDefaultsStoreUsesSharedKeyNames() async throws {
        let defaults = makeTestDefaults("onboarding-store-keys")
        let store = UserDefaultsOnboardingRunStore(defaults: defaults)

        await store.saveRunPointer(userID: "u42", runID: "run-x")
        await store.saveStartKey(userID: "u42", "key-x")

        #expect(defaults.string(forKey: "stride:onboarding-run:u42") == "run-x")
        #expect(defaults.string(forKey: "stride:onboarding-start-key:u42") == "key-x")

        await store.clearRunPointer(userID: "u42")
        await store.clearStartKey(userID: "u42")
        #expect(defaults.string(forKey: "stride:onboarding-run:u42") == nil)
        #expect(await store.runPointer(userID: "u42") == nil)
    }
}
