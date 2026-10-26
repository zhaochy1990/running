import SwiftUI

/// 四 tab 完全镜像（devops#751 决议 1）：教练（首页）/ 记录 / 训练 / 我。
/// 各 tab 独立 `NavigationStack`，切 tab 保留栈（confirmed 偏差 D-nav-1）。
public struct MainTabView: View {

    @Environment(AppModel.self) private var model

    public init() {}

    public var body: some View {
        let router = model.router
        TabView(selection: selection) {
            ForEach(AppTab.allCases) { tab in
                NavigationStack(path: pathBinding(for: tab, router: router)) {
                    tabRoot(for: tab)
                        .navigationDestination(for: Route.self) { route in
                            RouteShellView(route: route)
                        }
                }
                .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                .tag(tab)
            }
        }
    }

    private var selection: Binding<AppTab> {
        let router = model.router
        return Binding(
            get: { router.selectedTab },
            set: { router.selectedTab = $0 }
        )
    }

    private func pathBinding(for tab: AppTab, router: AppRouter) -> Binding<[Route]> {
        Binding(
            get: { router.paths[tab] ?? [] },
            set: { router.paths[tab] = $0 }
        )
    }

    @ViewBuilder
    private func tabRoot(for tab: AppTab) -> some View {
        switch tab {
        case .coach: CoachHomeView()
        case .activities: ActivitiesView()
        case .training: TrainingHomeView()
        case .profile: ProfileHomeView()
        }
    }
}

/// 四 tab 首页空壳（PR-1 骨架；各域实现归 PR-3~PR-7）。
struct CoachHomeView: View {
    var body: some View {
        PageShell(title: "教练", systemImage: "bubble.left.and.text.bubble.right")
    }
}

struct ActivitiesView: View {
    var body: some View {
        PageShell(title: "活动记录", systemImage: "figure.run")
    }
}

struct TrainingHomeView: View {
    var body: some View {
        PageShell(title: "STRIDE", systemImage: "list.clipboard")
    }
}

struct ProfileHomeView: View {
    var body: some View {
        PageShell(title: "我", systemImage: "person.crop.circle")
    }
}

/// 路由占位页：深链落点 / push 目标的通用骨架（各域票逐页替换）。
struct RouteShellView: View {
    let route: Route

    var body: some View {
        PageShell(title: routeTitle, systemImage: "square.grid.2x2")
    }

    private var routeTitle: String {
        switch route {
        case .coach, .activities, .trainingHome, .profile: ""
        case .login: "登录"
        case .onboarding: "引导"
        case .declaration: "声明"
        case .activityDetail: "活动详情"
        case .workoutDetail: "课表详情"
        case .workoutShare: "课表分享"
        case .coachShare: "教练对话分享"
        case .strategyShare: "比赛策略"
        case .trainingPlan: "我的训练计划"
        case .trainingStatus: "训练状态"
        case .raceCenter: "赛事中心"
        case .raceDetail: "赛事详情"
        case .raceStrategy: "比赛策略报告"
        case .myRaces: "我的比赛"
        case .customRaceForm: "自定义比赛"
        case .feedback: "意见反馈"
        case .feedbackForm: "提交反馈"
        case .feedbackChat: "反馈详情"
        case .productRoadmap: "产品路线"
        case .roadmapDetail: "路线想法"
        case .watch: "手表"
        case .profileEdit: "个人资料"
        case .privacy: "隐私与权限"
        }
    }
}

/// 空壳页统一形态：标题 + 建设中占位。
struct PageShell: View {
    @Environment(AppModel.self) private var model

    let title: String
    let systemImage: String

    var body: some View {
        VStack(spacing: model.theme.current.space(.md)) {
            Image(systemName: systemImage)
                .font(model.theme.current.font(.fsDisplay48))
                .foregroundStyle(model.theme.current.mutedTwo)
            Text("建设中")
                .font(model.theme.current.font(.fs15, weight: .medium))
                .foregroundStyle(model.theme.current.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(model.theme.current.background)
        .navigationTitle(title)
    }
}
