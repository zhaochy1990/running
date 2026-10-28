import Foundation

// 活动 wire 类型（devops#766 PR-3）—— 1:1 沿小程序 `types/activity.ts` 的
// 字段子集（记录域两页消费面），snake_case 手动 CodingKeys。
// 后端对个别活动返回 null 的字段一律 Optional（sport_name 等），解码永不因此中断。

// MARK: - Activity

/// 活动行 / 详情头部共用（list 端点必返字段 + 详情可选字段合一）。
public struct Activity: Decodable, Hashable, Sendable {

    public let labelId: String
    public let name: String?
    /// 后端对个别活动（未标注运动类型的历史数据）返回 null。
    public let sportName: String?
    /// 力量活动类型码（402/800 = 力量，无 GPS 不渲染地图）。
    public let sportType: Int
    /// 上海本地 YYYY-MM-DD 或 ISO 时间串（后端序列化前已转上海时区）。
    public let date: String
    public let distanceM: Double
    public let distanceKm: Double
    public let durationS: Double
    public let durationFmt: String?
    public let avgPaceSKm: Double?
    public let avgHr: Double?
    public let maxHr: Double?
    public let avgCadence: Double?
    /// 手表上报的平均步幅（cm）；null = 设备未上报。
    public let avgStepLenCm: Double?
    /// 手表厂商上报的负荷（COROS/Garmin training_load）。
    public let trainingLoad: Double?
    /// STRIDE 自身计算的 PMC 训练剂量；列表页负荷展示优先。
    public let strideTrainingDose: Double?
    public let trainType: String?
    /// 路线缩略图形状（devops#828）：[[x,y],...] 归一化 0..100 视窗、Y 已翻转
    /// （屏幕坐标），列表行用 RouteThumbView 原生 Path 绘制；室内/无 GPS/尚未
    /// 生成时为 null。
    public let routeThumb: [[Double]]?

    // —— 详情页字段（list 端点可能不返回）——
    public let ascentM: Double?
    public let temperature: Double?
    public let humidity: Double?
    public let feelsLike: Double?
    public let windSpeed: Double?
    /// 体感 emoji 档位（1-5）。
    public let feelType: Int?
    /// 运动员经教练对话补填的体感原话。
    public let feelNote: String?
    public let sportNote: String?
    public let pauses: [Pause]?
    /// AI 点评（教练简评）。
    public let commentary: String?

    public init(
        labelId: String,
        name: String? = nil,
        sportName: String? = nil,
        sportType: Int = 0,
        date: String = "",
        distanceM: Double = 0,
        distanceKm: Double = 0,
        durationS: Double = 0,
        durationFmt: String? = nil,
        avgPaceSKm: Double? = nil,
        avgHr: Double? = nil,
        maxHr: Double? = nil,
        avgCadence: Double? = nil,
        avgStepLenCm: Double? = nil,
        trainingLoad: Double? = nil,
        strideTrainingDose: Double? = nil,
        trainType: String? = nil,
        routeThumb: [[Double]]? = nil,
        ascentM: Double? = nil,
        temperature: Double? = nil,
        humidity: Double? = nil,
        feelsLike: Double? = nil,
        windSpeed: Double? = nil,
        feelType: Int? = nil,
        feelNote: String? = nil,
        sportNote: String? = nil,
        pauses: [Pause]? = nil,
        commentary: String? = nil
    ) {
        self.labelId = labelId
        self.name = name
        self.sportName = sportName
        self.sportType = sportType
        self.date = date
        self.distanceM = distanceM
        self.distanceKm = distanceKm
        self.durationS = durationS
        self.durationFmt = durationFmt
        self.avgPaceSKm = avgPaceSKm
        self.avgHr = avgHr
        self.maxHr = maxHr
        self.avgCadence = avgCadence
        self.avgStepLenCm = avgStepLenCm
        self.trainingLoad = trainingLoad
        self.strideTrainingDose = strideTrainingDose
        self.trainType = trainType
        self.routeThumb = routeThumb
        self.ascentM = ascentM
        self.temperature = temperature
        self.humidity = humidity
        self.feelsLike = feelsLike
        self.windSpeed = windSpeed
        self.feelType = feelType
        self.feelNote = feelNote
        self.sportNote = sportNote
        self.pauses = pauses
        self.commentary = commentary
    }

    enum CodingKeys: String, CodingKey {
        case labelId = "label_id"
        case name
        case sportName = "sport_name"
        case sportType = "sport_type"
        case date
        case distanceM = "distance_m"
        case distanceKm = "distance_km"
        case durationS = "duration_s"
        case durationFmt = "duration_fmt"
        case avgPaceSKm = "avg_pace_s_km"
        case avgHr = "avg_hr"
        case maxHr = "max_hr"
        case avgCadence = "avg_cadence"
        case avgStepLenCm = "avg_step_len_cm"
        case trainingLoad = "training_load"
        case strideTrainingDose = "stride_training_dose"
        case trainType = "train_type"
        // thumb_url（后端预渲染 PNG）已弃用（devops#828，用户 2026-10-28 拍板）：
        // 不再解码消费，列表缩略图改由 route_thumb 形状数据原生绘制；
        // 后端停止预渲染 thumb_url 归 Epic #826 发版节奏统一（两端 adoption 后）。
        case routeThumb = "route_thumb"
        case ascentM = "ascent_m"
        case temperature
        case humidity
        case feelsLike = "feels_like"
        case windSpeed = "wind_speed"
        case feelType = "feel_type"
        case feelNote = "feel_note"
        case sportNote = "sport_note"
        case pauses
        case commentary
    }

    /// 力量活动（sport_type 402/800）：无 GPS，不渲染地图、指标走力量 4 项。
    public var isStrength: Bool { sportType == 402 || sportType == 800 }
}

// MARK: - Pause / Segment / Zone / Timeseries

/// 手表暂停区间。timestamp 为原始 COROS 厘秒，与 timeseries 同口径。
public struct Pause: Decodable, Hashable, Sendable {
    public let startTs: Double?
    public let endTs: Double?
    public let type: Int?

    enum CodingKeys: String, CodingKey {
        case startTs = "start_ts"
        case endTs = "end_ts"
        case type
    }
}

/// 分段行（type2 手表圈/间歇组，回落 autoKm）；圈速表与力量分组共用。
public struct Segment: Decodable, Hashable, Sendable {
    public let lapIndex: Int
    public let lapType: String
    public let distanceM: Double?
    public let distanceKm: Double?
    public let durationS: Double?
    public let durationFmt: String?
    /// 平均配速（s/km）。
    public let avgPace: Double?
    public let avgHr: Double?
    public let avgCadence: Double?
    public let segName: String
    /// COROS 原始圈类型（3 = 恢复圈）。
    public let mode: Int?

    enum CodingKeys: String, CodingKey {
        case lapIndex = "lap_index"
        case lapType = "lap_type"
        case distanceM = "distance_m"
        case distanceKm = "distance_km"
        case durationS = "duration_s"
        case durationFmt = "duration_fmt"
        case avgPace = "avg_pace"
        case avgHr = "avg_hr"
        case avgCadence = "avg_cadence"
        case segName = "seg_name"
        case mode
    }
}

/// 手表上报区间（Go）或校准区间（Python）；percent 为该区间时长占比。
public struct Zone: Decodable, Hashable, Sendable {
    public let zoneType: String
    public let zoneIndex: Int
    public let rangeMin: Double?
    public let rangeMax: Double?
    public let rangeUnit: String?
    public let durationS: Double?
    public let percent: Double?

    enum CodingKeys: String, CodingKey {
        case zoneType = "zone_type"
        case zoneIndex = "zone_index"
        case rangeMin = "range_min"
        case rangeMax = "range_max"
        case rangeUnit = "range_unit"
        case durationS = "duration_s"
        case percent
    }
}

/// timeseries 采样点。timestamp 为厘秒；distance 实测 cm。
public struct TimeseriesPoint: Decodable, Hashable, Sendable {
    public let timestamp: Double?
    public let distance: Double?
    public let heartRate: Double?
    public let speed: Double?
    public let adjustedPace: Double?
    public let cadence: Double?
    public let altitude: Double?
    public let gpsLat: Double?
    public let gpsLon: Double?

    enum CodingKeys: String, CodingKey {
        case timestamp
        case distance
        case heartRate = "heart_rate"
        case speed
        case adjustedPace = "adjusted_pace"
        case cadence
        case altitude
        case gpsLat = "gps_lat"
        case gpsLon = "gps_lon"
    }

    /// 轨迹着色用的配速（s/km）：adjusted_pace 优先，回落 speed。
    public var paceForColoring: Double? {
        adjustedPace ?? speed
    }
}

// MARK: - 响应面

public struct ActivityDetailResponse: Decodable, Hashable, Sendable {
    public let activity: Activity
    public let segments: [Segment]
    public let zones: [Zone]
    /// 仅在请求 include=timeseries 时返回。
    public let timeseries: [TimeseriesPoint]?

    enum CodingKeys: String, CodingKey {
        case activity
        case segments
        case zones
        case timeseries
    }
}

public struct ActivityMonthlySummary: Decodable, Hashable, Sendable {
    public let activityCount: Int
    public let totalRunKm: Double
    public let durationS: Double

    enum CodingKeys: String, CodingKey {
        case activityCount = "activity_count"
        case totalRunKm = "total_run_km"
        case durationS = "duration_s"
    }
}

public struct ActivitiesListResponse: Decodable, Hashable, Sendable {
    public let total: Int
    public let activities: [Activity]
    /// 本页可见各上海月份的聚合（键为 YYYY-MM）；旧后端可能不返回。
    public let monthlySummaries: [String: ActivityMonthlySummary]?

    enum CodingKeys: String, CodingKey {
        case total
        case activities
        case monthlySummaries = "monthly_summaries"
    }
}
