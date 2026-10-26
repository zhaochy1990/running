import Foundation
import Testing
@testable import StrideKit

/// 深链 Route 解析单测（验收项：深链 Route 解析单测）。
@Suite struct RouteTests {

    // MARK: - 白名单正向

    @Test func parsesTabRoots() {
        #expect(Route(url: url("/pages/coach/coach")) == .coach)
        #expect(Route(url: url("/pages/activities/activities")) == .activities)
        #expect(Route(url: url("/pages/index/index")) == .trainingHome)
        #expect(Route(url: url("/pages/profile/profile")) == .profile)
    }

    @Test func parsesQueryFaces() {
        #expect(Route(url: url("/pages/activity-detail/activity-detail?labelId=abc")) == .activityDetail(labelId: "abc"))
        #expect(
            Route(url: url("/pages/workout-detail/workout-detail?date=2026-10-26&workoutId=w1&title=课"))
                == .workoutDetail(date: "2026-10-26", workoutId: "w1", title: "课")
        )
        // title 可缺省
        #expect(
            Route(url: url("/pages/workout-detail/workout-detail?date=2026-10-26&workoutId=w1"))
                == .workoutDetail(date: "2026-10-26", workoutId: "w1", title: nil)
        )
        #expect(Route(url: url("/pages/workout-share/workout-share?user=u1&workout=w1")) == .workoutShare(user: "u1", workout: "w1"))
        #expect(Route(url: url("/pages/coach-share/coach-share?sid=s9")) == .coachShare(sid: "s9"))
        #expect(
            Route(url: url("/pages/race-center/strategy-share/strategy-share?user=u1&id=42&version=3"))
                == .strategyShare(user: "u1", id: 42, version: 3)
        )
        #expect(Route(url: url("/pages/race-center/detail?id=7")) == .raceDetail(id: 7))
        #expect(Route(url: url("/pages/race-center/strategy/strategy?id=7&target=3:45:00")) == .raceStrategy(id: 7, target: "3:45:00"))
        #expect(Route(url: url("/pages/race-center/strategy/strategy?id=7")) == .raceStrategy(id: 7, target: nil))
        #expect(Route(url: url("/pages/declaration/declaration?doc_type=user_agreement")) == .declaration(docType: .userAgreement))
        #expect(Route(url: url("/pages/feedback/feedback?tab=roadmap")) == .feedback(initialTab: .roadmap))
        #expect(Route(url: url("/pages/feedback/feedback")) == .feedback(initialTab: nil))
        #expect(Route(url: url("/pages/feedback-chat/feedback-chat?id=88")) == .feedbackChat(id: "88"))
        #expect(Route(url: url("/pages/roadmap-detail/roadmap-detail?id=15")) == .roadmapDetail(id: 15))
        #expect(Route(url: url("/pages/watch/watch?provider=coros")) == .watch(provider: .coros))
        #expect(Route(url: url("/pages/watch/watch")) == .watch(provider: nil))
        #expect(Route(url: url("/pages/login/login")) == .login(redirect: nil))
    }

    @Test func parsesNestedRedirect() {
        let redirect = "/pages/activity-detail/activity-detail?labelId=xyz".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!
        let route = Route(url: url("/pages/login/login?redirect=\(redirect)"))
        #expect(route == .login(redirect: .activityDetail(labelId: "xyz")))
    }

    @Test func pathWithQueryRoundTrips() {
        let samples: [Route] = [
            .coach, .profile, .privacy,
            .activityDetail(labelId: "abc"),
            .workoutDetail(date: "2026-10-26", workoutId: "w1", title: "课"),
            .workoutDetail(date: "d", workoutId: "w", title: nil),
            .workoutShare(user: "u", workout: "w"),
            .coachShare(sid: "s"),
            .strategyShare(user: "u", id: 1, version: 2),
            .raceDetail(id: 7),
            .raceStrategy(id: 7, target: "3:45"),
            .raceStrategy(id: 7, target: nil),
            .declaration(docType: .privacyPolicy),
            .feedback(initialTab: .roadmap),
            .feedback(initialTab: nil),
            .feedbackChat(id: "88"),
            .roadmapDetail(id: 15),
            .watch(provider: .garmin),
            .watch(provider: nil),
        ]
        for route in samples {
            #expect(Route(url: url(route.pathWithQuery)) == route, "往返失败：\(route.pathWithQuery)")
        }
    }

    // MARK: - 公开落地页

    @Test func publicLandingIsTheThreeSharePages() {
        #expect(Route.workoutShare(user: "u", workout: "w").isPublicLanding)
        #expect(Route.coachShare(sid: "s").isPublicLanding)
        #expect(Route.strategyShare(user: "u", id: 1, version: 2).isPublicLanding)
        #expect(!Route.coach.isPublicLanding)
        #expect(!Route.activityDetail(labelId: "a").isPublicLanding)
    }

    // MARK: - 拒绝面（sanitizeRedirect 等价更严）

    @Test func rejectsUnknownPage() {
        #expect(Route(url: url("/pages/plan/plan")) == nil)          // 死页不迁
        #expect(Route(url: url("/pages/health/health")) == nil)      // 死页不迁
        #expect(Route(url: url("/pages/nonexistent/page")) == nil)
        #expect(Route(url: url("https://evil.example.com/phish")) == nil)
    }

    @Test func invalidRedirectShapesAreDroppedNotFollowed() {
        // redirect 形状非法/指向白名单外 → 丢弃 redirect（sanitizeRedirect 返回空串
        // 的等价语义），绝不回跳外部地址；页面本身仍可解析
        #expect(Route(url: url("/pages/login/login?redirect=https:%2F%2Fevil.com")) == .login(redirect: nil))
        #expect(Route(url: url("/pages/login/login?redirect=%2F%2Fevil.com")) == .login(redirect: nil))
        #expect(Route(url: url("/pages/login/login?redirect=%2Fpages%2Fplan%2Fplan")) == .login(redirect: nil))
    }

    @Test func rejectsBadParams() {
        // 缺必填
        #expect(Route(url: url("/pages/activity-detail/activity-detail")) == nil)
        #expect(Route(url: url("/pages/race-center/detail")) == nil)
        // 非法必填枚举 → 整体 nil
        #expect(Route(url: url("/pages/declaration/declaration?doc_type=other")) == nil)
        // 非法可选枚举 → 忽略该参数（沿小程序 options 容错语义：provider/tab
        // 取值不认识即不预选，不废掉整个路由）
        #expect(Route(url: url("/pages/watch/watch?provider=suunto")) == .watch(provider: nil))
        #expect(Route(url: url("/pages/feedback/feedback?tab=other")) == .feedback(initialTab: nil))
        // 非整数 id
        #expect(Route(url: url("/pages/race-center/detail?id=abc")) == nil)
        // 未知参数（白名单语义）
        #expect(Route(url: url("/pages/coach/coach?x=1")) == nil)
        #expect(Route(url: url("/pages/race-center/detail?id=1&extra=2")) == nil)
        // 空 query 值
        #expect(Route(url: url("/pages/coach-share/coach-share?sid=")) == nil)
        // 重复 key
        #expect(Route(url: url("/pages/race-center/detail?id=1&id=2")) == nil)
    }

    // MARK: - 深链落点填根

    @Test func homeTabMapping() {
        #expect(Route.activityDetail(labelId: "a").homeTab == .activities)
        #expect(Route.workoutDetail(date: "d", workoutId: "w", title: nil).homeTab == .training)
        #expect(Route.raceCenter.homeTab == .profile)
        #expect(Route.feedbackChat(id: "1").homeTab == .profile)
        #expect(Route.workoutShare(user: "u", workout: "w").homeTab == .coach)
    }

    private func url(_ pathAndQuery: String) -> URL {
        URL(string: "https://stride-running.cn\(pathAndQuery)")!
    }
}
