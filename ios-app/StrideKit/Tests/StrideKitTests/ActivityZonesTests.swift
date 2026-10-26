import Foundation
import Testing
@testable import StrideKit

/// 心率/配速区间逻辑（devops#766，对齐 activity-detail.ts / utils/curve.ts）：
/// COROS 7→6 归一、开放边界标签、zoneBands 首档校正、曲线序列构建与抽稀。
@Suite struct ActivityZonesTests {

    private func zone(_ type: String, _ index: Int, min: Double?, max: Double?,
                      unit: String, duration: Double = 600, percent: Double = 20) -> Zone {
        Zone(zoneType: type, zoneIndex: index, rangeMin: min, rangeMax: max,
             rangeUnit: unit, durationS: duration, percent: percent)
    }

    // MARK: - COROS 7→6

    @Test func normalizesSevenPaceZones() {
        // COROS 布局：range_min=慢边（大）、range_max=快边（小）
        // range_min=慢边（更大 ms/km）、range_max=快边（更小 ms/km）
        let zones = [
            zone("pace", 1, min: 720_000, max: 620_000, unit: "ms/km"),
            zone("pace", 2, min: 620_000, max: 540_000, unit: "ms/km"),
            zone("pace", 3, min: 540_000, max: 500_000, unit: "ms/km"),
            zone("pace", 4, min: 500_000, max: 480_000, unit: "ms/km", duration: 100, percent: 10),
            zone("pace", 5, min: 480_000, max: 470_000, unit: "ms/km", duration: 50, percent: 5),
            zone("pace", 6, min: 470_000, max: 440_000, unit: "ms/km"),
            zone("pace", 7, min: 440_000, max: nil, unit: "ms/km"),
        ]
        let merged = normalizePaceZones(zones)
        #expect(merged.count == 6)
        // Z4+Z5 合并：慢边取 z4 慢边、快边取 z5 快边、时长/占比求和
        #expect(merged[3].rangeMin == 500_000)
        #expect(merged[3].rangeMax == 470_000)
        #expect(merged[3].durationS == 150)
        #expect(merged[3].percent == 15)
        // 重编号
        #expect(merged.map(\.zoneIndex) == [1, 2, 3, 4, 5, 6])
    }

    @Test func keepsNonCorosLayouts() {
        let zones = (1...5).map { zone("pace", $0, min: 500_000, max: 600_000, unit: "ms/km") }
        #expect(normalizePaceZones(zones).count == 5)
        let sevenNoIndex4 = [
            zone("pace", 1, min: 720_000, max: nil, unit: "ms/km"),
            zone("pace", 2, min: 620_000, max: 720_000, unit: "ms/km"),
            zone("pace", 3, min: 540_000, max: 620_000, unit: "ms/km"),
            zone("pace", 5, min: 480_000, max: 500_000, unit: "ms/km"),
            zone("pace", 6, min: 440_000, max: 480_000, unit: "ms/km"),
            zone("pace", 7, min: nil, max: 440_000, unit: "ms/km"),
            zone("pace", 8, min: 0, max: 440_000, unit: "ms/km"),
        ]
        #expect(normalizePaceZones(sevenNoIndex4).count == 7)
    }

    // MARK: - 区间标签

    @Test func hrRangeLabels() {
        let peers = [
            zone("heartRate", 1, min: 100, max: 120, unit: "bpm"),
            zone("heartRate", 2, min: 120, max: 140, unit: "bpm"),
            zone("heartRate", 3, min: 140, max: 160, unit: "bpm"),
            zone("heartRate", 4, min: 160, max: 180, unit: "bpm"),
            zone("heartRate", 5, min: 180, max: 200, unit: "bpm"),
        ]
        #expect(formatZoneRange(peers[0], peers: peers) == "100 - 120 bpm")
        #expect(formatZoneRange(peers[1], peers: peers) == "120 - 140 bpm")
        // 最高区开放高边
        #expect(formatZoneRange(peers[4], peers: peers) == "≥ 180 bpm")
    }

    @Test func hrRangeDuplicatedFirstZoneOpensLowEdge() {
        // 手表第一档与第二档同区间（重复值表达开放边）→ `< 共享下界`
        let peers = [
            zone("heartRate", 1, min: 100, max: 120, unit: "bpm"),
            zone("heartRate", 2, min: 100, max: 120, unit: "bpm"),
            zone("heartRate", 3, min: 120, max: 140, unit: "bpm"),
        ]
        #expect(formatZoneRange(peers[0], peers: peers) == "< 100 bpm")
    }

    @Test func paceRangeInvertedBoundaries() {
        // 慢边大值在 range_min、快边小值在 range_max（与心率相反）；
        // 手表首档与二档同区间（重复值表达开放边）→ `> 慢边`
        let peers = [
            zone("pace", 1, min: 700_000, max: 600_000, unit: "ms/km"),
            zone("pace", 2, min: 700_000, max: 600_000, unit: "ms/km"),
            zone("pace", 3, min: 600_000, max: 500_000, unit: "ms/km"),
        ]
        #expect(formatZoneRange(peers[0], peers: peers) == "> 11:40/km")
        #expect(formatZoneRange(peers[1], peers: peers) == "11:40 - 10:00/km")
        #expect(formatZoneRange(peers[2], peers: peers) == "< 10:00/km")
    }

    @Test func rawPaceRangeForUnknownUnits() {
        let z = zone("pace", 1, min: 3.2, max: 4.1, unit: "m/s")
        #expect(formatZoneRange(z, peers: [z]) == "3.2 - 4.1 m/s")
    }

    // MARK: - zoneBands

    @Test func zoneBandsAdjustsDuplicatedFirstZone() {
        // 手表首档与二档同区间（重复值表达开放边）
        let hr = [
            zone("heartRate", 1, min: 100, max: 120, unit: "bpm"),
            zone("heartRate", 2, min: 100, max: 120, unit: "bpm"),
            zone("heartRate", 3, min: 120, max: 140, unit: "bpm"),
        ]
        let bands = zoneBands(hr)
        // 心率首档挪到区间下方
        #expect(bands[0].lo == -.infinity)
        #expect(bands[0].hi == 100)
        #expect(bands.last?.hi == 140)
        #expect(bands.map(\.lo).sorted() == bands.map(\.lo)) // 有序

        let pace = [
            zone("pace", 1, min: 700, max: 600, unit: "ms/km"),
            zone("pace", 2, min: 700, max: 600, unit: "ms/km"),
            zone("pace", 3, min: 600, max: 500, unit: "ms/km"),
        ]
        let paceBandsSorted = zoneBands(pace)
        // 配速首档挪到区间上方（值更大的一侧）
        #expect(paceBandsSorted.last?.hi == .infinity)
        #expect(paceBandsSorted.last?.lo == 700)
    }

    @Test func paceZoneToSecondsOnlyForMsPerKm() {
        let z = zone("pace", 1, min: 500_000, max: 400_000, unit: "ms/km")
        let seconds = paceZoneToSeconds(z)
        #expect(seconds.rangeMin == 500)
        #expect(seconds.rangeMax == 400)
        let other = zone("pace", 1, min: 3.0, max: 4.0, unit: "m/s")
        #expect(paceZoneToSeconds(other).rangeMin == 3.0)
    }

    // MARK: - 序列

    private func ts(_ t: Double, hr: Double? = nil, pace: Double? = nil,
                    lat: Double? = nil, lon: Double? = nil, distance: Double? = nil) -> TimeseriesPoint {
        TimeseriesPoint(timestamp: t, distance: distance, heartRate: hr, speed: nil,
                        adjustedPace: pace, cadence: nil, altitude: nil, gpsLat: lat, gpsLon: lon)
    }

    @Test func buildSeriesConvertsCentisecondsAndFilters() {
        let points = [
            ts(0, hr: 120),
            ts(10_000, hr: 130),   // 100s
            ts(20_000, hr: 0),     // 0 丢弃
            ts(30_000),            // 缺失丢弃
            ts(40_000, hr: 145),   // 400s
        ]
        let series = buildHrSeries(points)
        #expect(series.map(\.t) == [0, 100, 400])
        #expect(series.map(\.v) == [120, 130, 145])
    }

    @Test func buildPaceSeriesFiltersOutliers() {
        let points = [
            ts(0, pace: 300),
            ts(10_000, pace: 1300), // ≥1200 丢弃
            ts(20_000, pace: 0),    // 0 丢弃
            ts(30_000, pace: 290),  // speed 回落场景由 paceForColoring 覆盖
        ]
        let series = buildPaceSeries(points)
        #expect(series.map(\.v) == [300, 290])
    }

    @Test func downsampleKeepsEndpoints() {
        let points = (0..<1000).map { CurvePoint(t: Double($0), v: Double($0 % 50)) }
        let out = downsample(points, limit: 100)
        #expect(out.count <= 101) // 步长取样 + 可能补的末点
        #expect(out.first == points.first)
        #expect(out.last == points.last)
        // 不超限直接原样
        #expect(downsample(Array(points.prefix(50)), limit: 100).count == 50)
    }

    @Test func chartTimeAndBounds() {
        #expect(formatChartTime(0) == "00:00:00")
        #expect(formatChartTime(3661) == "01:01:01")
        #expect(axisBounds([], step: 10).min == 0)
        let b = axisBounds([104, 187], step: 10)
        #expect(b.min == 100)
        #expect(b.max == 190)
        let flat = axisBounds([100], step: 10)
        #expect(flat.min == 100)
        #expect(flat.max == 110) // 与 lo 相等时保证有高度
    }
}
