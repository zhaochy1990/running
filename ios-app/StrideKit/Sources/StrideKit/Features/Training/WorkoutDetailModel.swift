import Foundation
import Observation

// 课表详情 ViewModel（devops#768 PR-5，baseline §4.1 直译）：
// 统一课表行按 workout_id 取当日行（三源），weekly 源回联周计划补教练备注。
// 四态 loadState（loading / ready / notfound / error，错误带重试）。

@MainActor
@Observable
public final class WorkoutDetailModel {

    public enum LoadState: Equatable, Sendable {
        case loading, ready, notfound, error
    }

    public struct Header: Equatable, Sendable {
        public let name: String
        /// 类型 chip（间歇/节奏/变速/有氧/渐进/长距离/力量，启发式推导）。
        public let typeChip: String
        /// 来源标记：custom「自建」、watch「手表」、weekly 不标。
        public let sourceLabel: String
        /// `10月20日 周二`。
        public let dateLabel: String
        public let summary: String
        public let systemImage: String
    }

    public private(set) var loadState: LoadState = .loading
    public private(set) var header = Header(name: "", typeChip: "", sourceLabel: "", dateLabel: "", summary: "", systemImage: "figure.run")
    public private(set) var stats: [StatItem] = []
    public private(set) var runGroups: [SegmentGroup] = []
    public private(set) var exercises: [ExerciseRow] = []
    /// 课表内容自带备注（spec.note）。
    public private(set) var specNote = ""
    /// 教练备注（weekly 源回联周计划；session notes 优先，退回计划级备注）。
    public private(set) var coachNote = ""
    /// 自建课才出分享 pill（weekly/watch 不出，#704）。
    public private(set) var canShare = false
    /// 自建课分享链接占位（出向 PR-8 接线）。
    public private(set) var shareURL: URL?

    private let date: String
    private let workoutId: String
    /// 列表页传来的名称（先占位顶栏，拉到行后覆盖）。
    private let titleHint: String
    private var repo: TrainingRepository?
    private var userId = ""

    public init(date: String, workoutId: String, title: String?) {
        self.date = date
        self.workoutId = workoutId
        self.titleHint = title ?? ""
    }

    // MARK: - 生命周期

    public func activate(app: AppModel) async {
        await app.waitUntilSessionSettled()
        repo = TrainingRepository(api: app.api)
        userId = app.me?.id ?? ""
        header = Header(name: titleHint.isEmpty ? "课表详情" : titleHint,
                        typeChip: "", sourceLabel: "", dateLabel: "", summary: "", systemImage: "figure.run")
        guard !userId.isEmpty, !date.isEmpty, !workoutId.isEmpty else {
            loadState = .notfound
            return
        }
        await load()
    }

    public func retry() async {
        loadState = .loading
        await load()
    }

    // MARK: - 拉取

    private func load() async {
        do {
            let rows = try await repo?.planSessions(userId: userId, dateFrom: date, dateTo: date) ?? []
            guard let row = rows.first(where: { $0.workoutId == workoutId }) else {
                loadState = .notfound
                return
            }
            apply(row)
            loadState = .ready
        } catch {
            loadState = .error
        }
    }

    private func apply(_ row: PlanSessionRow) {
        let isRun = row.kind == .run && row.spec?.runSpec != nil
        let isStrength = row.kind == .strength && row.spec?.strengthSpec != nil
        let dateLabel = "\(Int(row.date.dropFirst(5).prefix(2)))月\(Int(row.date.suffix(2)))日 \(Shanghai.weekdayLabel(row.date))"

        // 总时长：落库值优先；custom 常缺，配速中值估时兜底（力量课不兜底）。
        let durationText: String
        if isRun {
            if let total = row.totalDurationS {
                durationText = Fmt.durationShort(total)
            } else {
                durationText = Fmt.durationShort(estimateWorkoutSeconds(blocks: row.spec!.runSpec!.blocks))
            }
        } else {
            durationText = row.totalDurationS != nil ? Fmt.durationShort(row.totalDurationS) : "—"
        }

        // 指标行按课表类型换口径：跑课=距离/时长/负荷，力量=时长/动作数/总组数。
        if isStrength {
            let ex = row.spec!.strengthSpec!.exercises
            stats = [
                StatItem(value: durationText, label: "预计时长"),
                StatItem(value: "\(ex.count) 个", label: "动作"),
                StatItem(value: "\(ex.reduce(0) { $0 + $1.sets }) 组", label: "总组数"),
            ]
        } else {
            stats = [
                StatItem(value: Fmt.km(row.totalDistanceM), label: "距离(公里)"),
                StatItem(value: durationText, label: "总时长"),
                StatItem(value: Fmt.dose(row.estimatedDose), label: "训练负荷"),
            ]
        }

        header = Header(
            name: row.name.isEmpty ? (row.summary ?? "训练") : row.name,
            typeChip: deriveWorkoutType(kind: row.kind, spec: row.spec, totalDistanceM: row.totalDistanceM),
            sourceLabel: row.source == .custom ? "自建" : row.source == .watch ? "手表" : "",
            dateLabel: dateLabel,
            summary: row.summary ?? "",
            systemImage: row.kind == .strength ? "dumbbell" : "figure.run"
        )
        runGroups = isRun ? buildRunGroups(spec: row.spec!.runSpec!) : []
        exercises = isStrength ? buildExerciseRows(spec: row.spec!.strengthSpec!) : []
        specNote = isRun ? (row.spec!.runSpec!.note ?? "") : ""
        canShare = row.source == .custom
        shareURL = canShare ? WorkoutSharePlaceholder.link(user: userId, workout: workoutId) : nil

        // 教练备注：weekly 源回联周计划（session notes_md 优先，退回计划级）。
        if row.source == .weekly {
            Task { await fetchCoachNote(for: row) }
        }
    }

    /// 周计划拉取失败不挡详情渲染，备注留空。
    private func fetchCoachNote(for row: PlanSessionRow) async {
        let weekName = Shanghai.weekFolderName(weekStartYmd: Shanghai.weekStart(ymd: row.date))
        guard let plan = try? await repo?.weeklyPlan(userId: userId, weekName: weekName),
              let content = plan.content else { return }
        let sessionNote: String?
        if let idx = row.sessionIndex {
            sessionNote = content.sessions?.first { $0.date == row.date && $0.sessionIndex == idx }?.notesMd
        } else {
            sessionNote = nil
        }
        coachNote = firstNonEmpty(firstLine(sessionNote), firstLine(content.coachNotes), firstLine(content.notesMd))
    }
}
