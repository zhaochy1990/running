import CoreGraphics
import Foundation
import Testing
@testable import StrideKit

/// route_thumb 归一化形状 → 视图坐标映射（devops#828）：
/// 0..100 视窗线性缩放、Y 不再翻转（后端已翻成屏幕坐标，与 SVG 同向）、
/// 坏点跳过不中断——与 web 端 SVG polyline 同一份数据逐点同源。
@Suite struct RouteThumbViewTests {

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
}
