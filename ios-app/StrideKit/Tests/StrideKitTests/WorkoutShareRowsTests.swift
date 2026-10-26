import Foundation
import Testing
@testable import StrideKit

/// 课表 spec 模型与分享落地页视图构建（utils/workoutSegments + date.ts 选日
/// 自检移植，devops#703）。
@Suite struct WorkoutShareRowsTests {

    private func runSpec() -> RunWorkoutSpec {
        let json = """
        {"name":"间歇课","date":"2026-10-28","note":"注意热身",
         "blocks":[{"repeat":2,"steps":[
            {"step_kind":"warmup","duration":{"kind":"distance_m","value":800},
             "target":{"kind":"pace_s_km","low":330,"high":360},"note":null,"hr_cap_bpm":150},
            {"step_kind":"work","duration":{"kind":"time_s","value":600},
             "target":{"kind":"hr_bpm","low":150,"high":165},"note":"稳住",
             "rest":{"kind":"time_s","value":90}}]}]}
        """
        return try! JSONDecoder().decode(RunWorkoutSpec.self, from: Data(json.utf8))
    }

    @Test func decodesRunSpecWithRepeatAndRest() throws {
        let spec = runSpec()
        #expect(spec.blocks.count == 1)
        #expect(spec.blocks[0].repeatCount == 2)
        #expect(spec.blocks[0].steps.count == 2)
        #expect(spec.blocks[0].steps[1].rest?.kind == "time_s")
        #expect((spec.blocks[0].steps[1].rest?.value ?? 0) == 90)
    }

    @Test func buildRunGroupsExpandsRestRowsAndRepeatBadge() {
        let groups = buildRunGroups(runSpec())
        #expect(groups.count == 1)
        #expect(groups[0].repeatCount == 2)
        // 2 步 + 1 休息行 = 3 行
        #expect(groups[0].rows.count == 3)
        #expect(groups[0].rows[0].kindLabel == "热身")
        #expect(groups[0].rows[0].main == "800 m · 5:30–6:00/km")
        #expect(groups[0].rows[0].hrCapText == "心率≤150")
        #expect(groups[0].rows[1].main == "10:00 · 150–165 bpm")
        #expect(groups[0].rows[1].note == "稳住")
        #expect(groups[0].rows[2].quiet)
        #expect(groups[0].rows[2].main == "90 秒")
    }

    @Test func estimateWorkoutSecondsUsesPaceMidpoint() {
        // warmup 800m @ 345s/km = 276s；work 600s + rest 90s；×2 组 = 1932s
        let total = estimateWorkoutSeconds(runSpec())
        #expect(abs(total - (276 + 600 + 90) * 2) < 1)
    }

    @Test func exerciseRowsFormatTargetAndRest() throws {
        let json = """
        {"name":"力量","date":"2026-10-28","note":null,"exercises":[
          {"canonical_id":"squat","display_name":"深蹲","sets":3,"target_kind":"reps",
           "target_value":12,"rest_seconds":60,"note":null},
          {"canonical_id":"plank","display_name":"平板支撑","sets":3,"target_kind":"time_s",
           "target_value":45,"rest_seconds":0,"note":"保持直线"}]}
        """
        let spec = try JSONDecoder().decode(StrengthWorkoutSpec.self, from: Data(json.utf8))
        let rows = buildExerciseRows(spec)
        #expect(rows.count == 2)
        #expect(rows[0].target == "3 组 × 12 次")
        #expect(rows[0].rest == "组间休息 60 秒")
        #expect(rows[1].target == "3 组 × 0:45")
        #expect(rows[1].rest.isEmpty)
        #expect(rows[1].note == "保持直线")
    }

    // MARK: - ±7 天选日（buildPushDateOptions）

    private func date(_ ymd: String, hour: Int = 12) -> Date {
        let components = DateComponents(timeZone: Shanghai.timeZone,
                                        year: Int(ymd.prefix(4)), month: Int(ymd.dropFirst(5).prefix(2)),
                                        day: Int(ymd.suffix(2)), hour: hour)
        return Calendar(identifier: .gregorian).date(from: components)!
    }

    @Test func dateOptionsAreTodayPlusSevenWithPlannedDefault() {
        let options = buildPushDateOptions(plannedDate: "2026-10-29", plannedTag: "（原排期）", now: date("2026-10-26"))
        #expect(options.count == 8)
        #expect(options[0].label == "今天")
        #expect(options[1].label == "明天")
        #expect(options[2].label == "后天")
        // 计划日在可见范围内 → 默认 + 带（原排期）标
        let planned = options.first { $0.value == "2026-10-29" }
        #expect(planned?.selected == true)
        #expect(planned?.label.contains("（原排期）") == true)
        #expect(options[0].selected == false)
    }

    @Test func dateOptionsFallBackToTodayWhenPlannedIsPast() {
        let options = buildPushDateOptions(plannedDate: "2026-10-20", now: date("2026-10-26"))
        #expect(options.first { $0.value == "2026-10-26" }?.selected == true)
        // 过去计划日不出现在选项里
        #expect(!options.contains { $0.value == "2026-10-20" })
    }

    @Test func formatDurationShortAndLong() {
        #expect(fmtDurationShort(3580.0) == "59:40")
        #expect(fmtDurationShort(3723.0) == "1:02:03")
    }
}
