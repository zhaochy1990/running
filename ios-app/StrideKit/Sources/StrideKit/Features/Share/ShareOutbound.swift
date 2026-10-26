import Foundation

// PR-8 分享出向（devops#771）：ShareLink 出向矩阵的链接与文案收口。
//
// 链接（#758 拍板 1 + #762 方案，PR-9 双链配套）：全部走裸域分流页
// `https://stride-running.cn/s/<小程序页路径>?query` —— 微信内经 mp-link 换
// URL Link 直达小程序对应页，其他环境由 Universal Link 唤起 App（AASA
// components=["/s/*"]），未安装落下载卡片。页路径与 query 复用 Route 白名单
// 表（pagePath + queryItems 互逆），单一事实源；分享回流经 `Route(url:)`
// 同表解析（/s/ 前缀由分流页剥掉后再回 App/小程序）。
//
// 文案品牌口径（#771）：StrideWise 拉丁优先，文案不提 AI / 教练。

/// 出向链接构造（D-share-1：单一路分享，universal link 承载）。
public enum ShareOutbound {

    /// 生产裸域（与 `APIConfig.shareBaseURL` 默认值同源；无 config 注入的
    /// 调用方兜底）。
    public static let productionBase = URL(string: "https://stride-running.cn")!

    /// 分流页链接：`<shareBaseURL>/s<pagePath>?query`（pagePath 以 / 开头）。
    public static func link(base: URL, route: Route) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/s" + route.pagePath
        let items = route.queryItems
        if !items.isEmpty {
            components.queryItems = items
        }
        return components.url!
    }

    /// `link(base: productionBase, route:)`。
    public static func link(route: Route) -> URL {
        link(base: productionBase, route: route)
    }
}

/// 分享文案（各页 onShareAppMessage 标题的品牌口径直译）。
public enum ShareCopy {

    /// 默认品牌卡（utils/share.ts DEFAULT_SHARE_TITLE「砺跑 · 马拉松训练助手」
    /// 的 StrideWise 拉丁优先版）。
    public static let app = "StrideWise · 马拉松训练助手"

    /// 赛事中心（race-center.ts onShareAppMessage）。
    public static let raceCenter = "StrideWise · 全年路跑赛事日历"

    /// 赛事详情：`<名> · <2026-11-01> 开跑`；无日期只留名，无名回落「赛事详情」
    ///（detail.ts onShareAppMessage）。
    public static func raceDetail(name: String, date: String?) -> String {
        guard let date, !date.isEmpty else { return name.isEmpty ? "赛事详情" : name }
        return "\(name) · \(date) 开跑"
    }

    /// 教练多选转发：`<昵称> 与 StrideWise 的对话 · N 条`，无昵称
    /// 「我与 StrideWise 的对话 · N 条」（coach.ts createSelectedShare；
    /// 昵称去空白截 64 字）。
    public static func coachConversation(sharerName: String?, count: Int) -> String {
        let trimmed = sharerName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty {
            return "\(trimmed.prefix(64)) 与 StrideWise 的对话 · \(count) 条"
        }
        return "我与 StrideWise 的对话 · \(count) 条"
    }

    /// 自建课分享（workout-detail.ts onShareAppMessage：title=课名，空回落
    /// 「训练课表」）。
    public static func workout(name: String) -> String {
        name.isEmpty ? "训练课表" : name
    }

    /// 自建课封面品牌 label（workout-detail 封面「砺跑 · 自建课表」的拉丁优先版）。
    public static let workoutCoverBrand = "StrideWise · 自建课表"
}
