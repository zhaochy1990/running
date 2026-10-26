import CoreLocation
import Foundation
import Testing
@testable import StrideKit

/// 轨迹地图构建（devops#766，#422/#463 渲染决议 + #754 决议二直译）：
/// pause 分段、<20 点隐藏、抽稀补末点、共享端点 8 点分段、三色 gradient、
/// 起终点重合不画终点、圈号徽标比例映射、WGS-84 直传（无 GCJ-02 转换）。
@Suite struct TrackMapBuilderTests {

    /// `hasGps: false` 模拟室内/无 GPS 采样（显式产出 nil，不能用 `lat ?? 默认`
    /// 形参——显式传 nil 会被默认值吞掉）。
    private func point(_ i: Int, hasGps: Bool = true,
                       hr: Double? = 140, pace: Double? = 300) -> TimeseriesPoint {
        TimeseriesPoint(
            timestamp: Double(i * 100),
            distance: Double(i * 500),
            heartRate: hr,
            speed: nil,
            adjustedPace: pace,
            cadence: nil,
            altitude: nil,
            gpsLat: hasGps ? 31.20 + Double(i) * 0.0001 : nil,
            gpsLon: hasGps ? 121.40 + Double(i) * 0.0001 : nil
        )
    }

    private func lap(_ index: Int, distanceM: Double, name: String = "训练", mode: Int? = 0) -> Segment {
        Segment(lapIndex: index, lapType: "type2", distanceM: distanceM, distanceKm: distanceM / 1000,
                durationS: 300, durationFmt: "05:00", avgPace: 300, avgHr: 150, avgCadence: 180,
                segName: name, mode: mode)
    }

    // MARK: - pause 分段

    @Test func pauseSplitsSegments() {
        let timeseries = (0..<10).map { point($0) }
        let pauses = [Pause(startTs: 450, endTs: 650, type: 1)] // 第 5、6 点落窗内
        let segments = buildMapSegments(timeseries, pauses: pauses)
        // 点 4 (ts=400) 在窗前；点 5 (ts=500)、6 (ts=600) 在窗内被丢弃；点 7 起新段
        #expect(segments.count == 2)
        #expect(segments[0].count == 5)
        #expect(segments[1].count == 3)
    }

    @Test func missingGpsDropped() {
        let timeseries = (0..<5).map { point($0, hasGps: false) } + (5..<25).map { point($0) }
        let segments = buildMapSegments(timeseries, pauses: nil)
        #expect(segments.count == 1)
        #expect(segments[0].count == 20)
    }

    // MARK: - 隐藏 / 抽稀 / 分段

    @Test func fewerThan20PointsHidesMap() {
        let segments = buildMapSegments((0..<19).map { point($0) }, pauses: nil)
        #expect(buildTrackMap(segments: segments, coloring: .pace) == nil)
    }

    @Test func decimationKeepsLastPointOfSegment() {
        // 1200 点 → stride=2 → 每段约 601 点（含补的末点）
        let timeseries = (0..<1200).map { point($0) }
        let segments = buildMapSegments(timeseries, pauses: nil)
        let map = buildTrackMap(segments: segments, coloring: .none)!
        // none 着色每段一条 polyline；共享端点 8 点窗口不影响 none 分支
        #expect(map.polylines.count == 1)
        #expect(map.polylines[0].points.count <= 601)
        // 补末点：最后一个点必须是原始末点
        let last = map.polylines[0].points.last!
        #expect(last.latitude == point(1199).gpsLat!)
        #expect(last.longitude == point(1199).gpsLon!)
    }

    @Test func coloredChunksShareEndpoints() {
        // 24 点（>20 显示、不抽稀）→ 共享端点 8 点窗口：0-7, 7-14, 14-21, 21-23
        let timeseries = (0..<24).map { point($0) }
        let segments = buildMapSegments(timeseries, pauses: nil)
        let map = buildTrackMap(segments: segments, coloring: .pace)!
        #expect(map.polylines.count == 4)
        #expect(map.polylines[0].points.count == 8)
        #expect(map.polylines[1].points.count == 8)
        #expect(map.polylines[2].points.count == 8)
        #expect(map.polylines[3].points.count == 3) // 末窗收尾恒 ≥2 点
        // 相邻 polyline 共享端点（无视觉断缝）
        #expect(map.polylines[0].points.last?.latitude == map.polylines[1].points.first?.latitude)
        #expect(map.polylines[1].points.last?.latitude == map.polylines[2].points.first?.latitude)
        #expect(map.polylines[2].points.last?.latitude == map.polylines[3].points.first?.latitude)
    }

    @Test func lastChunkShorterButNeverSingle() {
        // 20 点 → 0-7, 7-14, 14-19（末窗 6 点）
        let timeseries = (0..<20).map { point($0) }
        let segments = buildMapSegments(timeseries, pauses: nil)
        let map = buildTrackMap(segments: segments, coloring: .pace)!
        #expect(map.polylines.count == 3)
        #expect(map.polylines[2].points.count == 6)
    }

    // MARK: - gradient3

    @Test func gradient3EndpointsAndMid() {
        #expect(gradient3(0) == mapGreen)
        #expect(gradient3(1) == mapRed)
        #expect(gradient3(0.5) == mapAmber)
        // 越界夹取
        #expect(gradient3(-1) == mapGreen)
        #expect(gradient3(2) == mapRed)
    }

    // MARK: - 视野

    @Test func fitBoundsHave10PercentPadding() {
        let timeseries = (0..<25).map { point($0) }
        let segments = buildMapSegments(timeseries, pauses: nil)
        let map = buildTrackMap(segments: segments, coloring: .none)!
        // 跨度 0.0024 的 10% = 0.00024 < 最小 0.0008 → 用 0.0008 兜底
        #expect(abs(map.fitSouthWest.latitude - (31.20 - 0.0008)) < 1e-9)
        #expect(abs(map.fitNorthEast.latitude - (31.20 + 24 * 0.0001 + 0.0008)) < 1e-9)
        #expect(abs(map.center.latitude - (31.20 + 12 * 0.0001)) < 1e-9)
    }

    // MARK: - 标注

    @Test func coincidingEndpointsDrawOnlyStart() {
        let timeseries = (0..<25).map { point($0) }
        // 把末点改回起点坐标 → 终点不画
        let loopTimeseries = timeseries.dropLast().map { $0 } + [
            TimeseriesPoint(timestamp: 2400, distance: 12_000, heartRate: 140, speed: nil,
                            adjustedPace: 300, cadence: nil, altitude: nil,
                            gpsLat: timeseries[0].gpsLat, gpsLon: timeseries[0].gpsLon),
        ]
        let loopSegments = buildMapSegments(loopTimeseries, pauses: nil)
        let markers = buildMarkers(segments: loopSegments, lapSegments: [], timeseries: loopTimeseries)
        #expect(markers.filter { if case .start = $0.kind { return true }; return false }.count == 1)
        #expect(markers.filter { if case .end = $0.kind { return true }; return false }.count == 0)
    }

    @Test func endpointsAndLapBadges() {
        let timeseries = (0..<25).map { point($0) }
        let segments = buildMapSegments(timeseries, pauses: nil)
        let laps = [lap(0, distanceM: 6000), lap(1, distanceM: 6000), lap(2, distanceM: 5000, name: "恢复", mode: 3)]
        let markers = buildMarkers(segments: segments, lapSegments: laps, timeseries: timeseries)

        #expect(markers.first?.kind == .start)
        #expect(markers.contains { if case .end = $0.kind { return true }; return false })
        // 两圈计号（恢复圈不计）→ 徽标 1、2
        let badges = markers.compactMap { marker -> Int? in
            if case let .lapBadge(number) = marker.kind { return number }
            return nil
        }
        #expect(badges == [1, 2])
        // WGS-84 直传：徽标坐标与原始 GPS 一致（不经过 GCJ-02 偏移）
        if case let .lapBadge(number) = markers.last?.kind, number == 2 {
            // 圈 2 结束在 12_000/17_000 ≈ 70% → ts 点 ~17 → lat 31.2017
            #expect(abs(markers.last!.coordinate.latitude - 31.2017) < 0.0005)
        }
    }

    @Test func wgs84PassThroughNoGcj02Shift() {
        // 境内点若误转 GCJ-02 会偏 ~0.002-0.005°；直传应与原始值逐位相等
        let timeseries = (0..<25).map { point($0) }
        let segments = buildMapSegments(timeseries, pauses: nil)
        let map = buildTrackMap(segments: segments, coloring: .none)!
        #expect(map.polylines[0].points[0].latitude == 31.20)
        #expect(map.polylines[0].points[0].longitude == 121.40)
    }
}
