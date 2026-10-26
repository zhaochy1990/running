import Foundation
import Testing
@testable import StrideKit

/// 产品路线纯变换（utils/roadmapRows.ts 自检移植，devops#553/#551）。
@Suite struct RoadmapRowsTests {

    @Test func toggleAddsVoteAndReordersByVotesDesc() {
        var rows = [RoadmapBacklogItem(id: 1, title: "a", summary: nil, description: "", category: "",
                                        isNew: false, votes: 10, voted: false),
                    RoadmapBacklogItem(id: 2, title: "b", summary: nil, description: "", category: "",
                                        isNew: false, votes: 9, voted: false)]
        // 给 id=2 投票 → 10 票，同票新想法（id 大）在前 → [2, 1]
        let next = togglePoolVote(rows, id: 2)
        #expect(next.map(\.id) == [2, 1])
        #expect(next[0].voted)
        #expect(next[0].votes == 10)

        // 撤销同一票 → 回到 9，且 voted=false，排序复原 [1, 2]
        let restored = togglePoolVote(next, id: 2)
        #expect(restored.map(\.id) == [1, 2])
        #expect(!restored[1].voted)
        #expect(restored[1].votes == 9)
    }

    @Test func toggleUnknownIdReturnsRowsUnchanged() {
        let rows = [RoadmapBacklogItem(id: 1, title: "a", summary: nil, description: "", category: "",
                                        isNew: false, votes: 3, voted: false)]
        #expect(togglePoolVote(rows, id: 99).map(\.id) == [1])
    }

    @Test func toggleClampsVotesAtZero() {
        let rows = [RoadmapBacklogItem(id: 1, title: "a", summary: nil, description: "", category: "",
                                        isNew: false, votes: 0, voted: true)]
        // 异常态（voted=true 且 votes=0）撤销不出现 -1
        let next = togglePoolVote(rows, id: 1)
        #expect(next[0].votes == 0)
        #expect(!next[0].voted)
    }

    @Test func blurbPrefersSummaryAndFallsBackToPlainDescription() {
        #expect(roadmapBlurb("概括", "# 长描述") == "概括")
        #expect(roadmapBlurb("   ", "支持 **加粗** 与 [链接](https://x)") == "支持 加粗 与 链接")
        let long = String(repeating: "字", count: 80)
        let blurb = roadmapBlurb(nil, long)
        #expect(blurb.count == roadmapBlurbMax + 1) // 50 字 + 省略号
        #expect(blurb.hasSuffix("…"))
    }

    @Test func stripMarkdownishRemovesStructuralMarks() {
        let raw = """
        # 标题
        - 列表项
        > 引用
        `code` 与 **bold**
        """
        let plain = stripMarkdownish(raw)
        #expect(!plain.contains("#"))
        #expect(!plain.contains("-"))
        #expect(!plain.contains(">"))
        #expect(plain.contains("标题"))
        #expect(plain.contains("code 与 bold"))
    }
}

extension RoadmapBacklogItem {
    init(id: Int, title: String, summary: String?, description: String, category: String,
         isNew: Bool, votes: Int, voted: Bool) {
        let json = """
        {"id":\(id),"title":"\(title)","description":"\(description)","category":"\(category)",
         "is_new":\(isNew),"votes":\(votes),"voted":\(voted)\(summary.map { ",\"summary\":\"\($0)\"" } ?? "")}
        """
        self = try! JSONDecoder().decode(RoadmapBacklogItem.self, from: Data(json.utf8))
    }
}
