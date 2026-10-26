import SwiftUI

/// 「我的训练计划」页（devops#768 PR-5，baseline §4.2 直译 · 方案 B 备赛旅程）：
/// 目标条 → lede → 训练周期图（km/dose 切换、阶段色带、三态柱、当前周粉红、
/// 点柱详情）→ 旅程时间轴（阶段块全要素 + 周行展开）→ 本周关键课 → 训练原则
/// → 教练 CTA。loadState 五态：loading/ready/empty/v1/error。
public struct TrainingPlanView: View {

    @Environment(AppModel.self) private var app
    @State private var model = TrainingPlanModel()

    public init() {}

    public var body: some View {
        ScrollView {
            switch model.loadState {
            case .loading:
                ProgressView()
                    .tint(app.theme.current.mutedTwo)
                    .padding(.top, app.theme.current.space(.xxxl))
            case .error:
                stateCard(icon: "calendar", title: "加载失败", subtitle: model.errorText, cta: ("重试", { Task { await model.retry() } }))
            case .empty:
                stateCard(icon: "calendar", title: "还没有启用中的训练计划",
                          subtitle: "把目标比赛告诉教练，为你生成一份完整的赛季备赛计划",
                          cta: ("去找教练生成", { switchToCoach() }))
            case .v1:
                stateCard(icon: "calendar", title: "这是旧版训练计划", subtitle: "旧版计划请前往网页查看", cta: nil)
            case .ready:
                if let vm = model.vm {
                    readyContent(vm)
                }
            }
        }
        .background(app.theme.current.background)
        .navigationTitle("我的训练计划")
        .inlineNavigationTitle()
        .task { await model.activate(app: app) }
    }

    private func switchToCoach() {
        app.router.selectedTab = .coach
    }

    // MARK: - ready 内容

    private func readyContent(_ vm: TrainingPlanVM) -> some View {
        LazyVStack(alignment: .leading, spacing: app.theme.current.space(.md)) {
            goalStrip(vm)
            cycleCard(vm)
            timeline(vm)
            if !vm.principles.isEmpty {
                principlesCard(vm)
            }
            adjustCTA
        }
        .padding(.horizontal, app.theme.current.space(.md))
        .padding(.top, app.theme.current.space(.xs))
        .padding(.bottom, app.theme.current.space(.xxl))
    }

    // MARK: - 目标条

    private func goalStrip(_ vm: TrainingPlanVM) -> some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.sm)) {
            Text("赛季训练计划 · 已启用")
                .font(app.theme.current.font(.fs11))
                .foregroundStyle(app.theme.current.mutedTwo)
            HStack(alignment: .center) {
                HStack(spacing: app.theme.current.space(.xs)) {
                    Image(systemName: "flag")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(app.theme.current.accent)
                    Text(vm.raceName)
                        .font(app.theme.current.font(.fs18, weight: .bold))
                        .foregroundStyle(app.theme.current.foreground)
                    Text(vm.raceDistanceLabel)
                        .font(app.theme.current.font(.fs10, weight: .medium))
                        .foregroundStyle(app.theme.current.accentDeep)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(app.theme.current.accentTint))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("\(vm.countdownDays) 天")
                        .font(app.theme.current.font(.fs18, weight: .bold, mono: true))
                        .foregroundStyle(app.theme.current.accentDeep)
                    if !vm.raceDateLabel.isEmpty {
                        Text("\(vm.raceDateLabel) 开赛")
                            .font(app.theme.current.font(.fs10))
                            .foregroundStyle(app.theme.current.mutedTwo)
                    }
                }
            }
            Text(vm.ledeText)
                .font(app.theme.current.font(.fs12))
                .foregroundStyle(app.theme.current.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    // MARK: - 训练周期图（柱 + 阶段色带）

    private func cycleCard(_ vm: TrainingPlanVM) -> some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.sm)) {
            HStack {
                Text("训练周期")
                    .font(app.theme.current.font(.fs14, weight: .medium))
                    .foregroundStyle(app.theme.current.foreground)
                Spacer()
                metricToggle
            }

            // 柱列（自绘：填充=实际/计划中值、色带=计划区间、tick=计划中值刻度）。
            // 列宽 12pt + 间 3pt（pitch 15）；span 按 `grid span N` 语义取 N 列宽。
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .bottom, spacing: 3) {
                        ForEach(model.bars) { bar in
                            barColumn(bar)
                        }
                    }
                    .frame(height: 84, alignment: .bottom)
                    HStack(spacing: 3) {
                        ForEach(model.spans) { span in
                            HStack(spacing: 3) {
                                Rectangle()
                                    .fill(Tokens.color(span.color))
                                    .frame(height: 3)
                                Text(span.label)
                                    .font(.system(size: 9))
                                    .foregroundStyle(app.theme.current.mutedTwo)
                            }
                            .frame(width: CGFloat(span.weeks) * 15 - 3)
                        }
                    }
                }
            }

            Text(model.chartDetail)
                .font(app.theme.current.font(.fs11))
                .foregroundStyle(app.theme.current.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(app.theme.current.space(.xs))
                .background(RoundedRectangle(cornerRadius: app.theme.current.radius(.sm)).fill(app.theme.current.background))

            HStack(spacing: app.theme.current.space(.md)) {
                legendItem(color: 0x7AC9A3, label: "实际")
                legendItem(color: 0, label: "计划", dim: true)
                legendItem(color: 0xFF6363, label: "当前周")
            }
        }
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    private var metricToggle: some View {
        HStack(spacing: 0) {
            toggleItem("跑量", active: !model.doseMetric) { model.toggleMetric(false) }
            toggleItem("负荷", active: model.doseMetric) { model.toggleMetric(true) }
        }
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(app.theme.current.border, lineWidth: 0.5))
    }

    private func toggleItem(_ title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(app.theme.current.font(.fs11, weight: .medium))
                .foregroundStyle(active ? app.theme.current.onAccent : app.theme.current.muted)
                .padding(.horizontal, app.theme.current.space(.md))
                .padding(.vertical, 3)
                .background(active ? Capsule().fill(app.theme.current.accent) : nil)
        }
        .buttonStyle(.plain)
    }

    private func barColumn(_ bar: PlanChartBar) -> some View {
        Button {
            model.selectWeek(bar.week)
        } label: {
            VStack(spacing: 2) {
                if !bar.label.isEmpty {
                    Text(bar.label)
                        .font(.system(size: 8))
                        .foregroundStyle(app.theme.current.accentDeep)
                } else {
                    Text("").font(.system(size: 8))
                }
                ZStack(alignment: .bottom) {
                    // 计划区间带（浅色柱形背景）。
                    if bar.band > 0 {
                        Rectangle()
                            .fill(Tokens.color(bar.bandColor).opacity(0.15))
                            .frame(width: 10, height: max(2, 64 * bar.band))
                    }
                    // 填充柱（实际 / 计划中值）。
                    if bar.fill > 0 {
                        Rectangle()
                            .fill(Tokens.color(bar.barColor))
                            .opacity(bar.opacity)
                            .frame(width: 10, height: max(2, 64 * bar.fill))
                    }
                    // 计划中值刻度（km 口径）。
                    if bar.tick > 0 {
                        Rectangle()
                            .fill(app.theme.current.foreground.opacity(0.55))
                            .frame(width: 12, height: 1.5)
                            .offset(y: -64 * bar.tick)
                    }
                }
                .frame(width: 12, height: 64, alignment: .bottom)
            }
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            if model.selectedWeek == bar.week {
                Rectangle()
                    .fill(app.theme.current.accent.opacity(0.15))
                    .frame(width: 14, height: 76)
                    .offset(y: -6)
                    .allowsHitTesting(false)
            }
        }
    }

    private func legendItem(color: UInt32, label: String, dim: Bool = false) -> some View {
        HStack(spacing: 3) {
            RoundedRectangle(cornerRadius: 1)
                .fill(dim ? app.theme.current.border : Tokens.color(color))
                .opacity(dim ? 1 : 0.85)
                .frame(width: 8, height: 8)
            Text(label).font(app.theme.current.font(.fs10)).foregroundStyle(app.theme.current.muted)
        }
    }

    // MARK: - 旅程时间轴

    private func timeline(_ vm: TrainingPlanVM) -> some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.md)) {
            ForEach(vm.timeline) { item in
                switch item {
                case .phase(let phase):
                    phaseBlock(phase, vm: vm)
                case .week(let week):
                    if model.expandedPhases.contains(week.phaseId) {
                        weekRow(week, vm: vm)
                            .padding(.leading, app.theme.current.space(.lg))
                    }
                }
            }
        }
    }

    private func phaseBlock(_ phase: PlanPhaseVM, vm: TrainingPlanVM) -> some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.xs)) {
            HStack(spacing: app.theme.current.space(.xs)) {
                Circle().fill(Tokens.color(phase.color)).frame(width: 8, height: 8)
                Text(phase.name + (phase.state == .done ? "（已完成）" : phase.state == .current ? "（当前）" : ""))
                    .font(app.theme.current.font(.fs14, weight: .medium))
                    .foregroundStyle(app.theme.current.foreground)
                Spacer()
                Text(phase.weeksLabel)
                    .font(app.theme.current.font(.fs11, mono: true))
                    .foregroundStyle(app.theme.current.muted)
                Text(phase.kmRange)
                    .font(app.theme.current.font(.fs11))
                    .foregroundStyle(app.theme.current.mutedTwo)
            }
            if !phase.dateRange.isEmpty {
                Text("\(phase.dateRange) · \(phase.typeLabel)")
                    .font(app.theme.current.font(.fs11))
                    .foregroundStyle(app.theme.current.mutedTwo)
            }
            if phase.state == .current, !model.expandedPhases.contains(phase.id) {
                Text("◀ 你在这里 · 第 \(vm.weekNow)/\(vm.weekTotal) 周")
                    .font(app.theme.current.font(.fs11, weight: .medium))
                    .foregroundStyle(app.theme.current.accentDeep)
            }
            phaseLine("阶段重点", phase.focus)
            if !phase.rhythm.isEmpty { phaseLine("阶段节奏", phase.rhythm) }
            if !phase.keyWorkouts.isEmpty { phaseLine("关键课", phase.keyWorkouts) }

            if !phase.triggers.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("监控触发")
                        .font(app.theme.current.font(.fs10))
                        .foregroundStyle(app.theme.current.mutedTwo)
                    ForEach(phase.triggers, id: \.self) { trigger in
                        HStack(spacing: 4) {
                            Circle().fill(Tokens.color(phase.color)).frame(width: 4, height: 4)
                            Text(trigger)
                                .font(app.theme.current.font(.fs11))
                                .foregroundStyle(app.theme.current.muted)
                        }
                    }
                }
            }

            if !phase.keySessionTypes.isEmpty {
                HStack(spacing: 4) {
                    ForEach(phase.keySessionTypes, id: \.self) { t in
                        Text(t)
                            .font(.system(size: 9))
                            .foregroundStyle(app.theme.current.muted)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(Capsule().strokeBorder(app.theme.current.border, lineWidth: 0.5))
                    }
                }
            }

            if !phase.summaryLine.isEmpty {
                Text(phase.summaryLine)
                    .font(app.theme.current.font(.fs11))
                    .foregroundStyle(app.theme.current.muted)
            }
            if !phase.hrZoneLine.isEmpty {
                Text("心率区间：\(phase.hrZoneLine)")
                    .font(app.theme.current.font(.fs11))
                    .foregroundStyle(app.theme.current.muted)
            }
            if !phase.coachNote.isEmpty {
                Text("Coach：\(phase.coachNote)")
                    .font(app.theme.current.font(.fs11))
                    .foregroundStyle(app.theme.current.muted)
                    .padding(.leading, app.theme.current.space(.xs))
                    .overlay(alignment: .leading) {
                        Rectangle().fill(Tokens.color(phase.color)).frame(width: 2)
                    }
            }

            if !phase.milestones.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text("关键里程碑")
                        .font(app.theme.current.font(.fs10))
                        .foregroundStyle(app.theme.current.mutedTwo)
                    ForEach(phase.milestones) { ms in
                        HStack(spacing: app.theme.current.space(.sm)) {
                            Text(ms.dateLabel)
                                .font(app.theme.current.font(.fs12, weight: .medium, mono: true))
                                .foregroundStyle(Tokens.color(phase.color))
                            Text("\(ms.valueText) \(ms.typeLabel)")
                                .font(app.theme.current.font(.fs11))
                                .foregroundStyle(ms.done ? app.theme.current.muted : app.theme.current.foreground)
                            Spacer()
                            if ms.isNext {
                                Text("下一个 · \(ms.daysUntilLabel)")
                                    .font(app.theme.current.font(.fs10))
                                    .foregroundStyle(app.theme.current.accentDeep)
                            } else if ms.done {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(app.theme.current.mutedTwo)
                            }
                        }
                    }
                }
            }

            Button {
                model.togglePhaseWeeks(phase.id)
            } label: {
                Text(model.expandedPhases.contains(phase.id)
                     ? "收起周次 ▴"
                     : "展开周次 · \(phase.weekCount) 周 ▾")
                    .font(app.theme.current.font(.fs11, weight: .medium))
                    .foregroundStyle(app.theme.current.accentDeep)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, app.theme.current.space(.xs))
            }
            .buttonStyle(.plain)
        }
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
        .opacity(phase.state == .future ? 0.7 : 1)
    }

    private func phaseLine(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: app.theme.current.space(.xs)) {
            Text(label)
                .font(app.theme.current.font(.fs10))
                .foregroundStyle(app.theme.current.mutedTwo)
            Text(value)
                .font(app.theme.current.font(.fs12))
                .foregroundStyle(app.theme.current.muted)
        }
    }

    private func weekRow(_ week: PlanWeekRowVM, vm: TrainingPlanVM) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: app.theme.current.space(.sm)) {
                Text("\(week.weekIndex)")
                    .font(app.theme.current.font(.fs12, weight: .bold, mono: true))
                    .foregroundStyle(week.state == .current ? app.theme.current.accentDeep : app.theme.current.foreground)
                Text(week.dateRange)
                    .font(app.theme.current.font(.fs11))
                    .foregroundStyle(app.theme.current.muted)
                if !week.tag.isEmpty {
                    Text(week.tag)
                        .font(.system(size: 9))
                        .foregroundStyle(app.theme.current.mutedTwo)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().strokeBorder(app.theme.current.border, lineWidth: 0.5))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 1) {
                    Text(week.actualKm.isEmpty ? week.planKm : week.actualKm)
                        .font(app.theme.current.font(.fs12, mono: true))
                        .foregroundStyle(week.actualKm.isEmpty ? app.theme.current.mutedTwo : app.theme.current.foreground)
                    if !week.actualSub.isEmpty {
                        Text(week.actualSub)
                            .font(app.theme.current.font(.fs10))
                            .foregroundStyle(app.theme.current.mutedTwo)
                    }
                }
            }
            if week.state == .current {
                Text("◀ 你在这里 · 第 \(vm.weekNow)/\(vm.weekTotal) 周")
                    .font(app.theme.current.font(.fs11, weight: .medium))
                    .foregroundStyle(app.theme.current.accentDeep)
                if !vm.currentSessions.isEmpty {
                    VStack(spacing: app.theme.current.space(.xs)) {
                        ForEach(vm.currentSessions) { s in
                            HStack(spacing: app.theme.current.space(.sm)) {
                                Image(systemName: s.systemImage)
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(app.theme.current.accent)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(s.title)
                                        .font(app.theme.current.font(.fs12, weight: .medium))
                                        .foregroundStyle(app.theme.current.foreground)
                                    if !s.meta.isEmpty {
                                        Text(s.meta)
                                            .font(app.theme.current.font(.fs10))
                                            .foregroundStyle(app.theme.current.mutedTwo)
                                    }
                                }
                                Spacer()
                                if !s.km.isEmpty {
                                    Text(s.km)
                                        .font(app.theme.current.font(.fs12, mono: true))
                                        .foregroundStyle(app.theme.current.muted)
                                }
                            }
                        }
                    }
                    .padding(app.theme.current.space(.xs))
                    .background(RoundedRectangle(cornerRadius: app.theme.current.radius(.sm)).fill(app.theme.current.background))
                }
            }
        }
        .padding(app.theme.current.space(.sm))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.sm)))
    }

    // MARK: - 原则 / CTA

    private func principlesCard(_ vm: TrainingPlanVM) -> some View {
        VStack(alignment: .leading, spacing: app.theme.current.space(.sm)) {
            Text("训练原则")
                .font(app.theme.current.font(.fs14, weight: .medium))
                .foregroundStyle(app.theme.current.foreground)
            ForEach(Array(vm.principles.enumerated()), id: \.offset) { _, p in
                HStack(alignment: .firstTextBaseline, spacing: app.theme.current.space(.sm)) {
                    Text(p.0)
                        .font(app.theme.current.font(.fs12, weight: .medium, mono: true))
                        .foregroundStyle(app.theme.current.accentDeep)
                    Text(p.1)
                        .font(app.theme.current.font(.fs12))
                        .foregroundStyle(app.theme.current.muted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(app.theme.current.space(.md))
        .background(app.theme.current.surface)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.md)))
    }

    private var adjustCTA: some View {
        Button(action: switchToCoach) {
            Text("和教练调整计划")
                .font(app.theme.current.font(.fs14, weight: .medium))
                .foregroundStyle(app.theme.current.accentDeep)
                .frame(maxWidth: .infinity)
                .padding(.vertical, app.theme.current.space(.sm))
                .background(Capsule().strokeBorder(app.theme.current.accentDeep, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - 状态卡

    private func stateCard(icon: String, title: String, subtitle: String, cta: (String, () -> Void)?) -> some View {
        VStack(spacing: app.theme.current.space(.xs)) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(app.theme.current.mutedTwo)
            Text(title)
                .font(app.theme.current.font(.fs15, weight: .medium))
                .foregroundStyle(app.theme.current.muted)
            Text(subtitle)
                .font(app.theme.current.font(.fs12))
                .foregroundStyle(app.theme.current.mutedTwo)
                .multilineTextAlignment(.center)
            if let cta {
                Button(cta.0, action: cta.1)
                    .font(app.theme.current.font(.fs13, weight: .medium))
                    .foregroundStyle(app.theme.current.accentDeep)
                    .padding(.top, app.theme.current.space(.xs))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, app.theme.current.space(.xl))
        .padding(.top, app.theme.current.space(.xxxl))
    }
}
