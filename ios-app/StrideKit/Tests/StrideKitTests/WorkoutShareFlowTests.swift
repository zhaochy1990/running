import Foundation
import Testing
@testable import StrideKit

/// workout-share 双 CTA 流（devops#703 / #758 拍板 2）：选日保存（save_token
/// 幂等）→ 先存后推 → 绑表检查 → 回来自动续推；未登录 CTA → 登录回跳。
@Suite @MainActor struct WorkoutShareFlowTests {

    private func makeApp(_ transport: MockTransport, withToken: Bool = false) async -> AppModel {
        let (client, store) = makeTestClient(transport: transport)
        if withToken {
            await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        }
        let model = AppModel(api: client, tokens: store)
        try? await Task.sleep(for: .milliseconds(20))
        return model
    }

    private func loggedInApp(_ transport: MockTransport) async -> AppModel {
        await transport.plan("/api/users/me", responses: [(200, jsonData(#"{"id":"u1","email":"a@b.c"}"#))])
        await transport.plan("/api/users/me/profile", responses: [(
            200, jsonData(#"{"id":"u1","onboarding":{"watch_ready":true,"profile_ready":true,"completed_at":"2026-09-01"},"features":{}}"#)
        )])
        let model = await makeApp(transport, withToken: true)
        await model.bootstrap()
        return model
    }

    // 上海 2026-10-29 12:00（UTC+8 → UTC 04:00）：对齐 sharedWorkoutBody 的
    // 计划日，选日窗口（今天起 8 项）稳定含 2026-10-29（原实现取真实今天，
    // 2026-10-30 起窗口滑出即脆断）。
    private var plannedNoon: Date {
        let components = DateComponents(timeZone: TimeZone(identifier: "UTC"),
                                        year: 2026, month: 10, day: 29, hour: 4, minute: 0)
        return Calendar(identifier: .gregorian).date(from: components)!
    }

    private func sharedWorkoutBody() -> String {
        """
        {"kind":"run","name":"节奏课","summary":"阈","date":"2026-10-29",
         "spec":{"name":"节奏课","date":"2026-10-29","note":null,
                 "blocks":[{"repeat":1,"steps":[
                    {"step_kind":"work","duration":{"kind":"distance_m","value":5000},
                     "target":{"kind":"pace_s_km","low":300,"high":320},"note":null}]}]},
         "total_distance_m":5000,"total_duration_s":1500,"estimated_dose":60.0}
        """
    }

    @Test func saveFlowUpsertsWithSharedSaveTokenAndMarksSaved() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        await transport.plan("/api/workouts/shared/u1/w1", responses: [(200, jsonData(sharedWorkoutBody()))])
        await transport.plan("/api/users/me/custom-workouts", "POST", responses: [(
            200, jsonData(#"{"workout_id":"cw-9","date":"2026-10-29","source":"custom","pushed":false}"#)
        )])

        let share = WorkoutShareModel(user: "u1", workout: "w1", now: plannedNoon)
        await share.activate(app: app)
        #expect(share.loadState == .ready)

        share.saveTap()
        #expect(share.sheetVisible)
        // 选项窗是「今天起 8 天」（landingBuildPushDateOptions）：写死历史日期
        // 会在过窗后让查找失败（2026-10-30 起实证红）。取窗内第三项（今天+2），
        // 测试与日历解耦；计划日仅影响默认选中，不参与断言。
        let option = try #require(share.sheetOptions.dropFirst(2).first)
        await share.selectDate(option.value)

        #expect(share.saved)
        #expect(!share.pushed)
        let call = try #require(await transport.calls(to: "/api/users/me/custom-workouts").last)
        let sent = try JSONSerialization.jsonObject(with: call.body!) as? [String: Any]
        #expect(sent?["save_token"] as? String == "shared-w1")
        #expect(sent?["date"] as? String == option.value)
    }

    @Test func pushFlowChecksWatchAndResumesAfterBind() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        await transport.plan("/api/workouts/shared/u1/w1", responses: [(200, jsonData(sharedWorkoutBody()))])
        await transport.plan("/api/users/me/custom-workouts", "POST", responses: [(
            200, jsonData(#"{"workout_id":"cw-9","date":"2026-10-29","source":"custom","pushed":false}"#)
        )])
        // 未绑表 → provider null
        await transport.plan("/api/users/me/watch", responses: [(
            200, jsonData(#"{"provider":null,"provider_display_name":null,"logged_in":false,"email":null,"device":null,"last_sync_at":null,"capabilities":[]}"#)
        )])

        let share = WorkoutShareModel(user: "u1", workout: "w1", now: plannedNoon)
        await share.activate(app: app)

        share.pushTap()
        #expect(share.sheetTitle == "保存并推送到哪一天？")
        await share.selectDate("2026-10-29")
        // 已保存但推送被绑表检查拦下 → 触发引导信号
        #expect(share.saved)
        #expect(share.needsWatchBinding)

        // 「去绑定」→ watch 路由入栈
        share.confirmGoBindWatch()
        #expect(app.router.paths.values.contains { $0.contains(.watch(provider: nil)) })

        // 绑定后回来：重新 activate 自动续推（绑表 → push 端点）
        await transport.plan("/api/users/me/watch", responses: [(
            200, jsonData(#"{"provider":"coros","provider_display_name":"COROS","logged_in":true,"email":"a@b.c","device":null,"last_sync_at":null,"capabilities":[]}"#)
        )])
        await transport.plan("/api/users/me/custom-workouts/cw-9/push", "POST", responses: [(
            200, jsonData(#"{"ok":true,"workout_id":"cw-9","scheduled_workout_id":1,"provider":"coros","provider_workout_id":"p","push_date":"2026-10-29"}"#)
        )])
        await share.resumeIfNeeded()
        #expect(share.pushed)
    }

    @Test func deadLinkOnMissingParams() async {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        let share = WorkoutShareModel(user: "", workout: "w1")
        await share.activate(app: app)
        #expect(share.loadState == .dead)
    }

    @Test func notLoggedInCTARequestsLoginWithLandingRedirect() async throws {
        let transport = MockTransport()
        let app = await makeApp(transport)
        await app.bootstrap()

        let share = WorkoutShareModel(user: "u1", workout: "w1", now: plannedNoon)
        await transport.plan("/api/workouts/shared/u1/w1", responses: [(200, jsonData(sharedWorkoutBody()))])
        await share.activate(app: app)
        share.saveTap()
        // 未登录 → 不弹选日，切登录流且 redirect=本页
        #expect(!share.sheetVisible)
        #expect(app.phase == .loggedOut)
        #expect(app.loginRedirect == .workoutShare(user: "u1", workout: "w1"))
    }

}
