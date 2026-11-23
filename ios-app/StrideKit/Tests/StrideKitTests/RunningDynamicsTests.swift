import Foundation
import Testing
@testable import StrideKit

/// 跑姿动态卡（devops#1041）：wire 解码 / 分窗映射 / 位数格式化。期望值取自
/// 小程序 running-dynamics.ts（cardsFor / selectAt）与 chart.ts（dynamicsWindowAt /
/// axisTicks / markWidth）的既定行为，不由被测代码反推。
@Suite struct RunningDynamicsTests {

    private static let summaryJSON = #"""
    {
      "duration_s": 3081.5,
      "window_s": 90,
      "metrics": {
        "cadence": {"average": 178.4, "min": 160, "max": 190, "windows": [
          {"index": 0, "min": 172, "max": 180}, {"index": 1, "min": 168, "max": 184}]},
        "stride_length": {"average": 1.126, "min": 1.05, "max": 1.35, "windows": [
          {"index": 0, "min": 1.10, "max": 1.20}, {"index": 1, "min": 1.08, "max": 1.30}]},
        "vertical_oscillation": {"average": 8.26, "min": 7.2, "max": 9.4, "windows": [
          {"index": 0, "min": 7.9, "max": 8.6}, {"index": 1, "min": 7.2, "max": 9.4}]},
        "ground_contact_time": {"average": 247.6, "min": 220, "max": 260, "windows": [
          {"index": 0, "min": 240, "max": 250}, {"index": 1, "min": 220, "max": 260}]}
      }
    }
    """#

    private func summary(_ json: String = summaryJSON) throws -> RunningDynamics {
        try JSONDecoder().decode(RunningDynamics.self, from: Data(json.utf8))
    }

    private func section(_ json: String = summaryJSON) throws -> DynamicsSection {
        try #require(dynamicsSection(try summary(json)))
    }

    // MARK: - 解码

    @Test func decodesSnakeCaseSummary() throws {
        let decoded = try summary()
        #expect(decoded.durationS == 3081.5)
        #expect(decoded.windowS == 90)
        #expect(decoded.metrics.count == 4)
        #expect(decoded.metrics["cadence"]?.average == 178.4)
        #expect(decoded.metrics["stride_length"]?.windows.map(\.index) == [0, 1])
        #expect(decoded.metrics["vertical_oscillation"]?.min == 7.2)
        #expect(decoded.metrics["ground_contact_time"]?.windows[1].max == 260)
    }

    @Test func unreportedMetricsAreAbsentNotEmpty() throws {
        let decoded = try summary(#"""
        {"duration_s": 600, "window_s": 90, "metrics": {
          "ground_contact_time": {"average": 250, "min": 240, "max": 260, "windows": [{"index": 0, "min": 250, "max": 260}]}
        }}
        """#)
        #expect(decoded.metrics.count == 1)
        #expect(decoded.metrics["cadence"] == nil)
    }

    @Test func detailWithoutRunningDynamicsDecodesToNil() throws {
        for tail in ["", ", \"running_dynamics\": null"] {
            let json = #"""
            {"activity": {"label_id": "lbl-1", "sport_type": 402, "date": "2026-10-17",
                          "distance_m": 0, "distance_km": 0, "duration_s": 2400},
             "segments": [], "zones": []\#(tail)}
            """#
            let detail = try JSONDecoder().decode(ActivityDetailResponse.self, from: Data(json.utf8))
            #expect(detail.runningDynamics == nil)
            #expect(detail.activity.labelId == "lbl-1")
        }
    }

    /// 后端先改了形状、App 审核还没过：坏块只让跑姿卡隐藏，详情页其余部分照常解码。
    @Test func malformedRunningDynamicsHidesCardButKeepsDetail() throws {
        for bad in ["[]", #"{"duration_s": 600}"#, #"{"duration_s": "x", "window_s": 90, "metrics": {}}"#,
                    #"{"duration_s": 600, "window_s": 90, "metrics": {"cadence": 5}}"#] {
            let json = #"""
            {"activity": {"label_id": "lbl-1", "sport_type": 1, "date": "2026-10-18",
                          "distance_m": 10240, "distance_km": 10.24, "duration_s": 3081},
             "segments": [{"lap_index": 0, "lap_type": "type2", "distance_m": 1000, "duration_s": 300,
                           "seg_name": "训练"}],
             "zones": [], "running_dynamics": \#(bad)}
            """#
            let detail = try JSONDecoder().decode(ActivityDetailResponse.self, from: Data(json.utf8))
            #expect(detail.runningDynamics == nil, Comment(rawValue: bad))
            #expect(detail.segments.first?.segName == "训练", Comment(rawValue: bad))
        }
    }

    /// Garmin 步频口径归一（单脚步频 ×2 / 无法核实整项省略）在 Go API 的
    /// buildRunningDynamics 完成，对所有客户端生效。客户端只透传：再换算一次
    /// 会把已归一的步频翻倍。
    @Test func serverNormalizedCadencePassesThroughUnchanged() throws {
        let decoded = try summary(#"""
        {"duration_s": 600, "window_s": 90, "metrics": {
          "cadence": {"average": 178, "min": 172, "max": 184, "windows": [{"index": 0, "min": 172, "max": 180}]}
        }}
        """#)
        let section = try #require(dynamicsSection(decoded))
        let cadence = section.cards[0]
        #expect(cadence.average == "178")
        #expect(cadence.rangeText(selected: nil) == "172–184")
        #expect(cadence.rangeText(selected: 0) == "172–180")
    }

    // MARK: - 整卡门控

    @Test func noPlottableMetricHidesCard() throws {
        // metrics 为空 / 指标没有分窗区间 / 时长或窗口非法 → 都凑不出一张卡
        #expect(dynamicsSection(try summary(#"{"duration_s": 600, "window_s": 90, "metrics": {}}"#)) == nil)
        #expect(dynamicsSection(try summary(#"""
        {"duration_s": 600, "window_s": 90, "metrics": {
          "cadence": {"average": 178, "min": 172, "max": 184, "windows": []}
        }}
        """#)) == nil)
        #expect(dynamicsSection(try summary(#"""
        {"duration_s": 600, "window_s": 0, "metrics": {
          "cadence": {"average": 178, "min": 172, "max": 184, "windows": [{"index": 0, "min": 172, "max": 184}]}
        }}
        """#)) == nil)
        #expect(dynamicsSection(try summary(#"""
        {"duration_s": 0, "window_s": 90, "metrics": {
          "cadence": {"average": 178, "min": 172, "max": 184, "windows": [{"index": 0, "min": 172, "max": 184}]}
        }}
        """#)) == nil)
        // 全程范围倒挂：axisTicks 的 log10 会得到 NaN，Int(...) 直接 trap → 该指标不出卡
        #expect(dynamicsSection(try summary(#"""
        {"duration_s": 600, "window_s": 90, "metrics": {
          "cadence": {"average": 178, "min": 184, "max": 172, "windows": [{"index": 0, "min": 172, "max": 184}]}
        }}
        """#)) == nil)
    }

    @Test func cardsKeepFixedOrderAndSkipMissing() throws {
        let section = try section(#"""
        {"duration_s": 600, "window_s": 90, "metrics": {
          "vertical_oscillation": {"average": 8.26, "min": 7.2, "max": 9.4, "windows": [{"index": 0, "min": 7.9, "max": 8.6}]},
          "cadence": {"average": 178.4, "min": 160, "max": 190, "windows": [{"index": 0, "min": 172, "max": 180}]}
        }}
        """#)
        #expect(section.cards.map(\.key) == [.cadence, .verticalOscillation])
        #expect(section.durationS == 600)
        #expect(section.windowS == 90)
    }

    @Test func allFourMetricsInOrder() throws {
        let section = try section()
        #expect(section.cards.map(\.key.label) == ["步频", "步幅", "垂直振幅", "触地时间"])
        #expect(section.cards.map(\.key.unit) == ["步/分", "米/步", "厘米", "毫秒"])
    }

    // MARK: - 口径换算（各项小数位 = mp metrics 表 digits，toFixed 语义）

    @Test func averageUsesPerMetricDigits() throws {
        let section = try section()
        #expect(section.cards.map(\.average) == ["178", "1.13", "8.3", "248"])
    }

    @Test func fullRangeUsesPerMetricDigits() throws {
        let section = try section()
        #expect(section.cards.map { $0.rangeText(selected: nil) } == ["160–190", "1.05–1.35", "7.2–9.4", "220–260"])
    }

    // MARK: - 分窗聚合（选窗 → 四卡范围 + 时段标签）

    @Test func selectedWindowNarrowsRange() throws {
        let section = try section()
        #expect(section.cards.map { $0.rangeText(selected: 1) } == ["168–184", "1.08–1.30", "7.2–9.4", "220–260"])
        #expect(section.cards.map { $0.rangeText(selected: 0) } == ["172–180", "1.10–1.20", "7.9–8.6", "240–250"])
    }

    @Test func windowMissingFromOneMetricShowsDashOnlyThere() throws {
        // 该指标最后一个窗口没有采样（mp cardsFor：find 不到 → '—'），其余指标照常
        let section = try section(#"""
        {"duration_s": 200, "window_s": 90, "metrics": {
          "cadence": {"average": 178, "min": 172, "max": 184, "windows": [{"index": 0, "min": 172, "max": 184}]},
          "stride_length": {"average": 1.1, "min": 1.0, "max": 1.2, "windows": [
            {"index": 0, "min": 1.0, "max": 1.2}, {"index": 1, "min": 1.08, "max": 1.12}]}
        }}
        """#)
        #expect(section.cards.map { $0.rangeText(selected: 1) } == ["—", "1.08–1.12"])
        #expect(section.timeLabel(selected: 1) == "00:01:30–00:03:00")
    }

    @Test func timeLabelFollowsSelection() throws {
        let section = try section()
        #expect(section.timeLabel(selected: nil) == "全程范围")
        #expect(section.timeLabel(selected: 0) == "00:00:00–00:01:30")
        #expect(section.timeLabel(selected: 12) == "00:18:00–00:19:30")
        // 最后一个窗口不满 90 秒，止于活动时长
        #expect(section.timeLabel(selected: 34) == "00:51:00–00:51:22")
    }

    @Test func secondsMapToWindowIndex() throws {
        let section = try section()
        #expect(section.windowIndex(atSeconds: 0) == 0)
        #expect(section.windowIndex(atSeconds: 89.9) == 0)
        #expect(section.windowIndex(atSeconds: 90.1) == 1)
        #expect(section.windowIndex(atSeconds: 3059.9) == 33)
        #expect(section.windowIndex(atSeconds: 3060.1) == 34)
        #expect(section.windowIndex(atSeconds: 3081.5) == 34)
        // 触点落在绘图区外：夹回首尾窗口
        #expect(section.windowIndex(atSeconds: -50) == 0)
        #expect(section.windowIndex(atSeconds: 9999) == 34)
    }

    @Test func exactWindowBoundaryStaysInLastWindow() throws {
        // 时长恰好是窗口整数倍：终点不落到不存在的下一窗口
        let section = try section(#"""
        {"duration_s": 180, "window_s": 90, "metrics": {
          "cadence": {"average": 178, "min": 172, "max": 184, "windows": [{"index": 0, "min": 172, "max": 184}]}
        }}
        """#)
        #expect(section.windowIndex(atSeconds: 179.9) == 1)
        #expect(section.windowIndex(atSeconds: 180) == 1)
    }

    /// mp cardsFor 用 JS toFixed：恰好可表示的 .5 进位。String(format:) 对二进制值就近舍入，
    /// 会差末位 1（Garmin 垂直振幅是两位小数厘米，x.x5 很常见）。期望值 = Node 实跑 toFixed 输出。
    @Test func fixedRoundingMatchesJavaScriptToFixed() {
        let cases: [(Double, Int, String)] = [
            (8.25, 1, "8.3"), (1.125, 2, "1.13"), (178.5, 0, "179"), (247.5, 0, "248"), (0.25, 1, "0.3"),
            // 二进制里略低于 .5 的：照旧舍去
            (1.115, 2, "1.11"), (2.675, 2, "2.67"), (1.005, 2, "1.00"), (66.65, 1, "66.7"),
            // 非整位的照常四舍五入、补尾零
            (1.1, 2, "1.10"), (8.26, 1, "8.3"), (247.6, 0, "248"), (1.08, 2, "1.08"),
        ]
        for (value, digits, expected) in cases {
            #expect(dynamicsFixed(value, digits: digits) == expected, "\(value).toFixed(\(digits))")
        }
        #expect(dynamicsFixed(.nan, digits: 1) == "—")
    }

    @Test func garminOscillationTieRoundsUpLikeMiniProgram() throws {
        let decoded = try summary(#"""
        {"duration_s": 600, "window_s": 90, "metrics": {
          "vertical_oscillation": {"average": 8.25, "min": 8.1, "max": 8.75, "windows": [{"index": 0, "min": 8.25, "max": 8.75}]}
        }}
        """#)
        let section = try #require(dynamicsSection(decoded))
        #expect(section.cards[0].average == "8.3")
        #expect(section.cards[0].rangeText(selected: nil) == "8.1–8.8")
        #expect(section.cards[0].rangeText(selected: 0) == "8.3–8.8")
    }

    // MARK: - 图表刻度 / 线宽（chart.ts axisTicks / markWidth 直译）

    @Test func axisTicksUseNiceStepsWithPadding() {
        // 步频 160–185：步长 10，两端各留 1
        #expect(dynamicsAxisTicks(min: 160, max: 185, digits: 0) == [150, 160, 170, 180, 190])
        // 步幅 1.05–1.35：步长 0.1，刻度值去尾零前的数值形态
        #expect(dynamicsAxisTicks(min: 1.05, max: 1.35, digits: 2) == [1.0, 1.1, 1.2, 1.3, 1.4])
        // 触地 246–253：步长 2.5
        #expect(dynamicsAxisTicks(min: 246, max: 253, digits: 0) == [245, 247.5, 250, 252.5, 255])
    }

    @Test func axisTicksFlatMetricKeepsThreeLevels() {
        // 全程恒定（min == max）：上下各扩一格，竖线退化为圆点仍可见
        #expect(dynamicsAxisTicks(min: 250, max: 250, digits: 0) == [249, 250, 251])
        #expect(dynamicsAxisTicks(min: 8.2, max: 8.2, digits: 1) == [8, 8.1, 8.2, 8.3])
    }

    @Test func markWidthShrinksWithWindowCount() {
        // 375pt 机型绘图区宽 279pt
        let plot = 279.0
        #expect(abs(dynamicsMarkWidth(plotWidth: plot, durationS: 3600, windowS: 90) - 2.3) < 1e-9)
        #expect(abs(dynamicsMarkWidth(plotWidth: plot, durationS: 10800, windowS: 90) - 1.325) < 1e-9)
        #expect(abs(dynamicsMarkWidth(plotWidth: plot, durationS: 14400, windowS: 90) - 0.74375) < 1e-9)
        // 6 小时以上每个窗口不足 1.6pt：保底 0.6
        #expect(abs(dynamicsMarkWidth(plotWidth: plot, durationS: 43200, windowS: 90) - 0.6) < 1e-9)
    }
}

/// 详情链路接线：请求带 running_dynamics，视图数据只在可出卡时才给。
@Suite struct RunningDynamicsWiringTests {

    @Test func detailRequestsRunningDynamicsAlongsideTimeseries() async throws {
        let transport = MockTransport()
        let (client, _) = makeTestClient(transport: transport)
        await transport.plan("/api/u1/activities/lbl-1", responses: [(200, jsonData(#"{"activity": {"label_id": "lbl-1", "sport_type": 1, "date": "2026-10-18", "distance_m": 10240, "distance_km": 10.24, "duration_s": 3081}, "segments": [], "zones": []}"#))])

        _ = try await ActivitiesRepository(api: client).detail(userId: "u1", labelId: "lbl-1")

        let calls = await transport.calls(to: "/api/u1/activities/lbl-1")
        let call = try #require(calls.first)
        #expect(call.url.query == "include=timeseries,running_dynamics")
    }

    @Test func buildViewExposesSectionOnlyWhenPlottable() throws {
        let activity = Activity(labelId: "lbl-1", sportType: 1, date: "2026-10-18", distanceM: 10_240, distanceKm: 10.24, durationS: 3081)
        let plottable = try JSONDecoder().decode(RunningDynamics.self, from: jsonData(#"""
        {"duration_s": 3081.5, "window_s": 90, "metrics": {
          "cadence": {"average": 178.4, "min": 160, "max": 190, "windows": [{"index": 0, "min": 172, "max": 180}]}
        }}
        """#))
        let bare = try JSONDecoder().decode(RunningDynamics.self, from: jsonData(#"{"duration_s": 3081.5, "window_s": 90, "metrics": {}}"#))

        func view(_ dynamics: RunningDynamics?) -> ActivityDetailModel.ViewData {
            ActivityDetailModel.buildView(ActivityDetailResponse(
                activity: activity, segments: [], kilometerSplits: nil, zones: [], timeseries: [], runningDynamics: dynamics))
        }
        #expect(view(nil).runningDynamics == nil)
        #expect(view(bare).runningDynamics == nil)
        #expect(view(plottable).runningDynamics?.cards.map(\.key.label) == ["步频"])
    }
}
