import Foundation
import Testing
@testable import StrideKit

/// 首次同步 session 入口测试（devops#1016 / epic #1004 T12）：视图解码、
/// POST/GET 请求形状、纯展示口径（与 Web sessionModel.ts 同表）。
@Suite struct OnboardingSyncSessionTests {

    /// 与 Go onboardingsync.View 同形的完整负载（含 gaps / 双 readiness 面）。
    static let viewJSON = #"""
    {
      "session_id": "s-1",
      "state": "running",
      "shell_ready": true,
      "provider": "garmin",
      "binding_revision": 3,
      "anchor_day": "2026-11-17",
      "retry_count": 1,
      "error": null,
      "stages": [
        {
          "stage": "recent_raw",
          "status": "in_progress",
          "readiness": "running",
          "target_from": "2026-08-19",
          "target_to": "2026-11-17",
          "observed_from": "2026-10-01",
          "observed_to": "2026-11-17",
          "gaps": [{"from": "2026-09-01", "to": "2026-09-03", "reason": "provider_unavailable"}]
        },
        {
          "stage": "recent_analysis",
          "status": "pending",
          "readiness": "pending",
          "target_from": "2026-08-19",
          "target_to": "2026-11-17"
        }
      ],
      "readiness": {
        "shell_ready": true,
        "recent_data": "running",
        "recent_analysis": "pending",
        "extended_data": "not_started",
        "historical_data": "not_started",
        "historical_analysis": "not_started",
        "auxiliary": "not_started"
      },
      "created_at": "2026-11-17T01:00:00Z",
      "updated_at": "2026-11-17T01:05:00Z"
    }
    """#

    // MARK: - 解码与端点形状

    @Test func decodesSessionView() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, jsonData(Self.viewJSON))])
        let (client, _) = makeTestClient(transport: transport)

        let view = try await client.onboardingSyncSession()
        #expect(view.sessionId == "s-1")
        #expect(view.state == "running")
        #expect(view.shellReady)
        #expect(view.provider == "garmin")
        #expect(view.bindingRevision == 3)
        #expect(view.anchorDay == "2026-11-17")
        #expect(view.retryCount == 1)
        #expect(view.readiness.recentData == .running)
        #expect(view.readiness.recentAnalysis == .pending)
        #expect(view.readiness.historicalAnalysis == .notStarted)

        let stage = try #require(view.stages.first)
        #expect(stage.stage == "recent_raw")
        #expect(stage.readiness == .running)
        #expect(stage.targetFrom == "2026-08-19")
        #expect(stage.observedTo == "2026-11-17")
        let gap = try #require(stage.gaps?.first)
        #expect(gap.from == "2026-09-01")
        #expect(gap.reason == "provider_unavailable")
        #expect(view.stages.count == 2)
    }

    @Test func createPostsEmptyBodyByDefaultAndRetryBodyOnRetry() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(200, jsonData(Self.viewJSON))])
        let (client, _) = makeTestClient(transport: transport)

        _ = try await client.createOnboardingSyncSession(retry: false)
        let first = try #require(await transport.calls(to: "/api/users/me/onboarding/sync").first)
        #expect(first.method == "POST")
        #expect(first.body == Data("{}".utf8))

        _ = try await client.createOnboardingSyncSession(retry: true)
        let second = try #require(await transport.calls(to: "/api/users/me/onboarding/sync").last)
        #expect(second.body == Data(#"{"retry":true}"#.utf8))
    }

    // MARK: - 纯展示口径（与 Web sessionModel.ts 同表）

    @Test func stateAndReadinessLabelsMatchWebCopy() {
        #expect(OnboardingSessionDisplay.stateLabel("waiting_legacy") == "接管已有同步任务")
        #expect(OnboardingSessionDisplay.stateLabel("dispatching") == "正在启动同步")
        #expect(OnboardingSessionDisplay.stateLabel("running") == "同步进行中")
        #expect(OnboardingSessionDisplay.stateLabel("failed") == "同步失败")
        #expect(OnboardingSessionDisplay.stateLabel("completed_with_gaps") == "同步完成（部分缺项）")
        #expect(OnboardingSessionDisplay.stateLabel("completed") == "同步完成")
        #expect(OnboardingSessionDisplay.stateLabel("superseded") == "已由新绑定取代")
        // 未知状态原样回落（不撒谎）
        #expect(OnboardingSessionDisplay.stateLabel("weird") == "weird")

        #expect(OnboardingSessionDisplay.isTerminal("completed"))
        #expect(OnboardingSessionDisplay.isTerminal("completed_with_gaps"))
        #expect(OnboardingSessionDisplay.isTerminal("failed"))
        #expect(OnboardingSessionDisplay.isTerminal("superseded"))
        #expect(!OnboardingSessionDisplay.isTerminal("running"))
        #expect(!OnboardingSessionDisplay.isTerminal("waiting_legacy"))

        #expect(OnboardingSessionDisplay.readinessLabel(.ready) == "已就绪")
        #expect(OnboardingSessionDisplay.readinessLabel(.readyWithGaps) == "已就绪（有缺项）")
        #expect(OnboardingSessionDisplay.readinessLabel(.running) == "进行中")
        #expect(OnboardingSessionDisplay.readinessLabel(.pending) == "等待中")
        #expect(OnboardingSessionDisplay.readinessLabel(.failed) == "失败")
        #expect(OnboardingSessionDisplay.readinessLabel(.partial) == "部分可用")
        #expect(OnboardingSessionDisplay.readinessLabel(.unavailable) == "暂不可用")
        #expect(OnboardingSessionDisplay.readinessLabel(.notStarted) == "未开始")

        #expect(OnboardingSessionDisplay.readinessTone(.ready) == .good)
        #expect(OnboardingSessionDisplay.readinessTone(.readyWithGaps) == .warn)
        #expect(OnboardingSessionDisplay.readinessTone(.partial) == .warn)
        #expect(OnboardingSessionDisplay.readinessTone(.failed) == .bad)
        #expect(OnboardingSessionDisplay.readinessTone(.running) == .muted)
        #expect(OnboardingSessionDisplay.readinessTone(.pending) == .muted)
        #expect(OnboardingSessionDisplay.readinessTone(.unavailable) == .muted)

        #expect(OnboardingSessionDisplay.stageLabel("recent_raw") == "近期数据（活动 / 健康）")
        #expect(OnboardingSessionDisplay.stageLabel("recent_analysis") == "近期分析")
        #expect(OnboardingSessionDisplay.stageLabel("extended_raw") == "历史扩展（180日活动 / 90日健康）")
        #expect(OnboardingSessionDisplay.stageLabel("historical_raw") == "历史补齐（全部可访问活动）")
        #expect(OnboardingSessionDisplay.stageLabel("auxiliary") == "辅助任务（比赛识别 / 路线形状）")
        #expect(OnboardingSessionDisplay.stageLabel("unknown_stage") == "unknown_stage")
    }

    @Test func rangeLabelKeepsOpenEndsInsteadOfFakeCoverage() {
        #expect(OnboardingSessionDisplay.rangeLabel(from: nil, to: nil) == "—")
        #expect(OnboardingSessionDisplay.rangeLabel(from: "2026-11-10", to: "2026-11-16") == "2026-11-10 ~ 2026-11-16")
        // 未完成扫描的一端保持开放，不冒充完整覆盖
        #expect(OnboardingSessionDisplay.rangeLabel(from: nil, to: "2026-11-16") == "… ~ 2026-11-16")
        #expect(OnboardingSessionDisplay.rangeLabel(from: "2026-08-19", to: nil) == "2026-08-19 ~ …")
    }

    @Test func historicalAnalysisCanOutliveRawSync() throws {
        var object = try #require(try JSONSerialization.jsonObject(with: jsonData(Self.viewJSON)) as? [String: Any])
        object["state"] = "completed"
        object["historical_analysis_poll"] = true
        var flags = try #require(object["readiness"] as? [String: Any])
        flags["historical_analysis"] = "pending"
        object["readiness"] = flags
        let decoder = JSONDecoder()
        let pending = try decoder.decode(OnboardingSyncSessionView.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(OnboardingSessionDisplay.shouldPoll(pending))
        #expect(OnboardingSessionDisplay.historicalAnalysisLabel(pending) == "待处理")
        object["historical_analysis_poll"] = false
        object["historical_analysis_reason"] = "interruption_limit"
        let paused = try decoder.decode(OnboardingSyncSessionView.self, from: JSONSerialization.data(withJSONObject: object))
        #expect(!OnboardingSessionDisplay.shouldPoll(paused))
        #expect(OnboardingSessionDisplay.historicalAnalysisLabel(paused) == "待人工处理")
    }

    @Test func summaryChipsIncludeHistoricalAnalysis() throws {
        // 原始/派生/辅助分开，shell_ready 不是 chip（spec 决议）
        let keys = OnboardingSessionDisplay.ReadinessKey.allCases
        #expect(keys.map(\.label) == ["近期数据", "近期分析", "历史扩展", "历史补齐", "历史分析", "辅助任务"])
        let flags = try #require(try JSONDecoder().decode(OnboardingSyncSessionView.self, from: jsonData(Self.viewJSON)).readiness)
        let levels = keys.map { OnboardingSessionDisplay.readinessLevel($0, of: flags) }
        #expect(levels == [.running, .pending, .notStarted, .notStarted, .notStarted, .notStarted])
    }
}

/// 全局 session 状态轮询（devops#1016，Web OnboardingSyncStatusProvider 等价）：
/// 只读 GET 观察服务端进度——绝不创建 session、绝不写；404（无 session，
/// 老用户）/403（开关关，原禁用语义）/终态即停；瞬态错误保留上一视图续轮。
@Suite @MainActor struct OnboardingSyncStatusModelTests {

    private static let pollInterval: Duration = .milliseconds(15)

    private func viewData(state: String) -> Data {
        jsonData(#"{"session_id":"s-1","state":"\#(state)","shell_ready":true,"provider":"coros","binding_revision":1,"anchor_day":"2026-11-17","retry_count":0,"stages":[],"readiness":{"shell_ready":true,"recent_data":"running","recent_analysis":"pending","extended_data":"not_started","historical_data":"not_started","historical_analysis":"not_started","auxiliary":"not_started"}}"#)
    }

    private func makeStatus(_ transport: MockTransport) -> OnboardingSyncStatusModel {
        let (client, _) = makeTestClient(transport: transport)
        let status = OnboardingSyncStatusModel(pollInterval: Self.pollInterval)
        status.configure(api: client)
        return status
    }

    @Test func terminalStateStopsPolling() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, viewData(state: "completed"))])
        let status = makeStatus(transport)

        status.startPolling()
        try await Task.sleep(for: .milliseconds(120))
        // 终态后不再轮询：只打了一次 GET
        #expect(await transport.count(path: "/api/users/me/onboarding/sync") == 1)
        #expect(status.view?.state == "completed")
    }

    @Test func noSessionOrDisabledStopsSilentlyWithNoBanner() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(404, Data())])
        let status = makeStatus(transport)

        status.startPolling()
        try await Task.sleep(for: .milliseconds(120))
        #expect(await transport.count(path: "/api/users/me/onboarding/sync") == 1)
        #expect(status.view == nil)
        #expect(!status.shouldShowBanner)

        // 403（开关关）同款：入口不存在，不轮询不建 session
        let transport2 = MockTransport()
        await transport2.plan("/api/users/me/onboarding/sync", responses: [(403, jsonData(#"{"error":"sync_disabled"}"#))])
        let status2 = makeStatus(transport2)
        status2.startPolling()
        try await Task.sleep(for: .milliseconds(120))
        #expect(await transport2.count(path: "/api/users/me/onboarding/sync") == 1)
        #expect(status2.view == nil)
    }

    @Test func transientErrorKeepsLastViewAndKeepsPolling() async throws {
        let transport = MockTransport()
        // 首次成功，其后持续 5xx
        await transport.plan("/api/users/me/onboarding/sync", responses: [
            (200, viewData(state: "running")),
            (500, Data()),
        ])
        let status = makeStatus(transport)

        status.startPolling()
        try await Task.sleep(for: .milliseconds(150))
        let hits = await transport.count(path: "/api/users/me/onboarding/sync")
        #expect(hits >= 3)
        // 网络抖动不清近期视图：保留最后一次成功结果
        #expect(status.view?.state == "running")
    }

    @Test func failedAndGapsTerminalKeepBannerUntilDismissed() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, viewData(state: "failed"))])
        let status = makeStatus(transport)

        status.startPolling()
        try await Task.sleep(for: .milliseconds(100))
        // 后台失败不收回已展示的状态：banner 保留（错误 + 重试入口）
        #expect(status.shouldShowBanner)
        status.dismiss()
        #expect(!status.shouldShowBanner)
    }

    @Test func retryPostsRetryTrueAndResumesPolling() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, viewData(state: "failed"))])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(200, viewData(state: "running"))])
        let status = makeStatus(transport)

        status.startPolling()
        try await Task.sleep(for: .milliseconds(100))
        #expect(status.view?.state == "failed")

        // 服务端重试受理：后续 GET 回 running（重放末位响应）
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, viewData(state: "running"))])
        await status.retry()
        #expect(status.view?.state == "running")
        let post = try #require(await transport.calls(to: "/api/users/me/onboarding/sync").first { $0.method == "POST" })
        #expect(post.body == Data(#"{"retry":true}"#.utf8))

        // 重试后非终态 → 轮询恢复
        try await Task.sleep(for: .milliseconds(120))
        let gets = await transport.calls(to: "/api/users/me/onboarding/sync").filter { $0.method == "GET" }.count
        #expect(gets >= 3)
    }

    @Test func retryFailureSurfacesErrorWithoutLosingView() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, viewData(state: "failed"))])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(500, Data())])
        let status = makeStatus(transport)

        status.startPolling()
        try await Task.sleep(for: .milliseconds(100))
        await status.retry()
        #expect(status.retryError == "重试失败，请稍后再试")
        // 重试失败不清掉服务端真实状态
        #expect(status.view?.state == "failed")
    }

    @Test func resetClearsStateForAccountSwitch() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, viewData(state: "running"))])
        let status = makeStatus(transport)

        status.startPolling()
        try await Task.sleep(for: .milliseconds(60))
        status.dismiss()
        status.reset()
        #expect(status.view == nil)
        #expect(!status.dismissed)
        #expect(status.retryError == nil)

        // 停轮后不再发请求。先等一个 settle 窗口：stopPolling 是协作式取消，
        // reset 瞬间已在途的那次 GET 仍会落地记账（CI 慢机上必现），须让它
        // 落完再记基线，否则在途请求晚落地会被误判为「停轮后仍在发请求」。
        try await Task.sleep(for: .milliseconds(80))
        let hits = await transport.count(path: "/api/users/me/onboarding/sync")
        try await Task.sleep(for: .milliseconds(120))
        #expect(await transport.count(path: "/api/users/me/onboarding/sync") == hits)
    }
}

/// OnboardingModel 的 session 提交分支（devops#1016，Web SessionSubmitStep
/// 等价）：双开关开 → POST 创建/认领 session，shell_ready 确认后才进首页；
/// 完成走 profile-only（空 body，绝不把 session 的 recent run 喂给旧
/// finalizer）；403 回退旧 full-run 流程；创建失败不假报后台运行。
@Suite @MainActor struct OnboardingSessionSubmitTests {

    private static let pollInterval: Duration = .milliseconds(15)

    private func profileBody(sessionFlags: Bool) -> Data {
        let features = sessionFlags
            ? #"{"sync_data_at_onboarding":true,"onboarding_sync_session":true}"#
            : #"{"sync_data_at_onboarding":true}"#
        return jsonData(#"{"id":"u1","onboarding":{"watch_ready":true,"profile_ready":true,"completed_at":"2026-10-01T00:00:00Z"},"features":\#(features)}"#)
    }

    private func sessionBody(shellReady: Bool) -> Data {
        jsonData(#"{"session_id":"s-1","state":"running","shell_ready":\#(shellReady),"provider":"coros","binding_revision":1,"anchor_day":"2026-11-17","retry_count":0,"stages":[],"readiness":{"shell_ready":\#(shellReady),"recent_data":"running","recent_analysis":"pending","extended_data":"not_started","historical_data":"not_started","historical_analysis":"not_started","auxiliary":"not_started"}}"#)
    }

    private func makeModel(_ transport: MockTransport, finished: @escaping @MainActor () -> Void) -> OnboardingModel {
        let (client, _) = makeTestClient(transport: transport)
        return OnboardingModel(
            api: client,
            runStore: InMemoryOnboardingRunStore(),
            sessionPollInterval: Self.pollInterval,
            onFinish: finished
        )
    }

    // MARK: - 落位与主链

    @Test func sessionFlagsRouteToSessionSubmitStep() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: true))])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(200, sessionBody(shellReady: false))])
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, sessionBody(shellReady: false))])
        let model = makeModel(transport) {}

        await model.refresh()
        #expect(model.step == .sync)
        #expect(model.sessionMode)
        #expect(model.sessionPhase == .adopting)
        // session 模式不碰旧 full-run 入口
        #expect(await transport.count(path: "/api/u1/sync") == 0)
    }

    @Test func shellReadyCompletesProfileOnlyAndEntersHome() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: true))])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(200, sessionBody(shellReady: true))])
        await transport.plan("/api/users/me/onboarding/complete", "POST", responses: [(200, jsonData(#"{}"#))])
        var finished = 0
        let model = makeModel(transport) { finished += 1 }

        await model.refresh()
        #expect(finished == 1)
        let complete = try #require(await transport.calls(to: "/api/users/me/onboarding/complete").first)
        // profile-only：空 body，绝无 run_id（新 recent run 不发给旧 finalizer）
        #expect(complete.body == Data("{}".utf8))
        #expect(await transport.count(path: "/api/u1/sync") == 0)
    }

    @Test func waitingLegacyAdoptsByPollingUntilShellReady() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: true))])
        // POST 先回 waiting_legacy（shell 未就绪，服务端接管旧 full run）
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(200, sessionBody(shellReady: false))])
        // GET 轮到 shell_ready
        await transport.plan("/api/users/me/onboarding/sync", responses: [
            (200, sessionBody(shellReady: false)),
            (200, sessionBody(shellReady: true)),
        ])
        await transport.plan("/api/users/me/onboarding/complete", "POST", responses: [(200, jsonData(#"{}"#))])
        var finished = 0
        let model = makeModel(transport) { finished += 1 }

        await model.refresh()
        #expect(model.sessionPhase == .adopting)
        try await Task.sleep(for: .milliseconds(150))
        #expect(finished == 1)
    }

    @Test func flagsOffKeepsLegacyFlowUntouched() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: false))])
        await transport.plan("/api/users/u1/pipelines", responses: [(200, jsonData(#"{"pipelines":[]}"#))])
        await transport.plan("/api/u1/sync", "POST", responses: [(202, jsonData(#"{"run_id":"run-1","pipeline_name":"onboarding"}"#))])
        let model = makeModel(transport) {}

        await model.refresh()
        #expect(!model.sessionMode)
        #expect(model.sessionPhase == nil)
        #expect(await transport.count(path: "/api/users/me/onboarding/sync") == 0)
        #expect(await transport.count(path: "/api/u1/sync") == 1)
    }

    // MARK: - 403 回退与失败语义

    @Test func forbiddenFallsBackToLegacyFullRunFlow() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [
            (200, profileBody(sessionFlags: true)),
            (200, profileBody(sessionFlags: true)),
        ])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(403, jsonData(#"{"error":"onboarding_sync_not_enabled"}"#))])
        // 回退后走旧链：认领查询 + 触发
        await transport.plan("/api/users/u1/pipelines", responses: [(200, jsonData(#"{"pipelines":[]}"#))])
        await transport.plan("/api/u1/sync", "POST", responses: [(202, jsonData(#"{"run_id":"run-9","pipeline_name":"onboarding"}"#))])
        let model = makeModel(transport) {}

        await model.refresh()
        #expect(!model.sessionMode)
        #expect(model.sessionPhase == nil)
        #expect(await transport.count(path: "/api/u1/sync") == 1)
    }

    @Test func noWatchProviderIsCreateFailedWithHonestCopy() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: true))])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(409, jsonData(#"{"error":"no_watch_provider"}"#))])
        var finished = 0
        let model = makeModel(transport) { finished += 1 }

        await model.refresh()
        #expect(model.sessionPhase == .createFailed)
        #expect(model.sessionError == "尚未绑定手表，请返回上一步完成绑定。")
        #expect(finished == 0)
        // 创建失败：后台没有任何任务在跑，也不完成、不触发 full
        #expect(await transport.count(path: "/api/users/me/onboarding/complete") == 0)
        #expect(await transport.count(path: "/api/u1/sync") == 0)
    }

    @Test func createServerErrorOffersRetryThatRecreates() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: true))])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [
            (500, Data()),
            (200, sessionBody(shellReady: true)),
        ])
        await transport.plan("/api/users/me/onboarding/complete", "POST", responses: [(200, jsonData(#"{}"#))])
        var finished = 0
        let model = makeModel(transport) { finished += 1 }

        await model.refresh()
        #expect(model.sessionPhase == .createFailed)
        #expect(finished == 0)

        await model.retrySessionCreate()
        #expect(finished == 1)
    }

    @Test func enterFailureIsRetryableWithoutRecreatingSession() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: true))])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(200, sessionBody(shellReady: true))])
        await transport.plan("/api/users/me/onboarding/complete", "POST", responses: [
            (500, Data()),
            (200, jsonData(#"{}"#)),
        ])
        var finished = 0
        let model = makeModel(transport) { finished += 1 }

        await model.refresh()
        #expect(model.sessionPhase == .enterFailed)
        #expect(finished == 0)
        // 重试只重走进入（完成），不重建 session
        await model.retryEnterApp()
        #expect(finished == 1)
        #expect(await transport.calls(to: "/api/users/me/onboarding/sync").filter { $0.method == "POST" }.count == 1)
    }

    @Test func bindWatchLookupFailureSurfacesInSessionView() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, jsonData(#"{"id":"u1","onboarding":{"watch_ready":false,"profile_ready":true,"completed_at":"2026-10-01T00:00:00Z"},"features":{"sync_data_at_onboarding":true,"onboarding_sync_session":true}}"#))])
        await transport.plan("/api/users/me/watch/login", "POST", responses: [(200, jsonData(#"{"ok":true}"#))])
        let model = makeModel(transport) {}

        await model.refresh()
        #expect(model.step == .watch)
        // 绑定成功后兜底取 userId 失败（5xx）→ 错误必须落在 session 视图可见字段
        await transport.plan("/api/users/me/profile", responses: [(500, Data())])
        model.watchProvider = .coros
        model.watchEmail = "a@b.c"
        model.watchPassword = "pw"
        await model.bindWatch()

        #expect(model.step == .sync)
        #expect(model.sessionPhase == .createFailed)
        #expect(model.sessionError != nil)
    }

    // MARK: - 绑表步衔接（onboarding 内联绑表后直接走 session 提交）

    @Test func bindWatchInSessionModeStartsSessionSubmit() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: true))])
        await transport.plan("/api/users/me/watch/login", "POST", responses: [(200, jsonData(#"{"ok":true}"#))])
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(200, sessionBody(shellReady: true))])
        await transport.plan("/api/users/me/onboarding/complete", "POST", responses: [(200, jsonData(#"{}"#))])
        var finished = 0
        let model = makeModel(transport) { finished += 1 }

        // 落位到绑表步（watch_ready false）
        await transport.plan("/api/users/me/profile", responses: [(200, jsonData(#"{"id":"u1","onboarding":{"watch_ready":false,"profile_ready":true,"completed_at":"2026-10-01T00:00:00Z"},"features":{"sync_data_at_onboarding":true,"onboarding_sync_session":true}}"#))])
        await model.refresh()
        #expect(model.step == .watch)

        // 重新计划 profile（绑表成功后 currentUserID 兜底再取一次）
        await transport.plan("/api/users/me/profile", responses: [(200, profileBody(sessionFlags: true))])
        model.watchProvider = .coros
        model.watchEmail = "a@b.c"
        model.watchPassword = "pw"
        await model.bindWatch()
        #expect(finished == 1)
        #expect(await transport.count(path: "/api/u1/sync") == 0)
    }
}

/// 全局装配（devops#1016）：AppModel 持有状态模型并在进入 loggedIn 时启动
/// 只读观察（404/403 静默停轮——老用户无 banner）；登出/会话失效清空；
/// 已完成 onboarding 的用户从 profile 绑表走 session 创建入口（开关关则
/// 维持旧 full-run fire-and-forget）。
@Suite @MainActor struct OnboardingSessionAppWiringTests {

    private static let pollInterval: Duration = .milliseconds(15)

    private func sessionBody(state: String) -> Data {
        jsonData(#"{"session_id":"s-1","state":"\#(state)","shell_ready":true,"provider":"coros","binding_revision":1,"anchor_day":"2026-11-17","retry_count":0,"stages":[],"readiness":{"shell_ready":true,"recent_data":"running","recent_analysis":"pending","extended_data":"not_started","historical_data":"not_started","historical_analysis":"not_started","auxiliary":"not_started"}}"#)
    }

    private func loggedInApp(_ transport: MockTransport, sessionFlags: Bool) async -> AppModel {
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        await transport.plan("/api/users/me", responses: [(200, jsonData(#"{"id":"u1","email":"a@b.c"}"#))])
        let features = sessionFlags
            ? #"{"sync_data_at_onboarding":true,"onboarding_sync_session":true}"#
            : #"{"sync_data_at_onboarding":true}"#
        await transport.plan("/api/users/me/profile", responses: [(
            200, jsonData(#"{"id":"u1","onboarding":{"watch_ready":true,"profile_ready":true,"completed_at":"2026-09-01"},"features":\#(features)}"#)
        )])
        let model = AppModel(api: client, tokens: store, statusPollInterval: Self.pollInterval)
        try? await Task.sleep(for: .milliseconds(20))
        await model.bootstrap()
        return model
    }

    @Test func enteringLoggedInObservesOnceAndStopsOnNoSession() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(404, Data())])
        let app = await loggedInApp(transport, sessionFlags: true)

        #expect(app.phase == .loggedIn)
        try await Task.sleep(for: .milliseconds(100))
        // 老用户（无 session）：一次 GET 静默停轮，banner 不出现
        #expect(await transport.count(path: "/api/users/me/onboarding/sync") == 1)
        #expect(!app.onboardingSyncStatus.shouldShowBanner)
    }

    @Test func finishOnboardingStartsObservingForFreshSession() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport, sessionFlags: true)
        await transport.plan("/api/users/me/onboarding/sync", responses: [(404, Data())])
        try await Task.sleep(for: .milliseconds(100))
        #expect(await transport.count(path: "/api/users/me/onboarding/sync") == 1)

        // onboarding 完成离场（session 提交步的 onFinish 出口）：恢复观察
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, sessionBody(state: "running"))])
        app.finishOnboarding()
        try await Task.sleep(for: .milliseconds(100))
        #expect(await transport.count(path: "/api/users/me/onboarding/sync") >= 2)
        #expect(app.onboardingSyncStatus.shouldShowBanner)
    }

    @Test func logoutClearsStatusForNextAccount() async throws {
        let transport = MockTransport()
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, sessionBody(state: "running"))])
        let app = await loggedInApp(transport, sessionFlags: true)
        try await Task.sleep(for: .milliseconds(80))
        #expect(app.onboardingSyncStatus.view != nil)

        await app.logout()
        #expect(app.onboardingSyncStatus.view == nil)
        let hits = await transport.count(path: "/api/users/me/onboarding/sync")
        try await Task.sleep(for: .milliseconds(100))
        #expect(await transport.count(path: "/api/users/me/onboarding/sync") == hits)
    }

    // MARK: - profile 绑表（已完成 onboarding 用户）的首次同步入口

    private func planWatchBind(_ transport: MockTransport) async {
        await transport.plan("/api/users/me/watch", responses: [(
            200, jsonData(#"{"provider":"coros","provider_display_name":"COROS","logged_in":true,"email":"a@b.c","device":null,"last_sync_at":null,"capabilities":[]}"#)
        )])
        await transport.plan("/api/users/me/watch/login", "POST", responses: [(200, jsonData(#"{"ok":true}"#))])
    }

    @Test func watchBindWithSessionFlagsCreatesSessionNotFullRun() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport, sessionFlags: true)
        await planWatchBind(transport)
        await transport.plan("/api/users/me/onboarding/sync", "POST", responses: [(200, sessionBody(state: "dispatching"))])
        await transport.plan("/api/users/me/onboarding/sync", responses: [(200, sessionBody(state: "dispatching"))])

        let watch = WatchModel(provider: nil, redirect: .profileEdit)
        await watch.activate(app: app)
        watch.selectProvider(.coros)
        watch.email = "a@b.c"
        watch.password = "pw"
        await watch.connect()

        try await Task.sleep(for: .milliseconds(150))
        let posts = await transport.calls(to: "/api/users/me/onboarding/sync").filter { $0.method == "POST" }
        #expect(posts.count == 1)
        // 不触发旧 full-run 入口（不重复 full）
        #expect(await transport.count(path: "/api/u1/sync") == 0)
    }

    @Test func watchBindWithoutSessionFlagsKeepsLegacyFullRun() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport, sessionFlags: false)
        await planWatchBind(transport)
        // 旧链：认领查询 + 触发（无指针）
        await transport.plan("/api/users/u1/pipelines", responses: [(200, jsonData(#"{"pipelines":[]}"#))])
        await transport.plan("/api/u1/sync", "POST", responses: [(202, jsonData(#"{"run_id":"run-1","pipeline_name":"onboarding"}"#))])

        let watch = WatchModel(provider: nil, redirect: .profileEdit)
        await watch.activate(app: app)
        watch.selectProvider(.coros)
        watch.email = "a@b.c"
        watch.password = "pw"
        await watch.connect()

        try await Task.sleep(for: .milliseconds(150))
        #expect(await transport.count(path: "/api/u1/sync") == 1)
        // session 创建入口不被触碰（bootstrap 观察轮的只读 GET 不算）
        let sessionPosts = await transport.calls(to: "/api/users/me/onboarding/sync").filter { $0.method == "POST" }
        #expect(sessionPosts.isEmpty)
    }
}
