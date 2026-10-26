import Foundation
import Testing
@testable import StrideKit

/// 展示格式化 + 上海时区日期（devops#766 PR-3）。
/// 用例值与小程序 `utils/format.ts` / `utils/date.ts` 行为逐条对齐。
@Suite struct ActivityFormatTests {

    // MARK: - Fmt

    @Test func km() {
        #expect(Fmt.km(nil) == "—")
        #expect(Fmt.km(0) == "—")
        #expect(Fmt.km(-5) == "—")
        #expect(Fmt.km(10_240) == "10.24")
        #expect(Fmt.km(1000) == "1.00")
    }

    @Test func hms() {
        #expect(Fmt.hms(nil) == "—")
        #expect(Fmt.hms(0) == "—")
        #expect(Fmt.hms(3081) == "00:51:21")
        #expect(Fmt.hms(3600) == "01:00:00")
        #expect(Fmt.hms(360_000) == "100:00:00") // >99h 不补零
    }

    @Test func durationShort() {
        #expect(Fmt.durationShort(nil) == "—")
        #expect(Fmt.durationShort(65) == "1:05")
        #expect(Fmt.durationShort(599) == "9:59")
        #expect(Fmt.durationShort(3661) == "1:01:01")
    }

    @Test func dose() {
        #expect(Fmt.dose(nil) == "—")
        #expect(Fmt.dose(12.34) == "12.3")
    }

    @Test func pace() {
        #expect(Fmt.pace(nil) == "—")
        #expect(Fmt.pace(0) == "—")
        #expect(Fmt.pace(270) == "4:30/km")
        #expect(Fmt.pace(365) == "6:05/km") // 四舍五入 364.6 → 365
    }

    @Test func paceQuoteParts() {
        #expect(Fmt.paceQuoteParts(nil).0 == "—")
        #expect(Fmt.paceQuoteParts(nil).1 == "")
        let parts = Fmt.paceQuoteParts(270)
        #expect(parts.0 == "4")
        #expect(parts.1 == "'30\"")
        #expect(Fmt.paceQuote(270) == "4'30\"")
    }

    @Test func paceBound() {
        #expect(Fmt.paceBound(nil) == nil)
        #expect(Fmt.paceBound(0) == nil)
        #expect(Fmt.paceBound(340_000) == "5:40")
    }

    @Test func intAndDecimal() {
        #expect(Fmt.intStr(nil) == "—")
        #expect(Fmt.intStr(151.4) == "151")
        #expect(Fmt.decimalStr(nil) == "—")
        #expect(Fmt.decimalStr(3.14159, digits: 2) == "3.14")
        #expect(Fmt.stepLenM(nil) == "—")
        #expect(Fmt.stepLenM(112) == "1.12")
    }

    @Test func autoStrMatchesJsTemplate() {
        #expect(Fmt.autoStr(10) == "10")
        #expect(Fmt.autoStr(10.24) == "10.24")
        #expect(Fmt.autoStr(12.3) == "12.3")
        #expect(Fmt.autoStr(nil) == "—")
    }

    // MARK: - Shanghai

    /// 固定时区数学：2026-10-26 是周一（上海），2026-10-25 周日。
    @Test func weekdayLabel() {
        #expect(Shanghai.weekdayLabel("2026-10-26") == "周一")
        #expect(Shanghai.weekdayLabel("2026-10-25") == "周日")
        #expect(Shanghai.weekdayLabel("2026-10-31") == "周六")
        #expect(Shanghai.weekdayLabel("bad") == "")
        #expect(Shanghai.weekdayLabel(nil) == "")
    }

    @Test func dateLabelFromYMD() {
        #expect(Shanghai.dateLabel(fromYMD: "2026-08-28") == "8月28日 周五")
        // ISO 串取前 10 位
        #expect(Shanghai.dateLabel(fromYMD: "2026-08-28T08:30:00+08:00") == "8月28日 周五")
        #expect(Shanghai.dateLabel(fromYMD: "") == "")
    }

    @Test func dateLabelFromISO() {
        #expect(Shanghai.dateLabel(fromISO: "2026-08-28T08:30:00+08:00") == "8月28日 08:30")
        #expect(Shanghai.dateLabel(fromISO: "2026-08-28") == "8月28日")
        #expect(Shanghai.dateLabel(fromISO: nil) == "")
        #expect(Shanghai.dateLabel(fromISO: "") == "")
    }

    @Test func monthLabel() {
        #expect(Shanghai.monthLabel("2026-03") == "2026年3月")
        #expect(Shanghai.monthLabel("2026-11") == "2026年11月")
        #expect(Shanghai.monthLabel("202603") == "202603")
    }

    @Test func todayYMDUsesShanghaiWallClock() {
        // 注入固定时刻：UTC 2026-10-25 17:00 = 上海 2026-10-26 01:00。
        // 设备本地时区无论是什么，都应得到上海日期。
        let utc = Date(timeIntervalSince1970: 1_792_947_600)
        #expect(Shanghai.todayYMD(now: utc) == "2026-10-26")
        #expect(Shanghai.todayYM(now: utc) == "2026-10")
    }

    // MARK: - 运动类型展示

    @Test func sportSystemImage() {
        #expect(SportDisplay.systemImage(forSportName: "Strength Training") == "dumbbell")
        #expect(SportDisplay.systemImage(forSportName: "Trail Run") == "figure.run")
        #expect(SportDisplay.systemImage(forSportName: "Treadmill") == "figure.run")
        #expect(SportDisplay.systemImage(forSportName: "Walk") == "calendar")
        #expect(SportDisplay.systemImage(forSportName: nil) == "calendar")
    }

    @Test func sportAndTrainTypeCN() {
        #expect(SportDisplay.sportCN("Run") == "跑步")
        #expect(SportDisplay.sportCN(nil) == "活动")
        #expect(SportDisplay.sportCN("Kayaking") == "Kayaking")
        #expect(SportDisplay.trainTypeCN("Threshold") == "乳酸阈")
        #expect(SportDisplay.trainTypeCN(nil) == "")
        #expect(SportDisplay.feelEmoji(1) == "😄")
        #expect(SportDisplay.feelEmoji(6) == "")
        #expect(SportDisplay.feelEmoji(nil) == "")
    }
}
