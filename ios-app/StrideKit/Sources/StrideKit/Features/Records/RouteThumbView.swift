import SwiftUI

/// 路线缩略图（devops#828）：`route_thumb` 归一化形状 [[x,y],...]（0..100
/// 视窗、Y 已翻转为屏幕坐标）用 SwiftUI `Path` 原生绘制，替代后端预渲染
/// thumb_url PNG——与 web 端 SVG polyline 同一份数据逐点同源；墨色取绘制
/// 时的主题令牌（调用方传 theme.muted），未来主题/深色切换无需任何数据
/// 动作。室内/无 GPS 活动后端给 null，由调用方回退 SF Symbol。
struct RouteThumbView: View {

    /// 归一化轨迹点（0..100 视窗）；<2 点由调用方走回退图标，不进本视图。
    let points: [[Double]]
    /// 数据墨色（绘制时主题令牌，如 theme.muted）。
    let ink: Color
    /// 正方形边长（pt）；线宽 ≈ size/30（同 web 端 3/100 视窗比例），圆角连接。
    var size: CGFloat = 44

    var body: some View {
        Path { path in
            for (i, p) in Self.cgPoints(points, in: size).enumerated() {
                if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
            }
        }
        .stroke(ink, style: StrokeStyle(lineWidth: size / 30, lineCap: .round, lineJoin: .round))
        .frame(width: size, height: size)
    }

    /// [[x,y],...]（0..100 视窗、Y 已翻转）→ 视图坐标（左上原点，线性缩放；
    /// SwiftUI 与 SVG 同为 y 向下，不再翻 Y）。纯函数，单测覆盖；
    /// 坏点（元素不足 2 个）跳过不中断。View 在 Swift 6 下整体 @MainActor，
    /// 纯映射标 nonisolated 供任意执行器调用（同 ActivitiesModel 纯构建函数）。
    nonisolated static func cgPoints(_ route: [[Double]], in size: CGFloat) -> [CGPoint] {
        route.compactMap { pair in
            guard pair.count >= 2 else { return nil }
            return CGPoint(x: pair[0] * size / 100, y: pair[1] * size / 100)
        }
    }
}
