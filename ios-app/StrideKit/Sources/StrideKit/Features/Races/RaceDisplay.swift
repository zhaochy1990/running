import Foundation

// 赛事中心 / 详情的纯视图变换（devops#769，PR-6）—— 直译小程序
// utils/raceCenterRows.ts / raceDetailRows.ts / raceCourse.ts /
// racePlanRows.ts / myRaceRows.ts / raceResultRows.ts 的确定性变换面。
// 页面只做请求与交互；这里不依赖 SwiftUI，单测直接覆盖。

// MARK: - 徽章与缩写（raceCenterRows）

/// 田协认证值 → 徽章全称；nil 与未知取值返回 ''（不编造认证）。
public func cnBadge(_ label: String?) -> String {
    let badges = [
        "A": "中国田协A类赛事",
        "B": "中国田协B类赛事",
        "C": "中国田协C类赛事",
        "C（属地办赛）": "中国田协C类（属地办赛）",
        "系列赛": "中国田协系列赛",
    ]
    guard let label else { return "" }
    return badges[label] ?? ""
}

/// 世界田联标牌值 → 徽章全称；nil 与未知取值返回 ''。
public func waBadge(_ waLabel: String?) -> String {
    let badges = [
        "Gold": "世界田联金标",
        "Platinum": "世界田联白金标",
        "Label": "世界田联标牌",
        "Elite": "世界田联精英标",
    ]
    guard let waLabel else { return "" }
    return badges[waLabel] ?? ""
}

/// 项目 token → 密表缩写：{n}Km 压成 {n}K；未知返回 ''。
public func typeAbbr(_ token: String) -> String {
    if token == "Marathon" { return "全马" }
    if token == "HalfMarathon" { return "半马" }
    if let m = token.range(of: #"^(\d+(?:\.\d+)?)Km$"#, options: .regularExpression) {
        return String(token[m]).replacingOccurrences(of: "Km", with: "K")
    }
    return ""
}

/// 一行密表的渲染模型（全部字段预格式化）。
public struct RaceRowView: Equatable, Identifiable, Sendable {
    public let id: Int
    /// MM/DD
    public let dateLabel: String
    /// 周五
    public let weekday: String
    public let name: String
    /// '' = 隐藏
    public let cnBadgeText: String
    public let waBadgeText: String
    /// 项目缩写序列（全马/半马）；无已知项目 '—'。
    public let typesLabel: String
    public let city: String
    public let starred: Bool
}

/// 月份分组：一组一个头。
public struct RaceMonthGroup: Equatable, Identifiable, Sendable {
    /// YYYY-MM
    public let key: String
    /// 10月
    public let label: String
    public var rows: [RaceRowView]

    public var id: String { key }
}

public struct RaceFilter: Sendable {
    /// racetypes token；''=全部
    public var type: String
    public var favoritesOnly: Bool

    public init(type: String = "", favoritesOnly: Bool = false) {
        self.type = type
        self.favoritesOnly = favoritesOnly
    }
}

/// 列表行 → 渲染模型。
public func toRaceRowView(_ r: RaceCalendarRace) -> RaceRowView {
    let abbrs = r.raceTypes.map(typeAbbr).filter { !$0.isEmpty }
    return RaceRowView(
        id: r.id,
        dateLabel: String(r.raceDate.dropFirst(5)).replacingOccurrences(of: "-", with: "/"),
        weekday: Shanghai.weekdayLabel(r.raceDate),
        name: r.nameCn ?? r.name,
        cnBadgeText: cnBadge(r.label),
        waBadgeText: waBadge(r.waLabel),
        typesLabel: abbrs.isEmpty ? "—" : abbrs.joined(separator: "/"),
        city: r.city ?? "—",
        starred: r.favorited
    )
}

/// 客户端筛选：type 匹配事件的 race_types；省份/年份走服务端参数。
public func filterRaces(_ races: [RaceCalendarRace], _ f: RaceFilter) -> [RaceCalendarRace] {
    races.filter { r in
        if f.favoritesOnly && !r.favorited { return false }
        if !f.type.isEmpty && !r.raceTypes.contains(f.type) { return false }
        return true
    }
}

/// 按比赛日升序分组（API 本身已排序，这里防御性重排）。
public func groupByMonth(_ races: [RaceCalendarRace]) -> [RaceMonthGroup] {
    let sorted = races.sorted { a, b in
        a.raceDate == b.raceDate ? a.id < b.id : a.raceDate < b.raceDate
    }
    var groups: [RaceMonthGroup] = []
    for r in sorted {
        let ym = String(r.raceDate.prefix(7))
        if let last = groups.last, last.key == ym {
            groups[groups.count - 1].rows.append(toRaceRowView(r))
        } else {
            let month = Int(ym.suffix(2)) ?? 0
            groups.append(RaceMonthGroup(key: ym, label: "\(month)月", rows: [toRaceRowView(r)]))
        }
    }
    return groups
}

/// 年份选项：当前上海年份 ±1。
public func raceYearOptions(now: Date = Date()) -> [String] {
    let y = Int(Shanghai.todayYMD(now: now).prefix(4)) ?? 2026
    return [String(y - 1), String(y), String(y + 1)]
}

/// 全国省级行政区静态列表（服务端精确匹配的原文口径，不随后端数据渲染）。
public let raceProvinces: [String] = [
    "北京市", "上海市", "天津市", "重庆市", "河北省", "山西省", "辽宁省", "吉林省",
    "黑龙江省", "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省", "河南省",
    "湖北省", "湖南省", "广东省", "海南省", "四川省", "贵州省", "云南省", "陕西省",
    "甘肃省", "青海省", "台湾省", "内蒙古自治区", "广西壮族自治区", "西藏自治区",
    "宁夏回族自治区", "新疆维吾尔自治区", "香港特别行政区", "澳门特别行政区",
]

/// 筛选栏的项目类型选项：''=全部。
public let raceTypeOptions: [(label: String, token: String)] = [
    ("全部", ""),
    ("全马", "Marathon"),
    ("半马", "HalfMarathon"),
    ("10K", "10Km"),
]

/// 赛事中心整年翻页上限：50 页 × 100 = 5000 场，防 total 异常时死循环。
public let raceCalendarMaxPages = 50

// MARK: - 详情头区/时间轴/概要（raceDetailRows）

/// YYYY-MM-DD 间隔天数：比赛日当天 = 0，已结束为负（上海时区口径）。
public func daysUntil(raceDate: String, today: String) -> Int {
    Shanghai.daysBetween(fromYMD: today, toYMD: raceDate) ?? 0
}

/// 三宫格一格：lead = 主强调色（仅未开赛倒计时）。
public struct RaceHeadCell: Equatable, Sendable {
    public let value: String
    public let label: String
    public let lead: Bool
}

/// 报名时间轴一步。
public struct RaceTimelineStep: Equatable, Identifiable, Sendable {
    public let key: String
    public var id: String { key }
    public let date: String
    public let label: String
    /// 完成态按今天计算。
    public let done: Bool
}

/// 头区渲染模型：timeline 为空 = 整条隐藏。
public struct RaceDetailHead: Equatable, Sendable {
    public let name: String
    public let cnBadgeText: String
    public let waBadgeText: String
    public let grid: [RaceHeadCell]
    public let timeline: [RaceTimelineStep]
}

/// 键值行。
public struct RaceKvRow: Equatable, Identifiable, Sendable {
    public let k: String
    public let v: String
    public var id: String { k }
}

/// 报名渠道行：copyUrl 非空才有「复制链接」。
public struct RaceChannelRow: Equatable, Identifiable, Sendable {
    public let key: String
    public var id: String { key }
    public let name: String
    public let type: String
    public let copyUrl: String
}

/// 项目一节：entry 行 + 赛道文字。
public struct RaceItemSection: Equatable, Identifiable, Sendable {
    public let id: Int
    public let title: String
    public let rows: [RaceKvRow]
    public let route: String
}

/// 出行 tab：领物 + 城市介绍。
public struct RaceTripView: Equatable, Sendable {
    public struct Pickup: Equatable, Identifiable, Sendable {
        public let key: String
        public var id: String { key }
        public let time: String
        public let location: String
    }

    public struct City: Equatable, Sendable {
        public let title: String
        public let paragraphs: [RaceKvRow]
        public let attractions: [RaceAttraction]
    }

    public let pickups: [Pickup]
    public let city: City?
}

/// 赛道 tab 投影：available=false（无任何赛道内容）时 tab 缺席，页面回落三 tab。
public struct RaceCourseContent: Equatable, Sendable {
    public let available: Bool
    public let sections: [RaceCourseSection]
}

/// 详情页整体视图模型。
public struct RaceDetailViewData: Equatable, Sendable {
    public let head: RaceDetailHead
    public let summary: [RaceKvRow]
    public let channels: [RaceChannelRow]
    public let items: [RaceItemSection]
    public let trip: RaceTripView
    public let course: RaceCourseContent
}

/// YYYY-MM-DD → 'M/D'（去前导零）；非法/空 → '待公布'。
private func mdLabel(_ ymd: String?) -> String {
    guard let ymd, ymd.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return "待公布" }
    let month = Int(ymd.dropFirst(5).prefix(2)) ?? 0
    let day = Int(ymd.suffix(2)) ?? 0
    return "\(month)/\(day)"
}

/// 报名费分 → 元标签；nil/非正数 = 待定。
private func feeLabel(_ fen: Int?) -> String {
    guard let fen, fen > 0 else { return "待定" }
    let yuan = Double(fen) / 100
    return yuan == yuan.rounded() ? "¥\(Int(yuan))" : String(format: "¥%.2f", yuan)
}

/// 各项目发枪时间里最早的一个（HH:MM 字典序即时间序）；没有 = ''。
public func firstStartTime(_ items: [RaceItem]) -> String {
    let times = items.compactMap(\.startTime).filter { !$0.isEmpty }.sorted()
    return times.first ?? ""
}

private func headGrid(_ detail: RaceDetail, today: String) -> [RaceHeadCell] {
    let days = daysUntil(raceDate: detail.raceDate, today: today)
    let countCell: RaceHeadCell
    if days > 0 {
        countCell = RaceHeadCell(value: String(days), label: "天后开赛", lead: true)
    } else if days == 0 {
        countCell = RaceHeadCell(value: "今天", label: "开赛", lead: false)
    } else {
        countCell = RaceHeadCell(value: "已结束", label: "", lead: false)
    }
    let start = firstStartTime(detail.items)
    let dayCell = RaceHeadCell(
        value: String(detail.raceDate.dropFirst(5)).replacingOccurrences(of: "-", with: "/"),
        label: start.isEmpty ? "比赛日" : "比赛日 \(start)",
        lead: false
    )
    let format = detail.signupTimeline.map { $0.lottery ? "抽签" : "先到先得" } ?? "待定"
    return [countCell, dayCell, RaceHeadCell(value: format, label: "报名制式", lead: false)]
}

/// 报名时间轴：报名开始 → 截止 → 出签·缴费 → 开赛；非抽签且无缴费截止收成三步。
private func timelineSteps(_ detail: RaceDetail, today: String) -> [RaceTimelineStep] {
    guard let t = detail.signupTimeline else { return [] }
    let drawAt = t.lotteryResultAt ?? t.paymentDeadline
    let defs: [(key: String, label: String, date: String?)] = [
        ("start", "报名开始", t.startAt),
        ("deadline", "报名截止", t.deadline),
        ("draw", t.lottery ? "出签·缴费" : "缴费截止", drawAt),
        ("race", "开赛", detail.raceDate),
    ]
    return defs
        .filter { $0.key != "draw" || t.lottery || (t.paymentDeadline != nil) }
        .map { d in
            let ok = d.date.map { $0.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil } ?? false
            return RaceTimelineStep(key: d.key, date: mdLabel(d.date), label: d.label, done: ok && d.date! <= today)
        }
}

private func summaryRows(_ detail: RaceDetail) -> [RaceKvRow] {
    let weekday = Shanghai.weekdayLabel(detail.raceDate)
    let place = [detail.province, detail.city].compactMap { $0 }.joined()
    let startName = detail.items.first(where: { $0.startPoint?.name != nil })?.startPoint?.name
    let placeLine = [place, startName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    let badges = [cnBadge(detail.label), waBadge(detail.waLabel)].filter { !$0.isEmpty }
    let quotas = detail.items.compactMap { $0.quota }.filter { $0 > 0 }
    let scale = quotas.isEmpty ? "待定" : "\(quotas.reduce(0, +)) 人"
    let start = firstStartTime(detail.items)
    let itemNames = detail.items.map(\.name)
    return [
        RaceKvRow(k: "比赛日", v: weekday.isEmpty ? detail.raceDate : "\(detail.raceDate) \(weekday)"),
        RaceKvRow(k: "起跑时间", v: start.isEmpty ? "待定" : start),
        RaceKvRow(k: "地点", v: placeLine.isEmpty ? "待定" : placeLine),
        RaceKvRow(k: "认证", v: badges.isEmpty ? "—" : badges.joined(separator: " · ")),
        RaceKvRow(k: "项目", v: itemNames.isEmpty ? "—" : itemNames.joined(separator: " / ")),
        RaceKvRow(k: "规模", v: scale),
    ]
}

private func channelRows(_ detail: RaceDetail) -> [RaceChannelRow] {
    (detail.signupChannels ?? []).enumerated().map { i, c in
        RaceChannelRow(
            key: String(i),
            name: c.name,
            type: c.type,
            copyUrl: (c.urlType == "web" && c.url != nil) ? c.url! : ""
        )
    }
}

private func itemSection(_ it: RaceItem) -> RaceItemSection {
    let ends = [it.startPoint?.name, it.finishPoint?.name].compactMap { $0 }.filter { !$0.isEmpty }
    let quota = (it.quota != nil && it.quota! > 0) ? "\(it.quota!) 人" : "待定"
    return RaceItemSection(
        id: it.id,
        title: it.name,
        rows: [
            RaceKvRow(k: "距离", v: it.distanceKm != nil ? "\(Fmt.autoStr(it.distanceKm)) km" : "待定"),
            RaceKvRow(k: "名额", v: quota),
            RaceKvRow(k: "起终点", v: ends.isEmpty ? "待定" : ends.joined(separator: " → ")),
            RaceKvRow(k: "发枪", v: it.startTime?.isEmpty == false ? it.startTime! : "待定"),
            RaceKvRow(k: "报名费", v: feeLabel(it.entryFee)),
        ],
        route: it.routeDescription ?? ""
    )
}

private func tripView(_ detail: RaceDetail) -> RaceTripView {
    var cityView: RaceTripView.City?
    if let city = detail.cityContent {
        var paragraphs: [RaceKvRow] = []
        if let intro = city.intro {
            let pairs = [("概览", intro.overview), ("人文", intro.culture), ("美食", intro.food), ("历史", intro.history)]
            paragraphs = pairs.filter { !$0.1.isEmpty }.map { RaceKvRow(k: $0.0, v: $0.1) }
        }
        cityView = RaceTripView.City(
            title: "城市 · \(city.city)",
            paragraphs: paragraphs,
            attractions: city.attractions ?? []
        )
    }
    return RaceTripView(
        pickups: (detail.packetPickup ?? []).enumerated().map { i, p in
            RaceTripView.Pickup(key: String(i), time: p.time, location: p.location)
        },
        city: cityView
    )
}

/// 详情数据 → 页面渲染模型；today 注入以便单测可复现。
public func toRaceDetailView(_ detail: RaceDetail, today: String) -> RaceDetailViewData {
    let sections = detail.items.compactMap(toCourseSection)
    return RaceDetailViewData(
        head: RaceDetailHead(
            name: detail.nameCn ?? detail.name,
            cnBadgeText: cnBadge(detail.label),
            waBadgeText: waBadge(detail.waLabel),
            grid: headGrid(detail, today: today),
            timeline: timelineSteps(detail, today: today)
        ),
        summary: summaryRows(detail),
        channels: channelRows(detail),
        items: detail.items.map(itemSection),
        trip: tripView(detail),
        course: RaceCourseContent(available: !sections.isEmpty, sections: sections)
    )
}

// MARK: - 赛道沿线（raceCourse）

/// 赛道沿线一个难点「站点」。
public struct CourseStation: Equatable, Identifiable, Sendable {
    public let key: String
    public var id: String { key }
    /// 类别名（已剥【x】前缀；未知前缀保留原文，配色回退灰）。
    public let cat: String
    /// 类别主题色（hex），未知类别回退灰。
    public let colorHex: UInt32
    /// distance_km 原文（nil →「全段」）。
    public let km: String
    /// 短标题（正文首个分隔符前的主干，剥前导公里段）。
    public let title: String
    /// 展开后的全文。
    public let body: String
    /// 纵向位置（pt）：公里差只保留节奏感，夹紧防大空档。
    public let top: Double
}

/// 赛道 tab 一个项目一节。
public struct RaceCourseSection: Equatable, Identifiable, Sendable {
    public let id: Int
    public let title: String
    /// 路线文字；'' = 待补。
    public let route: String
    /// 累计爬升（米）；nil = 未录。
    public let ascent: String?
    /// 项目距离（km）；nil = 未录。
    public let distanceKm: Double?
    public let stations: [CourseStation]
}

/// 相邻站点间距（pt）：下限 ≈ 收起卡高，上限封顶。
private let courseGapMin: Double = 48
private let courseGapMax: Double = 100
private let courseGapPerPct: Double = 1.5

/// 类别 → 主题色。
private let courseCategoryColors: [String: UInt32] = [
    "坡道": 0xFF9F0A,
    "桥梁": 0x8FB8E8,
    "隧道": 0xB98FE8,
    "拥堵": 0xFF6363,
    "折返": 0xE8C07D,
    "立交": 0x63D0C8,
    "风": 0x9EE6B8,
    "其他": 0x9C9C9D,
]

private let courseFallbackColor: UInt32 = 0x9C9C9D

/// 【x】前缀 → 类别名 + 正文（无前缀归「其他」）。
private func splitCategory(_ description: String) -> (cat: String, body: String) {
    guard let m = description.range(of: #"^【(.+?)】\s*"#, options: .regularExpression) else {
        return ("其他", description)
    }
    let body = String(description[m.upperBound...])
    let bracketed = String(description[m.lowerBound..<m.upperBound]) // 【x】
    return (String(bracketed.dropFirst().dropLast()), body.isEmpty ? description : body)
}

/// 自由文本公里段 → [起点km, 终点km]；区间与单点都吃下，解析不出 → nil。
public func parseCourseKm(_ text: String?) -> (start: Double, end: Double)? {
    guard let text, !text.isEmpty else { return nil }
    let pattern = #"(\d+(?:\.\d+)?)(?:\s*[–—\-~]\s*(\d+(?:\.\d+)?))?"#
    guard let re = try? NSRegularExpression(pattern: pattern),
          let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
          let r1 = Range(m.range(at: 1), in: text),
          let start = Double(text[r1]) else { return nil }
    var end = start
    if let r2 = Range(m.range(at: 2), in: text), let v = Double(text[r2]) {
        end = v
    }
    return (start, end)
}

/// 站点短标题：剥前导公里段 → 取首个分隔符前主干 → 截 16 字。
public func courseStationTitle(_ body: String) -> String {
    var stripped = body
    if let m = stripped.range(of: #"^\s*\d+(?:\.\d+)?(?:\s*[–—\-~]\s*\d+(?:\.\d+)?)?\s*km?\s*"#, options: .regularExpression) {
        stripped = String(stripped[m.upperBound...])
    }
    let head = stripped.split(whereSeparator: { "：:（(；;，,".contains($0) }).first.map(String.init) ?? stripped
    var title = head.trimmingCharacters(in: .whitespaces)
    if title.count > 16 {
        title = String(title.prefix(16)) + "…"
    }
    return title.isEmpty ? String(body.prefix(16)) : title
}

/// 一个项目的赛道节；无路线且无难点 → nil（tab 缺席依据）。
public func toCourseSection(_ item: RaceItem) -> RaceCourseSection? {
    let route = item.routeDescription ?? ""
    let rows = item.courseChallenges ?? []
    if route.isEmpty && rows.isEmpty { return nil }

    struct Parsed {
        let cat: String
        let body: String
        let colorHex: UInt32
        let km: String
        let range: (start: Double, end: Double)?
        let seq: Int
    }

    let parsed = rows.enumerated().map { i, row -> Parsed in
        let (cat, body) = splitCategory(row.description)
        return Parsed(
            cat: cat,
            body: body,
            colorHex: courseCategoryColors[cat] ?? courseFallbackColor,
            km: (row.distanceKm?.isEmpty == false) ? row.distanceKm! : "全段",
            range: parseCourseKm(row.distanceKm),
            seq: i
        )
    }
    .sorted { a, b in
        let ka = a.range?.start ?? .greatestFiniteMagnitude
        let kb = b.range?.start ?? .greatestFiniteMagnitude
        return ka == kb ? a.seq < b.seq : ka < kb
    }

    let distanceKm = (item.distanceKm != nil && item.distanceKm! > 0) ? item.distanceKm : nil
    func toPct(_ km: Double) -> Double {
        guard let distanceKm, distanceKm > 0 else { return 0 }
        return min(max(0, km / distanceKm * 100), 100)
    }

    var y: Double = 0
    var prevPct: Double?
    var stations: [CourseStation] = []
    for (i, p) in parsed.enumerated() {
        let pct = (p.range != nil && distanceKm != nil) ? toPct(p.range!.start) : 100
        if let prev = prevPct {
            y += min(courseGapMax, courseGapMin + max(0, pct - prev) * courseGapPerPct)
        }
        prevPct = pct
        stations.append(CourseStation(
            key: "\(item.id):\(i)",
            cat: p.cat,
            colorHex: p.colorHex,
            km: p.km,
            title: courseStationTitle(p.body),
            body: p.body,
            top: y
        ))
    }

    return RaceCourseSection(
        id: item.id,
        title: item.name,
        route: route,
        ascent: item.totalAscentM.map(String.init),
        distanceKm: distanceKm,
        stations: stations
    )
}

// MARK: - 报名选择器词表（raceDetailRows 下半）

/// 五态报名状态 → 中文标签。
public func racePlanStateLabel(_ state: RacePlanState) -> String {
    switch state {
    case .want: "想报名"
    case .registered: "已报名（等抽签）"
    case .won: "已中签"
    case .lost: "未中签"
    case .confirmed: "确认参赛"
    }
}

/// 选择器的状态选项；'none' = 未报名 · 取消追踪（删计划）。
public let racePlanStateOptions: [(value: String, label: String)] = [
    ("none", "未报名 · 取消追踪"),
    ("want", racePlanStateLabel(.want)),
    ("registered", racePlanStateLabel(.registered)),
    ("won", racePlanStateLabel(.won)),
    ("lost", racePlanStateLabel(.lost)),
    ("confirmed", racePlanStateLabel(.confirmed)),
]

/// 报名项目 chip：项目 token 去重；typeAbbr 不认识的 token 回落项目名。
public struct RaceChip: Equatable, Identifiable, Sendable {
    public let token: String
    public let label: String
    public var id: String { token }
}

public func itemChips(_ items: [RaceItem]) -> [RaceChip] {
    var seen: [String: String] = [:]
    for it in items where seen[it.type] == nil {
        let abbr = typeAbbr(it.type)
        seen[it.type] = abbr.isEmpty ? it.name : abbr
    }
    return seen.map { RaceChip(token: $0.key, label: $0.value) }
}

/// 报名按钮文案：'未报名' 或 '全马 · 想报名'。
public func planButtonLabel(itemType: String, state: RacePlanState?) -> String {
    guard let state else { return "未报名" }
    let abbr = typeAbbr(itemType)
    return "\(abbr.isEmpty ? itemType : abbr) · \(racePlanStateLabel(state))"
}
