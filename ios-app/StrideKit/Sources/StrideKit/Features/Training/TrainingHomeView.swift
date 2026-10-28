import SwiftUI

/// 训练 tab · 今日首页（devops#768 PR-5，baseline §2.3 直译）：
/// 周选择条 7 天 chip（跨周先空渲染再拉取）→ 今日活动卡（同记录 tab 行样式）
/// → 今日训练卡（强度条形图 + 手表推送/自建课分享/教练 CTA/更多=删除）
/// → 营养建议卡；scenePhase active 静默刷新（教练改课切回即时反映 #698）。
public struct TrainingHomeView: View {

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = TrainingHomeModel()

    public init() {}

    public var body: some View {
        ScrollView {
            LazyVStack(spacing: app.theme.current.space(.md)) {
                weekStrip
                if !model.todayActivities.isEmpty {
                    sectionHeader("今日活动 · \(model.todayLabel)")
                    card {
                        VStack(spacing: 0) {
                            ForEach(model.todayActivities) { row in
                                ActivityRowView(row: row) {
                                    app.router.push(.activityDetail(labelId: row.labelId))
                                }
                            }
                        }
                    }
                }
                sectionHeader("今日安排 · \(model.todayLabel)")
                if let workout = model.workout {
                    workoutCard(workout)
                } else if !model.loading {
                    emptyCard
                }
                if let nutrition = model.nutrition {
                    sectionHeader("今日饮食营养")
                    nutritionCard(nutrition)
                }
            }
            .padding(.horizontal, app.theme.current.space(.md))
            .padding(.top, app.theme.current.space(.xs))
            .padding(.bottom, app.theme.current.space(.xxl))
        }
        .background(app.theme.current.background)
        .navigationTitle("本周训练")
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text("本周训练").font(app.theme.current.font(.fs15, weight: .medium))
                    Text(model.weekSubtitle).font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.muted)
                }
            }
        }
        .overlay(alignment: .bottom) { toastView }
        .sheet(isPresented: Binding(get: { model.pushSheetVisible }, set: { _ in model.closePushSheet() })) {
            PushDateSheet(options: model.pushOptions) { date in
                Task { await model.pushToWatch(targetDate: date) }
            }
        }
        .task { await model.activate(app: app) }
        .onChange(of: scenePhase) { _, phase in
            // onShow 静默刷新等价：跳过首帧（activate 刚拉过）与未加载态。
            if phase == .active {
                Task { await model.refreshOnReappear() }
            }
        }
    }

    // MARK: - 周选择条

    private var weekStrip: some View {
        card {
            HStack(spacing: 0) {
                ForEach(model.weekDays) { day in
                    Button {
                        model.selectDay(day.date)
                    } label: {
                        VStack(spacing: 2) {
                            Text(day.label)
                                .font(app.theme.current.font(.fs11))
                                .foregroundStyle(day.isToday ? app.theme.current.onAccent : app.theme.current.muted)
                            Text("\(day.dayNumber)")
                                .font(app.theme.current.font(.fs15, weight: .medium, mono: true))
                                .foregroundStyle(day.isToday ? app.theme.current.onAccent : app.theme.current.foreground)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, app.theme.current.space(.xs))
                        .background(day.isToday ? Capsule().fill(app.theme.current.accent) : nil)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: - 今日训练卡

    private func workoutCard(_ workout: TodayWorkoutCard) -> some View {
        card {
            VStack(alignment: .leading, spacing: app.theme.current.space(.md)) {
                headRow(workout)
                if workout.isRunning {
                    intensityChart(workout)
                }
                statRow(workout.stats)
                if !workout.coachNote.isEmpty {
                    noteBox(title: "教练备注", text: workout.coachNote)
                }
                coachCTA(workout)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            // 卡片整体 → 课表详情（有分段结构时）；内层按钮优先级天然高于 tap。
            guard workout.hasStructure else { return }
            app.router.push(.workoutDetail(date: workout.date, workoutId: workout.workoutId, title: workout.title))
        }
    }

    private func headRow(_ workout: TodayWorkoutCard) -> some View {
        HStack(alignment: .center, spacing: app.theme.current.space(.sm)) {
            HStack(spacing: app.theme.current.space(.xs)) {
                Image(systemName: workout.systemImage)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(app.theme.current.accent)
                Text(workout.title)
                    .font(app.theme.current.font(.fs15, weight: .medium))
                    .foregroundStyle(app.theme.current.foreground)
                    .lineLimit(1)
                if !workout.sourceLabel.isEmpty {
                    Text(workout.sourceLabel)
                        .font(app.theme.current.font(.fs10))
                        .foregroundStyle(app.theme.current.muted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().strokeBorder(app.theme.current.border, lineWidth: 0.5))
                }
            }
            Spacer(minLength: app.theme.current.space(.xs))
            HStack(spacing: app.theme.current.space(.sm)) {
                watchButton(workout)
                if workout.source == .custom {
                    workoutShareLink(workout)
                }
                moreButton(workout)
            }
        }
    }

    /// 手表推送 icon（已推送高亮；watch 源本就来自手表，不回推）。
    private func watchButton(_ workout: TodayWorkoutCard) -> some View {
        Button {
            model.openPushSheet()
        } label: {
            Image(systemName: "applewatch")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(workout.pushed ? app.theme.current.accent : app.theme.current.mutedTwo)
        }
        .buttonStyle(.plain)
    }

    /// 自建课分享 icon（#689 仅自建课可分享；PR-8 出向：课名文案 +
    /// `/s/` workout-share 链接——今日卡分享无封面，对齐小程序 index 分支）。
    private func workoutShareLink(_ workout: TodayWorkoutCard) -> some View {
        ShareLink(
            item: ShareOutbound.link(
                base: app.api.config.shareBaseURL,
                route: .workoutShare(user: app.me?.id ?? "", workout: workout.workoutId)
            ),
            preview: SharePreview(ShareCopy.workout(name: workout.title))
        ) {
            Image(systemName: "square.and.arrow.up")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(app.theme.current.mutedTwo)
        }
    }

    /// 更多 = 自建课删除（ActionSheet→双确认 modal 的 iOS 形态：
    /// confirmationDialog 选择「删除」即执行）；非自建课 toast「暂无更多操作」。
    @State private var showDeleteDialog = false

    private func moreButton(_ workout: TodayWorkoutCard) -> some View {
        Button {
            if workout.deletable {
                showDeleteDialog = true
            } else {
                model.toast = "暂无更多操作"
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(app.theme.current.mutedTwo)
        }
        .buttonStyle(.plain)
        .confirmationDialog("删除自建课「\(workout.title)」？", isPresented: $showDeleteDialog, titleVisibility: .visible) {
            Button("删除", role: .destructive) {
                Task { await model.deleteCustomWorkout() }
            }
        }
    }

    /// 强度柱状图：高度=强度、宽度=段估时占比、休息空档占位、首段淡化。
    private func intensityChart(_ workout: TodayWorkoutCard) -> some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.xs)) {
            HStack {
                Text("课表内容").font(app.theme.current.font(.fs12)).foregroundStyle(app.theme.current.muted)
                Spacer()
                if workout.hasStructure {
                    Text("点击卡片看分段详情 ›")
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.mutedTwo)
                }
            }
            // 柱宽 = 段估时占比（时间轴：休息空档同占权重，严格比例不钳制）。
            GeometryReader { geo in
                let totalWeight = max(workout.intensityBars.reduce(0) { $0 + $1.weight }, 0.001)
                HStack(alignment: .bottom, spacing: 2) {
                    ForEach(Array(workout.intensityBars.enumerated()), id: \.offset) { _, bar in
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(app.theme.current.accent)
                            .opacity(bar.dim ? 0.6 : 1)
                            .frame(height: max(2, 44 * bar.pct / 100))
                            .frame(width: max(2, geo.size.width * bar.weight / totalWeight), alignment: .bottom)
                    }
                }
                .frame(width: geo.size.width, height: 44, alignment: .bottom)
            }
            .frame(height: 44)
            Rectangle().fill(app.theme.current.borderSoft).frame(height: 0.5)
        }
    }

    private func statRow(_ stats: [StatItem]) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(stats.enumerated()), id: \.offset) { _, stat in
                VStack(spacing: 2) {
                    Text(stat.value)
                        .font(app.theme.current.font(.fs15, weight: .bold, mono: true))
                        .foregroundStyle(app.theme.current.foreground)
                    Text(stat.label)
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.mutedTwo)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    /// 和教练聊一聊：把当前 session 作为权威 target 交给教练 tab（单次消费交接）。
    private func coachCTA(_ workout: TodayWorkoutCard) -> some View {
        Button {
            guard !workout.date.isEmpty else {
                model.toast = "今日暂无训练安排"
                return
            }
            // 交接当前计划课为权威 target（PR-4 CoachTarget：session kind 携
            // date + session_index）。仅 weekly 源有 sessionIndex 才建上下文
            // 会话；custom/watch 源纯切 tab（小程序同款：storage 交接只在
            // session_index != null 时写入）。
            let label = "\(workout.title) · \(Int(workout.date.dropFirst(5).prefix(2)))月\(Int(workout.date.suffix(2)))日"
            if let sessionIndex = workout.sessionIndex {
                app.pendingCoachContext = PendingCoachContext(
                    target: CoachTarget(kind: .session, date: workout.date, sessionIndex: sessionIndex),
                    label: label
                )
            }
            app.router.selectedTab = .coach
        } label: {
            HStack(spacing: app.theme.current.space(.xs)) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .font(.system(size: 14, weight: .medium))
                Text("和教练聊一聊")
            }
            .font(app.theme.current.font(.fs14, weight: .medium))
            .foregroundStyle(app.theme.current.accentDeep)
            .frame(maxWidth: .infinity)
            .padding(.vertical, app.theme.current.space(.sm))
            .background(Capsule().fill(app.theme.current.accentTint))
        }
        .buttonStyle(.plain)
    }

    // MARK: - 营养建议卡

    private func nutritionCard(_ nutrition: NutritionCard) -> some View {
        card {
            VStack(alignment: .leading, spacing: app.theme.current.space(.md)) {
                if nutrition.hasTargets {
                    statRow(nutrition.targetsTop)
                    statRow(nutrition.targetsBottom)
                }
                ForEach(Array(nutrition.meals.enumerated()), id: \.offset) { _, meal in
                    HStack(alignment: .top, spacing: app.theme.current.space(.sm)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(meal.name)
                                .font(app.theme.current.font(.fs14, weight: .medium))
                                .foregroundStyle(app.theme.current.foreground)
                            if !meal.timeHint.isEmpty {
                                Text(meal.timeHint).font(app.theme.current.font(.fs11)).foregroundStyle(app.theme.current.mutedTwo)
                            }
                            if !meal.detail.isEmpty {
                                Text(meal.detail).font(app.theme.current.font(.fs12)).foregroundStyle(app.theme.current.muted)
                            }
                        }
                        Spacer()
                        Text(meal.kcal)
                            .font(app.theme.current.font(.fs13, weight: .medium, mono: true))
                            .foregroundStyle(app.theme.current.accentDeep)
                    }
                }
                if !nutrition.note.isEmpty {
                    noteBox(title: "营养建议", text: nutrition.note)
                }
            }
        }
    }

    // MARK: - 通用件

    private func sectionHeader(_ title: String) -> some View {
        HStack {
            Text(title).font(app.theme.current.font(.fs13, weight: .medium)).foregroundStyle(app.theme.current.foreground)
            Spacer()
        }
        .padding(.top, app.theme.current.space(.xs))
    }

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(app.theme.current.space(.md))
            .background(app.theme.current.surface)
            .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    private func noteBox(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(app.theme.current.font(.fs11)).foregroundStyle(app.theme.current.mutedTwo)
            Text(text).font(app.theme.current.font(.fs12)).foregroundStyle(app.theme.current.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(app.theme.current.space(.sm))
        .background(RoundedRectangle(cornerRadius: app.theme.current.radius(.sm)).fill(app.theme.current.accentTint.opacity(0.5)))
    }

    private var emptyCard: some View {
        VStack(spacing: app.theme.current.space(.xs)) {
            Text("今日无训练安排")
                .font(app.theme.current.font(.fs15, weight: .medium))
                .foregroundStyle(app.theme.current.muted)
            Text("好好休息，或查看本周计划")
                .font(app.theme.current.font(.fs12))
                .foregroundStyle(app.theme.current.mutedTwo)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, app.theme.current.space(.xl))
    }

    @ViewBuilder
    private var toastView: some View {
        if let toast = model.toast {
            Text(toast)
                .font(app.theme.current.font(.fs13, weight: .medium))
                .foregroundStyle(app.theme.current.onAccent)
                .padding(.horizontal, app.theme.current.space(.md))
                .padding(.vertical, app.theme.current.space(.sm))
                .background(Capsule().fill(app.theme.current.foreground.opacity(0.9)))
                .padding(.bottom, app.theme.current.space(.xxl))
                .task(id: toast) {
                    try? await Task.sleep(for: .seconds(2))
                    model.clearToast()
                }
        }
    }
}

// MARK: - 推送日期弹层（push-date-sheet → 底部 sheet，#755 sheet 惯例）

/// 选择把课表推送到手表的目标日期（今天起 8 个可选日；小程序 ±7 天 15 项
/// 经 ActionSheet 上限 6 逼出弹层，iOS sheet 直接承载列表）。
struct PushDateSheet: View {

    @Environment(AppModel.self) private var app
    let options: [PushDateOption]
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("选择推送日期")
                .font(app.theme.current.font(.fs15, weight: .medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, app.theme.current.space(.md))
            Divider()
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(options) { option in
                        Button {
                            onSelect(option.value)
                        } label: {
                            HStack {
                                Text(option.label)
                                    .font(app.theme.current.font(.fs14))
                                    .foregroundStyle(app.theme.current.foreground)
                                Spacer()
                                if option.isSelected {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(app.theme.current.accent)
                                }
                            }
                            .padding(.vertical, app.theme.current.space(.md))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Divider()
                    }
                }
            }
        }
        .padding(.horizontal, app.theme.current.space(.md))
        .presentationDetents([.medium])
        .background(app.theme.current.surface)
    }
}
