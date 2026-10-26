import SwiftUI

/// 我的比赛（devops#769，baseline §5.4 直译）：双 tab（我的赛事=混排卡默认 /
/// 我的成绩）；官方卡（状态 chips 流转 + 行程勾选乐观更新）、自定义卡（想跑↔
/// 已报名 + 编辑/删除）、offboarded 灰卡、已结束沉底；成绩行长按 contextMenu
/// （改名/恢复活动名/「不是这场比赛」二次确认）+ 金杯 PB 徽章。
public struct MyRacesView: View {

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = MyRacesModel()
    @State private var renameText = ""

    public init() {}

    public var body: some View {
        main
        .raceToast(model.toast) { model.clearToast() }
        // 长按「输入/修改比赛名字」：alert 文本框回显（#545 editable modal 等价）。
        .alert("比赛名字", isPresented: Binding(
            get: { model.renameTarget != nil },
            set: { if !$0 { model.renameTarget = nil } }
        )) {
            TextField("如「2026 厦门马拉松」", text: $renameText)
            Button("保存") {
                if let target = model.renameTarget {
                    Task { await model.renameRace(labelId: target.labelId, to: renameText) }
                }
                model.renameTarget = nil
            }
            Button("取消", role: .cancel) { model.renameTarget = nil }
        } message: {
            Text("官方赛名优先展示；手输名只在这场比赛使用。")
        }
        // 「这不是这场比赛」二次确认。
        .alert("清除比赛识别", isPresented: Binding(
            get: { model.pendingClearMatch != nil },
            set: { if !$0 { model.pendingClearMatch = nil } }
        )) {
            Button("清除", role: .destructive) {
                if let labelId = model.pendingClearMatch {
                    Task { await model.clearRaceMatch(labelId: labelId) }
                }
                model.pendingClearMatch = nil
            }
            Button("取消", role: .cancel) { model.pendingClearMatch = nil }
        } message: {
            if let labelId = model.pendingClearMatch {
                Text("不再把这场成绩识别为「\(model.resultName(labelId))」？")
            }
        }
    }

    /// 主体（双 tab 容器 + 生命周期），body 只叠 alert/toast 保持类型检查可过。
    private var main: some View {
        let t = app.theme.current
        return VStack(spacing: 0) {
            tabBar
            ScrollView {
                VStack(spacing: t.space(.md)) {
                    if model.activeTab == .plans {
                        plansTab
                    } else {
                        resultsTab
                    }
                }
                .padding(.horizontal, t.space(.md))
                .padding(.vertical, t.space(.sm))
            }
            .id(model.activeTab) // tab 切换回顶
        }
        .background(t.background)
        .navigationTitle("我的比赛")
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .raceTopBarTrailing) {
                Button {
                    app.router.push(.customRaceForm)
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(t.accentDeep)
                }
            }
        }
        .refreshable {
            if model.activeTab == .plans {
                await model.refreshPlans()
            } else {
                await model.fetchResults()
            }
        }
        .task { await model.activate(app: app) }
        .onAppear { Task { await model.onShowRefresh() } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.onShowRefresh() } }
        }
    }

    // MARK: - tab 行

    private var tabBar: some View {
        let t = app.theme.current
        return HStack(spacing: t.space(.xs)) {
            ForEach(MyRacesModel.Tab.allCases, id: \.rawValue) { tab in
                tabButton(tab)
            }
        }
        .padding(.horizontal, t.space(.md))
        .background(t.background)
    }

    private func tabButton(_ tab: MyRacesModel.Tab) -> some View {
        let t = app.theme.current
        let on = model.activeTab == tab
        return Button {
            model.activeTab = tab
        } label: {
            Text(tab.title)
                .font(t.font(.fs14, weight: on ? .bold : .medium))
                .foregroundStyle(on ? t.accentDeep : t.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, t.space(.sm))
                .background(on ? AnyShapeStyle(t.surface) : AnyShapeStyle(Color.clear))
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: t.radius(.md), topTrailingRadius: t.radius(.md)))
        }
        .buttonStyle(.plain)
    }

    // MARK: - 我的赛事（混排卡）

    @ViewBuilder
    private var plansTab: some View {
        if model.plansLoading {
            ProgressView()
                .tint(app.theme.current.mutedTwo)
                .frame(maxWidth: .infinity)
                .padding(.top, app.theme.current.space(.xxxl))
        } else if !model.plansError.isEmpty {
            errorText(model.plansError)
        } else if model.mixRows.isEmpty {
            emptyState(title: "还没有跟进的比赛", cta: "去赛事中心逛逛") {
                app.router.push(.raceCenter)
            }
        } else {
            ForEach(model.mixRows) { row in
                if case .official(_, let card) = row {
                    OfficialPlanCard(card: card, model: model, app: app)
                } else if case .custom(_, let card) = row {
                    CustomRaceCard(card: card, model: model, app: app)
                }
            }
        }
    }

    // MARK: - 我的成绩

    @ViewBuilder
    private var resultsTab: some View {
        if model.loading {
            ProgressView()
                .tint(app.theme.current.mutedTwo)
                .frame(maxWidth: .infinity)
                .padding(.top, app.theme.current.space(.xxxl))
        } else if !model.error.isEmpty {
            errorText(model.error)
        } else if model.rows.isEmpty {
            emptyState(title: "还没有比赛成绩", cta: "同步手表后自动识别全马/半马") {}
        } else {
            VStack(spacing: 0) {
                Text(model.summary)
                    .font(app.theme.current.font(.fs12, weight: .medium))
                    .foregroundStyle(app.theme.current.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, app.theme.current.space(.sm))
                ForEach(model.rows) { row in
                    ResultRowView(row: row) {
                        app.router.push(.activityDetail(labelId: row.labelId))
                    }
                    .contextMenu {
                        if row.isAuto {
                            Button(role: .destructive) {
                                model.pendingClearMatch = row.labelId
                            } label: {
                                Label("这不是这场比赛", systemImage: "questionmark.circle")
                            }
                        } else {
                            Button {
                                renameText = model.resultName(row.labelId)
                                model.renameTarget = (labelId: row.labelId, current: row.name)
                            } label: {
                                Label(row.hasCustom ? "修改比赛名字" : "输入比赛名字", systemImage: "pencil")
                            }
                            if row.hasCustom {
                                Button {
                                    Task { await model.restoreRaceName(labelId: row.labelId) }
                                } label: {
                                    Label("恢复活动名", systemImage: "arrow.counterclockwise")
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func errorText(_ text: String) -> some View {
        let t = app.theme.current
        return Text(text)
            .font(t.font(.fs14, weight: .medium))
            .foregroundStyle(t.muted)
            .frame(maxWidth: .infinity)
            .padding(.vertical, t.space(.xxxl))
    }

    private func emptyState(title: String, cta: String, action: @escaping () -> Void) -> some View {
        let t = app.theme.current
        return VStack(spacing: t.space(.sm)) {
            Text(title)
                .font(t.font(.fs14, weight: .medium))
                .foregroundStyle(t.muted)
            if !cta.isEmpty {
                Button(action: action) {
                    Text(cta)
                        .font(t.font(.fs13, weight: .medium))
                        .foregroundStyle(t.accentDeep)
                        .padding(.horizontal, t.space(.lg))
                        .padding(.vertical, t.space(.xs))
                        .background(Capsule().fill(t.accentTint))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, t.space(.xxxl))
    }
}

// MARK: - 官方计划卡

struct OfficialPlanCard: View {

    let card: PlanCardView
    let model: MyRacesModel
    let app: AppModel

    var body: some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.sm)) {
            HStack(spacing: t.space(.sm)) {
                Text(card.itemLabel)
                    .font(t.font(.fs11, weight: .bold))
                    .foregroundStyle(t.onAccent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(t.accent))
                Button {
                    if !card.offboarded {
                        app.router.push(.raceDetail(id: card.raceId))
                    }
                } label: {
                    Text(card.name)
                        .font(t.font(.fs15, weight: .bold))
                        .foregroundStyle(card.offboarded ? t.mutedTwo : t.foreground)
                        .strikethrough(false)
                }
                .buttonStyle(.plain)
                .disabled(card.offboarded)
                Spacer()
                Text(card.stateLabel)
                    .font(t.font(.fs11, weight: .medium))
                    .foregroundStyle(card.state == .lost ? t.mutedTwo : t.accentDeep)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(card.state == .lost ? t.grid : t.accentTint))
            }
            if !card.dateLabel.isEmpty || !card.city.isEmpty {
                Text([card.dateLabel, card.city].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(t.font(.fs12))
                    .foregroundStyle(t.muted)
            }
            if !card.countdown.isEmpty {
                Text(card.countdown)
                    .font(t.font(.fs12, weight: .medium, mono: true))
                    .foregroundStyle(t.accentDeep)
            }
            if card.offboarded {
                Text("赛事已下架")
                    .font(t.font(.fs12))
                    .foregroundStyle(t.mutedTwo)
            } else if card.lost {
                // 未中签旁路：转化引导。
                Button {
                    app.router.push(.raceCenter)
                } label: {
                    Text("未中签 · 去找替代赛事")
                        .font(t.font(.fs12, weight: .medium))
                        .foregroundStyle(t.accentDeep)
                }
                .buttonStyle(.plain)
            } else if !card.steps.isEmpty {
                HStack(spacing: t.space(.xs)) {
                    ForEach(card.steps) { chip in
                        Button {
                            Task { await model.togglePlanState(raceId: card.raceId, next: chip.state) }
                        } label: {
                            Text(chip.label)
                                .font(t.font(.fs11, weight: chip.on ? .bold : .regular))
                                .foregroundStyle(chip.on ? t.onAccent : t.muted)
                                .padding(.horizontal, t.space(.sm))
                                .padding(.vertical, 4)
                                .background(Capsule().fill(chip.on ? t.accent : t.grid))
                        }
                        .buttonStyle(.plain)
                    }
                }
                // 行程勾选：🏨 酒店 / 🚄 火车票·机票
                HStack(spacing: t.space(.lg)) {
                    tripToggle("🏨 酒店", on: card.hotel) {
                        Task { await model.toggleTrip(raceId: card.raceId, field: .hotel) }
                    }
                    tripToggle("🚄 火车票·机票", on: card.transit) {
                        Task { await model.toggleTrip(raceId: card.raceId, field: .transit) }
                    }
                    Spacer()
                }
            }
        }
        .padding(t.space(.md))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: t.radius(.md))
                .fill(card.offboarded ? t.grid : t.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: t.radius(.md))
                .stroke(t.borderSoft, lineWidth: card.offboarded ? 0 : 1)
        )
        .opacity(card.offboarded ? 0.7 : 1)
    }

    private func tripToggle(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        let t = app.theme.current
        return Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 13))
                Text(label)
                    .font(t.font(.fs12))
            }
            .foregroundStyle(on ? t.accentDeep : t.muted)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 自定义卡

struct CustomRaceCard: View {

    let card: CustomCardView
    let model: MyRacesModel
    let app: AppModel
    @State private var menuOpen = false
    @State private var confirmDelete = false

    var body: some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.sm)) {
            HStack(spacing: t.space(.sm)) {
                Text("自定义")
                    .font(t.font(.fs11, weight: .bold))
                    .foregroundStyle(t.onAccent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Color(hex: 0xE85BAD)))
                Text(card.badgeLabel)
                    .font(t.font(.fs11, weight: .medium))
                    .foregroundStyle(t.foregroundSoft)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(t.grid))
                Spacer()
                // 「···」菜单 → contextMenu（iOS 惯例，D-menu-1）。
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(t.mutedTwo)
            }
            Text(card.name)
                .font(t.font(.fs15, weight: .bold))
                .foregroundStyle(card.done ? t.mutedTwo : t.foreground)
            if !card.metaLabel.isEmpty {
                Text(card.metaLabel)
                    .font(t.font(.fs12))
                    .foregroundStyle(t.muted)
            }
            if !card.countdown.isEmpty {
                Text(card.countdown)
                    .font(t.font(.fs12, weight: .medium, mono: true))
                    .foregroundStyle(t.accentDeep)
            }
            HStack(spacing: t.space(.xs)) {
                Text(card.stateLabel)
                    .font(t.font(.fs11, weight: .medium))
                    .foregroundStyle(card.done ? t.mutedTwo : t.accentDeep)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(card.done ? t.grid : t.accentTint))
                Spacer()
            }
            if !card.steps.isEmpty {
                HStack(spacing: t.space(.xs)) {
                    ForEach(card.steps) { chip in
                        Button {
                            Task { await model.toggleCustomState(rowKey: "c-\(card.rowId)", next: chip.state) }
                        } label: {
                            Text(chip.label)
                                .font(t.font(.fs11, weight: chip.on ? .bold : .regular))
                                .foregroundStyle(chip.on ? t.onAccent : t.muted)
                                .padding(.horizontal, t.space(.sm))
                                .padding(.vertical, 4)
                                .background(Capsule().fill(chip.on ? t.accent : t.grid))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if !card.note.isEmpty {
                Text(card.note)
                    .font(t.font(.fs12))
                    .foregroundStyle(t.mutedTwo)
            }
        }
        .padding(t.space(.md))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))
        .opacity(card.done ? 0.6 : 1)
        .contextMenu {
            Button {
                model.editCustom(app: app, rowKey: "c-\(card.rowId)")
            } label: {
                Label("编辑", systemImage: "pencil")
            }
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Label("删除", systemImage: "trash")
            }
        }
        .alert("删除自定义比赛", isPresented: $confirmDelete) {
            Button("删除", role: .destructive) {
                Task { await model.deleteCustom(rowKey: "c-\(card.rowId)") }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("删除「\(card.name)」？记录不可恢复")
        }
    }
}

// MARK: - 成绩行

struct ResultRowView: View {

    @Environment(AppModel.self) private var app
    let row: RaceResultRow
    let onTap: () -> Void

    var body: some View {
        let t = app.theme.current
        Button(action: onTap) {
            HStack(alignment: .center, spacing: t.space(.md)) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(row.bandLabel)
                            .font(t.font(.fs10, weight: .bold))
                            .foregroundStyle(bandColor)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1.5)
                            .background(Capsule().fill(bandColor.opacity(0.12)))
                        if row.isPb {
                            Text("🏆 PB")
                                .font(t.font(.fs10, weight: .bold))
                                .foregroundStyle(t.warning)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(Capsule().fill(t.warning.opacity(0.12)))
                        }
                    }
                    Text(row.name)
                        .font(t.font(.fs14, weight: .medium))
                        .foregroundStyle(t.foreground)
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        if !row.cnBadgeText.isEmpty { miniBadge(row.cnBadgeText, color: t.accentDeep) }
                        if !row.waBadgeText.isEmpty { miniBadge(row.waBadgeText, color: t.warning) }
                    }
                }
                Spacer(minLength: t.space(.xs))
                VStack(alignment: .trailing, spacing: 3) {
                    Text(row.duration)
                        .font(t.font(.fs15, weight: .bold, mono: true))
                        .foregroundStyle(t.foreground)
                    Text(metaLine)
                        .font(t.font(.fs11))
                        .foregroundStyle(t.mutedTwo)
                }
            }
            .padding(.vertical, t.space(.sm))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Rectangle().fill(t.borderSoft).frame(height: 0.5).padding(.leading, t.space(.md))
        }
    }

    private var bandColor: Color {
        let t = app.theme.current
        switch row.bandClass {
        case "marathon": return t.accentDeep
        case "half": return t.warning
        default: return t.muted
        }
    }

    private var metaLine: String {
        var parts = [row.dateLabel, "\(row.distanceKm) km"]
        if !row.pace.isEmpty { parts.append(row.pace) }
        if !row.avgHr.isEmpty { parts.append("\(row.avgHr) bpm") }
        if !row.ascent.isEmpty { parts.append("↑\(row.ascent)m") }
        return parts.joined(separator: " · ")
    }

    private func miniBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(app.theme.current.font(.fs10))
            .foregroundStyle(color)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.1)))
    }
}
