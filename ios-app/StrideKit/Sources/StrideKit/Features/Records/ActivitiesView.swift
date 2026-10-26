import SwiftUI

/// 记录 tab（devops#766，baseline §2.2 直译）：
/// 月份折叠分组 → 行（缩略图/运动图标 + 名称 + 日期 + 指标 + 负荷）→
/// 空态卡 → 加载更多按钮分页；下拉刷新；失败静默保持空态。
public struct ActivitiesView: View {

    @Environment(AppModel.self) private var app
    @State private var model = ActivitiesModel()

    public init() {}

    public var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if !model.monthGroups.isEmpty {
                    monthList
                } else if !model.loading {
                    emptyCard
                }
                if model.hasMore && !model.monthGroups.isEmpty {
                    loadMoreButton
                }
                if model.loading {
                    ProgressView()
                        .tint(app.theme.current.mutedTwo)
                        .padding(.top, app.theme.current.space(.xxl))
                }
            }
            .padding(.horizontal, app.theme.current.space(.md))
            .padding(.top, app.theme.current.space(.xs))
        }
        .background(app.theme.current.background)
        .navigationTitle("活动记录")
        .inlineNavigationTitle()
        .refreshable { await model.fetch() }
        .task { await model.activate(app: app) }
    }

    // MARK: - 月份分组

    private var monthList: some View {
        LazyVStack(spacing: 0) {
            ForEach(model.monthGroups) { group in
                monthGroup(group)
            }
        }
    }

    @ViewBuilder
    private func monthGroup(_ group: ActivitiesModel.MonthGroup) -> some View {
        VStack(spacing: 0) {
            Button {
                model.toggleMonth(group.monthKey)
            } label: {
                HStack(spacing: app.theme.current.space(.sm)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(group.label)
                            .font(app.theme.current.font(.fs14, weight: .medium))
                            .foregroundStyle(app.theme.current.foreground)
                        Text("\(group.count) 次 · \(group.km) km · \(group.duration)")
                            .font(app.theme.current.font(.fs12))
                            .foregroundStyle(app.theme.current.muted)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(app.theme.current.mutedTwo)
                        .rotationEffect(.degrees(group.expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
                .padding(.vertical, app.theme.current.space(.sm))
            }
            .buttonStyle(.plain)

            if group.expanded {
                VStack(spacing: app.theme.current.space(.sm)) {
                    if group.rows.isEmpty {
                        Text("本月暂无活动")
                            .font(app.theme.current.font(.fs12))
                            .foregroundStyle(app.theme.current.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, app.theme.current.space(.md))
                    } else {
                        ForEach(group.rows) { row in
                            ActivityRowView(row: row) {
                                app.router.push(.activityDetail(labelId: row.labelId))
                            } onThumbError: {
                                model.clearThumb(row.labelId)
                            }
                        }
                    }
                }
                .padding(.bottom, app.theme.current.space(.sm))
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(app.theme.current.borderSoft)
                .frame(height: 0.5)
        }
        .padding(.bottom, 1)
    }

    // MARK: - 空态 / 分页

    private var emptyCard: some View {
        VStack(spacing: app.theme.current.space(.sm)) {
            Text(model.emptyTitle)
                .font(app.theme.current.font(.fs15, weight: .medium))
                .foregroundStyle(app.theme.current.muted)
            Text("完成一次训练后同步展示")
                .font(app.theme.current.font(.fs12))
                .foregroundStyle(app.theme.current.mutedTwo)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, app.theme.current.space(.xxxl))
    }

    private var loadMoreButton: some View {
        Button {
            Task { await model.loadMore() }
        } label: {
            HStack(spacing: app.theme.current.space(.xs)) {
                if model.loadingMore {
                    ProgressView()
                        .controlSize(.small)
                }
                Text(model.loadingMore ? "加载中..." : "加载更早的记录")
            }
            .font(app.theme.current.font(.fs13, weight: .medium))
            .foregroundStyle(app.theme.current.accentDeep)
            .frame(maxWidth: .infinity)
            .padding(.vertical, app.theme.current.space(.lg))
        }
        .buttonStyle(.plain)
        .disabled(model.loadingMore)
    }
}

/// 单条活动行：缩略图（后端预渲染路线 PNG，加载失败回退运动图标）+
/// 名称/日期/指标串 + 右侧负荷。
struct ActivityRowView: View {

    @Environment(AppModel.self) private var app
    let row: ActivitiesModel.ActivityRow
    let onTap: () -> Void
    let onThumbError: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: app.theme.current.space(.md)) {
                thumb
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.name)
                        .font(app.theme.current.font(.fs14, weight: .medium))
                        .foregroundStyle(app.theme.current.foreground)
                        .lineLimit(1)
                    Text(row.date)
                        .font(app.theme.current.font(.fs12))
                        .foregroundStyle(app.theme.current.muted)
                    Text(metaLine)
                        .font(app.theme.current.font(.fs12))
                        .foregroundStyle(app.theme.current.mutedTwo)
                        .lineLimit(1)
                }
                Spacer(minLength: app.theme.current.space(.xs))
                VStack(spacing: 2) {
                    if row.load != "—" {
                        Text(row.load)
                            .font(app.theme.current.font(.fs15, weight: .bold, mono: true))
                            .foregroundStyle(app.theme.current.accentDeep)
                    }
                    Text("负荷")
                        .font(app.theme.current.font(.fs11))
                        .foregroundStyle(app.theme.current.mutedTwo)
                }
            }
            .padding(.vertical, app.theme.current.space(.sm))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 指标串（缺失项跳过，段落间 ` · ` 分隔；parity 同款）。
    private var metaLine: String {
        var parts: [String] = []
        if row.distanceKm != "—" { parts.append("\(row.distanceKm) km") }
        if row.duration != "—" { parts.append(row.duration) }
        if row.pace != "—" { parts.append(row.pace) }
        if row.avgHr != "—" { parts.append("\(row.avgHr) bpm") }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var thumb: some View {
        ZStack {
            RoundedRectangle(cornerRadius: app.theme.current.radius(.sm))
                .fill(app.theme.current.accentTint)
            if let url = row.thumbURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .failure:
                        // 加载失败回退运动图标（不留空白圆槽）；
                        // onAppear 上报一次，model 记住该行不再加载。
                        fallbackIcon.onAppear { onThumbError() }
                    default:
                        Color.clear
                    }
                }
            } else {
                fallbackIcon
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: app.theme.current.radius(.sm)))
    }

    private var fallbackIcon: some View {
        Image(systemName: row.systemImage)
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(app.theme.current.accent)
    }
}
