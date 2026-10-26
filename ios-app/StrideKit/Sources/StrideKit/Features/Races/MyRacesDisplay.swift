import Foundation

// 「我的比赛」的纯视图模型（devops#769）—— 直译小程序 utils/racePlanRows.ts /
// myRaceRows.ts / raceResultRows.ts：官方计划卡 / 自定义卡 / 混排行 / 成绩行
// / PB 判定 / 自定义表单类型词表与校验。

// MARK: - 官方计划卡（racePlanRows）

/// 状态全称（卡头徽章）；chip 用短名（去掉「· 等抽签」尾缀）。
public func planStateLabel(_ state: RacePlanState) -> String {
    switch state {
    case .want: "想报名"
    case .registered: "已报名 · 等抽签"
    case .won: "已中签"
    case .lost: "未中签"
    case .confirmed: "确认参赛"
    }
}

/// 状态条四态流转序列（未中签是旁路状态，不进 chips）。
public let planStateFlow: [RacePlanState] = [.want, .registered, .won, .confirmed]

/// 官方计划卡的渲染模型（全部字段预格式化）。
public struct PlanCardView: Equatable, Identifiable, Sendable {
    /// 一人一赛一计划，raceId 即唯一。
    public var id: Int { raceId }
    public var raceId: Int
    /// 赛事投影被物理删除时回落占位文案。
    public var name: String
    /// 报名项目缩写；未知 token '—'。
    public var itemLabel: String
    /// racetypes token 原文（回写 upsert 必带）。
    public var itemToken: String
    public var state: RacePlanState
    public var stateLabel: String
    /// `2026/11/01 周日`；无日期 ''。
    public var dateLabel: String
    public var city: String
    /// 倒计时文案；已结束/无日期 ''。
    public var countdown: String
    /// 状态条 chips。
    public var steps: [PlanStateChip]
    /// 未中签旁路：给「去找替代赛事」引导。
    public var lost: Bool
    public var hotel: Bool
    public var transit: Bool
    public var offboarded: Bool
}

public struct PlanStateChip: Equatable, Identifiable, Sendable {
    public var id: String { state.rawValue }
    public let state: RacePlanState
    public let label: String
    public let on: Bool
}

/// 状态切换后卡片的可变部分：乐观更新与失败回滚共用，与 toPlanCard 同源。
public func planStatePatch(_ state: RacePlanState) -> (state: RacePlanState, stateLabel: String, steps: [PlanStateChip], lost: Bool) {
    (
        state,
        planStateLabel(state),
        planStateFlow.map { s in
            PlanStateChip(state: s, label: planStateLabel(s).replacingOccurrences(of: " · 等抽签", with: ""), on: s == state)
        },
        state == .lost
    )
}

/// YYYY-MM-DD → `2026/11/01 周日`（官方计划卡与自定义卡共用）。
public func planDateLabel(_ ymd: String) -> String {
    let weekday = Shanghai.weekdayLabel(ymd)
    guard ymd.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return ymd }
    let label = "\(ymd.prefix(4))/\(ymd.dropFirst(5).replacingOccurrences(of: "-", with: "/"))"
    return weekday.isEmpty ? label : "\(label) \(weekday)"
}

/// 开赛倒计时文案；nil（无日期）/负数（已结束）不给文案。
public func countdownLabel(_ days: Int?) -> String {
    guard let days, days >= 0 else { return "" }
    return days > 0 ? "距离比赛还有 \(days) 天" : "今天开赛"
}

public func toPlanCard(_ plan: RacePlan, today: String) -> PlanCardView {
    let abbr = typeAbbr(plan.itemType)
    let patch = planStatePatch(plan.state)
    return PlanCardView(
        raceId: plan.raceId,
        name: plan.race?.nameCn ?? plan.race?.name ?? "已下架赛事",
        itemLabel: abbr.isEmpty ? "—" : abbr,
        itemToken: plan.itemType,
        state: patch.state,
        stateLabel: patch.stateLabel,
        dateLabel: plan.race.map { planDateLabel($0.raceDate) } ?? "",
        city: plan.race?.city ?? "",
        countdown: countdownLabel(plan.race.map { daysUntil(raceDate: $0.raceDate, today: today) }),
        steps: patch.steps,
        lost: patch.lost,
        hotel: plan.hotel,
        transit: plan.transit,
        offboarded: plan.offboarded
    )
}

// MARK: - 自定义卡与混排（myRaceRows）

/// 表单 chips 与卡面徽章共用的七值类型词表（自定义卡用全名，密表缩写另表）。
public let customTypeChips: [(token: String, label: String)] = [
    ("Marathon", "马拉松"),
    ("HalfMarathon", "半马"),
    ("10Km", "10K"),
    ("5Km", "5K"),
    ("Trail", "越野跑"),
    ("Ultra", "超长越野"),
    ("Other", "其他"),
]

public func customTypeLabel(_ token: String) -> String {
    customTypeChips.first(where: { $0.token == token })?.label ?? token
}

func customStateLabel(_ state: CustomRaceState) -> String {
    state == .want ? "想跑" : "已报名"
}

/// 自定义比赛卡的渲染模型。
public struct CustomCardView: Equatable, Identifiable, Sendable {
    public var id: Int { rowId }
    public var rowId: Int
    public var name: String
    /// 类型（距离）徽章。
    public var badgeLabel: String
    public var state: CustomRaceState
    /// done 时「已结束」。
    public var stateLabel: String
    /// 状态 chips；done 时空。
    public var steps: [CustomStateChip]
    /// 日期 · 城市 · 爬升，缺项省略。
    public var metaLabel: String
    public var countdown: String
    public var done: Bool
    public var note: String
}

public struct CustomStateChip: Equatable, Identifiable, Sendable {
    public var id: String { state.rawValue }
    public let state: CustomRaceState
    public let label: String
    public let on: Bool
}

/// 状态切换后自定义卡的可变部分（乐观补丁）。
public func customStatePatch(_ state: CustomRaceState) -> (state: CustomRaceState, stateLabel: String, steps: [CustomStateChip]) {
    (
        state,
        customStateLabel(state),
        [CustomRaceState.want, .registered].map { s in
            CustomStateChip(state: s, label: customStateLabel(s), on: s == state)
        }
    )
}

public func toCustomCard(_ race: CustomRace, today: String) -> CustomCardView {
    let typeLabel = customTypeLabel(race.itemType)
    let dist: String
    if let km = race.distanceKm {
        dist = km == km.rounded() ? "\(Int(km))K" : String(format: "%.1fK", km)
    } else {
        dist = ""
    }
    let base = customStatePatch(race.state)
    var meta = [planDateLabel(race.raceDate), race.city].filter { !$0.isEmpty }
    if let ascent = race.ascentM { meta.append("爬升 D+\(ascent)m") }
    return CustomCardView(
        rowId: race.id,
        name: race.name,
        // 类型名已含距离数字且一致时不重复拼（10Km+10 → 10K）。
        badgeLabel: (!dist.isEmpty && dist != typeLabel) ? "\(typeLabel) \(dist)" : typeLabel,
        state: base.state,
        stateLabel: race.done ? "已结束" : base.stateLabel,
        steps: race.done ? [] : base.steps,
        metaLabel: meta.joined(separator: " · "),
        countdown: race.done ? "" : countdownLabel(daysUntil(raceDate: race.raceDate, today: today)),
        done: race.done,
        note: race.note
    )
}

/// 一行混排卡：官方计划卡或自定义卡。
public enum MyRaceRow: Equatable, Identifiable, Sendable {
    case official(key: String, plan: PlanCardView)
    case custom(key: String, custom: CustomCardView)

    public var id: String {
        switch self {
        case .official(let key, _): key
        case .custom(let key, _): key
        }
    }
}

/// 聚合 items → 混排行序列，保序（后端已排好）；残缺项跳过。
public func toMyRaceRows(_ items: [MyRaceItem], today: String) -> [MyRaceRow] {
    items.compactMap { item in
        if item.source == .custom, let race = item.race {
            return .custom(key: "c-\(race.id)", custom: toCustomCard(race, today: today))
        }
        if let plan = item.plan {
            return .official(key: "o-\(plan.raceId)", plan: toPlanCard(plan, today: today))
        }
        return nil
    }
}

/// 把乐观补丁合并进一行混排卡。
public func mergeMyRaceRow(_ row: MyRaceRow,
                           state: (state: RacePlanState, stateLabel: String, steps: [PlanStateChip], lost: Bool)? = nil,
                           hotel: Bool? = nil,
                           transit: Bool? = nil,
                           customState: (state: CustomRaceState, stateLabel: String, steps: [CustomStateChip])? = nil) -> MyRaceRow {
    switch row {
    case .official(let key, var plan):
        if let s = state {
            plan.state = s.state
            plan.stateLabel = s.stateLabel
            plan.steps = s.steps
            plan.lost = s.lost
        }
        if let hotel { plan.hotel = hotel }
        if let transit { plan.transit = transit }
        return .official(key: key, plan: plan)
    case .custom(let key, var custom):
        if let s = customState {
            custom.state = s.state
            custom.stateLabel = s.stateLabel
            custom.steps = s.steps
        }
        return .custom(key: key, custom: custom)
    }
}

// MARK: - 我的成绩行（raceResultRows + my-races.ts toRow/pbLabelIds）

/// 成绩行显示名解析链：官方赛名 → 手输名 → 活动名（空串由档位文案兜底）。
public func raceDisplayName(_ race: RaceResultItem) -> String {
    race.raceName ?? race.displayName ?? race.name ?? ""
}

/// 距离档位 → 中文档位标签。
public func raceBandLabel(_ band: RaceDistanceBand) -> String {
    switch band {
    case .marathon: "全马"
    case .halfMarathon: "半马"
    case .other: "比赛"
    }
}

/// 成绩行的渲染模型。
public struct RaceResultRow: Equatable, Identifiable, Sendable {
    public var id: String { labelId }
    public let labelId: String
    public var name: String
    public let bandLabel: String
    /// marathon / half / other（配色档）。
    public let bandClass: String
    public let dateLabel: String
    public let distanceKm: String
    public let duration: String
    public let pace: String
    public let avgHr: String
    public let ascent: String
    public let isPb: Bool
    public var isAuto: Bool
    public var hasCustom: Bool
    public var cnBadgeText: String
    public var waBadgeText: String
}

/// 成绩行构建（isPb 由 pbLabelIds 判定后传入）。
public func toResultRow(_ race: RaceResultItem, isPb: Bool) -> RaceResultRow {
    let isAuto = race.raceName != nil
    let pace = (race.paceFmt.isEmpty || race.paceFmt == "—") ? "" : race.paceFmt
    return RaceResultRow(
        labelId: race.labelId,
        name: raceDisplayName(race).isEmpty ? raceBandLabel(race.distanceBand) : raceDisplayName(race),
        bandLabel: raceBandLabel(race.distanceBand),
        bandClass: race.distanceBand == .marathon ? "marathon" : race.distanceBand == .halfMarathon ? "half" : "other",
        dateLabel: String(race.date.prefix(10)).replacingOccurrences(of: "-", with: "/"),
        distanceKm: String(format: "%.1f", race.distanceKm),
        duration: race.durationFmt,
        pace: pace,
        avgHr: race.avgHr.map(String.init) ?? "",
        ascent: race.ascentM.map { String(Int($0.rounded())) } ?? "",
        isPb: isPb,
        isAuto: isAuto,
        hasCustom: race.displayName != nil,
        cnBadgeText: isAuto ? cnBadge(race.label) : "",
        waBadgeText: isAuto ? waBadge(race.waLabel) : ""
    )
}

/// 当前 PB 的 labelId 集合：全马/半马各取净用时最短一场（同成绩记首场——
/// 新→旧遍历用 `<=` 让更早一场胜出）；其它档位距离不一无 PB。
public func pbLabelIds(_ races: [RaceResultItem]) -> Set<String> {
    var best: [RaceDistanceBand: (id: String, seconds: Double)] = [:]
    for race in races {
        guard race.distanceBand == .marathon || race.distanceBand == .halfMarathon,
              let seconds = race.durationS else { continue }
        if let cur = best[race.distanceBand] {
            if seconds <= cur.seconds {
                best[race.distanceBand] = (race.labelId, seconds)
            }
        } else {
            best[race.distanceBand] = (race.labelId, seconds)
        }
    }
    return Set(best.values.map(\.id))
}

/// 汇总行：`共 N 场 · 全马 N · 半马 N`。
public func resultSummary(_ rows: [RaceResultRow]) -> String {
    let marathon = rows.filter { $0.bandClass == "marathon" }.count
    let half = rows.filter { $0.bandClass == "half" }.count
    var parts = ["共 \(rows.count) 场"]
    if marathon > 0 { parts.append("全马 \(marathon)") }
    if half > 0 { parts.append("半马 \(half)") }
    return parts.joined(separator: " · ")
}

// MARK: - 请求体拼装（customRaceBody：PUT 全量更新的字段面）

/// 存储行 → 全量更新请求体：PUT 缺省可选字段会被清空，聚合下发的原行
/// 显式挑拣全部字段回传（多余字段 hotel/done/时间戳丢弃）。
public func customRaceBody(_ race: CustomRace, state: CustomRaceState) -> CustomRaceBody {
    CustomRaceBody(
        name: race.name,
        raceDate: race.raceDate,
        itemType: race.itemType,
        distanceKm: race.distanceKm,
        ascentM: race.ascentM,
        city: race.city,
        website: race.website,
        note: race.note,
        state: state
    )
}

// MARK: - 自定义表单校验（custom-race-form.ts onSave）

/// 表单校验结果；ok 时的请求体（全量：可选项显式 null/空串）。
public enum CustomRaceFormValidation {
    case ok(CustomRaceBody)
    case failed(String)
}

/// 前端校验：名称/日期必填；距离正数 ≤99999.9；爬升非负整数。
public func validateCustomRaceForm(
    name: String, raceDate: String, itemType: String,
    distanceKm: String, ascentM: String,
    city: String, website: String, note: String, state: CustomRaceState
) -> CustomRaceFormValidation {
    let trimmedName = name.trimmingCharacters(in: .whitespaces)
    guard !trimmedName.isEmpty else { return .failed("请填写比赛名称") }
    guard raceDate.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
        return .failed("请选择比赛日期")
    }
    let dist = distanceKm.trimmingCharacters(in: .whitespaces)
    var km: Double?
    if !dist.isEmpty {
        guard let v = Double(dist), v.isFinite, v > 0 else { return .failed("距离需为正数（km）") }
        guard v <= 99_999.9 else { return .failed("距离上限 99999.9 km") }
        km = v
    }
    let ascent = ascentM.trimmingCharacters(in: .whitespaces)
    var ascentValue: Int?
    if !ascent.isEmpty {
        guard let n = Double(ascent), n == n.rounded(), n >= 0, n <= 9_999_999 else {
            return .failed("爬升需为非负整数（m）")
        }
        ascentValue = Int(n)
    }
    return .ok(CustomRaceBody(
        name: trimmedName,
        raceDate: raceDate,
        itemType: itemType,
        distanceKm: km,
        ascentM: ascentValue,
        city: city.trimmingCharacters(in: .whitespaces),
        website: website.trimmingCharacters(in: .whitespaces),
        note: note.trimmingCharacters(in: .whitespaces),
        state: state
    ))
}
