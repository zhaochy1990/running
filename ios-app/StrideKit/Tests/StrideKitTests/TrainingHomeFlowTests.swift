import Foundation
import Testing
@testable import StrideKit

/// 训练 tab 今日首页流程测试（devops#941）：左右轻扫切日（mp 7c592c67）+
/// 跨周补拉的 loading 门控（mp 6de91c32 / devops#929——空态判定必须等
/// loading 结束，补拉期间骨架占位，不闪「今日无训练安排」假空态）。
@Suite @MainActor struct TrainingHomeFlowTests {

    private func makeApp(_ transport: MockTransport) async -> AppModel {
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        let model = AppModel(api: client, tokens: store)
        try? await Task.sleep(for: .milliseconds(20))
        return model
    }

    private func loggedInApp(_ transport: MockTransport) async -> AppModel {
        await transport.plan("/api/users/me", responses: [(200, jsonData(#"{"id":"u1","email":"a@b.c"}"#))])
        await transport.plan("/api/users/me/profile", responses: [(
            200, jsonData(#"{"id":"u1","onboarding":{"watch_ready":true,"profile_ready":true,"completed_at":"2026-09-01"},"features":{}}"#)
        )])
        let model = await makeApp(transport)
        await model.bootstrap()
        return model
    }

    // 上海 2026-11-05 12:00（UTC+8 → UTC 04:00）：周四，所在周 11-02（周一）起。
    private var thursday: Date {
        let components = DateComponents(timeZone: TimeZone(identifier: "UTC"),
                                        year: 2026, month: 11, day: 5, hour: 4, minute: 0)
        return Calendar(identifier: .gregorian).date(from: components)!
    }

    private func emptyWeekPlan(weekName: String) -> Data {
        jsonData("""
        {"plan_id":"p1","week_name":"\(weekName)","status":"active","content_version":2,
         "content":{"sessions":[],"nutrition":[]}}
        """)
    }

    /// 周 sessions 响应（同一 path 按命中序消费：第 1 次本周空，第 2 次上周带课）。
    private func sessionsResponse(dates: [String]) -> Data {
        let rows = dates.map { date in
            """
            {"workout_id":"w-\(date)","date":"\(date)","source":"custom","kind":"run",
             "name":"课","summary":null,"spec":null,
             "total_distance_m":8000,"total_duration_s":3600,"estimated_dose":55.5}
            """
        }.joined(separator: ",")
        return jsonData(#"{"sessions":[\#(rows)]}"#)
    }

    @Test func swipeWithinWeekShiftsDayWithoutRefetch() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        // 本周（11-02..11-08）无课：初始加载后是合法空态（loading=false）。
        await transport.plan("/api/u1/plan/weeks/2026-11-02_11-08", responses: [(200, emptyWeekPlan(weekName: "2026-11-02_11-08"))])
        await transport.plan("/api/users/me/plan/sessions", responses: [(200, sessionsResponse(dates: []))])

        let model = TrainingHomeModel(now: thursday)
        await model.activate(app: app)

        #expect(model.selectedDate == "2026-11-05")
        #expect(!model.loading)
        #expect(model.workout == nil)

        // 右滑 → 后一天；左滑 → 前一天（同周缓存渲染，不重拉）。
        model.shiftDay(1)
        #expect(model.selectedDate == "2026-11-06")
        #expect(!model.loading)
        model.shiftDay(-1)
        #expect(model.selectedDate == "2026-11-05")
        #expect(!model.loading)

        // 同周切换零新增请求（本周 sessions 只在 activate 拉过一次）。
        let sessionFetches = await transport.count(path: "/api/users/me/plan/sessions")
        #expect(sessionFetches == 1)
    }

    @Test func swipeAcrossWeekGatesEmptyStateUntilWeekLoaded() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        await transport.plan("/api/u1/plan/weeks/2026-11-02_11-08", responses: [(200, emptyWeekPlan(weekName: "2026-11-02_11-08"))])
        // 第 1 次命中 = 本周（空）；第 2 次 = 左滑跨周到 11-01（上周，10-26..11-01）。
        await transport.plan("/api/users/me/plan/sessions", responses: [
            (200, sessionsResponse(dates: [])),
            (200, sessionsResponse(dates: ["2026-11-01"])),
        ])

        let model = TrainingHomeModel(now: thursday)
        await model.activate(app: app)
        #expect(!model.loading)

        // 11-05 → 11-01：连续左滑 4 天跨进上一周；最后一跳落在跨周补拉上。
        model.shiftDay(-1)
        model.shiftDay(-1)
        model.shiftDay(-1)
        #expect(model.selectedDate == "2026-11-02")
        #expect(!model.loading)
        model.shiftDay(-1)
        #expect(model.selectedDate == "2026-11-01")
        // 假空态门控：上周数据回来前 loading=true（骨架），不得先闪空态。
        #expect(model.loading)
        #expect(model.workout == nil)

        // 拉取回填后收 loading、渲染上周日的课。
        try await waitForLoadingSettled(model)
        #expect(!model.loading)
        #expect(model.workout?.date == "2026-11-01")

        let sessionFetches = await transport.count(path: "/api/users/me/plan/sessions")
        #expect(sessionFetches == 2)
    }

    /// 等待 model 上的异步补拉收敛（MockTransport 即时响应，短轮询足够；
    /// 超时由调用方的 `!model.loading` 断言自然失败）。
    private func waitForLoadingSettled(_ model: TrainingHomeModel, timeoutMs: Int = 1000) async throws {
        let start = Date()
        while model.loading, Date().timeIntervalSince(start) < TimeInterval(timeoutMs) / 1000 {
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
