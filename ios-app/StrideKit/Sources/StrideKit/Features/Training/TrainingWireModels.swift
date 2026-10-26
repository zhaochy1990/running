import Foundation

// 训练域 wire 类型（devops#768 PR-5）—— 1:1 沿小程序 `types/plan.ts` /
// `types/health.ts` / `services/master-plan.ts` 的字段子集（训练域四页消费面），
// snake_case 手动 CodingKeys。可空字段一律 Optional，后端字段漂移不炸解码。

// MARK: - workout_spec 原语（课表内容）

public enum StepKind: String, Decodable, Hashable, Sendable {
    case warmup, work, recovery, cooldown, rest
}

public enum WorkoutTargetKind: String, Decodable, Hashable, Sendable {
    case paceSKm = "pace_s_km"
    case hrBpm = "hr_bpm"
    case powerW = "power_w"
    case open
}

public struct WorkoutTarget: Decodable, Hashable, Sendable {
    public let kind: WorkoutTargetKind
    public let low: Double?
    public let high: Double?

    enum CodingKeys: String, CodingKey { case kind, low, high }
}

public struct WorkoutStepRest: Decodable, Hashable, Sendable {
    public let kind: String
    public let value: Double?

    enum CodingKeys: String, CodingKey { case kind, value }
}

/// 段时长：kind = time_s / distance_m / open（lap 键手动结束）。
public struct WorkoutStepDuration: Decodable, Hashable, Sendable {
    public let kind: String
    public let value: Double?

    enum CodingKeys: String, CodingKey { case kind, value }
}

public struct WorkoutStep: Decodable, Hashable, Sendable {
    public let stepKind: StepKind
    public let duration: WorkoutStepDuration
    public let target: WorkoutTarget?
    public let note: String?
    public let hrCapBpm: Double?
    /// 步后休息（devops#520 D2 新 idiom，work 步可携带）。
    public let rest: WorkoutStepRest?

    enum CodingKeys: String, CodingKey {
        case stepKind = "step_kind"
        case duration, target, note, rest
        case hrCapBpm = "hr_cap_bpm"
    }
}

public struct WorkoutBlock: Decodable, Hashable, Sendable {
    public let steps: [WorkoutStep]
    /// 组内重复次数（wire key `repeat`，Swift 关键字规避改名）。
    public let repeatCount: Int

    enum CodingKeys: String, CodingKey { case steps; case repeatCount = "repeat" }
}

/// run-workout/v1（blocks/steps）。
public struct RunWorkoutSpec: Decodable, Hashable, Sendable {
    public let schema: String?
    public let name: String
    public let date: String
    public let note: String?
    public let blocks: [WorkoutBlock]

    enum CodingKeys: String, CodingKey { case schema, name, date, note, blocks }
}

public struct StrengthExercise: Decodable, Hashable, Sendable {
    public let canonicalId: String
    public let displayName: String
    public let sets: Int
    public let targetKind: String
    public let targetValue: Double
    public let restSeconds: Double
    public let note: String?

    enum CodingKeys: String, CodingKey {
        case canonicalId = "canonical_id"
        case displayName = "display_name"
        case sets
        case targetKind = "target_kind"
        case targetValue = "target_value"
        case restSeconds = "rest_seconds"
        case note
    }
}

/// strength-workout/v1（exercises）。
public struct StrengthWorkoutSpec: Decodable, Hashable, Sendable {
    public let schema: String?
    public let name: String
    public let date: String
    public let note: String?
    public let exercises: [StrengthExercise]

    enum CodingKeys: String, CodingKey { case schema, name, date, note, exercises }
}

// MARK: - 周计划（GET /api/{user}/plan/weeks/{weekName}）

public enum SessionKind: String, Decodable, Hashable, Sendable {
    case run, strength, rest, cross, note
}

public struct PlannedSession: Decodable, Hashable, Sendable {
    public let date: String
    public let sessionIndex: Int
    public let kind: SessionKind
    public let summary: String
    /// run / strength spec；rest/note 无。多态按 kind 判别解码（spec 无判别符时）。
    public let spec: SessionSpec?
    public let notesMd: String?
    public let totalDistanceM: Double?
    public let totalDurationS: Double?
    public let estimatedDose: Double?

    enum CodingKeys: String, CodingKey {
        case date
        case sessionIndex = "session_index"
        case kind, summary, spec
        case notesMd = "notes_md"
        case totalDistanceM = "total_distance_m"
        case totalDurationS = "total_duration_s"
        case estimatedDose = "estimated_dose"
    }

    public init(date: String, sessionIndex: Int, kind: SessionKind, summary: String,
                spec: SessionSpec?, notesMd: String?, totalDistanceM: Double?,
                totalDurationS: Double?, estimatedDose: Double?) {
        self.date = date
        self.sessionIndex = sessionIndex
        self.kind = kind
        self.summary = summary
        self.spec = spec
        self.notesMd = notesMd
        self.totalDistanceM = totalDistanceM
        self.totalDurationS = totalDurationS
        self.estimatedDose = estimatedDose
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decodeIfPresent(String.self, forKey: .date) ?? ""
        sessionIndex = try c.decodeIfPresent(Int.self, forKey: .sessionIndex) ?? 0
        kind = (try? c.decodeIfPresent(SessionKind.self, forKey: .kind)) ?? .note
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        // spec 形状异常（如空 blocks/exercises 的残缺对象）降级 nil，不炸整行。
        spec = try? c.decodeIfPresent(SessionSpec.self, forKey: .spec)
        notesMd = try c.decodeIfPresent(String.self, forKey: .notesMd)
        totalDistanceM = try c.decodeIfPresent(Double.self, forKey: .totalDistanceM)
        totalDurationS = try c.decodeIfPresent(Double.self, forKey: .totalDurationS)
        estimatedDose = try c.decodeIfPresent(Double.self, forKey: .estimatedDose)
    }
}

/// session/统一行里的 spec 二态：run-workout（blocks）或 strength-workout（exercises）。
public enum SessionSpec: Decodable, Hashable, Sendable {
    case run(RunWorkoutSpec)
    case strength(StrengthWorkoutSpec)

    public var runSpec: RunWorkoutSpec? {
        if case .run(let s) = self { return s }
        return nil
    }

    public var strengthSpec: StrengthWorkoutSpec? {
        if case .strength(let s) = self { return s }
        return nil
    }

    /// 判别规则同小程序：spec 可能缺判别符（#584 前落库内容），按携带键分派。
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let run = try? container.decode(RunWorkoutSpec.self), !run.blocks.isEmpty {
            self = .run(run)
        } else if let strength = try? container.decode(StrengthWorkoutSpec.self), !strength.exercises.isEmpty {
            self = .strength(strength)
        } else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "未知 spec 形状"))
        }
    }
}

public struct PlannedMeal: Decodable, Hashable, Sendable {
    public let name: String
    public let timeHint: String?
    public let kcal: Double?
    public let carbsG: Double?
    public let proteinG: Double?
    public let fatG: Double?
    public let itemsMd: String?

    enum CodingKeys: String, CodingKey {
        case name
        case timeHint = "time_hint"
        case kcal
        case carbsG = "carbs_g"
        case proteinG = "protein_g"
        case fatG = "fat_g"
        case itemsMd = "items_md"
    }
}

public struct PlannedNutrition: Decodable, Hashable, Sendable {
    public let date: String
    public let kcalTarget: Double?
    public let carbsG: Double?
    public let proteinG: Double?
    public let fatG: Double?
    public let waterMl: Double?
    public let meals: [PlannedMeal]
    public let notesMd: String?

    enum CodingKeys: String, CodingKey {
        case date
        case kcalTarget = "kcal_target"
        case carbsG = "carbs_g"
        case proteinG = "protein_g"
        case fatG = "fat_g"
        case waterMl = "water_ml"
        case meals
        case notesMd = "notes_md"
    }
}

public struct WeeklyPlanContent: Decodable, Hashable, Sendable {
    public let schema: String?
    public let sessions: [PlannedSession]?
    public let nutrition: [PlannedNutrition]?
    public let notesMd: String?
    public let coachNotes: String?

    enum CodingKeys: String, CodingKey {
        case schema, sessions, nutrition
        case notesMd = "notes_md"
        case coachNotes = "coach_notes"
    }
}

public struct WeeklyPlanDetail: Decodable, Hashable, Sendable {
    public let planId: String
    public let weekName: String
    public let dateFrom: String
    public let dateTo: String
    public let status: String
    public let contentVersion: Int
    public let revision: Int
    /// content_version == 2 时结构化；== 1 时 markdown 字符串（本域不消费）。
    public let content: WeeklyPlanContent?

    enum CodingKeys: String, CodingKey {
        case planId = "plan_id"
        case weekName = "week_name"
        case dateFrom = "date_from"
        case dateTo = "date_to"
        case status
        case contentVersion = "content_version"
        case revision
        case content
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        planId = try c.decodeIfPresent(String.self, forKey: .planId) ?? ""
        weekName = try c.decodeIfPresent(String.self, forKey: .weekName) ?? ""
        dateFrom = try c.decodeIfPresent(String.self, forKey: .dateFrom) ?? ""
        dateTo = try c.decodeIfPresent(String.self, forKey: .dateTo) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        contentVersion = try c.decodeIfPresent(Int.self, forKey: .contentVersion) ?? 0
        revision = try c.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        // 与 TS `typeof plan.content === 'object'` 同款：对象才取，字符串/缺失都落 nil。
        content = try? c.decodeIfPresent(WeeklyPlanContent.self, forKey: .content)
    }

    public init(planId: String, weekName: String, dateFrom: String, dateTo: String,
                status: String, contentVersion: Int, revision: Int, content: WeeklyPlanContent?) {
        self.planId = planId
        self.weekName = weekName
        self.dateFrom = dateFrom
        self.dateTo = dateTo
        self.status = status
        self.contentVersion = contentVersion
        self.revision = revision
        self.content = content
    }
}

// MARK: - 统一课表（GET /api/users/me/plan/sessions，三源投影）

public enum WorkoutSource: String, Decodable, Hashable, Sendable {
    case weekly, custom, watch
}

/// 统一 workout 行：某天要练什么的一次性投影（weekly→custom→watch 排序）。
public struct PlanSessionRow: Decodable, Hashable, Sendable {
    public let workoutId: String
    public let date: String
    public let source: WorkoutSource
    public let kind: SessionKind
    public let name: String
    public let summary: String?
    public let spec: SessionSpec?
    public let totalDistanceM: Double?
    public let totalDurationS: Double?
    public let estimatedDose: Double?
    /// 仅 weekly 源携带（plan lineage）。
    public let sessionIndex: Int?
    public let planId: String?
    public let provider: String?
    public let providerEntityId: String?
    public let pushed: Bool
    public let saveToken: String?

    enum CodingKeys: String, CodingKey {
        case workoutId = "workout_id"
        case date, source, kind, name, summary, spec
        case totalDistanceM = "total_distance_m"
        case totalDurationS = "total_duration_s"
        case estimatedDose = "estimated_dose"
        case sessionIndex = "session_index"
        case planId = "plan_id"
        case provider
        case providerEntityId = "provider_entity_id"
        case pushed
        case saveToken = "save_token"
    }

    public init(workoutId: String, date: String, source: WorkoutSource, kind: SessionKind,
                name: String, summary: String?, spec: SessionSpec?, totalDistanceM: Double?,
                totalDurationS: Double?, estimatedDose: Double?, sessionIndex: Int?,
                planId: String?, provider: String?, providerEntityId: String?,
                pushed: Bool, saveToken: String?) {
        self.workoutId = workoutId
        self.date = date
        self.source = source
        self.kind = kind
        self.name = name
        self.summary = summary
        self.spec = spec
        self.totalDistanceM = totalDistanceM
        self.totalDurationS = totalDurationS
        self.estimatedDose = estimatedDose
        self.sessionIndex = sessionIndex
        self.planId = planId
        self.provider = provider
        self.providerEntityId = providerEntityId
        self.pushed = pushed
        self.saveToken = saveToken
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workoutId = try c.decodeIfPresent(String.self, forKey: .workoutId) ?? ""
        date = try c.decodeIfPresent(String.self, forKey: .date) ?? ""
        source = (try? c.decodeIfPresent(WorkoutSource.self, forKey: .source)) ?? .weekly
        kind = (try? c.decodeIfPresent(SessionKind.self, forKey: .kind)) ?? .note
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        // spec 形状异常降级 nil（该行课表结构不可看，但行本身仍在）。
        spec = try? c.decodeIfPresent(SessionSpec.self, forKey: .spec)
        totalDistanceM = try c.decodeIfPresent(Double.self, forKey: .totalDistanceM)
        totalDurationS = try c.decodeIfPresent(Double.self, forKey: .totalDurationS)
        estimatedDose = try c.decodeIfPresent(Double.self, forKey: .estimatedDose)
        sessionIndex = try c.decodeIfPresent(Int.self, forKey: .sessionIndex)
        planId = try c.decodeIfPresent(String.self, forKey: .planId)
        provider = try c.decodeIfPresent(String.self, forKey: .provider)
        providerEntityId = try c.decodeIfPresent(String.self, forKey: .providerEntityId)
        pushed = (try? c.decodeIfPresent(Bool.self, forKey: .pushed)) ?? false
        saveToken = try c.decodeIfPresent(String.self, forKey: .saveToken)
    }
}

public struct PlanSessionsResponse: Decodable, Hashable, Sendable {
    public let sessions: [PlanSessionRow]
}

// MARK: - 推送响应（推送后只关心成败，字段最小面）

public struct PushWorkoutResponse: Decodable, Hashable, Sendable {
    public let ok: Bool?
}

// MARK: - master-plan（GET /api/users/{user}/master-plan/current）

public struct MasterPlanGoal: Decodable, Hashable, Sendable {
    public let goalId: String
    public let raceName: String?
    public let distance: String?
    public let raceDate: String?
    public let targetTime: String?

    enum CodingKeys: String, CodingKey {
        case goalId = "goal_id"
        case raceName = "race_name"
        case distance
        case raceDate = "race_date"
        case targetTime = "target_time"
    }
}

public struct HrZoneShare: Decodable, Hashable, Sendable {
    public let zoneIndex: Int
    public let minutes: Double
    public let percent: Double

    enum CodingKeys: String, CodingKey {
        case zoneIndex = "zone_index"
        case minutes, percent
    }
}

public struct CompletedPhaseSummary: Decodable, Hashable, Sendable {
    public let totalDistanceKm: Double
    public let runCount: Int
    public let avgPaceFmt: String?
    public let avgHr: Double?
    public let hrZoneDistribution: [HrZoneShare]?

    enum CodingKeys: String, CodingKey {
        case totalDistanceKm = "total_distance_km"
        case runCount = "run_count"
        case avgPaceFmt = "avg_pace_fmt"
        case avgHr = "avg_hr"
        case hrZoneDistribution = "hr_zone_distribution"
    }
}

public struct MasterPlanPhase: Decodable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let startDate: String
    public let endDate: String
    public let focus: String
    public let weeklyDistanceKmLow: Double
    public let weeklyDistanceKmHigh: Double
    public let keySessionTypes: [String]?
    public let phaseType: String?
    public let rhythm: String?
    public let keyWorkouts: String?
    public let monitoringTriggers: [String]?
    public let coachNote: String?
    public let isCompleted: Bool?
    public let summary: CompletedPhaseSummary?

    enum CodingKeys: String, CodingKey {
        case id, name
        case startDate = "start_date"
        case endDate = "end_date"
        case focus
        case weeklyDistanceKmLow = "weekly_distance_km_low"
        case weeklyDistanceKmHigh = "weekly_distance_km_high"
        case keySessionTypes = "key_session_types"
        case phaseType = "phase_type"
        case rhythm
        case keyWorkouts = "key_workouts"
        case monitoringTriggers = "monitoring_triggers"
        case coachNote = "coach_note"
        case isCompleted = "is_completed"
        case summary
    }
}

public struct MasterPlanKeySession: Decodable, Hashable, Sendable {
    public let type: String
    public let distanceKm: Double?
    public let durationMin: Double?
    public let intensity: String?
    public let purpose: String?

    enum CodingKeys: String, CodingKey {
        case type
        case distanceKm = "distance_km"
        case durationMin = "duration_min"
        case intensity, purpose
    }
}

public struct MasterPlanWeek: Decodable, Hashable, Sendable {
    public let weekIndex: Int
    public let weekStart: String
    public let weekEnd: String?
    public let phaseId: String
    public let targetWeeklyKmLow: Double?
    public let targetWeeklyKmHigh: Double?
    public let targetTrainingDoseLow: Double?
    public let targetTrainingDoseHigh: Double?
    public let keySessions: [MasterPlanKeySession]?
    public let isRecoveryWeek: Bool?
    public let isTaperWeek: Bool?
    public let plannedDistanceKm: Double?
    public let isCompleted: Bool?
    public let actualDistanceKm: Double?
    public let actualAvgPaceFmt: String?
    public let actualAvgHr: Double?
    public let actualTrainingDose: Double?

    enum CodingKeys: String, CodingKey {
        case weekIndex = "week_index"
        case weekStart = "week_start"
        case weekEnd = "week_end"
        case phaseId = "phase_id"
        case targetWeeklyKmLow = "target_weekly_km_low"
        case targetWeeklyKmHigh = "target_weekly_km_high"
        case targetTrainingDoseLow = "target_training_dose_low"
        case targetTrainingDoseHigh = "target_training_dose_high"
        case keySessions = "key_sessions"
        case isRecoveryWeek = "is_recovery_week"
        case isTaperWeek = "is_taper_week"
        case plannedDistanceKm = "planned_distance_km"
        case isCompleted = "is_completed"
        case actualDistanceKm = "actual_distance_km"
        case actualAvgPaceFmt = "actual_avg_pace_fmt"
        case actualAvgHr = "actual_avg_hr"
        case actualTrainingDose = "actual_training_dose"
    }
}

public struct MasterPlanMilestone: Decodable, Hashable, Sendable {
    public let id: String
    public let type: String
    public let date: String
    public let phaseId: String
    public let target: String
    public let completedActual: String?

    enum CodingKeys: String, CodingKey {
        case id, type, date
        case phaseId = "phase_id"
        case target
        case completedActual = "completed_actual"
    }
}

public struct MasterPlanNextMilestone: Decodable, Hashable, Sendable {
    public let id: String
    public let date: String
    public let target: String
    public let daysUntil: Int

    enum CodingKeys: String, CodingKey {
        case id, date, target
        case daysUntil = "days_until"
    }
}

public struct SeasonPlanContent: Decodable, Hashable, Sendable {
    public let goal: MasterPlanGoal
    public let startDate: String
    public let endDate: String
    public let totalWeeks: Int
    public let phases: [MasterPlanPhase]
    public let milestones: [MasterPlanMilestone]
    public let weeks: [MasterPlanWeek]
    public let trainingPrinciples: [String]
    public let currentPhaseId: String?
    public let currentWeekNumber: Int?
    public let nextMilestone: MasterPlanNextMilestone?

    enum CodingKeys: String, CodingKey {
        case goal
        case startDate = "start_date"
        case endDate = "end_date"
        case totalWeeks = "total_weeks"
        case phases, milestones, weeks
        case trainingPrinciples = "training_principles"
        case currentPhaseId = "current_phase_id"
        case currentWeekNumber = "current_week_number"
        case nextMilestone = "next_milestone"
    }
}

/// current 信封：v1 正文 markdown 字符串（不渲染），v2 结构化 plan。
public struct CurrentSeasonPlan: Decodable, Hashable, Sendable {
    public let status: String
    public let planId: String
    public let createdAt: String
    public let updatedAt: String
    public let contentVersion: Int
    public let revision: Int?
    public let plan: SeasonPlanContent?

    enum CodingKeys: String, CodingKey {
        case status
        case planId = "plan_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case contentVersion = "content_version"
        case revision
        case plan
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "active"
        planId = try c.decodeIfPresent(String.self, forKey: .planId) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        contentVersion = try c.decodeIfPresent(Int.self, forKey: .contentVersion) ?? 0
        revision = try c.decodeIfPresent(Int.self, forKey: .revision)
        plan = try? c.decodeIfPresent(SeasonPlanContent.self, forKey: .plan)
    }

    public init(status: String, planId: String, createdAt: String, updatedAt: String,
                contentVersion: Int, revision: Int?, plan: SeasonPlanContent?) {
        self.status = status
        self.planId = planId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.contentVersion = contentVersion
        self.revision = revision
        self.plan = plan
    }
}

// MARK: - 训练状态数据面（health / hrv / zones / training-load）

public struct StrideTrainingLoadRecord: Decodable, Hashable, Sendable {
    public let date: String
    public let trainingDose: Double?
    public let acuteLoad: Double?
    public let chronicLoad: Double?
    public let form: Double?
    public let loadRatio: Double?
    public let coverageStatus: String
    public let readinessGate: String?
    public let readinessReasons: [String]?

    enum CodingKeys: String, CodingKey {
        case date
        case trainingDose = "training_dose"
        case acuteLoad = "acute_load"
        case chronicLoad = "chronic_load"
        case form
        case loadRatio = "load_ratio"
        case coverageStatus = "coverage_status"
        case readinessGate = "readiness_gate"
        case readinessReasons = "readiness_reasons"
    }
}

public struct StrideTrainingLoadResponse: Decodable, Hashable, Sendable {
    public let current: StrideTrainingLoadRecord?
    public let series: [StrideTrainingLoadRecord]
}

public struct HealthRecord: Decodable, Hashable, Sendable {
    /// 上海 YYYY-MM-DD（或 YYYYMMDD，两种都兼容）。
    public let date: String
    public let rhr: Double?

    enum CodingKeys: String, CodingKey { case date, rhr }
}

public struct HRVSnapshot: Decodable, Hashable, Sendable {
    public let hrvNormalLow: Double?
    public let hrvNormalHigh: Double?

    enum CodingKeys: String, CodingKey {
        case hrvNormalLow = "hrv_normal_low"
        case hrvNormalHigh = "hrv_normal_high"
    }
}

public struct HealthResponse: Decodable, Hashable, Sendable {
    public let health: [HealthRecord]
    public let hrv: HRVSnapshot
    public let rhrBaseline: Double?

    enum CodingKeys: String, CodingKey {
        case health, hrv
        case rhrBaseline = "rhr_baseline"
    }
}

public struct HrvDailyRecord: Decodable, Hashable, Sendable {
    public let date: String
    public let lastNightAvg: Double?

    enum CodingKeys: String, CodingKey {
        case date
        case lastNightAvg = "last_night_avg"
    }
}

public struct HrvResponse: Decodable, Hashable, Sendable {
    public let hrv: [HrvDailyRecord]
}

public struct StrideThreshold: Decodable, Hashable, Sendable {
    public let pacePerKmSec: Double?
    public let hrBpm: Double?
    public let speedConfidence: String?
    public let hrConfidence: String?
    public let asOfDate: String

    enum CodingKeys: String, CodingKey {
        case pacePerKmSec = "pace_per_km_sec"
        case hrBpm = "hr_bpm"
        case speedConfidence = "speed_confidence"
        case hrConfidence = "hr_confidence"
        case asOfDate = "as_of_date"
    }
}

public struct StridePaceZone: Decodable, Hashable, Sendable {
    public let name: String
    public let label: String
    public let upperPace: String?
    public let lowerPace: String?

    enum CodingKeys: String, CodingKey {
        case name, label
        case upperPace = "upper_pace"
        case lowerPace = "lower_pace"
    }
}

public struct StrideHrZone: Decodable, Hashable, Sendable {
    public let name: String
    public let label: String
    public let lowerBpm: Double?
    public let upperBpm: Double?

    enum CodingKeys: String, CodingKey {
        case name, label
        case lowerBpm = "lower_bpm"
        case upperBpm = "upper_bpm"
    }
}

public struct StrideZonesResponse: Decodable, Hashable, Sendable {
    public let threshold: StrideThreshold?
    public let paceZones: [StridePaceZone]
    public let hrZones: [StrideHrZone]

    enum CodingKeys: String, CodingKey {
        case threshold
        case paceZones = "pace_zones"
        case hrZones = "hr_zones"
    }
}
