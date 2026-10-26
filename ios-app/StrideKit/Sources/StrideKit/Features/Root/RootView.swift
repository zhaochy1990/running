import SwiftUI

/// 根视图：全屏 Login / Onboarding 切换（devops#751 决议 2：未登录/会话
/// 失效不露 tab，根视图级整体替换，非 sheet 覆盖；PR-2 增加 onboarding
/// 全屏态——app.ts reLaunch onboarding 的等价呈现）。
public struct RootView: View {

    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        ZStack {
            switch model.phase {
            case .checking:
                ProgressView()
            case .loggedOut:
                // 登录流的法务链接在本地栈 push declaration（返回回登录页）。
                NavigationStack {
                    LoginView()
                        .navigationDestination(for: Route.self) { route in
                            LegalDestinationView(route: route)
                        }
                }
            case .onboarding:
                OnboardingView()
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

/// 登录上下文中的 Route 落点：法务两页真实实现，其余沿用域骨架壳
/// （登录流实际可达面只有 declaration）。
struct LegalDestinationView: View {
    let route: Route

    var body: some View {
        switch route {
        case .declaration(let docType):
            DeclarationView(docType: docType)
        default:
            RouteShellView(route: route)
        }
    }
}
