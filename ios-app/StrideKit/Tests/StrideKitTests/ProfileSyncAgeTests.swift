import Foundation
import Testing
@testable import StrideKit

/// 「上次同步」相对时间中文化测试（devops#1003 P2-3，LEDGER D-locale-1）：
/// 分段口径与 mp relativeTime 同源（<1min 刚刚 / <60min 分钟 / <24h 小时 / 天），
/// 文案中文化为用户批准的 confirmed 偏差（mp 保留英文 ago）。
@Suite struct ProfileSyncAgeTests {

    /// UTC 2026-11-16 04:00:00Z（上海 12:00）。
    private var now: Date {
        let comps = DateComponents(timeZone: TimeZone(identifier: "UTC"),
                                    year: 2026, month: 11, day: 16, hour: 4)
        return Calendar(identifier: .gregorian).date(from: comps)!
    }

    private func iso(secondsAgo: Double) -> String {
        let date = now.addingTimeInterval(-secondsAgo)
        let formatter = ISO8601DateFormatter()
        return formatter.string(from: date)
    }

    private func iso(hoursAgo: Double) -> String {
        iso(secondsAgo: hoursAgo * 3600)
    }

    @Test func nilOrInvalidFallsBackToNotSynced() {
        #expect(relativeSyncAge(nil, now: now) == "未同步")
        #expect(relativeSyncAge("not-a-date", now: now) == "未同步")
    }

    @Test func underOneMinuteIsJustNow() {
        #expect(relativeSyncAge(iso(secondsAgo: 10), now: now) == "刚刚")
    }

    @Test func minutesAreChinese() {
        #expect(relativeSyncAge(iso(hoursAgo: 0.5), now: now) == "30 分钟前")
    }

    @Test func hoursAreChinese() {
        #expect(relativeSyncAge(iso(hoursAgo: 6), now: now) == "6 小时前")
    }

    @Test func daysAreChinese() {
        #expect(relativeSyncAge(iso(hoursAgo: 72), now: now) == "3 天前")
    }

    @Test func neverEmitsEnglishAgo() {
        for h in [0.1, 0.5, 6, 72, 240] {
            #expect(!relativeSyncAge(iso(hoursAgo: h), now: now).contains("ago"))
        }
    }
}
