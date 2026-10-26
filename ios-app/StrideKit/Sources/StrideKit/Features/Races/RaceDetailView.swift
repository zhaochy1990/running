import SwiftUI

/// 赛事详情（devops#769，baseline §5.2 直译）：头区（名称+星标+双徽章）→
/// 三宫格 → 报名时间轴（完成态按今天推算）→ 报名按钮（底部 sheet 选择器）→
/// 三/四 tab（概要/项目/赛道/出行，赛道无内容缺席回退）→ 策略卡两态。
public struct RaceDetailView: View {

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: RaceDetailModel

    public init(raceId: Int) {
        _model = State(initialValue: RaceDetailModel(raceId: raceId))
    }

    public var body: some View {
        let t = app.theme.current
        Group {
            if model.loading {
                ProgressView().tint(t.mutedTwo).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !model.error.isEmpty {
                errorCard
            } else if let view = model.view {
                ScrollView {
                    VStack(alignment: .leading, spacing: t.space(.lg)) {
                        RaceDetailHeaderBlock(view: view, starred: model.starred, onStar: {
                            Task { await model.toggleStar() }
                        })
                        grid(view.head.grid)
                        if !view.head.timeline.isEmpty { timeline }
                        if model.signupAvailable { signupButton }
                        tabBar
                        tabContent(view)
                        if model.strategyEntry { strategyCard }
                    }
                    .padding(.horizontal, t.space(.md))
                    .padding(.top, t.space(.sm))
                    .padding(.bottom, t.space(.xxl))
                }
            }
        }
        .background(t.background)
        .navigationTitle("赛事详情")
        .inlineNavigationTitle()
        .refreshable { await model.refresh() }
        .task { await model.activate(app: app) }
        .onAppear { Task { await model.onShowRefresh() } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.onShowRefresh() } }
        }
        .sheet(isPresented: Binding(get: { model.sheetOpen }, set: { model.sheetOpen = $0 })) {
            RaceSignupSheet(model: model)
                .presentationDetents([.medium])
        }
        .raceToast(model.toast) { model.clearToast() }
    }

    // MARK: - 区块

    private var errorCard: some View {
        let t = app.theme.current
        return VStack(spacing: t.space(.sm)) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(t.mutedTwo)
            Text(model.error)
                .font(t.font(.fs14, weight: .medium))
                .foregroundStyle(t.muted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func grid(_ cells: [RaceHeadCell]) -> some View {
        let t = app.theme.current
        return HStack(spacing: t.space(.sm)) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                VStack(spacing: 4) {
                    Text(cell.value)
                        .font(t.font(.fs22, weight: .bold, mono: true))
                        .foregroundStyle(cell.lead ? t.accentDeep : t.foreground)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text(cell.label)
                        .font(t.font(.fs11))
                        .foregroundStyle(t.mutedTwo)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, t.space(.md))
                .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
                .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))
            }
        }
    }

    private var timeline: some View {
        let t = app.theme.current
        let steps = model.view?.head.timeline ?? []
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(steps.enumerated()), id: \.element.key) { i, step in
                    HStack(alignment: .top, spacing: t.space(.sm)) {
                        VStack(spacing: 4) {
                            Circle()
                                .fill(step.done ? t.accent : t.border)
                                .frame(width: 8, height: 8)
                            if i < steps.count - 1 {
                                Rectangle()
                                    .fill(step.done ? t.accent.opacity(0.4) : t.borderSoft)
                                    .frame(width: 36, height: 2)
                            }
                        }
                        .padding(.top, 5)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.date)
                                .font(t.font(.fs14, weight: .bold, mono: true))
                                .foregroundStyle(step.done ? t.foreground : t.mutedTwo)
                            Text(step.label)
                                .font(t.font(.fs11))
                                .foregroundStyle(t.muted)
                        }
                        .frame(minWidth: 64, alignment: .leading)
                    }
                    .fixedSize()
                }
            }
            .padding(.vertical, t.space(.xs))
        }
        .padding(.vertical, t.space(.xs))
    }

    private var signupButton: some View {
        let t = app.theme.current
        return Button {
            model.openSheet()
        } label: {
            HStack {
                Text("报名")
                Text(model.signupButton)
                    .foregroundStyle(model.signupButton == "未报名" ? t.onAccent.opacity(0.85) : t.onAccent)
                Spacer()
                Image(systemName: "chevron.down")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(t.onAccent.opacity(0.8))
            }
            .font(t.font(.fs15, weight: .bold))
            .foregroundStyle(t.onAccent)
            .padding(.horizontal, t.space(.lg))
            .padding(.vertical, t.space(.md))
            .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.accent))
        }
        .buttonStyle(.plain)
    }

    private var tabBar: some View {
        let t = app.theme.current
        return HStack(spacing: t.space(.xs)) {
            ForEach(model.tabs, id: \.rawValue) { tab in
                Button {
                    model.tabIndex = tab
                } label: {
                    Text(tab.title)
                        .font(t.font(.fs13, weight: model.tabIndex == tab ? .bold : .medium))
                        .foregroundStyle(model.tabIndex == tab ? t.accentDeep : t.muted)
                        .padding(.horizontal, t.space(.md))
                        .padding(.vertical, t.space(.xs))
                        .background(
                            Capsule().fill(model.tabIndex == tab ? t.accentTint : Color.clear)
                        )
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func tabContent(_ view: RaceDetailViewData) -> some View {
        switch model.tabIndex {
        case .summary:
            VStack(alignment: .leading, spacing: 0) {
                kvRows(view.summary)
                if !view.channels.isEmpty { channels(view.channels) }
            }
        case .items:
            VStack(alignment: .leading, spacing: t_spaceLg) {
                ForEach(view.items) { section in
                    RaceItemSectionView(section: section)
                }
            }
        case .course:
            VStack(alignment: .leading, spacing: t_spaceLg) {
                ForEach(view.course.sections) { section in
                    RaceCourseSectionView(section: section, open: model.courseOpen) { key in
                        model.toggleCourse(key)
                    }
                }
            }
        case .trip:
            RaceTripBlock(trip: view.trip)
        }
    }

    private var t_spaceLg: CGFloat { app.theme.current.space(.lg) }

    @ViewBuilder
    private func kvRows(_ rows: [RaceKvRow]) -> some View {
        let t = app.theme.current
        VStack(spacing: 0) {
            ForEach(rows) { row in
                HStack(alignment: .top, spacing: t.space(.md)) {
                    Text(row.k)
                        .font(t.font(.fs13))
                        .foregroundStyle(t.muted)
                        .frame(width: 72, alignment: .leading)
                    Text(row.v)
                        .font(t.font(.fs13, weight: .medium))
                        .foregroundStyle(t.foreground)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, t.space(.sm))
            }
        }
        .padding(.horizontal, t.space(.md))
        .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))
    }

    @ViewBuilder
    private func channels(_ rows: [RaceChannelRow]) -> some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.sm)) {
            Text("报名渠道")
                .font(t.font(.fs13, weight: .bold))
                .foregroundStyle(t.foreground)
            ForEach(rows) { row in
                HStack(spacing: t.space(.sm)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.name)
                            .font(t.font(.fs13, weight: .medium))
                            .foregroundStyle(t.foreground)
                        Text(row.type)
                            .font(t.font(.fs11))
                            .foregroundStyle(t.mutedTwo)
                    }
                    Spacer()
                    if !row.copyUrl.isEmpty {
                        Button {
                            copy(row.copyUrl)
                        } label: {
                            Text("复制链接")
                                .font(t.font(.fs12, weight: .medium))
                                .foregroundStyle(t.accentDeep)
                                .padding(.horizontal, t.space(.sm))
                                .padding(.vertical, 5)
                                .background(Capsule().fill(t.accentTint))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
        }
        .padding(t.space(.md))
        .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))
    }

    private func copy(_ url: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = url
        // 成功不另发 toast：系统自带「已拷贝」提示，双 toast 会叠显（parity 同款）。
        #endif
    }

    // MARK: - 策略卡（两态）

    @ViewBuilder
    private var strategyCard: some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.sm)) {
            HStack {
                Text("比赛策略")
                    .font(t.font(.fs14, weight: .bold))
                    .foregroundStyle(t.foreground)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(t.mutedTwo)
            }
            if let summary = model.strategySummary {
                Text("目标 \(summary.target)" + (summary.count > 1 ? " · \(summary.count) 个版本" : ""))
                    .font(t.font(.fs13))
                    .foregroundStyle(t.muted)
                if !summary.updatedAt.isEmpty {
                    Text("更新于 \(summary.updatedAt)")
                        .font(t.font(.fs12))
                        .foregroundStyle(t.mutedTwo)
                }
            } else {
                Text("和教练聊聊这场比赛，生成你的专属配速策略")
                    .font(t.font(.fs13))
                    .foregroundStyle(t.muted)
            }
        }
        .padding(t.space(.md))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.accentTint.opacity(0.5)))
        .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.accent.opacity(0.25), lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture { model.strategyTap(app: app) }
    }
}

// MARK: - 头区

struct RaceDetailHeaderBlock: View {

    @Environment(AppModel.self) private var app
    let view: RaceDetailViewData
    let starred: Bool
    let onStar: () -> Void

    var body: some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.sm)) {
            HStack(alignment: .top, spacing: t.space(.sm)) {
                Text(view.head.name)
                    .font(t.font(.fs20, weight: .bold))
                    .foregroundStyle(t.foreground)
                Spacer()
                Button(action: onStar) {
                    Image(systemName: starred ? "star.fill" : "star")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(starred ? t.accentDeep : t.mutedTwo)
                }
                .buttonStyle(.plain)
            }
            HStack(spacing: 6) {
                if !view.head.cnBadgeText.isEmpty { badge(view.head.cnBadgeText, color: t.accentDeep) }
                if !view.head.waBadgeText.isEmpty { badge(view.head.waBadgeText, color: t.warning) }
            }
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        let t = app.theme.current
        return Text(text)
            .font(t.font(.fs10))
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(color.opacity(0.1)))
    }
}

// MARK: - 项目节

struct RaceItemSectionView: View {

    @Environment(AppModel.self) private var app
    let section: RaceItemSection

    var body: some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.sm)) {
            Text(section.title)
                .font(t.font(.fs14, weight: .bold))
                .foregroundStyle(t.foreground)
            ForEach(section.rows) { row in
                HStack(alignment: .top, spacing: t.space(.md)) {
                    Text(row.k)
                        .font(t.font(.fs13))
                        .foregroundStyle(t.muted)
                        .frame(width: 72, alignment: .leading)
                    Text(row.v)
                        .font(t.font(.fs13, weight: .medium))
                        .foregroundStyle(t.foreground)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 4)
            }
            if !section.route.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("赛道")
                        .font(t.font(.fs13))
                        .foregroundStyle(t.muted)
                    Text(section.route)
                        .font(t.font(.fs13, weight: .medium))
                        .foregroundStyle(t.foregroundSoft)
                }
                .padding(t.space(.sm))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: t.radius(.sm)).fill(t.grid))
            }
        }
        .padding(t.space(.md))
        .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))
    }
}

// MARK: - 赛道节（站点卡展开/收起）

struct RaceCourseSectionView: View {

    @Environment(AppModel.self) private var app
    let section: RaceCourseSection
    let open: Set<String>
    let onToggle: (String) -> Void

    var body: some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.sm)) {
            HStack(spacing: t.space(.sm)) {
                Text(section.title)
                    .font(t.font(.fs14, weight: .bold))
                    .foregroundStyle(t.foreground)
                if let km = section.distanceKm {
                    Text("\(Fmt.autoStr(km)) km")
                        .font(t.font(.fs12))
                        .foregroundStyle(t.muted)
                }
                if let ascent = section.ascent {
                    Text("爬升 D+\(ascent)m")
                        .font(t.font(.fs12))
                        .foregroundStyle(t.muted)
                }
            }
            if section.route.isEmpty {
                Text("赛道待补")
                    .font(t.font(.fs12))
                    .foregroundStyle(t.mutedTwo)
            } else {
                Text(section.route)
                    .font(t.font(.fs13))
                    .foregroundStyle(t.foregroundSoft)
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(section.stations) { station in
                    HStack(alignment: .top, spacing: t.space(.sm)) {
                        VStack(spacing: 0) {
                            Circle()
                                .fill(Tokens.color(station.colorHex))
                                .frame(width: 8, height: 8)
                                .padding(.top, 6)
                        }
                        stationCard(station)
                    }
                    .padding(.bottom, t.space(.sm))
                }
            }
        }
        .padding(t.space(.md))
        .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
        .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))
    }

    private func stationCard(_ station: CourseStation) -> some View {
        let t = app.theme.current
        let expanded = open.contains(station.key)
        return Button {
            onToggle(station.key)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(station.cat)
                        .font(t.font(.fs10, weight: .medium))
                        .foregroundStyle(Tokens.color(station.colorHex))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1.5)
                        .background(Capsule().fill(Tokens.color(station.colorHex).opacity(0.12)))
                    Text(station.km)
                        .font(t.font(.fs10, mono: true))
                        .foregroundStyle(t.mutedTwo)
                    Spacer()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(t.mutedTwo)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                Text(expanded ? station.body : station.title)
                    .font(t.font(.fs12, weight: expanded ? .regular : .medium))
                    .foregroundStyle(expanded ? t.foregroundSoft : t.foreground)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(t.space(.sm))
            .background(RoundedRectangle(cornerRadius: t.radius(.sm)).fill(t.grid))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 出行

struct RaceTripBlock: View {

    @Environment(AppModel.self) private var app
    let trip: RaceTripView

    var body: some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.lg)) {
            VStack(alignment: .leading, spacing: t.space(.sm)) {
                Text("领物")
                    .font(t.font(.fs13, weight: .bold))
                    .foregroundStyle(t.foreground)
                if trip.pickups.isEmpty {
                    Text("待发布")
                        .font(t.font(.fs12))
                        .foregroundStyle(t.mutedTwo)
                } else {
                    ForEach(trip.pickups) { p in
                        HStack(alignment: .top, spacing: t.space(.sm)) {
                            Text(p.time)
                                .font(t.font(.fs12, mono: true))
                                .foregroundStyle(t.muted)
                                .frame(width: 128, alignment: .leading)
                            Text(p.location)
                                .font(t.font(.fs12, weight: .medium))
                                .foregroundStyle(t.foreground)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .padding(t.space(.md))
            .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
            .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))

            if let city = trip.city {
                VStack(alignment: .leading, spacing: t.space(.sm)) {
                    Text(city.title)
                        .font(t.font(.fs13, weight: .bold))
                        .foregroundStyle(t.foreground)
                    ForEach(city.paragraphs) { p in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.k)
                                .font(t.font(.fs11))
                                .foregroundStyle(t.mutedTwo)
                            Text(p.v)
                                .font(t.font(.fs13))
                                .foregroundStyle(t.foregroundSoft)
                        }
                    }
                    ForEach(city.attractions, id: \.name) { a in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.name)
                                .font(t.font(.fs13, weight: .medium))
                                .foregroundStyle(t.foreground)
                            Text(a.description)
                                .font(t.font(.fs12))
                                .foregroundStyle(t.muted)
                        }
                        .padding(.top, t.space(.xs))
                    }
                }
                .padding(t.space(.md))
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: t.radius(.md)).fill(t.surface))
                .overlay(RoundedRectangle(cornerRadius: t.radius(.md)).stroke(t.borderSoft, lineWidth: 1))
            }
        }
    }
}

// MARK: - 报名选择器（底部 sheet）

struct RaceSignupSheet: View {

    @Environment(AppModel.self) private var app
    let model: RaceDetailModel

    var body: some View {
        let t = app.theme.current
        VStack(alignment: .leading, spacing: t.space(.md)) {
            Capsule()
                .fill(t.border)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)
            Text("报名状态")
                .font(t.font(.fs15, weight: .bold))
                .foregroundStyle(t.foreground)
            // 项目 chips
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: t.space(.sm)) {
                    ForEach(model.sheetChips) { chip in
                        Button {
                            model.selectChip(chip.token)
                        } label: {
                            Text(chip.label)
                                .font(t.font(.fs13, weight: model.sheetItem == chip.token ? .bold : .medium))
                                .foregroundStyle(model.sheetItem == chip.token ? t.onAccent : t.foregroundSoft)
                                .padding(.horizontal, t.space(.md))
                                .padding(.vertical, t.space(.xs))
                                .background(
                                    Capsule().fill(model.sheetItem == chip.token ? t.accent : t.surface)
                                )
                                .overlay(
                                    Capsule().stroke(model.sheetItem == chip.token ? Color.clear : t.borderSoft, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            // 状态单选
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(model.sheetStates, id: \.value) { state in
                        Button {
                            Task { await model.chooseState(state.value) }
                        } label: {
                            HStack {
                                Text(state.label)
                                    .font(t.font(.fs14, weight: state.current ? .bold : .regular))
                                    .foregroundStyle(state.current ? t.accentDeep : t.foreground)
                                Spacer()
                                if state.current {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundStyle(t.accentDeep)
                                }
                            }
                            .padding(.vertical, t.space(.sm))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .overlay(alignment: .bottom) {
                            if state.value != model.sheetStates.last?.value {
                                Rectangle().fill(t.borderSoft).frame(height: 0.5)
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: 320)
        }
        .padding(t.space(.lg))
        .background(t.background)
    }
}
