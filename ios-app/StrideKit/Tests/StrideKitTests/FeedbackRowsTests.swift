import Foundation
import Testing
@testable import StrideKit

/// 反馈会话行纯逻辑（utils/feedbackRows.ts 直译的自检移植，devops#554）。
@Suite struct FeedbackRowsTests {

    // 上海 2026-10-26 12:00（UTC+8 → UTC 04:00）
    private var now: Date {
        let components = DateComponents(timeZone: TimeZone(identifier: "UTC"),
                                        year: 2026, month: 10, day: 26, hour: 4, minute: 0)
        return Calendar(identifier: .gregorian).date(from: components)!
    }

    @Test func wallClockShiftsToShanghai() {
        // UTC 2026-10-25 20:30 = 上海 2026-10-26 04:30（跨日 +8）
        let wc = shanghaiWallClock("2026-10-25T20:30:00Z")
        #expect(wc?.ymd == "2026-10-26")
        #expect(wc?.hm == "04:30")
        #expect(shanghaiWallClock(nil) == nil)
        #expect(shanghaiWallClock("garbage") == nil)
    }

    @Test func timeLabelTodayYesterdayAndCrossYear() {
        #expect(feedbackTimeLabel("2026-10-26T03:00:00Z", now: now) == "11:00")
        #expect(feedbackTimeLabel("2026-10-25T10:00:00Z", now: now) == "昨天 18:00")
        #expect(feedbackTimeLabel("2026-10-20T10:00:00Z", now: now) == "10-20 18:00")
        // 跨年补年份前缀
        #expect(feedbackTimeLabel("2025-12-30T10:00:00Z", now: now) == "2025-12-30 18:00")
    }

    @Test func fractionalSecondsIsoParses() {
        // Go RFC3339Nano 序列化带小数秒
        #expect(feedbackTimeLabel("2026-10-26T03:00:00.123456Z", now: now) == "11:00")
    }

    @Test func previewPrefersLastReplyWithAuthorPrefix() {
        #expect(conversationPreview(content: "原文", lastReply: nil) == "原文")
        let mine = FeedbackItem.LastReply(author: "user", content: "我说", createdAt: "2026-10-26T03:00:00Z")
        let admin = FeedbackItem.LastReply(author: "admin", content: "官方说", createdAt: "2026-10-26T03:00:00Z")
        #expect(conversationPreview(content: "原文", lastReply: mine) == "我：我说")
        #expect(conversationPreview(content: "原文", lastReply: admin) == "官方：官方说")
    }

    @Test func convRowTruncatesTitleToFirstLine20() throws {
        let json = """
        {"id":7,"type":"bug","content":"第一行超过二十个字符的标题内容\\n下一行正文",
         "images":[],"status":"replied","adopted_feature_id":3,
         "created_at":"2026-10-26T03:00:00Z","unread":true}
        """
        let item = try JSONDecoder().decode(FeedbackItem.self, from: Data(json.utf8))
        let rows = toConvRows([item], now: now)
        #expect(rows.count == 1)
        #expect(rows[0].emoji == "🐞")
        #expect(rows[0].title == "第一行超过二十个字符的标题内容")
        #expect(rows[0].adopted)
        #expect(rows[0].unread)
        #expect(rows[0].preview.contains("第一行"))
    }

    @Test func decodesListResponseWithTotalUnread() throws {
        let json = #"{"total_unread":3,"items":[]}"#
        let res = try JSONDecoder().decode(FeedbackListResponse.self, from: Data(json.utf8))
        #expect(res.totalUnread == 3)
        #expect(res.items.isEmpty)
    }

    @Test func decodesDetailWithAdoptedFeature() throws {
        let json = """
        {"feedback":{"id":9,"type":"suggestion","content":"想法","image_urls":["https://c/1.png"],
         "status":"closed","adopted_feature_id":5,"created_at":"2026-10-20T02:00:00Z"},
         "replies":[{"id":11,"author":"admin","content":"收到","created_at":"2026-10-21T02:00:00Z"}]}
        """
        let res = try JSONDecoder().decode(FeedbackDetailResponse.self, from: Data(json.utf8))
        #expect(res.feedback.adoptedFeatureId == 5)
        #expect(res.feedback.status == .closed)
        #expect(res.replies.count == 1)
        #expect(res.replies[0].author == "admin")
    }
}
