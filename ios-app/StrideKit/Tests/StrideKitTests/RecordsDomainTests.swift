import Foundation
import Testing
@testable import StrideKit

/// 月份分组构建 / 合并 / 分页语义（devops#766，对齐 activities.ts 纯函数）。
@Suite struct ActivitiesModelGroupingTests {

    private func activity(_ labelId: String, date: String, distanceM: Double = 10_000,
                          sportName: String? = "Run", route: [[Double]]? = nil) -> Activity {
        Activity(
            labelId: labelId, name: "晨跑 \(labelId)", sportName: sportName, sportType: 1,
            date: date, distanceM: distanceM, distanceKm: distanceM / 1000, durationS: 3600,
            durationFmt: "01:00:00", avgPaceSKm: 300, avgHr: 150, maxHr: 170, avgCadence: 180,
            avgStepLenCm: 110, trainingLoad: 50, strideTrainingDose: 66.6, trainType: "Base",
            routeThumb: route
        )
    }

    private func listResponse(_ acts: [Activity], total: Int? = nil,
                              summaries: [String: ActivityMonthlySummary]? = nil) -> ActivitiesListResponse {
        ActivitiesListResponse(total: total ?? acts.count, activities: acts, monthlySummaries: summaries)
    }

    // MARK: - build

    @Test func groupsByMonthDescendingCurrentExpanded() {
        let res = listResponse([
            activity("a1", date: "2026-10-02"),
            activity("a2", date: "2026-10-18"),
            activity("a3", date: "2026-09-05"),
            activity("a4", date: "2026-09-21"),
            activity("a5", date: "2026-08-11"),
        ])
        let groups = ActivitiesModel.monthGroups(from: res, currentMonth: "2026-10")

        #expect(groups.map(\.monthKey) == ["2026-10", "2026-09", "2026-08"])
        #expect(groups[0].expanded == true)   // 本月默认展开
        #expect(groups[1].expanded == false)
        #expect(groups[0].rows.map(\.labelId) == ["a1", "a2"])
        #expect(groups[0].label == "2026年10月")
        // 无后端月汇总 → 回退本页活动汇总
        #expect(groups[0].count == "2")
        #expect(groups[0].km == "20.0")
        #expect(groups[0].duration == "2:00:00")
    }

    @Test func prefersBackendMonthlySummary() {
        let res = listResponse(
            [activity("a1", date: "2026-10-02")],
            summaries: ["2026-10": ActivityMonthlySummary(activityCount: 13, totalRunKm: 120.5, durationS: 43_200)]
        )
        let groups = ActivitiesModel.monthGroups(from: res, currentMonth: "2026-10")
        #expect(groups[0].count == "13")
        #expect(groups[0].km == "120.5")
        #expect(groups[0].duration == "12:00:00")
    }

    @Test func rowFieldsAndFallbacks() {
        let res = listResponse([
            activity("a1", date: "2026-10-02", route: [[5, 95], [95, 5]]),
            Activity(labelId: "a2", name: nil, sportName: nil, sportType: 1, date: "2026-10-03",
                     distanceM: 0, distanceKm: 0, durationS: 0, durationFmt: nil),
        ])
        let rows = ActivitiesModel.monthGroups(from: res, currentMonth: "2026-10")[0].rows

        #expect(rows[0].routeThumb == [[5, 95], [95, 5]])
        #expect(rows[1].routeThumb == nil)
        #expect(rows[0].distanceKm == "10.00")
        #expect(rows[0].pace == "5:00/km")
        #expect(rows[0].avgHr == "150")
        // STRIDE dose 优先
        #expect(rows[0].load == "66.6")
        #expect(rows[0].date == "10月2日 周五")

        // 兜底：名称回退 sport_name（nil→「活动」）、距离 0 → —、负荷缺失 → —
        #expect(rows[1].name == "活动")
        #expect(rows[1].distanceKm == "—")
        #expect(rows[1].load == "—")
    }

    // MARK: - merge

    @Test func mergeAppendsRowsAndNewMonthsCollapsed() {
        let first = listResponse([
            activity("a1", date: "2026-10-02"),
            activity("a2", date: "2026-09-05"),
        ])
        var groups = ActivitiesModel.monthGroups(from: first, currentMonth: "2026-10")

        let second = listResponse([
            activity("a3", date: "2026-09-28"),
            activity("a4", date: "2026-08-15"),
        ], total: 4)
        groups = ActivitiesModel.merged(existing: groups, with: second)

        #expect(groups.map(\.monthKey) == ["2026-10", "2026-09", "2026-08"])
        #expect(groups[1].rows.map(\.labelId) == ["a2", "a3"])
        #expect(groups[2].expanded == false) // 新月份折叠
        // 兜底汇总只统计「本页」该月活动（小程序同款口径）：2026-09 本页只有 a3
        #expect(groups[1].count == "1")
        #expect(groups[0].rows.count == 1)
    }

    @Test func mergeKeepsExistingExpandedState() {
        let first = listResponse([activity("a1", date: "2026-10-02")])
        var groups = ActivitiesModel.monthGroups(from: first, currentMonth: "2026-10")
        groups[0].expanded = false

        let second = listResponse([activity("a2", date: "2026-10-20")], total: 2)
        groups = ActivitiesModel.merged(existing: groups, with: second)

        #expect(groups[0].expanded == false)
        #expect(groups[0].rows.count == 2)
    }
}

/// 记录域 DTO 解码（snake_case / null 容错，对齐 types/activity.ts 契约）。
@Suite struct ActivityModelsDecodingTests {

    @Test func decodesListWithNulls() throws {
        let json = #"""
        {
          "total": 2,
          "activities": [
            {
              "label_id": "lbl-1",
              "name": null,
              "sport_type": 1,
              "sport_name": null,
              "date": "2026-10-18",
              "distance_m": 10240,
              "distance_km": 10.24,
              "duration_s": 3081,
              "duration_fmt": "00:51:21",
              "avg_pace_s_km": 300,
              "pace_fmt": "5:00",
              "avg_hr": 152,
              "max_hr": 171,
              "avg_cadence": 180,
              "avg_step_len_cm": 112,
              "calories_kcal": 600,
              "training_load": 55,
              "stride_training_dose": 61.25,
              "vo2max": 52,
              "train_type": "Base",
              "route_thumb": [[5, 95], [95, 5]],
              "thumb_url": "https://cdn/thumb.png"
            },
            {
              "label_id": "lbl-2",
              "name": "周中力量",
              "sport_type": 402,
              "sport_name": "Strength Training",
              "date": "2026-10-17",
              "distance_m": 0,
              "distance_km": 0,
              "duration_s": 2400,
              "duration_fmt": "00:40:00",
              "avg_pace_s_km": null,
              "pace_fmt": "",
              "avg_hr": 120,
              "max_hr": 140,
              "avg_cadence": null,
              "training_load": 30,
              "train_type": null,
              "route_thumb": null,
              "thumb_url": null,
              "feels_like": 20
            }
          ],
          "monthly_summaries": {
            "2026-10": { "activity_count": 9, "total_run_km": 88.2, "run_duration_s": 30000, "duration_s": 33000 }
          }
        }
        """#
        let res = try JSONDecoder().decode(ActivitiesListResponse.self, from: Data(json.utf8))
        #expect(res.total == 2)
        #expect(res.activities[0].sportName == nil)
        #expect(res.activities[0].strideTrainingDose == 61.25)
        // route_thumb 形状解码（devops#828）；null → nil；thumb_url 已弃用忽略。
        #expect(res.activities[0].routeThumb == [[5, 95], [95, 5]])
        #expect(res.activities[1].routeThumb == nil)
        #expect(res.activities[1].isStrength)
        #expect(res.monthlySummaries?["2026-10"]?.activityCount == 9)
    }

    @Test func decodesDetailWithTimeseries() throws {
        let json = #"""
        {
          "activity": {
            "label_id": "lbl-1", "name": "外滩晨跑", "sport_type": 1, "sport_name": "Run",
            "date": "2026-10-18T06:30:00+08:00",
            "distance_m": 10240, "distance_km": 10.24, "duration_s": 3081, "duration_fmt": "00:51:21",
            "avg_pace_s_km": 300, "pace_fmt": "5:00", "avg_hr": 152, "max_hr": 171, "avg_cadence": 180,
            "training_load": 55, "train_type": "Base",
            "ascent_m": 42, "temperature": 18.5, "humidity": 62, "feels_like": 17.2, "wind_speed": 8.4,
            "feel_type": 2, "feel_note": "腿部略沉", "sport_note": "匀速有氧",
            "commentary": "本周有氧底子扎实。",
            "pauses": [{ "start_ts": 1000000, "end_ts": 1600000, "type": 1 }]
          },
          "stride_training_load": { "label_id": "lbl-1" },
          "segments": [
            { "lap_index": 0, "lap_type": "type2", "distance_m": 1000, "distance_km": 1.0,
              "duration_s": 300, "duration_fmt": "05:00", "avg_pace": 300, "pace_fmt": "5:00",
              "avg_hr": 150, "avg_cadence": 180, "seg_name": "训练", "mode": 0 }
          ],
          "zones": [
            { "zone_type": "heartRate", "zone_index": 0, "range_min": 100, "range_max": 120,
              "range_unit": "bpm", "duration_s": 600, "percent": 20 }
          ],
          "timeseries": [
            { "timestamp": 0, "distance": 0, "heart_rate": 120, "speed": 3.0, "adjusted_pace": 320,
              "cadence": 178, "altitude": 4.2, "gps_lat": 31.23, "gps_lon": 121.49 },
            { "timestamp": 100, "distance": 500, "heart_rate": 128, "speed": 3.1, "adjusted_pace": 315,
              "gps_lat": 31.231, "gps_lon": 121.491 }
          ]
        }
        """#
        let detail = try JSONDecoder().decode(ActivityDetailResponse.self, from: Data(json.utf8))
        #expect(detail.activity.feelNote == "腿部略沉")
        #expect(detail.activity.pauses?.first?.endTs == 1_600_000)
        #expect(detail.segments[0].segName == "训练")
        #expect(detail.timeseries?.count == 2)
        #expect(detail.timeseries?[1].paceForColoring == 315)
        #expect(detail.zones[0].zoneType == "heartRate")
    }
}
