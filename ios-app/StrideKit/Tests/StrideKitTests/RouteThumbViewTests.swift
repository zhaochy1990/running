import CoreGraphics
import Foundation
import SwiftUI
import Testing
@testable import StrideKit

/// route_thumb 归一化形状 → 视图坐标映射 / 分段绘制 / 线宽 / 三代形状解码
/// （devops#828、#1039）：0..100 视窗线性缩放、Y 不再翻转（后端已翻成屏幕坐标，
/// 与 SVG 同向）、坏点跳过不中断——与 web 端 SVG 同一份数据逐点同源。
@Suite struct RouteThumbViewTests {

    private static func elements(_ path: Path) -> [Path.Element] {
        var out: [Path.Element] = []
        path.forEach { out.append($0) }
        return out
    }

    @Test func mapsViewportToViewLinearly() {
        let pts = RouteThumbView.cgPoints([[0, 0], [50, 50], [100, 100]], in: 44)
        #expect(pts == [CGPoint(x: 0, y: 0), CGPoint(x: 22, y: 22), CGPoint(x: 44, y: 44)])
    }

    @Test func yIsAlreadyScreenOriented() {
        // 后端 Y 已翻转：视窗 y=95（路线下沿）→ 视图 y=41.8 靠近底边，不再翻。
        let pts = RouteThumbView.cgPoints([[5, 95]], in: 44)
        #expect(abs(pts[0].x - 2.2) < 0.0001)
        #expect(abs(pts[0].y - 41.8) < 0.0001)
    }

    @Test func skipsMalformedPairs() {
        let pts = RouteThumbView.cgPoints([[10, 10], [20], [], [30, 30, 99]], in: 100)
        #expect(pts == [CGPoint(x: 10, y: 10), CGPoint(x: 30, y: 30)])
    }

    // MARK: - 形状解码（devops#1039：同一字段三代并存）

    private func decode(_ json: String) throws -> RouteThumbShape {
        try JSONDecoder().decode(RouteThumbShape.self, from: Data(json.utf8))
    }

    @Test func decodesLegacyPolyline() throws {
        #expect(try decode("[[5.0,95.0],[50.0,20.0],[95.0,5.0]]") == .polyline([[5, 95], [50, 20], [95, 5]]))
    }

    @Test func decodesMultiStrokeWithRealEndpointsAndWidthMetrics() throws {
        // 与 Go API 测试 TestActivityList_RouteThumbServesAllShapeGenerations 同一份 v2 样本。
        let json = #"{"v":2,"strokes":[[[5.0,95.0],[50.0,20.0]],[[50.0,20.0],[95.0,5.0]]],"start":[5.0,95.0],"end":[95.0,5.0],"short":10.0,"long":90.0,"travel":127.3}"#
        #expect(try decode(json) == .multiStroke(.init(
            strokes: [[[5, 95], [50, 20]], [[50, 20], [95, 5]]],
            start: [5, 95], end: [95, 5], short: 10, long: 90, travel: 127.3
        )))
    }

    @Test(arguments: [
        "future version": #"{"v":3,"strokes":[[[5.0,95.0],[50.0,50.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":1.0,"long":2.0,"travel":3.0}"#,
        "no strokes": #"{"v":2,"strokes":[],"start":[5.0,95.0],"end":[50.0,50.0],"short":1.0,"long":2.0,"travel":3.0}"#,
        "one-point stroke": #"{"v":2,"strokes":[[[5.0,95.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":1.0,"long":2.0,"travel":3.0}"#,
        "one-number endpoint": #"{"v":2,"strokes":[[[5.0,95.0],[50.0,50.0]]],"start":[5.0],"end":[50.0,50.0],"short":1.0,"long":2.0,"travel":3.0}"#,
        "missing metric": #"{"v":2,"strokes":[[[5.0,95.0],[50.0,50.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":1.0,"long":2.0}"#,
        "one-point polyline": "[[5.0,95.0]]",
        "empty polyline": "[]",
        "malformed polyline": #"[[1.0,"x"]]"#,
    ])
    func rejectsShapesItCannotDraw(name: String, json: String) {
        #expect(throws: (any Error).self) { try decode(json) }
    }

    // MARK: - 分段绘制（各段单独起笔）

    @Test func drawsEachStrokeAsItsOwnSubpath() {
        let path = RouteThumbView.path(strokes: [
            [CGPoint(x: 2, y: 44), CGPoint(x: 22, y: 20)],
            [CGPoint(x: 50, y: 20), CGPoint(x: 44, y: 2), CGPoint(x: 10, y: 2)],
        ])
        // 两段 = 两个子路径：第二段从 move 起笔，而不是从上一段终点连一条线过来。
        #expect(Self.elements(path) == [
            .move(to: CGPoint(x: 2, y: 44)), .line(to: CGPoint(x: 22, y: 20)),
            .move(to: CGPoint(x: 50, y: 20)), .line(to: CGPoint(x: 44, y: 2)), .line(to: CGPoint(x: 10, y: 2)),
        ])
    }

    /// 真实起终点属于轨迹而不属于任何一段（devops#1034）：GPS 断笔留下的起点不在
    /// 已画线段上，绘制不把它接上去——开放端点保持开放，不凭距离接通。
    @Test func leavesRealEndpointsOffTheStrokesUnconnected() throws {
        let shape = try decode(#"{"v":2,"strokes":[[[50.0,20.0],[95.0,5.0]]],"start":[5.0,95.0],"end":[95.0,5.0],"short":0.0,"long":90.0,"travel":180.0}"#)
        let path = RouteThumbView.path(strokes: shape.strokes.map { RouteThumbView.cgPoints($0, in: 100) })
        #expect(Self.elements(path) == [.move(to: CGPoint(x: 50, y: 20)), .line(to: CGPoint(x: 95, y: 5))])
    }

    @Test func legacyPolylineIsOneStroke() throws {
        #expect(try decode("[[5.0,95.0],[95.0,5.0]]").strokes == [[[5, 95], [95, 5]]])
    }

    // MARK: - 线宽（用例同 Go TestStrokeWidth）

    @Test(arguments: [
        (size: 36.0, short: 60.0, long: 90.0, travel: 300.0, want: 1.2),       // 36 px 常规
        (size: 36.0, short: 8.0, long: 90.0, travel: 260.0, want: 0.9),        // 36 px 狭长往返
        (size: 64.0, short: 8.0, long: 90.0, travel: 260.0, want: 64.0 / 30),  // ≥ 56 px 不收窄
        (size: 36.0, short: 0.0, long: 90.0, travel: 300.0, want: 1.2),        // 直线轨迹不收窄
        (size: 36.0, short: 20.0, long: 90.0, travel: 100.0, want: 1.2),       // 短路线不收窄
    ])
    func strokeWidthMatchesGo(size: Double, short: Double, long: Double, travel: Double, want: Double) {
        let got = RouteThumbShape.strokeWidth(displaySize: size, short: short, long: long, travel: travel)
        #expect(abs(got - want) < 1e-9)
    }

    /// 线宽取逻辑显示尺寸（devops#1034）：列表槽 44 pt 上狭长往返路线的三个权重为
    /// 1 × 1 × (56−44)/20 = 0.6；56 pt 起回到常规线宽。
    @Test func narrowOutAndBackThinsByTheLogicalDisplaySize() {
        let thin = RouteThumbShape.strokeWidth(displaySize: 44, short: 8, long: 90, travel: 260)
        #expect(abs(thin - 44.0 / 30 * (1 - 0.25 * 0.6)) < 1e-9)
        #expect(abs(RouteThumbShape.strokeWidth(displaySize: 56, short: 8, long: 90, travel: 260) - 56.0 / 30) < 1e-9)
    }

    /// 旧版单折线维持常规线宽；新版按形状自带的指标收窄。
    @Test func lineWidthFollowsTheShapeVersion() throws {
        #expect(try decode("[[5.0,95.0],[95.0,5.0]]").lineWidth(displaySize: 44) == 44.0 / 30)
        let thin = try decode(#"{"v":2,"strokes":[[[5.0,95.0],[95.0,5.0]]],"start":[5.0,95.0],"end":[95.0,5.0],"short":8.0,"long":90.0,"travel":260.0}"#)
        #expect(abs(thin.lineWidth(displaySize: 44) - 44.0 / 30 * 0.85) < 1e-9)
    }
}
