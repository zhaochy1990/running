import Foundation

// 赛事域 wire 契约镜像（devops#769，PR-6）—— 1:1 沿小程序 services/
// race-center.ts / race-plans.ts / race-strategy.ts / custom-races.ts /
// races.ts（端点零新增，devops#749 §7.1）。命名 camelCase + CodingKeys 对齐
// 服务端 snake_case；「absent-when-empty as null」契约用 Optional 承载。

// MARK: - 赛事日历（race-center.ts）

/// 赛事日历一行（后端 userRaceSummaryDTO）。
public struct RaceCalendarRace: Decodable, Hashable, Sendable, Identifiable {
    public let id: Int
    /// 英文名（源数据 canonical 名）。
    public let name: String
    /// 中文名；nil 时回落 name。
    public let nameCn: String?
    /// 比赛日 YYYY-MM-DD（上海时区口径）。
    public let raceDate: String
    public let province: String?
    public let city: String?
    /// 中国田协认证：A / B / C / C（属地办赛） / 系列赛；nil = 无。
    public let label: String?
    /// 世界田联标牌：Gold / Platinum / Label / Elite；nil = 无。
    public let waLabel: String?
    /// racetypes 词汇 token：Marathon / HalfMarathon / {n}Km / Other / Unknown。
    public let raceTypes: [String]
    /// 请求用户是否已收藏。var：列表星标乐观更新就地翻转（失败回滚）。
    public var favorited: Bool

    public init(id: Int, name: String, nameCn: String? = nil, raceDate: String,
                province: String? = nil, city: String? = nil, label: String? = nil,
                waLabel: String? = nil, raceTypes: [String] = [], favorited: Bool = false) {
        self.id = id
        self.name = name
        self.nameCn = nameCn
        self.raceDate = raceDate
        self.province = province
        self.city = city
        self.label = label
        self.waLabel = waLabel
        self.raceTypes = raceTypes
        self.favorited = favorited
    }

    enum CodingKeys: String, CodingKey {
        case id, name
        case nameCn = "name_cn"
        case raceDate = "race_date"
        case province, city, label
        case waLabel = "wa_label"
        case raceTypes = "race_types"
        case favorited
    }
}

public struct RaceCalendarResponse: Decodable, Sendable {
    public let races: [RaceCalendarRace]
    public let total: Int
    public let page: Int
    public let perPage: Int

    enum CodingKeys: String, CodingKey {
        case races, total, page
        case perPage = "per_page"
    }
}

public struct RaceFavoriteToggleResponse: Decodable, Sendable {
    public let raceId: Int
    public let favorited: Bool

    enum CodingKeys: String, CodingKey {
        case raceId = "race_id"
        case favorited
    }
}

// MARK: - 赛事详情（race-center.ts：userRaceDetailDTO 镜像）

/// 报名时间轴；日期均为 YYYY-MM-DD。
public struct RaceSignupTimeline: Decodable, Hashable, Sendable {
    public let startAt: String
    public let deadline: String
    public let lottery: Bool
    public let lotteryResultAt: String?
    public let paymentDeadline: String?

    enum CodingKeys: String, CodingKey {
        case startAt = "start_at"
        case deadline, lottery
        case lotteryResultAt = "lottery_result_at"
        case paymentDeadline = "payment_deadline"
    }
}

/// 报名渠道：url_type 区分 web（可复制链接）与 qrcode（只标注形态）。
public struct RaceSignupChannel: Decodable, Hashable, Sendable {
    public let name: String
    public let type: String
    public let url: String?
    public let urlType: String

    enum CodingKeys: String, CodingKey {
        case name, type, url
        case urlType = "url_type"
    }
}

/// 领物窗口。
public struct RacePacketPickup: Decodable, Hashable, Sendable {
    public let time: String
    public let location: String
}

public struct RacePoint: Decodable, Hashable, Sendable {
    public let name: String
}

/// 赛道难点；distance_km 是自由文本（"28" / "0–10km（外滩→南京西路）"）。
public struct RaceCourseChallenge: Decodable, Hashable, Sendable {
    public let distanceKm: String?
    public let description: String

    enum CodingKeys: String, CodingKey {
        case distanceKm = "distance_km"
        case description
    }
}

/// 详情页一个项目（userRaceItemDTO v1 投影）；entryFee 单位是分。
/// 内容列遵循后端「absent-when-empty as null」契约（cutoffs 可为 nil）。
public struct RaceItem: Decodable, Hashable, Sendable, Identifiable {
    public let id: Int
    public let name: String
    public let type: String
    public let startTime: String?
    public let entryFee: Int?
    public let quota: Int?
    public let distanceKm: Double?
    public let startPoint: RacePoint?
    public let finishPoint: RacePoint?
    public let routeDescription: String?
    public let totalAscentM: Int?
    public let courseChallenges: [RaceCourseChallenge]?
    public let cutoffs: [RaceCutoff]?

    enum CodingKeys: String, CodingKey {
        case id, name, type
        case startTime = "start_time"
        case entryFee = "entry_fee"
        case quota
        case distanceKm = "distance_km"
        case startPoint = "start_point"
        case finishPoint = "finish_point"
        case routeDescription = "route_description"
        case totalAscentM = "total_ascent_m"
        case courseChallenges = "course_challenges"
        case cutoffs
    }
}

/// 关门点（位置名 + 当日墙钟 HH:MM）。
public struct RaceCutoff: Decodable, Hashable, Sendable {
    public let point: String
    public let cutoffAt: String

    enum CodingKeys: String, CodingKey {
        case point
        case cutoffAt = "cutoff_at"
    }
}

public struct RaceCityIntro: Decodable, Hashable, Sendable {
    public let overview: String
    public let culture: String
    public let food: String
    public let history: String
}

public struct RaceAttraction: Decodable, Hashable, Sendable {
    public let name: String
    public let description: String
}

/// 城市介绍（v1 投影：图片/省份列不镜像）。
public struct RaceCityContent: Decodable, Hashable, Sendable {
    public let city: String
    public let intro: RaceCityIntro?
    public let attractions: [RaceAttraction]?
}

/// 赛事详情：列表行字段 + 三段内容区 + 策略入口门槛。
public struct RaceDetail: Decodable, Hashable, Sendable {
    public let id: Int
    public let name: String
    public let nameCn: String?
    public let raceDate: String
    public let province: String?
    public let city: String?
    public let label: String?
    public let waLabel: String?
    public let raceTypes: [String]
    /// var：详情页星标乐观更新就地翻转（服务端结果为准，失败回滚）。
    public var favorited: Bool
    public let signupTimeline: RaceSignupTimeline?
    public let signupChannels: [RaceSignupChannel]?
    public let packetPickup: [RacePacketPickup]?
    public let items: [RaceItem]
    public let cityContent: RaceCityContent?
    /// 内容是否经过调研（v2 比赛策略入口门槛）。
    public let strategyAvailable: Bool

    enum CodingKeys: String, CodingKey {
        case id, name
        case nameCn = "name_cn"
        case raceDate = "race_date"
        case province, city, label
        case waLabel = "wa_label"
        case raceTypes = "race_types"
        case favorited
        case signupTimeline = "signup_timeline"
        case signupChannels = "signup_channels"
        case packetPickup = "packet_pickup"
        case items
        case cityContent = "city_content"
        case strategyAvailable = "strategy_available"
    }
}

// MARK: - 参赛计划（race-plans.ts）

/// 报名状态 token：想报名 → 已报名（等抽签）→ 已中签 / 未中签 → 确认参赛。
public enum RacePlanState: String, Decodable, Encodable, Hashable, Sendable, CaseIterable {
    case want
    case registered
    case won
    case lost
    case confirmed
}

/// 计划卡上的赛事投影（racePlanRaceDTO 镜像）。
public struct RacePlanRace: Decodable, Hashable, Sendable {
    public let id: Int
    public let name: String
    public let nameCn: String?
    public let raceDate: String
    public let province: String?
    public let city: String?
    public let label: String?
    public let waLabel: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case nameCn = "name_cn"
        case raceDate = "race_date"
        case province, city, label
        case waLabel = "wa_label"
    }
}

/// 一条参赛计划（racePlanDTO 镜像）。
public struct RacePlan: Decodable, Hashable, Sendable {
    public let raceId: Int
    public let itemType: String
    public let state: RacePlanState
    public let hotel: Bool
    public let transit: Bool
    public let race: RacePlanRace?
    /// 已下架：计划遇到赛事下架时的灰卡标记。
    public let offboarded: Bool
    public let createdAt: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case raceId = "race_id"
        case itemType = "item_type"
        case state, hotel, transit, race, offboarded
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// PUT 请求体：项目与状态成对提交；hotel/transit 缺省 = 保留已存值
/// （nil 时键省略，encodeIfPresent 语义即契约）。
public struct RacePlanUpsertBody: Encodable, Sendable {
    public var itemType: String
    public var state: RacePlanState
    public var hotel: Bool?
    public var transit: Bool?

    public init(itemType: String, state: RacePlanState, hotel: Bool? = nil, transit: Bool? = nil) {
        self.itemType = itemType
        self.state = state
        self.hotel = hotel
        self.transit = transit
    }

    enum CodingKeys: String, CodingKey {
        case itemType = "item_type"
        case state, hotel, transit
    }
}

public struct RacePlanUpsertResult: Decodable, Sendable {
    public let raceId: Int
    public let itemType: String
    public let state: RacePlanState
    public let hotel: Bool
    public let transit: Bool
    public let createdAt: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case raceId = "race_id"
        case itemType = "item_type"
        case state, hotel, transit
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct RacePlanListResponse: Decodable, Sendable {
    public let plans: [RacePlan]
}

// MARK: - 比赛策略（race-strategy.ts：coach_contract RaceStrategySchema 镜像）

/// 分段配速表一行（五列：分段/本段配速/本段用时/累计用时/说明）。
public struct RacePaceSegment: Codable, Hashable, Sendable {
    public var segment: String
    /// 本段距离 km；nil = 未知（用时无法自动换算）。
    public var distanceKm: Double?
    public var pace: String
    public var segmentTime: String
    public var cumulativeTime: String
    public var note: String

    public init(segment: String, distanceKm: Double? = nil, pace: String,
                segmentTime: String, cumulativeTime: String, note: String) {
        self.segment = segment
        self.distanceKm = distanceKm
        self.pace = pace
        self.segmentTime = segmentTime
        self.cumulativeTime = cumulativeTime
        self.note = note
    }

    enum CodingKeys: String, CodingKey {
        case segment
        case distanceKm = "distance_km"
        case pace
        case segmentTime = "segment_time"
        case cumulativeTime = "cumulative_time"
        case note
    }
}

/// 补给计划一行：时间点｜内容。
public struct RaceFuelingItem: Codable, Hashable, Sendable {
    public var timePoint: String
    public var content: String

    public init(timePoint: String, content: String) {
        self.timePoint = timePoint
        self.content = content
    }

    enum CodingKeys: String, CodingKey {
        case timePoint = "time_point"
        case content
    }
}

/// 补给打包清单一行：品类｜数量｜用法提示（教练生成，页面只读）。
public struct RaceFuelingChecklistItem: Codable, Hashable, Sendable {
    public var item: String
    public var count: Int
    public var note: String

    enum CodingKeys: String, CodingKey {
        case item, count, note
    }
}

/// 教练生成的比赛策略内容（保存体与草稿交接共用；`PendingStrategyDraft.payload`
/// 解码目标）。旧版本内容无 fueling_checklist 字段（nil 按空清单隐藏）。
public struct RaceStrategyContent: Codable, Hashable, Sendable {
    public var raceName: String
    public var itemType: String
    public var targetFinishTime: String
    public var summary: String
    public var paceSegments: [RacePaceSegment]
    public var fuelingPlan: [RaceFuelingItem]
    public var fuelingChecklist: [RaceFuelingChecklistItem]?
    public var courseTips: [String]
    public var weatherTips: [String]
    public var basisNote: String

    public init(raceName: String, itemType: String, targetFinishTime: String, summary: String,
                paceSegments: [RacePaceSegment], fuelingPlan: [RaceFuelingItem],
                fuelingChecklist: [RaceFuelingChecklistItem]? = nil,
                courseTips: [String] = [], weatherTips: [String] = [], basisNote: String = "") {
        self.raceName = raceName
        self.itemType = itemType
        self.targetFinishTime = targetFinishTime
        self.summary = summary
        self.paceSegments = paceSegments
        self.fuelingPlan = fuelingPlan
        self.fuelingChecklist = fuelingChecklist
        self.courseTips = courseTips
        self.weatherTips = weatherTips
        self.basisNote = basisNote
    }

    enum CodingKeys: String, CodingKey {
        case raceName = "race_name"
        case itemType = "item_type"
        case targetFinishTime = "target_finish_time"
        case summary
        case paceSegments = "pace_segments"
        case fuelingPlan = "fueling_plan"
        case fuelingChecklist = "fueling_checklist"
        case courseTips = "course_tips"
        case weatherTips = "weather_tips"
        case basisNote = "basis_note"
    }
}

/// 一个目标版本的落库视图；id 是行 id（分享链接的版本标识）。
public struct RaceStrategyVersion: Decodable, Hashable, Sendable {
    public let id: Int
    public let targetFinishTime: String
    public let itemType: String
    public let content: RaceStrategyContent
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case targetFinishTime = "target_finish_time"
        case itemType = "item_type"
        case content
        case updatedAt = "updated_at"
    }
}

public struct RaceStrategyListResponse: Decodable, Sendable {
    public let raceId: Int
    public let strategies: [RaceStrategyVersion]

    enum CodingKeys: String, CodingKey {
        case raceId = "race_id"
        case strategies
    }
}

public struct SaveRaceStrategyBody: Encodable, Sendable {
    public var itemType: String
    public var content: RaceStrategyContent

    public init(itemType: String, content: RaceStrategyContent) {
        self.itemType = itemType
        self.content = content
    }

    enum CodingKeys: String, CodingKey {
        case itemType = "item_type"
        case content
    }
}

public struct SaveRaceStrategyResult: Decodable, Sendable {
    public let raceId: Int
    public let targetFinishTime: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case raceId = "race_id"
        case targetFinishTime = "target_finish_time"
        case updatedAt = "updated_at"
    }
}

// MARK: - 自定义比赛与聚合（custom-races.ts）

/// 参赛状态 token（自定义卡两态；「已结束」读时按日期派生）。
public enum CustomRaceState: String, Codable, Hashable, Sendable {
    case want
    case registered
}

/// 一条自定义比赛（customRaceDTO 镜像）。state 为 var：状态切换乐观更新时
/// 就地同步内存缓存（供下次编辑回显）。
public struct CustomRace: Decodable, Hashable, Sendable, Identifiable {
    public let id: Int
    public let name: String
    public let raceDate: String
    public let itemType: String
    public let distanceKm: Double?
    public let ascentM: Int?
    public let city: String
    public let website: String
    public let note: String
    public var state: CustomRaceState
    public let hotel: Bool
    public let transit: Bool
    /// 比赛日已过（上海时区）派生标志。
    public let done: Bool
    public let createdAt: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, name
        case raceDate = "race_date"
        case itemType = "item_type"
        case distanceKm = "distance_km"
        case ascentM = "ascent_m"
        case city, website, note, state, hotel, transit, done
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// 创建/全量更新请求体：PUT 全量更新缺省可选字段会被清空——nil 必须显式
/// 编码为 JSON null（custom encode，勿用 encodeIfPresent）。
public struct CustomRaceBody: Encodable, Sendable {
    public var name: String
    public var raceDate: String
    public var itemType: String
    public var distanceKm: Double?
    public var ascentM: Int?
    public var city: String
    public var website: String
    public var note: String
    public var state: CustomRaceState

    public init(name: String, raceDate: String, itemType: String,
                distanceKm: Double?, ascentM: Int?,
                city: String, website: String, note: String, state: CustomRaceState) {
        self.name = name
        self.raceDate = raceDate
        self.itemType = itemType
        self.distanceKm = distanceKm
        self.ascentM = ascentM
        self.city = city
        self.website = website
        self.note = note
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case name
        case raceDate = "race_date"
        case itemType = "item_type"
        case distanceKm = "distance_km"
        case ascentM = "ascent_m"
        case city, website, note, state
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(raceDate, forKey: .raceDate)
        try c.encode(itemType, forKey: .itemType)
        if let distanceKm { try c.encode(distanceKm, forKey: .distanceKm) } else { try c.encodeNil(forKey: .distanceKm) }
        if let ascentM { try c.encode(ascentM, forKey: .ascentM) } else { try c.encodeNil(forKey: .ascentM) }
        try c.encode(city, forKey: .city)
        try c.encode(website, forKey: .website)
        try c.encode(note, forKey: .note)
        try c.encode(state, forKey: .state)
    }
}

/// 聚合端点的一张卡：official 的 plan 即 race-plans DTO 原样。
public struct MyRaceItem: Decodable, Sendable {
    public enum Source: String, Decodable, Sendable {
        case official
        case custom
    }

    public let source: Source
    public let plan: RacePlan?
    public let race: CustomRace?
}

public struct MyRaceAggregateResponse: Decodable, Sendable {
    public let items: [MyRaceItem]
}

// MARK: - 我的成绩（races.ts）

public enum RaceDistanceBand: String, Decodable, Sendable {
    case marathon
    case halfMarathon = "half_marathon"
    case other
}

/// 一场已确认的比赛；后端已预格式化 date/durationFmt/paceFmt（上海时区）。
public struct RaceResultItem: Decodable, Hashable, Sendable, Identifiable {
    public let labelId: String
    public let name: String?
    /// 日历身份链：官方赛名，未关联日历时为 nil。var：清除识别后就地同步。
    public var raceName: String?
    /// 手输名，未设置时为 nil。var：改名/清除识别后就地同步内存缓存。
    public var displayName: String?
    public let label: String?
    public let waLabel: String?
    public let sportName: String?
    /// 上海时区 ISO 8601（带 +08:00 偏移）。
    public let date: String
    public let distanceBand: RaceDistanceBand
    public let distanceM: Double?
    public let distanceKm: Double
    public let durationS: Double?
    public let durationFmt: String
    public let avgPaceSKm: Double?
    public let paceFmt: String
    public let avgHr: Int?
    public let maxHr: Int?
    public let ascentM: Double?
    public let thumbUrl: String?

    public var id: String { labelId }

    enum CodingKeys: String, CodingKey {
        case labelId = "label_id"
        case name
        case raceName = "race_name"
        case displayName = "display_name"
        case label
        case waLabel = "wa_label"
        case sportName = "sport_name"
        case date
        case distanceBand = "distance_band"
        case distanceM = "distance_m"
        case distanceKm = "distance_km"
        case durationS = "duration_s"
        case durationFmt = "duration_fmt"
        case avgPaceSKm = "avg_pace_s_km"
        case paceFmt = "pace_fmt"
        case avgHr = "avg_hr"
        case maxHr = "max_hr"
        case ascentM = "ascent_m"
        case thumbUrl = "thumb_url"
    }
}

public struct RacesResponse: Decodable, Sendable {
    public let userId: String
    public let races: [RaceResultItem]

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case races
    }
}
