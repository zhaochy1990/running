import Foundation
import Observation

// 训练 tab（今日首页）ViewModel（devops#768 PR-5，baseline §2.3 直译）：
// 周选择条 + 今日活动卡 + 今日训练卡 + 营养建议卡 + 推送日期弹层。
// 跨周先空渲染再拉取（重入保护）、过期响应丢弃、onShow 静默刷新跳过首帧。

// MARK: - 视图模型（展示就绪）

/// 今日训练卡（统一课表行 → 展示字段）。
public struct TodayWorkoutCard: Equatable, Sendable {
    public let title: String
    public let source: WorkoutSource
    /// 来源标签：仅 watch「手表」；weekly/custom 不标。
    public let sourceLabel: String
    public let workoutId: String
    public let systemImage: String
    public let isRunning: Bool
    public let pushed: Bool
    public let intensityBars: [IntensityBar]
    public let stats: [StatItem]
    public let coachNote: String
    public let sessionIndex: Int?
    public let date: String
    public let deletable: Bool
    /// 有完整 spec 可推手表（weekly run/strength 带 session_index、custom run/strength）。
    public let hasSpec: Bool
    /// 有可渲染结构（任意源 run/strength 带 spec）→ 课表详情入口。
    public let hasStructure: Bool

    /// 可推送但走 custom 端点的分支标记。
    public var isCustom: Bool { source == .custom }
}

public struct StatItem: Equatable, Hashable, Sendable {
    public let value: String
    public let label: String

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

public struct MealItem: Equatable, Hashable, Sendable {
    public let name: String
    public let timeHint: String
    public let detail: String
    public let kcal: String
}

/// 营养建议卡（无目标/餐次/建议整块隐藏）。
public struct NutritionCard: Equatable, Sendable {
    public let targetsTop: [StatItem]
    public let targetsBottom: [StatItem]
    public let hasTargets: Bool
    public let meals: [MealItem]
    public let note: String
}

/// 指定日视图（周条 + 训练卡 + 营养卡）。
public struct DayView: Equatable, Sendable {
    public let weekDays: [WeekDayChip]
    public let weekSubtitle: String
    public let todayLabel: String
    public let workout: TodayWorkoutCard?
    public let nutrition: NutritionCard?
}

// MARK: - ViewModel

@MainActor
@Observable
public final class TrainingHomeModel {

    public private(set) var loading = true
    public private(set) var weekSubtitle = ""
    public private(set) var todayLabel = ""
    public private(set) var weekDays: [WeekDayChip] = []
    public private(set) var selectedDate = ""
    public private(set) var workout: TodayWorkoutCard?
    public private(set) var nutrition: NutritionCard?
    public private(set) var todayActivities: [ActivitiesModel.ActivityRow] = []
    /// 推送日期弹层（±7 天 15 选项 → iOS sheet 8 选项形态，见 PushDateSheet）。
    public private(set) var pushSheetVisible = false
    public private(set) var pushOptions: [PushDateOption] = []
    /// 推送/删除进行中（loading 遮罩 + 防重复触发）。
    public private(set) var pushing = false
    /// 操作 toast（成功/失败一句话，2 秒自动消失由视图层负责清）。
    public var toast: String?

    private let todayYmd: String
    private var repo: TrainingRepository?
    private var activitiesRepo: ActivitiesRepository?
    private var userId = ""
    /// 已拉取的周计划（教练备注回联数据源；跨周切换时保留）。
    private var fetchedPlan: WeeklyPlanDetail?
    /// 当前周的统一课表行 + 其周起始（快速切周重入保护）。
    private var weekSessions: [PlanSessionRow] = []
    private var sessionsWeekStart = ""
    /// 首帧加载完成标记（scenePhase 静默刷新跳过首帧，devops#698 同款）。
    private var planLoaded = false
    private var started = false
    /// 拉取序号：过期响应丢弃（快速切日期时）。
    private var fetchGeneration = 0

    public init(now: Date = Date()) {
        todayYmd = Shanghai.todayYMD(now: now)
        selectedDate = todayYmd
    }

    // MARK: - 生命周期

    /// 首次可见时装配依赖并拉取（waitForAuth 等价）。重复调用幂等。
    public func activate(app: AppModel) async {
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        repo = TrainingRepository(api: app.api)
        activitiesRepo = ActivitiesRepository(api: app.api)
        userId = app.me?.id ?? ""
        guard !userId.isEmpty else {
            loading = false
            return
        }
        await fetchInitial()
    }

    /// 静默刷新本周课表（scenePhase active；教练改课切回即时反映，#698）。
    public func refreshOnReappear() async {
        guard planLoaded, !userId.isEmpty else { return }
        await fetchWeekSessions(anchor: selectedDate.isEmpty ? todayYmd : selectedDate)
    }

    // MARK: - 拉取

    private func fetchInitial() async {
        let anchor = selectedDate.isEmpty ? todayYmd : selectedDate
        do {
            fetchedPlan = try await repo?.weeklyPlan(userId: userId, weekName: Shanghai.weekFolderName(weekStartYmd: Shanghai.weekStart(ymd: todayYmd)))
        } catch {
            // 拉取失败（未生成计划/网络）保持空态，由界面展示空态卡。
        }
        renderDay(anchor)
        loading = false
        await fetchWeekSessions(anchor: anchor)
        planLoaded = true
    }

    /// 拉取指定日期所在周的统一课表行；返回后重渲染选中日。
    private func fetchWeekSessions(anchor: String) async {
        guard !userId.isEmpty else { return }
        let weekStart = Shanghai.weekStart(ymd: anchor)
        sessionsWeekStart = weekStart // 先记录，防快速切周重入循环
        let weekEnd = Shanghai.addDays(weekStart, 6)
        fetchGeneration += 1
        let gen = fetchGeneration
        do {
            weekSessions = try await repo?.planSessions(userId: userId, dateFrom: weekStart, dateTo: weekEnd) ?? []
        } catch {
            weekSessions = []
        }
        // 快速切周时丢弃过期响应（与渲染时 selectedDate 校验双保险）。
        guard gen == fetchGeneration, sessionsWeekStart == weekStart else { return }
        if !selectedDate.isEmpty {
            renderDay(selectedDate)
        }
    }

    /// 渲染指定日期（上海 YYYY-MM-DD）并拉取当天实际活动。
    private func renderDay(_ dateYmd: String) {
        selectedDate = dateYmd
        weekDays = Shanghai.buildWeekDays(anchorYmd: dateYmd, todayYmd: todayYmd)
        weekSubtitle = Shanghai.weekSubtitle(weekStartYmd: Shanghai.weekStart(ymd: dateYmd))
        todayLabel = "\(Int(dateYmd.dropFirst(5).prefix(2)))月\(Int(dateYmd.suffix(2)))日"
        if Shanghai.weekStart(ymd: dateYmd) != sessionsWeekStart {
            // 切到尚未拉取的周：先空渲染，fetchWeekSessions 回来后重渲染。
            let view = Self.buildDayView(plan: fetchedPlan, rows: [], dateYmd: dateYmd, todayYmd: todayYmd)
            workout = view.workout
            nutrition = view.nutrition
            todayActivities = []
            Task { await fetchWeekSessions(anchor: dateYmd) }
            return
        }
        let view = Self.buildDayView(plan: fetchedPlan, rows: weekSessions, dateYmd: dateYmd, todayYmd: todayYmd)
        workout = view.workout
        nutrition = view.nutrition
        todayActivities = []
        Task { await fetchDayActivities(dateYmd) }
    }

    /// 拉取当天实际活动记录；无记录空数组（卡片不展示）。过期响应丢弃。
    private func fetchDayActivities(_ dateYmd: String) async {
        guard !userId.isEmpty else { return }
        let gen = fetchGeneration
        do {
            let res = try await activitiesRepo?.list(userId: userId, dateFrom: dateYmd, dateTo: dateYmd, limit: 20, offset: 0)
            guard gen == fetchGeneration, selectedDate == dateYmd else { return }
            todayActivities = (res?.activities ?? []).map(Self.activityRow)
        } catch {
            if gen == fetchGeneration, selectedDate == dateYmd { todayActivities = [] }
        }
    }

    // MARK: - 交互

    /// 周条点选任意日期（含跨周）。
    public func selectDay(_ date: String) {
        guard date != selectedDate else { return }
        renderDay(date)
    }

    /// 手表推送：打开日期选择弹层（weekly/custom 可推；watch 源不回推）。
    public func openPushSheet() {
        guard let workout else { return }
        guard workout.hasSpec else {
            toast = workout.isCustom ? "自建课暂不支持推送" : "该训练暂不支持推送"
            return
        }
        pushOptions = buildPushDateOptions(plannedDate: workout.date, todayYmd: todayYmd)
        pushSheetVisible = true
    }

    public func closePushSheet() {
        pushSheetVisible = false
    }

    /// 弹层选日后推送（custom 走 custom 端点；weekly 走 planned-session 端点）。
    public func pushToWatch(targetDate: String) async {
        pushSheetVisible = false
        guard let workout, !pushing else { return }
        guard workout.source == .custom || workout.sessionIndex != nil else { return }
        pushing = true
        do {
            if workout.source == .custom {
                try await repo?.pushCustomWorkout(workoutId: workout.workoutId)
            } else {
                try await repo?.pushPlannedSession(userId: userId, date: workout.date, sessionIndex: workout.sessionIndex!, targetDate: targetDate)
            }
            await fetchWeekSessions(anchor: selectedDate)
            toast = "推送成功"
        } catch {
            toast = "推送失败"
        }
        pushing = false
    }

    /// 删除自建课（确认由视图层负责；软删后重拉本周课表）。
    public func deleteCustomWorkout() async {
        guard let workout, workout.deletable, !workout.workoutId.isEmpty, !pushing else { return }
        pushing = true
        do {
            try await repo?.deleteCustomWorkout(workoutId: workout.workoutId)
            await fetchWeekSessions(anchor: selectedDate)
            toast = "已删除"
        } catch {
            toast = "删除失败"
        }
        pushing = false
    }

    public func clearToast() {
        toast = nil
    }

    // MARK: - 纯构建（单测面）

    /// 组装指定日视图：服务端已按 weekly→custom→watch 排序，优先展示可训练的
    /// 课，否则落到休息行；营养无量化目标/餐次/建议时整块隐藏。
    public nonisolated static func buildDayView(plan: WeeklyPlanDetail?, rows: [PlanSessionRow], dateYmd: String, todayYmd: String) -> DayView {
        let content = plan?.content
        let dayRows = rows.filter { $0.date == dateYmd }
        let meaningful = dayRows.first { $0.kind != .rest && $0.kind != .note }
        let workoutRow = meaningful ?? dayRows.first
        let nutrition = content?.nutrition?.first { $0.date == dateYmd }.flatMap(buildNutritionCard)
        return DayView(
            weekDays: Shanghai.buildWeekDays(anchorYmd: dateYmd, todayYmd: todayYmd),
            weekSubtitle: Shanghai.weekSubtitle(weekStartYmd: Shanghai.weekStart(ymd: dateYmd)),
            todayLabel: "\(Int(dateYmd.dropFirst(5).prefix(2)))月\(Int(dateYmd.suffix(2)))日",
            workout: workoutRow.flatMap { buildWorkoutCard(row: $0, content: content) },
            nutrition: nutrition
        )
    }

    /// 统一课表行 → 今日训练卡。
    public nonisolated static func buildWorkoutCard(row: PlanSessionRow, content: WeeklyPlanContent?) -> TodayWorkoutCard {
        let isRunning = row.kind == .run && row.spec?.runSpec != nil
        // 统一行不带 session notes；weekly 源回联周计划内容补齐教练备注。
        let weeklySession: PlannedSession?
        if row.source == .weekly, let idx = row.sessionIndex {
            weeklySession = content?.sessions?.first { $0.date == row.date && $0.sessionIndex == idx }
        } else {
            weeklySession = nil
        }
        let coachNote = firstNonEmpty(
            firstLine(weeklySession?.notesMd),
            firstLine(content?.coachNotes),
            firstLine(content?.notesMd)
        )

        let bars = isRunning ? deriveIntensityBars(blocks: row.spec!.runSpec!.blocks) : []
        let blocks = isRunning ? row.spec!.runSpec!.blocks : nil

        // 总时长：落库值优先；custom 常缺，配速中值估时兜底（不加约等号）。
        let durationText: String
        if let total = row.totalDurationS {
            durationText = Fmt.hms(total)
        } else if let blocks {
            durationText = Fmt.hms(estimateWorkoutSeconds(blocks: blocks))
        } else {
            durationText = "—"
        }

        let hasSpec = row.spec != nil
            && (row.kind == .run || row.kind == .strength)
            && (row.source == .custom || (row.source == .weekly && row.sessionIndex != nil))
        let hasStructure = row.spec != nil && (row.kind == .run || row.kind == .strength)

        return TodayWorkoutCard(
            title: row.name.isEmpty ? (row.summary ?? "训练") : row.name,
            source: row.source,
            sourceLabel: row.source == .watch ? "手表" : "",
            workoutId: row.workoutId,
            systemImage: row.kind == .strength ? "dumbbell" : "figure.run",
            isRunning: isRunning,
            pushed: row.pushed,
            intensityBars: bars,
            stats: [
                StatItem(value: Fmt.km(row.totalDistanceM), label: "距离(公里)"),
                StatItem(value: durationText, label: "总时长"),
                StatItem(value: Fmt.dose(row.estimatedDose), label: "训练负荷"),
            ],
            coachNote: coachNote,
            sessionIndex: row.sessionIndex,
            date: row.date,
            deletable: row.source == .custom,
            hasSpec: hasSpec,
            hasStructure: hasStructure
        )
    }

    /// 结构化营养 → 营养卡（无目标/餐次/建议 → nil 整块隐藏）。
    public nonisolated static func buildNutritionCard(_ n: PlannedNutrition) -> NutritionCard? {
        func intOrDash(_ v: Double?) -> String {
            guard let v, v.isFinite else { return "—" }
            return String(Int(v.rounded()))
        }
        let top = [
            StatItem(value: intOrDash(n.kcalTarget), label: "目标热量(kcal)"),
            StatItem(value: intOrDash(n.carbsG), label: "碳水(g)"),
            StatItem(value: intOrDash(n.proteinG), label: "蛋白质(g)"),
        ]
        let bottom = [
            StatItem(value: intOrDash(n.fatG), label: "脂肪(g)"),
            StatItem(value: intOrDash(n.waterMl), label: "饮水(ml)"),
        ]
        let meals = (n.meals ?? []).map { meal in
            MealItem(
                name: meal.name.isEmpty ? "餐次" : meal.name,
                timeHint: meal.timeHint ?? "",
                detail: firstLine(meal.itemsMd),
                kcal: meal.kcal != nil ? "\(Int(meal.kcal!.rounded())) kcal" : "—"
            )
        }
        let note = firstLine(n.notesMd)
        let hasTargets = (top + bottom).contains { $0.value != "—" }
        if meals.isEmpty && !hasTargets && note.isEmpty { return nil }
        return NutritionCard(targetsTop: top, targetsBottom: bottom, hasTargets: hasTargets, meals: meals, note: note)
    }

    /// 活动行（复用记录 tab 行样式与口径）。
    public nonisolated static func activityRow(_ a: Activity) -> ActivitiesModel.ActivityRow {
        let name: String = {
            if let n = a.name?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
            if let s = a.sportName?.trimmingCharacters(in: .whitespaces), !s.isEmpty { return s }
            return "活动"
        }()
        return ActivitiesModel.ActivityRow(
            labelId: a.labelId,
            name: name,
            date: Shanghai.dateLabel(fromYMD: a.date),
            systemImage: SportDisplay.systemImage(forSportName: a.sportName),
            routeThumb: a.routeThumb,
            distanceKm: a.distanceKm > 0 ? Fmt.km(a.distanceM) : "—",
            duration: Fmt.durationShort(a.durationS),
            pace: Fmt.pace(a.avgPaceSKm),
            avgHr: a.avgHr != nil ? Fmt.intStr(a.avgHr) : "—",
            load: Fmt.dose(a.strideTrainingDose ?? a.trainingLoad)
        )
    }
}
