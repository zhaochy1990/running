import SwiftUI

/// 根视图：全屏 Login 切换骨架（devops#751 决议 2：未登录/会话失效不露 tab，
/// 根视图级整体替换，非 sheet 覆盖）。
public struct RootView: View {

    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        ZStack {
            switch model.phase {
            case .checking:
                ProgressView()
            case .loggedOut:
                LoginView()
            case .loggedIn:
                MainTabView()
            }
        }
        .animation(.default, value: model.phase)
        // 全局 accent 藕粉 #ff6363（含 tab 选中色，devops#751 决议 1）
        .tint(model.theme.current.accent)
        .background(model.theme.current.background)
    }
}
