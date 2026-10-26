import Foundation
import Observation

/// 全局导航骨架（devops#749 §4.2 / #751 决议 4）。
///
/// - 四 tab 各自 `NavigationStack`，**切 tab 不清栈**（iOS 惯例；parity ledger
///   confirmed 偏差 D-nav-1：小程序 switchTab 销毁所有普通页栈）。
/// - `reset(to:)` = 小程序 `wx.reLaunch`（20 处）的分解等价物：重置根。
/// - 小房子按钮整体消失（devops#749 §3）：深链落点 path 填根，系统返回
///   永远有处可退。
@MainActor
@Observable
public final class AppRouter {

    /// 当前选中 tab（教练=首页，镜像 app.json pages[0]）。
    public var selectedTab: AppTab = .coach

    /// 各 tab 的 NavigationStack 栈（保留，切 tab 不清）。
    /// 可写：TabView 的 path Binding 需要（栈驱动权在导航容器）。
    public var paths: [AppTab: [Route]] = [:]

    public init() {}

    /// `wx.reLaunch` 等价：全栈重建 + 落点填根。
    /// tab 根 → 清栈落根；非 tab 页 → `[该 tab 根, 目标页]`（栈根隐式为 tab 根，
    /// path 只挂目标页）。
    public func reset(to route: Route) {
        let tab = route.homeTab
        selectedTab = tab
        paths[tab] = route == tab.root ? [] : [route]
    }

    /// `wx.navigateTo` 等价：当前 tab push。
    public func push(_ route: Route) {
        paths[selectedTab, default: []].append(route)
    }

    /// `wx.navigateBack` 等价（返回手势之外显式回退的兜底）。
    public func pop() {
        _ = paths[selectedTab]?.popLast()
    }
}
