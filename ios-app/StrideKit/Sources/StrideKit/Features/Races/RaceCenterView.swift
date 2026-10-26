import SwiftUI

/// 赛事中心（devops#769，baseline §5.1 直译）：筛选栏（年份/项目/省份 Menu
/// = 服务端过滤、收藏开关 = 客户端过滤即点即效）→ 月份分组密表 → 三段空态；
/// onShow 重拉真值 + 同键静默刷新；星标乐观更新失败回滚。
public struct RaceCenterView: View {

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = RaceCenterModel()

    public init() {}

    public var body: some View {
        let t = app.theme.current
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                if !model.error.isEmpty { errorBanner }
                if model.loading {
                    ProgressView()
                        .tint(t.mutedTwo)
                        .frame(maxWidth: .infinity)
                        .padding(.top, t.space(.xxxl))
                } else if !model.groups.isEmpty {
                    monthList
                } else {
                    emptyCard
                }
            }
            .padding(.horizontal, t.space(.md))
        }
        .background(t.background)
        .navigationTitle("赛事中心")
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .raceTopBarTrailing) {
                Button("我的赛事") { app.router.push(.myRaces) }
                    .font(t.font(.fs13, weight: .medium))
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { filterBar }
        .refreshable { await model.refresh() }
        .task { await model.activate(app: app) }
        .onAppear { Task { await model.onShowRefresh() } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.onShowRefresh() } }
        }
        .raceToast(model.toast) { model.clearToast() }
    }

    // MARK: - 筛选栏

    private var filterBar: some View {
        let t = app.theme.current
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: t.space(.sm)) {
                filterMenu(
                    title: model.years.indices.contains(model.yearIndex) ? model.years[model.yearIndex] : "",
                    items: model.years.map { ($0, $0) },
                    select: { model.selectYear(model.years.firstIndex(of: $0) ?? 0) }
                )
                filterMenu(
                    title: raceTypeOptions.indices.contains(model.typeIndex) ? raceTypeOptions[model.typeIndex].label : "全部",
                    items: raceTypeOptions.map { ($0.label, $0.label) },
                    select: { label in
                        model.selectType(raceTypeOptions.firstIndex(where: { $0.label == label }) ?? 0)
                    }
                )
                filterMenu(
                    title: model.provinceNames.indices.contains(model.provinceIndex) ? model.provinceNames[model.provinceIndex] : "全部",
                    items: model.provinceNames.map { ($0, $0) },
                    select: { model.selectProvince(model.provinceNames.firstIndex(of: $0) ?? 0) }
                )
                Button {
                    model.toggleFavOnly()
                } label: {
                    Image(systemName: model.favOnly ? "star.fill" : "star")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(model.favOnly ? t.accentDeep : t.muted)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, t.space(.md))
            .padding(.vertical, t.space(.sm))
        }
        .frame(maxWidth: .infinity)
        .background(t.background.opacity(0.96))
        .overlay(alignment: .bottom) { Rectangle().fill(t.borderSoft).frame(height: 0.5) }
    }

    private func filterMenu(title: String, items: [(String, String)], select: @escaping (String) -> Void) -> some View {
        let t = app.theme.current
        return Menu {
            ForEach(items, id: \.1) { label, _ in
                Button(label) { select(label) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .medium))
            }
            .font(t.font(.fs13))
            .foregroundStyle(t.foregroundSoft)
            .padding(.horizontal, t.space(.sm))
            .padding(.vertical, 6)
            .background(Capsule().fill(t.surface))
            .overlay(Capsule().stroke(t.borderSoft, lineWidth: 1))
        }
    }

    // MARK: - 列表

    private var monthList: some View {
        let t = app.theme.current
        return ForEach(model.groups) { group in
            Section {
                ForEach(group.rows) { row in
                    RaceCenterRowView(row: row) {
                        app.router.push(.raceDetail(id: row.id))
                    } onStar: {
                        Task { await model.toggleStar(row.id) }
                    }
                }
            } header: {
                HStack(spacing: t.space(.sm)) {
                    Text(group.label)
                        .font(t.font(.fs13, weight: .bold))
                        .foregroundStyle(t.foreground)
                    Text("\(group.rows.count) 场")
                        .font(t.font(.fs12))
                        .foregroundStyle(t.mutedTwo)
                    Spacer()
                }
                .padding(.top, t.space(.lg))
                .padding(.bottom, t.space(.xs))
                .background(t.background)
            }
        }
    }

    private var errorBanner: some View {
        let t = app.theme.current
        return Text(model.error)
            .font(t.font(.fs12))
            .foregroundStyle(t.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, t.space(.sm))
    }

    private var emptyCard: some View {
        let t = app.theme.current
        return VStack(spacing: t.space(.sm)) {
            Text(model.emptyText.isEmpty ? "暂无赛事" : model.emptyText)
                .font(t.font(.fs14, weight: .medium))
                .foregroundStyle(t.muted)
                .multilineTextAlignment(.center)
            Text("共 \(model.viewCount) 场")
                .font(t.font(.fs12))
                .foregroundStyle(t.mutedTwo)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, t.space(.xxxl))
    }
}

/// 一行密表：日期块 + 名称/徽章 + 城市·项目 + 星标。
struct RaceCenterRowView: View {

    @Environment(AppModel.self) private var app
    let row: RaceRowView
    let onTap: () -> Void
    let onStar: () -> Void

    var body: some View {
        let t = app.theme.current
        Button(action: onTap) {
            HStack(alignment: .center, spacing: t.space(.md)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.dateLabel)
                        .font(t.font(.fs15, weight: .bold, mono: true))
                        .foregroundStyle(t.foreground)
                    Text(row.weekday)
                        .font(t.font(.fs11))
                        .foregroundStyle(t.mutedTwo)
                }
                .frame(width: 46, alignment: .leading)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                        .font(t.font(.fs14, weight: .medium))
                        .foregroundStyle(t.foreground)
                        .lineLimit(1)
                    badgeLine
                    Text([row.city, row.typesLabel].joined(separator: " · "))
                        .font(t.font(.fs12))
                        .foregroundStyle(t.mutedTwo)
                        .lineLimit(1)
                }
                Spacer(minLength: t.space(.xs))
                Button(action: onStar) {
                    Image(systemName: row.starred ? "star.fill" : "star")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(row.starred ? t.accentDeep : t.mutedTwo)
                }
                .buttonStyle(.plain)
            }
            .padding(.vertical, t.space(.sm))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Rectangle().fill(t.borderSoft).frame(height: 0.5).padding(.leading, t.space(.md))
        }
    }

    @ViewBuilder
    private var badgeLine: some View {
        let t = app.theme.current
        if !row.cnBadgeText.isEmpty || !row.waBadgeText.isEmpty {
            HStack(spacing: 4) {
                if !row.cnBadgeText.isEmpty { badge(row.cnBadgeText, color: t.accentDeep) }
                if !row.waBadgeText.isEmpty { badge(row.waBadgeText, color: t.warning) }
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
