import Foundation
import Testing
@testable import StrideKit

/// 产品路线三区分区映射锁定（devops#1018 P2）：`GET /api/roadmap` 的
/// backlog/accepted/released 三数组 → 投票池/正在做/最近上线 三区行投影，
/// 与 mp roadmap-panel（components/roadmap-panel/index.ts 的
/// toPoolRow/toAcceptedRow/toReleasedRow）逐字段对齐；空数组 → 空区
/// （视图层整区隐藏不留白）。锁死「已上线想法进最近上线、可投票想法进
/// 投票池」的归属，防止分区串区回归。
@Suite @MainActor struct RoadmapPanelModelTests {

    private func makeApp(_ transport: MockTransport) async -> AppModel {
        let (client, store) = makeTestClient(transport: transport)
        await store.save(access: "acc", refresh: "ref", expiresIn: 300)
        let model = AppModel(api: client, tokens: store)
        try? await Task.sleep(for: .milliseconds(20))
        return model
    }

    /// 三数组各一条 → 三区各一行，字段按 mp 投影（日期点分、票数快照、
    /// 预计 chip、投票态/新想法徽章）。
    @Test func roadmapResponseMapsFeaturesIntoTheirOwnZones() async throws {
        let transport = MockTransport()
        let app = await makeApp(transport)
        await transport.plan("/api/roadmap", responses: [(200, jsonData("""
        {"summary":{"my_votes":1,"total_votes":9,"released_count":1},
         "released":[{"id":11,"title":"单次训练课程","summary":"自建课","description":"d",
                      "released_at":"2026-11-01T10:00:00+08:00","votes_snapshot":7}],
         "accepted":[{"id":8,"title":"正在做的想法","summary":"排期中","description":"d",
                      "category":"training","planned_note":"2026.12","votes":5}],
         "backlog":[{"id":15,"title":"投票池想法","summary":"来投","description":"d",
                     "category":"social","is_new":true,"votes":3,"voted":true}]}
        """))])

        let panel = RoadmapPanelModel()
        await panel.activate(app: app)

        #expect(panel.loadError.isEmpty)
        // 分区归属：released → 最近上线（id 11），accepted → 正在做（id 8），
        // backlog → 投票池（id 15），互不串区。
        #expect(panel.releasedRows.map(\.id) == [11])
        #expect(panel.acceptedRows.map(\.id) == [8])
        #expect(panel.poolRows.map(\.id) == [15])

        // 字段投影（mp toReleasedRow/toAcceptedRow/toPoolRow 同款）。
        #expect(panel.releasedRows[0].date == "2026.11.01")
        #expect(panel.releasedRows[0].proof == 7)
        #expect(panel.releasedRows[0].blurb == "自建课")
        #expect(panel.acceptedRows[0].plannedNote == "2026.12")
        #expect(panel.acceptedRows[0].votes == 5)
        #expect(panel.poolRows[0].isNew)
        #expect(panel.poolRows[0].voted)
        #expect(panel.poolRows[0].votes == 3)
    }

    /// 空区整区隐藏的数据面：数组为空 → 行集为空（视图按 isEmpty 收区）。
    @Test func emptyZonesStayEmptyForHiddenRendering() async throws {
        let transport = MockTransport()
        let app = await makeApp(transport)
        await transport.plan("/api/roadmap", responses: [(200, jsonData("""
        {"summary":{"my_votes":0,"total_votes":0,"released_count":0},
         "released":[],"accepted":[],
         "backlog":[{"id":2,"title":"唯一可投想法","summary":"","description":"存量行",
                     "category":"","is_new":false,"votes":0,"voted":false}]}
        """))])

        let panel = RoadmapPanelModel()
        await panel.activate(app: app)

        #expect(panel.releasedRows.isEmpty)
        #expect(panel.acceptedRows.isEmpty)
        #expect(panel.poolRows.map(\.id) == [2])
        // 存量行无概述 → blurb 兜底截断描述（RoadmapRowsTests 已锁规则）。
        #expect(panel.poolRows[0].blurb == "存量行")
    }

    /// 全量空态：三数组全空 → 三区行集全空（面板走 mp 同款「筹备中」空态）。
    @Test func allEmptyZonesYieldWholePanelEmptyState() async throws {
        let transport = MockTransport()
        let app = await makeApp(transport)
        await transport.plan("/api/roadmap", responses: [(200, jsonData("""
        {"summary":{"my_votes":0,"total_votes":0,"released_count":0},
         "released":[],"accepted":[],"backlog":[]}
        """))])

        let panel = RoadmapPanelModel()
        await panel.activate(app: app)

        #expect(panel.loadError.isEmpty)
        #expect(panel.releasedRows.isEmpty)
        #expect(panel.acceptedRows.isEmpty)
        #expect(panel.poolRows.isEmpty)
    }
}
