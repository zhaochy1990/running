import Foundation

/// 全局路由表（devops#749 §4.1 / #751 决议 3）。
///
/// 单一强类型 `Route` enum 替代小程序 `app.json` 字符串表 + 页内拼 query：
/// 27 个活跃页逐页入表（关联值承接全部实测 query 面），死页 plan/health 不迁
/// （baseline §10）。`Route(url:)` 白名单解析 = `sanitizeRedirect` 等价更严
/// （只接受白名单 path + 白名单参数，非法返回 nil），分享回流 / 登录回跳共用。
public enum Route: Hashable, Sendable {

    // ── 四 tab 根 ────────────────────────────────────────────────────────
    /// pages/coach/coach —— 教练 tab（首页，冷启动落点）
    case coach
    /// pages/activities/activities —— 记录 tab
    case activities
    /// pages/index/index —— 训练 tab（小程序首页 = 今日课表）
    case trainingHome
    /// pages/profile/profile —— 我 tab
    case profile

    // ── 引导账号域 ──────────────────────────────────────────────────────
    /// pages/login/login；redirect = 登录成功后的回跳目标（401 丢上下文修复）
    indirect case login(redirect: Route?)
    /// pages/onboarding/onboarding；redirect 同上
    indirect case onboarding(redirect: Route?)
    /// pages/declaration/declaration；docType 白名单二值
    case declaration(docType: DeclarationType)

    // ── 记录域 ──────────────────────────────────────────────────────────
    /// pages/activity-detail/activity-detail
    case activityDetail(labelId: String)
    /// pages/workout-detail/workout-detail
    case workoutDetail(date: String, workoutId: String, title: String?)

    // ── 分享落地域（公开免登录，PUBLIC_ENTRY_PAGES 三页）────────────────
    /// pages/workout-share/workout-share
    case workoutShare(user: String, workout: String)
    /// pages/coach-share/coach-share
    case coachShare(sid: String)
    /// pages/race-center/strategy-share/strategy-share
    case strategyShare(user: String, id: Int, version: Int)

    // ── 训练域 ──────────────────────────────────────────────────────────
    /// pages/training-plan/training-plan
    case trainingPlan
    /// pages/training-status/training-status
    case trainingStatus

    // ── 赛事域 ──────────────────────────────────────────────────────────
    /// pages/race-center/race-center
    case raceCenter
    /// pages/race-center/detail
    case raceDetail(id: Int)
    /// pages/race-center/strategy/strategy；target = 初始选中的目标成绩版本
    case raceStrategy(id: Int, target: String?)
    /// pages/my-races/my-races
    case myRaces
    /// pages/custom-race-form/custom-race-form（编辑回显走 AppModel 交接，非 query）
    case customRaceForm

    // ── 反馈路线域 ──────────────────────────────────────────────────────
    /// pages/feedback/feedback；tab 深链 `?tab=roadmap`
    case feedback(initialTab: FeedbackInitialTab?)
    /// pages/feedback-form/feedback-form
    case feedbackForm
    /// pages/feedback-chat/feedback-chat
    case feedbackChat(id: String)
    /// pages/product-roadmap/product-roadmap（路径兼容薄壳）
    case productRoadmap
    /// pages/roadmap-detail/roadmap-detail
    case roadmapDetail(id: Int)

    // ── 手表域 / 个人域 ─────────────────────────────────────────────────
    /// pages/watch/watch；provider 深链 `?provider=coros|garmin`
    case watch(provider: WatchProvider?)
    /// pages/profile-edit/profile-edit
    case profileEdit
    /// pages/privacy/privacy
    case privacy
}

/// 声明类型白名单（pages/declaration/declaration ?doc_type=）。
public enum DeclarationType: String, Hashable, Sendable, CaseIterable {
    case userAgreement = "user_agreement"
    case privacyPolicy = "privacy_policy"
}

/// 反馈页深链 tab（实测仅 `?tab=roadmap` 一值）。
public enum FeedbackInitialTab: String, Hashable, Sendable, CaseIterable {
    case roadmap
}

/// 手表品牌（pages/watch/watch ?provider=）。
public enum WatchProvider: String, Hashable, Sendable, CaseIterable {
    case coros
    case garmin
}

// MARK: - 路径与解析

extension Route {

    /// 小程序页面路径（app.json 字符串表原样，作为白名单 key）。
    public var pagePath: String {
        switch self {
        case .coach: "/pages/coach/coach"
        case .activities: "/pages/activities/activities"
        case .trainingHome: "/pages/index/index"
        case .profile: "/pages/profile/profile"
        case .login: "/pages/login/login"
        case .onboarding: "/pages/onboarding/onboarding"
        case .declaration: "/pages/declaration/declaration"
        case .activityDetail: "/pages/activity-detail/activity-detail"
        case .workoutDetail: "/pages/workout-detail/workout-detail"
        case .workoutShare: "/pages/workout-share/workout-share"
        case .coachShare: "/pages/coach-share/coach-share"
        case .strategyShare: "/pages/race-center/strategy-share/strategy-share"
        case .trainingPlan: "/pages/training-plan/training-plan"
        case .trainingStatus: "/pages/training-status/training-status"
        case .raceCenter: "/pages/race-center/race-center"
        case .raceDetail: "/pages/race-center/detail"
        case .raceStrategy: "/pages/race-center/strategy/strategy"
        case .myRaces: "/pages/my-races/my-races"
        case .customRaceForm: "/pages/custom-race-form/custom-race-form"
        case .feedback: "/pages/feedback/feedback"
        case .feedbackForm: "/pages/feedback-form/feedback-form"
        case .feedbackChat: "/pages/feedback-chat/feedback-chat"
        case .productRoadmap: "/pages/product-roadmap/product-roadmap"
        case .roadmapDetail: "/pages/roadmap-detail/roadmap-detail"
        case .watch: "/pages/watch/watch"
        case .profileEdit: "/pages/profile-edit/profile-edit"
        case .privacy: "/pages/privacy/privacy"
        }
    }

    /// 带 query 的完整 path（redirect 回跳 / 分享 path 构造用）。
    public var pathWithQuery: String {
        let items = queryItems
        let query = items.map { "\($0.name)=\(($0.value ?? "").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ($0.value ?? ""))" }
            .joined(separator: "&")
        return query.isEmpty ? pagePath : pagePath + "?" + query
    }

    /// 关联值 → query 项（`pathWithQuery` 与白名单解析互逆）。
    public var queryItems: [URLQueryItem] {
        switch self {
        case .coach, .activities, .trainingHome, .profile,
             .trainingPlan, .trainingStatus, .raceCenter, .myRaces,
             .customRaceForm, .feedbackForm, .productRoadmap, .profileEdit, .privacy:
            []
        case .login(let redirect):
            redirect.map { [URLQueryItem(name: "redirect", value: $0.pathWithQuery)] } ?? []
        case .onboarding(let redirect):
            redirect.map { [URLQueryItem(name: "redirect", value: $0.pathWithQuery)] } ?? []
        case .declaration(let docType):
            [URLQueryItem(name: "doc_type", value: docType.rawValue)]
        case .activityDetail(let labelId):
            [URLQueryItem(name: "labelId", value: labelId)]
        case .workoutDetail(let date, let workoutId, let title):
            [URLQueryItem(name: "date", value: date), URLQueryItem(name: "workoutId", value: workoutId)]
                + (title.map { [URLQueryItem(name: "title", value: $0)] } ?? [])
        case .workoutShare(let user, let workout):
            [URLQueryItem(name: "user", value: user), URLQueryItem(name: "workout", value: workout)]
        case .coachShare(let sid):
            [URLQueryItem(name: "sid", value: sid)]
        case .strategyShare(let user, let id, let version):
            [URLQueryItem(name: "user", value: user), URLQueryItem(name: "id", value: String(id)),
             URLQueryItem(name: "version", value: String(version))]
        case .raceDetail(let id):
            [URLQueryItem(name: "id", value: String(id))]
        case .raceStrategy(let id, let target):
            [URLQueryItem(name: "id", value: String(id))]
                + (target.map { [URLQueryItem(name: "target", value: $0)] } ?? [])
        case .feedback(let tab):
            tab.map { [URLQueryItem(name: "tab", value: $0.rawValue)] } ?? []
        case .feedbackChat(let id):
            [URLQueryItem(name: "id", value: id)]
        case .roadmapDetail(let id):
            [URLQueryItem(name: "id", value: String(id))]
        case .watch(let provider):
            provider.map { [URLQueryItem(name: "provider", value: $0.rawValue)] } ?? []
        }
    }

    /// 公开免登录落地页（app.ts PUBLIC_ENTRY_PAGES 三页，#751 推导项）。
    /// App 内形态归分享深链票（#758）；骨架期只保路由可达与免登录语义。
    public var isPublicLanding: Bool {
        switch self {
        case .workoutShare, .coachShare, .strategyShare: true
        default: false
        }
    }

    /// 深链/冷开落点所属 tab（devops#749 §3「path 填根」策略）：
    /// 非路由页面按小程序实际入口归属，系统返回永远有处可退。
    public var homeTab: AppTab {
        switch self {
        case .coach: .coach
        case .activities, .activityDetail: .activities
        case .trainingHome, .workoutDetail: .training
        case .profile, .profileEdit, .privacy, .trainingPlan, .trainingStatus,
             .raceCenter, .raceDetail, .raceStrategy, .myRaces, .customRaceForm,
             .feedback, .feedbackForm, .feedbackChat, .productRoadmap, .roadmapDetail,
             .watch, .declaration: .profile
        case .workoutShare, .coachShare, .strategyShare, .login, .onboarding: .coach
        }
    }
}

// MARK: - 白名单解析

extension Route {

    /// 深链 / 分享回流 / 登录回跳统一入口：只接受白名单 path + 白名单参数
    /// （等价且严于 `utils/redirect.ts sanitizeRedirect`，后者只挡开放重定向形状）。
    /// 拒绝面：未知页、缺必填参、参数值类型不符、未知参数、重复 key、
    /// 必填枚举值非法 → nil。容错面（沿小程序 options 语义）：可选枚举
    /// （provider/tab）取值不认识 → 忽略该参数；redirect 不可解析/指向白名单
    /// 外 → 丢弃 redirect（绝不回跳外部地址）。
    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let query = Self.queryDictionary(components.queryItems) else { return nil }
        self.init(pagePath: components.path, query: query)
    }

    init?(pagePath: String, query: [String: String]) {
        func require(_ keys: String...) -> Bool {
            keys.allSatisfy { query[$0] != nil && !query[$0]!.isEmpty }
        }
        func allowOnly(_ keys: String...) -> Bool {
            Set(query.keys).isSubset(of: keys)
        }

        func redirectQuery() -> Route? {
            guard let raw = query["redirect"], !raw.isEmpty else { return nil }
            // 白名单解析取代 sanitizeRedirect 的形状校验：redirect 必须本身可解析。
            guard let inner = URLComponents(string: raw),
                  let innerQuery = Self.queryDictionary(inner.queryItems) else { return nil }
            return Route(pagePath: inner.path, query: innerQuery)
        }

        switch pagePath {
        case "/pages/coach/coach":
            guard allowOnly() else { return nil }
            self = .coach
        case "/pages/activities/activities":
            guard allowOnly() else { return nil }
            self = .activities
        case "/pages/index/index":
            guard allowOnly() else { return nil }
            self = .trainingHome
        case "/pages/profile/profile":
            guard allowOnly() else { return nil }
            self = .profile
        case "/pages/login/login":
            guard allowOnly("redirect") else { return nil }
            self = .login(redirect: redirectQuery())
        case "/pages/onboarding/onboarding":
            guard allowOnly("redirect") else { return nil }
            self = .onboarding(redirect: redirectQuery())
        case "/pages/declaration/declaration":
            guard allowOnly("doc_type"), let raw = query["doc_type"],
                  let docType = DeclarationType(rawValue: raw) else { return nil }
            self = .declaration(docType: docType)
        case "/pages/activity-detail/activity-detail":
            guard allowOnly("labelId"), require("labelId"), let labelId = query["labelId"] else { return nil }
            self = .activityDetail(labelId: labelId)
        case "/pages/workout-detail/workout-detail":
            guard allowOnly("date", "workoutId", "title"), require("date", "workoutId") else { return nil }
            self = .workoutDetail(date: query["date"]!, workoutId: query["workoutId"]!, title: query["title"])
        case "/pages/workout-share/workout-share":
            guard allowOnly("user", "workout"), require("user", "workout") else { return nil }
            self = .workoutShare(user: query["user"]!, workout: query["workout"]!)
        case "/pages/coach-share/coach-share":
            guard allowOnly("sid"), require("sid") else { return nil }
            self = .coachShare(sid: query["sid"]!)
        case "/pages/race-center/strategy-share/strategy-share":
            guard allowOnly("user", "id", "version"), require("user", "id", "version"),
                  let id = Int(query["id"]!), let version = Int(query["version"]!) else { return nil }
            self = .strategyShare(user: query["user"]!, id: id, version: version)
        case "/pages/training-plan/training-plan":
            guard allowOnly() else { return nil }
            self = .trainingPlan
        case "/pages/training-status/training-status":
            guard allowOnly() else { return nil }
            self = .trainingStatus
        case "/pages/race-center/race-center":
            guard allowOnly() else { return nil }
            self = .raceCenter
        case "/pages/race-center/detail":
            guard allowOnly("id"), require("id"), let id = Int(query["id"]!) else { return nil }
            self = .raceDetail(id: id)
        case "/pages/race-center/strategy/strategy":
            guard allowOnly("id", "target"), require("id"), let id = Int(query["id"]!) else { return nil }
            self = .raceStrategy(id: id, target: query["target"])
        case "/pages/my-races/my-races":
            guard allowOnly() else { return nil }
            self = .myRaces
        case "/pages/custom-race-form/custom-race-form":
            guard allowOnly() else { return nil }
            self = .customRaceForm
        case "/pages/feedback/feedback":
            guard allowOnly("tab") else { return nil }
            let tab = query["tab"].flatMap(FeedbackInitialTab.init(rawValue:))
            self = .feedback(initialTab: tab)
        case "/pages/feedback-form/feedback-form":
            guard allowOnly() else { return nil }
            self = .feedbackForm
        case "/pages/feedback-chat/feedback-chat":
            guard allowOnly("id"), require("id") else { return nil }
            self = .feedbackChat(id: query["id"]!)
        case "/pages/product-roadmap/product-roadmap":
            guard allowOnly() else { return nil }
            self = .productRoadmap
        case "/pages/roadmap-detail/roadmap-detail":
            guard allowOnly("id"), require("id"), let id = Int(query["id"]!) else { return nil }
            self = .roadmapDetail(id: id)
        case "/pages/watch/watch":
            guard allowOnly("provider") else { return nil }
            let provider = query["provider"].flatMap(WatchProvider.init(rawValue:))
            self = .watch(provider: provider)
        case "/pages/profile-edit/profile-edit":
            guard allowOnly() else { return nil }
            self = .profileEdit
        case "/pages/privacy/privacy":
            guard allowOnly() else { return nil }
            self = .privacy
        default:
            return nil
        }
    }

    /// queryItems → 字典；重复 key 视为非法输入，返回 nil（白名单语义更严）。
    private static func queryDictionary(_ items: [URLQueryItem]?) -> [String: String]? {
        guard let items, !items.isEmpty else { return [:] }
        var dict: [String: String] = [:]
        for item in items {
            guard dict[item.name] == nil else { return nil }
            dict[item.name] = item.value ?? ""
        }
        return dict
    }
}
