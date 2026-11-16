import Foundation
import Testing
@testable import StrideKit

/// 记录 tab activate 装配回归测试（devops#1003 P0）：activate() 必须装配
/// ActivitiesRepository（TrainingHomeModel.activate 同款接线）——漏掉会让
/// fetch 的 guard let repo 永远静默空态（记录 tab 永远「暂无活动记录」）。
@Suite @MainActor struct ActivitiesActivateFlowTests {

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

    /// 单条活动的列表响应（11 月一条 + 整月聚合）。
    private var listResponse: Data {
        jsonData("""
        {"total":1,"activities":[
          {"label_id":"lbl-1","name":"晨跑","sport_type":1,"sport_name":"Run","date":"2026-11-16",
           "distance_m":10000,"distance_km":10.0,"duration_s":3000,"duration_fmt":"00:50:00",
           "avg_pace_s_km":300,"pace_fmt":"5:00","avg_hr":150,"training_load":50}
        ],"monthly_summaries":{"2026-11":{"activity_count":1,"total_run_km":10.0,"duration_s":3000}}}
        """)
    }

    @Test func activateWiresRepoAndFetchesList() async throws {
        let transport = MockTransport()
        let app = await loggedInApp(transport)
        await transport.plan("/api/u1/activities", responses: [(200, listResponse)])

        let model = ActivitiesModel()
        await model.activate(app: app)

        // 回归锚点：activate 装配 repo 后首拉必须真的发出（修复前 repo=nil，
        // 零请求、永久空态）。
        let fetches = await transport.count(path: "/api/u1/activities")
        #expect(fetches == 1)
        #expect(!model.loading)
        #expect(model.monthGroups.count == 1)
        #expect(model.monthGroups[0].rows.count == 1)
        #expect(model.monthGroups[0].rows[0].name == "晨跑")
    }

    @Test func activateWithoutUserKeepsEmptyStateSilently() async throws {
        let transport = MockTransport()
        // 无 token → bootstrap 即 loggedOut（phase 离开 .checking，
        // activate 才能等完 settle——不调 bootstrap 会永久 .checking）。
        let (client, store) = makeTestClient(transport: transport)
        let app = AppModel(api: client, tokens: store)
        try? await Task.sleep(for: .milliseconds(20))
        await app.bootstrap()

        let model = ActivitiesModel()
        await model.activate(app: app)

        #expect(!model.loading)
        #expect(model.monthGroups.isEmpty)
        let fetches = await transport.count(path: "/api/u1/activities")
        #expect(fetches == 0)
    }
}
