import Foundation
import Testing
@testable import StrideKit

/// 圈速标记 / 力量分组（devops#766，对齐 utils/lapRows.ts 与 buildStrengthSegments）。
@Suite struct LapRowsTests {

    private func seg(_ name: String = "训练", mode: Int? = 0, pace: Double? = 300,
                     hr: Double? = 150, distanceM: Double = 1000, durationS: Double = 300) -> Segment {
        Segment(lapIndex: 0, lapType: "type2", distanceM: distanceM, distanceKm: distanceM / 1000,
                durationS: durationS, durationFmt: "05:00", avgPace: pace, avgHr: hr,
                avgCadence: 180, segName: name, mode: mode)
    }

    // MARK: - lapPaceMarks

    @Test func restLapsSkippedFromNumberingAndRanking() {
        let laps = [
            seg(pace: 300),                     // 1
            seg("恢复", mode: 3, pace: 400),     // 恢复
            seg(pace: 290),                     // 2
            seg(pace: 310),                     // 3
        ]
        let marks = lapPaceMarks(laps)
        #expect(marks[1].rest)
        #expect(marks[1].rowClass == .rest)
        #expect(!marks[0].rest)
        // 恢复圈不计圈号 → 圈 3 的「上一圈」是圈 2（跨过恢复圈）
        #expect(marks[2].trend == .up)   // 290 < 300 更快
        #expect(marks[3].trend == .down) // 310 > 290 更慢
    }

    @Test func fastestSlowestHighlightedWithThreePacedLaps() {
        let laps = [seg(pace: 300), seg(pace: 280), seg(pace: 320)]
        let marks = lapPaceMarks(laps)
        #expect(marks[1].rowClass == .fastest)
        #expect(marks[1].tag == "最快")
        #expect(marks[2].rowClass == .slowest)
        #expect(marks[2].tag == "最慢")
        #expect(marks[0].rowClass == .none)
    }

    @Test func fewerPacedLapsNoRanking() {
        let laps = [seg(pace: 300), seg(pace: 280), seg(pace: nil)]
        let marks = lapPaceMarks(laps)
        #expect(marks.allSatisfy { $0.rowClass == .none || $0.rowClass == .rest })
    }

    @Test func equalPaceNoRanking() {
        let laps = [seg(pace: 300), seg(pace: 300), seg(pace: 300)]
        let marks = lapPaceMarks(laps)
        #expect(marks.allSatisfy { $0.tag.isEmpty })
    }

    @Test func hrTrendAcrossRestLaps() {
        let laps = [
            seg(pace: 300, hr: 140),           // 1
            seg("休息", mode: 3, pace: 450, hr: 120), // 恢复
            seg(pace: 295, hr: 150),           // 2（vs 圈1：pace up / hr up）
        ]
        let marks = lapPaceMarks(laps)
        #expect(marks[2].trend == .up)
        #expect(marks[2].hrTrend == .up)
        #expect(marks[0].hrTrend == .none) // 首圈无走向
    }

    // MARK: - buildLapRows

    @Test func buildLapRowsNumbersSkipRest() {
        let laps = [seg(pace: 300), seg("恢复", mode: 3, pace: nil), seg(pace: 280)]
        let rows = buildLapRows(laps)
        #expect(rows.map(\.index) == ["1", "恢复", "2"])
        #expect(rows[0].paceMin == "5")
        #expect(rows[0].paceSec == "'00\"")
        // 两圈有配速 < MIN_RANKABLE_LAPS(3)，不标最快/最慢
        #expect(rows[2].rowClass == .none)
    }

    // MARK: - 力量分组

    @Test func strengthGroupsMergeConsecutiveSameNameAndSkipRest() {
        let segments = [
            seg("深蹲", mode: 0, pace: nil, hr: 110, distanceM: 0, durationS: 60),
            seg("深蹲", mode: 0, pace: nil, hr: 120, distanceM: 0, durationS: 60),
            seg("休息", mode: 15, pace: nil, hr: 90, distanceM: 0, durationS: 60),
            seg("卧推", mode: 0, pace: nil, hr: 115, distanceM: 0, durationS: 90),
            seg("卧推", mode: 0, pace: nil, hr: 125, distanceM: 0, durationS: 90),
        ]
        let groups = buildStrengthSegments(segments)
        #expect(groups.count == 2)
        #expect(groups[0].name == "深蹲")
        #expect(groups[0].sets == 2)
        #expect(groups[0].duration == "2:00")
        #expect(groups[0].avgHr == "115") // (110+120)/2
        #expect(groups[1].avgHr == "120")
    }

    @Test func strengthGroupsBlankNameFallsBack() {
        let segments = [seg("", mode: 0, pace: nil, hr: nil, distanceM: 0, durationS: 45)]
        let groups = buildStrengthSegments(segments)
        #expect(groups[0].name == "训练")
        #expect(groups[0].avgHr == "—")
    }
}
