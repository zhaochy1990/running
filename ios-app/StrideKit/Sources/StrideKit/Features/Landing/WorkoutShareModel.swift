import Foundation
import Observation

// 训练课表免登录分享落地页 ViewModel（PR-7 收尾域 devops#770，规格 #758
// 拍板 2 / devops#703）：
// loading：请求中；ready：已渲染；dead：链接失效（缺参/404）；error：5xx 可重试。
// 双 CTA：保存到我的课表（±7 天选日 + save_token=shared-{workoutId} 幂等）/
// 推送手表（先存后推 + 绑表检查 → watch 页回来自动续推）。
// 未登录 tap 任一 → login?redirect=本页（回来不 toast）。

@MainActor
@Observable
public final class WorkoutShareModel {

    public enum LoadState: Equatable, Sendable {
        case loading
        case ready
        case dead
        case error
    }

    public struct Stat: Equatable, Identifiable, Sendable {
        public let id: String
        public let value: String
        public let label: String

        public init(_ value: String, _ label: String) {
            self.id = label
            self.value = value
            self.label = label
        }
    }

    public private(set) var loadState: LoadState = .loading
    public private(set) var name = ""
    public private(set) var dateLabel = ""
    public private(set) var summary = ""
    public private(set) var stats: [Stat] = []
    public private(set) var runGroups: [SegmentGroup] = []
    public private(set) var exercises: [ExerciseRow] = []
    public private(set) var specNote = ""

    // ── CTA 态 ─────────────────────────────────────────────────────────
    /// 已保存（徽章），再点为幂等空操作（save_token 服务端幂等兜底）。
    public private(set) var saved = false
    /// 已推送（仅展示，可重复推）。
    public private(set) var pushed = false
    /// 保存请求在途（含保存+推送链），防双击重放。
    public private(set) var saving = false

    public internal(set) var toastMessage: String?

    // ── 选日弹层（保存 / 保存并推送共用）───────────────────────────────
    public internal(set) var sheetVisible = false
    public internal(set) var sheetTitle = ""
    public private(set) var sheetOptions: [PushDateOption] = []

    let user: String
    let workout: String
    private var shared: SharedWorkout?
    /// 分享者原排期日（YYYY-MM-DD），选日弹层默认值用。
    private var sourceDate = ""
    /// 保存后的统一课表行 workout_id（推送链用）。
    private var savedWorkoutId = ""
    /// 我保存这份课所选的日期（推送 target_date）。
    private var savedDate = ""
    /// 待执行的推送意图：选完日先存后推 / 绑表回来续推。
    private var pendingPush = false
    private var resumePush = false

    private var app: AppModel?
    private var started = false

    public init(user: String, workout: String) {
        self.user = user
        self.workout = workout
        if user.isEmpty || workout.isEmpty {
            loadState = .dead
        }
    }

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        if loadState != .dead {
            await load()
        }
    }

    /// 从 watch 页绑表回来（onAppear）：有未完成的推送意图就自动续推，
    /// 不再提示（零引导，workout-share.ts onShow 同款）。
    public func resumeIfNeeded() async {
        guard resumePush else { return }
        resumePush = false
        if !savedWorkoutId.isEmpty && !savedDate.isEmpty {
            await pushSaved()
        }
    }

    public func load() async {
        guard let app else { return }
        loadState = .loading
        do {
            let res = try await app.api.sharedWorkout(user: user, workout: workout)
            applyView(res)
        } catch {
            // 400/404（链接坏/已删/非自建课）→ 失效空态；网络/5xx → 可重试。
            let status = (error as? ApiError)?.statusCode ?? 0
            loadState = (status >= 500 || status == 0) ? .error : .dead
        }
    }

    private func applyView(_ res: SharedWorkout) {
        shared = res
        sourceDate = res.date
        let isRun = res.spec != nil
        let isStrength = res.strengthSpec != nil

        if Shanghai.ymdDate(res.date) != nil {
            dateLabel = Shanghai.dateLabel(fromYMD: res.date)
        } else {
            dateLabel = ""
        }
        name = res.name.isEmpty ? (res.summary ?? "训练") : res.name
        summary = res.summary ?? ""

        // 指标口径与 workout-detail 一致（所见即所得）：跑课=距离/时长/负荷
        // （时长缺落库值用配速中值估时兜底）；力量=时长/动作数/总组数。
        let durationText: String
        if let duration = res.totalDurationS {
            durationText = fmtDurationShort(duration)
        } else if let run = res.spec {
            durationText = fmtDurationShort(estimateWorkoutSeconds(run))
        } else {
            durationText = "—"
        }
        if isStrength, let strength = res.strengthSpec {
            let totalSets = strength.exercises.reduce(0) { $0 + $1.sets }
            stats = [
                Stat(durationText, "预计时长"),
                Stat("\(strength.exercises.count) 个", "动作"),
                Stat("\(totalSets) 组", "总组数"),
            ]
            exercises = buildExerciseRows(strength)
            runGroups = []
            specNote = ""
        } else {
            stats = [
                Stat(res.totalDistanceM.map { String(format: "%.2f", $0 / 1000) } ?? "—", "距离(公里)"),
                Stat(durationText, "总时长"),
                Stat(res.estimatedDose.map { String(format: "%.0f", $0) } ?? "—", "训练负荷"),
            ]
            runGroups = res.spec.map(buildRunGroups) ?? []
            exercises = []
            specNote = (res.spec?.note ?? "").isEmpty ? "" : res.spec!.note!
        }
        loadState = .ready
    }

    // MARK: - 双 CTA

    /// 未登录 → login?redirect=本页（#692 回跳白名单链路），不 toast。
    private func ensureLogin() -> Bool {
        guard let app else { return false }
        if app.phase == .loggedIn { return true }
        app.requestLogin(redirect: .workoutShare(user: user, workout: workout))
        return false
    }

    public func saveTap() {
        guard !saved, !saving else { return }
        guard ensureLogin() else { return }
        pendingPush = false
        sheetTitle = "保存到哪一天？"
        sheetOptions = buildPushDateOptions(plannedDate: sourceDate, plannedTag: "（原排期）")
        sheetVisible = true
    }

    public func pushTap() {
        guard !saving else { return }
        guard ensureLogin() else { return }
        if saved && !savedWorkoutId.isEmpty {
            Task { await pushSaved() }
            return
        }
        // 未保存先走「保存并推送」：选完日先 upsert 再推（coach 卡同款先后链）。
        pendingPush = true
        sheetTitle = "保存并推送到哪一天？"
        sheetOptions = buildPushDateOptions(plannedDate: sourceDate, plannedTag: "（原排期）")
        sheetVisible = true
    }

    public func selectDate(_ date: String) async {
        let pushAfter = pendingPush
        pendingPush = false
        sheetVisible = false
        guard !date.isEmpty, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let row = try await save(date: date)
            savedWorkoutId = row.workoutId
            savedDate = date
            saved = true
            if !pushAfter {
                toastMessage = "已保存"
                return
            }
            await pushSaved()
        } catch {
            toastMessage = "保存失败，请稍后再试"
        }
    }

    public func closeSheet() {
        pendingPush = false
        sheetVisible = false
    }

    /// 分享课 → 自建课保存卡：save_token=shared-{workoutId} 幂等，
    /// kind/name/summary/spec/totals/dose 按端点响应原样透传。
    private func save(date: String) async throws -> SavedCustomWorkout {
        guard let app, let shared else {
            throw ApiError(statusCode: 0, code: nil, detail: "课表内容缺失")
        }
        let specData = shared.spec.map { try? JSONEncoder().encode($0) }
            ?? shared.strengthSpec.map { try? JSONEncoder().encode($0) }
        let body = SaveCustomWorkoutBody(
            date: date,
            kind: shared.kind == "strength" ? "strength" : "run",
            name: shared.name,
            summary: shared.summary ?? "",
            spec: specData.flatMap { $0 },
            totalDistanceM: shared.totalDistanceM,
            totalDurationS: shared.totalDurationS,
            estimatedDose: shared.estimatedDose,
            saveToken: "shared-\(workout)"
        )
        return try await app.api.saveCustomWorkout(body)
    }

    /// 推送已保存的课：先查绑表，未绑 alert 引导去 watch 页，回来自动续推。
    public func pushSaved() async {
        guard let app else { return }
        guard await ensureWatchBound() else { return }
        do {
            try await app.api.pushCustomWorkout(workoutId: savedWorkoutId, targetDate: savedDate)
            pushed = true
            toastMessage = "已推送到手表"
        } catch {
            let message = (error as? ApiError)?.message ?? "推送失败"
            toastMessage = message.count > 15 ? "推送失败" : message
        }
    }

    /// 推送前绑表检查（watchInfo）；查询失败按已绑处理，让推送端点的服务端
    /// 失败文案兜底（不把网络故障误判成未绑表送去绑表页）。
    private func ensureWatchBound() async -> Bool {
        guard let app else { return false }
        do {
            let info = try await app.api.watchInfo()
            if info.provider != nil { return true }
            pendingPush = false
            resumePush = true
            // 引导去 watch 页绑定（确认弹层形态由视图层呈现，D-sheet-1）。
            needsWatchBinding = true
            return false
        } catch {
            return true
        }
    }

    /// 视图层消费一次的「推送手表需先绑定」引导信号。
    public internal(set) var needsWatchBinding = false

    /// 视图确认「去绑定」后调用。
    public func confirmGoBindWatch() {
        needsWatchBinding = false
        app?.router.push(.watch(provider: nil))
    }
}
