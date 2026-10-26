import Foundation
import Testing
@testable import StrideKit

// PR-8 分享出向纯函数单测（devops#771）—— ShareOutbound /s/ 分流链接构造
// （#758 拍板 1 + #762 方案）、ShareCopy 品牌口径（StrideWise 拉丁优先、
// 不提 AI/教练）、封面节选/折行（coach.ts plainExcerpt/coverLines 直译）、
// Route 对 /s/ 回流链接的剥前缀解析、封面视图的消息投影。

// MARK: - /s/ 分流链接

@Suite struct ShareOutboundLinkTests {

    let base = URL(string: "https://stride-running.cn")!

    @Test func routesCarrySlashSPrefixAndWhitelistedQuery() {
        #expect(
            ShareOutbound.link(base: base, route: .coachShare(sid: "sid123")).absoluteString
                == "https://stride-running.cn/s/pages/coach-share/coach-share?sid=sid123"
        )
        #expect(
            ShareOutbound.link(base: base, route: .strategyShare(user: "u1", id: 9, version: 3)).absoluteString
                == "https://stride-running.cn/s/pages/race-center/strategy-share/strategy-share?user=u1&id=9&version=3"
        )
        #expect(
            ShareOutbound.link(base: base, route: .raceDetail(id: 9)).absoluteString
                == "https://stride-running.cn/s/pages/race-center/detail?id=9"
        )
        #expect(
            ShareOutbound.link(base: base, route: .raceCenter).absoluteString
                == "https://stride-running.cn/s/pages/race-center/race-center"
        )
        #expect(
            ShareOutbound.link(base: base, route: .workoutShare(user: "u1", workout: "w1")).absoluteString
                == "https://stride-running.cn/s/pages/workout-share/workout-share?user=u1&workout=w1"
        )
        #expect(
            ShareOutbound.link(base: base, route: .trainingHome).absoluteString
                == "https://stride-running.cn/s/pages/index/index"
        )
    }

    @Test func queryValuesArePercentEncoded() {
        let link = ShareOutbound.link(base: base, route: .coachShare(sid: "a b&c"))
        #expect(link.absoluteString.contains("sid=a%20b%26c"), "空格/& 原样进 query 需转义")
    }

    @Test func productionBaseMatchesApiConfigDefault() {
        #expect(ShareOutbound.productionBase.absoluteString == "https://stride-running.cn")
        #expect(APIConfig().shareBaseURL.absoluteString == "https://stride-running.cn")
    }

    /// 出向 /s/ 链接回流（UL 唤起 App）应剥前缀还原白名单路由（PR-8）。
    @Test func slashSLinksRoundTripIntoRoutes() {
        #expect(
            Route(url: ShareOutbound.link(base: base, route: .coachShare(sid: "s1")))
                == .coachShare(sid: "s1")
        )
        #expect(
            Route(url: ShareOutbound.link(base: base, route: .strategyShare(user: "u1", id: 9, version: 3)))
                == .strategyShare(user: "u1", id: 9, version: 3)
        )
        #expect(
            Route(url: ShareOutbound.link(base: base, route: .raceDetail(id: 9)))
                == .raceDetail(id: 9)
        )
        #expect(Route(url: ShareOutbound.link(base: base, route: .trainingHome)) == .trainingHome)
    }
}

// MARK: - 品牌口径文案

@Suite struct ShareCopyTests {

    @Test func brandVoiceLatinFirstAndNoCoachOrAI() {
        let all = [
            ShareCopy.app,
            ShareCopy.raceCenter,
            ShareCopy.workoutCoverBrand,
            ShareCopy.raceDetail(name: "上马", date: "2026-11-01"),
            ShareCopy.coachConversation(sharerName: "跑者", count: 3),
            ShareCopy.coachConversation(sharerName: nil, count: 1),
            ShareCopy.workout(name: "周二间歇"),
        ]
        for copy in all {
            #expect(!copy.contains("教练"), "文案不提教练：\(copy)")
            #expect(!copy.uppercased().contains("AI"), "文案不提 AI：\(copy)")
        }
        #expect(ShareCopy.app == "StrideWise · 马拉松训练助手")
        #expect(ShareCopy.raceCenter == "StrideWise · 全年路跑赛事日历")
        #expect(ShareCopy.workoutCoverBrand == "StrideWise · 自建课表")
    }

    @Test func raceDetailTitleMirrorsMiniProgram() {
        #expect(ShareCopy.raceDetail(name: "上海马拉松", date: "2026-11-01") == "上海马拉松 · 2026-11-01 开跑")
        #expect(ShareCopy.raceDetail(name: "上海马拉松", date: nil) == "上海马拉松")
        #expect(ShareCopy.raceDetail(name: "上海马拉松", date: "") == "上海马拉松")
        #expect(ShareCopy.raceDetail(name: "", date: nil) == "赛事详情")
    }

    @Test func coachConversationTitleMirrorsCoachTs() {
        #expect(
            ShareCopy.coachConversation(sharerName: "小跑", count: 5)
                == "小跑 与 StrideWise 的对话 · 5 条"
        )
        #expect(
            ShareCopy.coachConversation(sharerName: nil, count: 2)
                == "我与 StrideWise 的对话 · 2 条"
        )
        #expect(
            ShareCopy.coachConversation(sharerName: "  \n 小跑 \t", count: 1)
                == "小跑 与 StrideWise 的对话 · 1 条",
            "昵称先去首尾空白"
        )
        let long = String(repeating: "跑", count: 80)
        #expect(
            ShareCopy.coachConversation(sharerName: long, count: 1)
                == "\(String(repeating: "跑", count: 64)) 与 StrideWise 的对话 · 1 条",
            "昵称截 64 字"
        )
    }

    @Test func workoutTitleFallsBackWhenEmpty() {
        #expect(ShareCopy.workout(name: "周三节奏跑") == "周三节奏跑")
        #expect(ShareCopy.workout(name: "") == "训练课表")
    }
}

// MARK: - 封面纯函数（coach.ts plainExcerpt / coverLines 直译）

@Suite struct CoverTextTests {

    @Test func excerptStripsMarkdownAndCollapsesWhitespace() {
        #expect(coverExcerpt("# 标题 **加粗** `code`") == "标题 加粗 code")
        #expect(coverExcerpt("> 引用 | 分隔 ~~删除~~ _斜体_") == "引用 分隔 删除 斜体")
        #expect(coverExcerpt("多  个\t空白\n折行") == "多 个 空白 折行")
        #expect(coverExcerpt("  去首尾  ") == "去首尾")
        #expect(coverExcerpt("") == "")
    }

    @Test func excerptCapsAtSixtyCharacters() {
        #expect(coverExcerpt(String(repeating: "跑", count: 80)).count == 60)
        #expect(coverExcerpt(String(repeating: "跑", count: 30)).count == 30)
    }

    @Test func linesSplitAtSixteenCharsUpToTwoLines() {
        #expect(coverLines("短句") == ["短句"])
        #expect(coverLines(String(repeating: "跑", count: 16)) == [String(repeating: "跑", count: 16)])
        #expect(
            coverLines(String(repeating: "跑", count: 32))
                == [String(repeating: "跑", count: 16), String(repeating: "跑", count: 16)]
        )
        // 33 字：第二行 15 字 + 省略号收尾
        #expect(
            coverLines(String(repeating: "跑", count: 33))
                == [String(repeating: "跑", count: 16), String(repeating: "跑", count: 15) + "…"]
        )
        #expect(coverLines("") == [])
    }
}

// MARK: - 气泡封面投影

@Suite struct CoachBubbleCoverProjectionTests {

    @Test func initTakesFirstTwoSelectedInConversationOrder() {
        var unselected = CoachMessage(id: 1, role: .user, content: "第一问")
        unselected.selected = false
        unselected.shareIndex = 1
        var first = CoachMessage(id: 2, role: .assistant, content: "**答一**")
        first.selected = true
        first.shareIndex = 2
        var second = CoachMessage(id: 3, role: .user, content: "第二问")
        second.selected = true
        second.shareIndex = 3
        var third = CoachMessage(id: 4, role: .assistant, content: "答二")
        third.selected = true
        third.shareIndex = 4

        #expect(CoachBubbleCoverView.picks(messages: [first]).count == 1, "单条所选照常进封面")
        let picks = CoachBubbleCoverView.picks(messages: [unselected, first, second, third])
        #expect(picks.count == 2, "只取前两条所选，未选的不进封面")
        #expect(picks[0].isUser == false)
        #expect(picks[0].lines == ["答一"], "markdown 装饰被剥掉")
        #expect(picks[1].isUser == true)
        #expect(picks[1].lines == ["第二问"])
    }

    @Test func initPicksCapAtTwoExplicitly() {
        let picks = (0..<4).map { CoachBubbleCoverView.Pick(isUser: $0 % 2 == 0, lines: ["x\($0)"]) }
        #expect(CoachBubbleCoverView(picks: picks).picks.count == 2)
        #expect(CoachBubbleCoverView(picks: []).picks.isEmpty)
    }
}
