import Foundation
import Observation

// MARK: - 教练对话分享阅读端 ViewModel（devops#718，规格 #758 拍板 2）
//
// loading / ready / expired（410）/ notfound（404）/ error（429 频控、5xx、
// 网络失败可重试）五态；浅色气泡对话流只读 + 策略卡静态摘要降级 + 底部品牌条。

@MainActor
@Observable
public final class CoachShareModel {

    public enum LoadState: Equatable, Sendable {
        case loading
        case ready
        case expired
        case notfound
        case error
    }

    public private(set) var loadState: LoadState = .loading
    /// 顶栏标题：「{sharer_name||TA} 分享的教练对话」。
    public private(set) var title = ""
    /// 顶栏 meta：「10月21日 · 8 条消息」。
    public private(set) var meta = ""
    public private(set) var messages: [CoachShareMessageRow] = []
    /// 码图 URL；空串回退品牌占位块（wxacode fail-soft 可为 null）。
    public private(set) var wxacodeURL = ""

    private let sid: String
    private var app: AppModel?
    private var started = false

    public init(sid: String) {
        self.sid = sid
        if sid.isEmpty {
            loadState = .notfound
        }
    }

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        if loadState != .notfound {
            await load()
        }
    }

    public func load() async {
        guard let app else { return }
        loadState = .loading
        do {
            let res = try await app.api.coachShare(sid: sid)
            // created_at 是 UTC ISO 串，按上海时区取日期（早于 08:00 的分享
            // UTC 日期会差一天，不能用字符串切片）。
            let ymd = shanghaiYmdFromISO(res.createdAt)
            title = "\(res.sharerName ?? "TA") 分享的教练对话"
            meta = "\(ymd.isEmpty ? "" : "\(monthDayLabel(ymd)) · ")\(res.messageCount) 条消息"
            messages = buildCoachShareMessages(res.messages)
            wxacodeURL = res.wxacodeURL ?? ""
            loadState = .ready
        } catch {
            let status = (error as? ApiError)?.statusCode ?? 0
            switch status {
            case 410: loadState = .expired
            case 404: loadState = .notfound
            default: loadState = .error
            }
        }
    }
}

// MARK: - 比赛策略只读分享 ViewModel（#506，规格 #758 拍板 2）
//
// owner+race+version 三元组只读 + 底部 CTA「生成我的比赛策略」（已登录 →
// detail，未登录 → 登录流）；缺参/版本已删 →「该分享已失效」，5xx 可重试。

@MainActor
@Observable
public final class StrategyShareModel {

    public enum LoadState: Equatable, Sendable {
        case loading
        case ready
        case dead
        case error
    }

    public private(set) var loadState: LoadState = .loading
    public private(set) var view: StrategyViewData?
    public private(set) var raceDayText = ""

    private let user: String
    let raceId: Int
    private let versionId: Int

    private var app: AppModel?
    private var started = false

    public init(user: String, id: Int, version: Int) {
        self.user = user
        self.raceId = id
        self.versionId = version
        if user.isEmpty || id <= 0 || version <= 0 {
            loadState = .dead
        }
    }

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        if loadState != .dead {
            await refresh()
        }
    }

    public func refresh() async {
        guard let app else { return }
        loadState = .loading
        do {
            let res = try await app.api.sharedRaceStrategy(user: user, raceId: raceId, versionId: versionId)
            // 服务端对损坏 content 回空对象：缺 pace_segments 就当失效，别白屏。
            guard !res.strategy.content.paceSegments.isEmpty else {
                loadState = .dead
                return
            }
            var view = toStrategyView(res.strategy.content)
            // 赛事名以 race_calendar 行为准：content 里的 race_name 是生成时
            // 的副本，赛事改名后会过期。
            view.raceName = res.race.name
            self.view = view
            raceDayText = raceDayLabel(res.race.raceDate)
            loadState = .ready
        } catch {
            let status = (error as? ApiError)?.statusCode ?? 0
            loadState = (status >= 500 || status == 0) ? .error : .dead
        }
    }

    /// 底部 CTA：已登录跳该赛事详情（策略入口），未登录走现有登录流。
    public func generateTap() {
        guard let app else { return }
        if app.phase == .loggedIn {
            app.router.push(.raceDetail(id: raceId))
        } else {
            app.requestLogin(redirect: .strategyShare(user: user, id: raceId, version: versionId))
        }
    }
}
