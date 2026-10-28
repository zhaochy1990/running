import Foundation
import Testing
@testable import StrideKit

/// 详情页视图数据构建（devops#766，对齐 activity-detail.ts buildView/buildMetrics/buildWeather）。
@Suite struct ActivityDetailBuildTests {

    private func runActivity(strength: Bool = false) -> Activity {
        Activity(
            labelId: "lbl-1", name: "  外滩晨跑  ", sportName: "Run",
            sportType: strength ? 402 : 1,
            date: "2026-10-18T06:30:00+08:00",
            distanceM: 10_240, distanceKm: 10.24, durationS: 3081, durationFmt: "00:51:21",
            avgPaceSKm: 300, avgHr: 152, maxHr: 171, avgCadence: 180, avgStepLenCm: 112,
            trainingLoad: 55, strideTrainingDose: 61.25, trainType: "Threshold",
            ascentM: 42, temperature: 18.5, humidity: 62, feelsLike: 16.5, windSpeed: 8.4,
            feelType: 2, feelNote: "腿部略沉", sportNote: "匀速有氧",
            pauses: nil, commentary: "  本周有氧底子扎实。  "
        )
    }

    private func detail(activity: Activity, segments: [Segment] = [],
                        zones: [Zone] = [], timeseries: [TimeseriesPoint] = []) -> ActivityDetailResponse {
        ActivityDetailResponse(activity: activity, segments: segments, zones: zones, timeseries: timeseries)
    }

    @Test func runMetricsNineItemsInOrder() {
        let view = ActivityDetailModel.buildView(detail(activity: runActivity()))
        #expect(view.metrics.count == 9)
        #expect(view.metrics.map(\.label) == ["距离", "平均配速", "平均心率", "训练负荷", "时长", "最大心率", "平均步幅", "平均步频", "累计爬升"])
        #expect(view.metrics[0].value == "10.24")
        #expect(view.metrics[1].value == "5'00\"")
        #expect(view.metrics[2].value == "152")
        #expect(view.metrics[3].value == "55")
        #expect(view.metrics[4].value == "00:51:21") // duration_fmt 优先
        #expect(view.metrics[6].value == "1.12")
    }

    @Test func strengthMetricsFourItemsAndNoMap() {
        let view = ActivityDetailModel.buildView(detail(activity: runActivity(strength: true)))
        #expect(view.metrics.map(\.label) == ["平均心率", "训练负荷", "时长", "最大心率"])
        // 力量活动不渲染地图（即使带 GPS 也直接跳过）
        #expect(view.mapSegments.isEmpty)
    }

    @Test func headerAndNotesAndCommentary() {
        let view = ActivityDetailModel.buildView(detail(activity: runActivity()))
        #expect(view.header.sportLabel == "跑步")
        #expect(view.header.name == "外滩晨跑") // trim
        #expect(view.header.dateLabel == "10月18日 06:30")
        #expect(view.header.trainTypeLabel == "乳酸阈")
        #expect(view.header.feelEmoji == "🙂")
        #expect(view.sportNote == "匀速有氧")
        #expect(view.feelNote == "腿部略沉")
        #expect(view.commentary == "  本周有氧底子扎实。  ")
    }

    @Test func blankCommentaryHidden() {
        var a = runActivity()
        a = Activity(labelId: a.labelId, name: a.name, sportName: a.sportName, sportType: a.sportType,
                     date: a.date, distanceM: a.distanceM, distanceKm: a.distanceKm, durationS: a.durationS,
                     durationFmt: a.durationFmt, avgPaceSKm: a.avgPaceSKm, avgHr: a.avgHr, maxHr: a.maxHr,
                     avgCadence: a.avgCadence, avgStepLenCm: a.avgStepLenCm, trainingLoad: a.trainingLoad,
                     strideTrainingDose: a.strideTrainingDose, trainType: a.trainType,
                     ascentM: a.ascentM, temperature: a.temperature, humidity: a.humidity,
                     feelsLike: a.feelsLike, windSpeed: a.windSpeed, feelType: a.feelType,
                     feelNote: a.feelNote, sportNote: a.sportNote, pauses: a.pauses, commentary: "   ")
        let view = ActivityDetailModel.buildView(detail(activity: a))
        #expect(view.commentary == nil)
    }

    @Test func weatherBuild() {
        let view = ActivityDetailModel.buildView(detail(activity: runActivity()))
        #expect(view.weather.map(\.value) == ["18.5°C（体感 16.5°）", "62%", "8.4 km/h"])
        #expect(view.weather.map(\.systemImage) == ["thermometer.medium", "drop.fill", "wind"])
    }

    @Test func weatherOmitsMissingAndEqualFeels() {
        var a = runActivity()
        a = Activity(labelId: a.labelId, name: nil, sportName: a.sportName, sportType: a.sportType,
                     date: a.date, distanceM: 0, distanceKm: 0, durationS: 0, durationFmt: nil,
                     avgPaceSKm: nil, avgHr: nil, maxHr: nil, avgCadence: nil, avgStepLenCm: nil,
                     trainingLoad: nil, strideTrainingDose: nil, trainType: nil,
                     ascentM: nil, temperature: 20, humidity: nil, feelsLike: 20, windSpeed: nil,
                     feelType: nil, feelNote: nil, sportNote: nil, pauses: nil, commentary: nil)
        let view = ActivityDetailModel.buildView(detail(activity: a))
        // feels_like == temperature 不带体感；湿度/风速缺失整项跳过
        #expect(view.weather.map(\.value) == ["20°C"])
    }

    @Test func strengthGroupsReplaceLaps() {
        let strength = runActivity(strength: true)
        let segments = [
            Segment(lapIndex: 0, lapType: "type2", distanceM: 0, distanceKm: 0, durationS: 60,
                    durationFmt: "01:00", avgPace: nil, avgHr: 110, avgCadence: nil, segName: "深蹲", mode: 0),
            Segment(lapIndex: 1, lapType: "type2", distanceM: 0, distanceKm: 0, durationS: 60,
                    durationFmt: "01:00", avgPace: nil, avgHr: 120, avgCadence: nil, segName: "深蹲", mode: 0),
        ]
        let view = ActivityDetailModel.buildView(detail(activity: strength, segments: segments))
        #expect(view.laps.isEmpty)
        #expect(view.strengthGroups.map(\.name) == ["深蹲"])
        #expect(view.strengthGroups[0].sets == 2)
        #expect(view.hasSegments)
    }

    @Test func indoorNoGpsHidesMap() {
        // 无 GPS 点（室内跑）→ mapSegments 空 → 地图隐藏
        let ts = (0..<30).map { i in
            TimeseriesPoint(timestamp: Double(i * 100), distance: Double(i * 100), heartRate: 150,
                            speed: 3.0, adjustedPace: 330, cadence: 180, altitude: nil,
                            gpsLat: nil, gpsLon: nil)
        }
        let view = ActivityDetailModel.buildView(detail(activity: runActivity(), timeseries: ts))
        #expect(view.mapSegments.isEmpty)
    }
}
