import SwiftUI

/// 路线缩略图（devops#828）：`route_thumb` 归一化形状（0..100 视窗、Y 已翻成
/// 屏幕坐标）用 SwiftUI `Path` 原生绘制，替代后端预渲染 thumb_url PNG——与 web 端
/// 同一份数据逐点同源；墨色取绘制时的主题令牌（调用方传 theme.muted），主题切换
/// 无需任何数据动作。第二版多段形状（devops#1039）各段分别起笔，线宽按形状自带
/// 的指标计算。室内/无 GPS 活动后端给 null，由调用方回退 SF Symbol。
struct RouteThumbView: View {

    /// 路线形状：各段分别起笔（旧版单折线即一段）；解不出的形状由解码落 nil，
    /// 不进本视图。
    let shape: RouteThumbShape
    /// 数据墨色（绘制时主题令牌，如 theme.muted）。
    let ink: Color
    /// 正方形边长（pt，逻辑显示尺寸），圆角连接；线宽见
    /// RouteThumbShape.lineWidth(displaySize:)。
    var size: CGFloat = 44

    var body: some View {
        Self.path(strokes: shape.strokes.map { Self.cgPoints($0, in: size) })
            .stroke(ink, style: StrokeStyle(
                lineWidth: shape.lineWidth(displaySize: size), lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
    }

    /// 各段分别起笔：每段一个子路径（首点 move、其余 addLine），段与段之间不连线——
    /// GPS 断笔保持断开，落在已画线段之外的真实起终点也不接上去。纯函数，单测覆盖。
    nonisolated static func path(strokes: [[CGPoint]]) -> Path {
        var path = Path()
        for stroke in strokes {
            for (i, p) in stroke.enumerated() {
                if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
            }
        }
        return path
    }

    /// [[x,y],...]（0..100 视窗、Y 已翻转）→ 视图坐标（左上原点，线性缩放；
    /// SwiftUI 与 SVG 同为 y 向下，不再翻 Y）。纯函数，单测覆盖；不可画的点对
    /// （不足两个数或非有限数，见 RouteThumbShape.isUsablePoint）跳过不中断。
    /// View 在 Swift 6 下整体 @MainActor，纯映射标 nonisolated 供任意执行器调用
    /// （同 ActivitiesModel 纯构建函数）。
    nonisolated static func cgPoints(_ route: [[Double]], in size: CGFloat) -> [CGPoint] {
        route.compactMap { pair in
            guard RouteThumbShape.isUsablePoint(pair) else { return nil }
            return CGPoint(x: pair[0] * size / 100, y: pair[1] * size / 100)
        }
    }
}
