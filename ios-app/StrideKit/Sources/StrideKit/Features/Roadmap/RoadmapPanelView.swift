import SwiftUI

/// 产品路线面板（devops#553 原型 514 variant C，2026-10-20 拍板三区平铺
/// 不折叠）。feedback 二级 tab 与 product-roadmap 薄壳共用；行点按进详情页。
public struct RoadmapPanelView: View {

    @Environment(AppModel.self) private var model
    @State private var panel = RoadmapPanelModel()

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        Group {
            if panel.loading {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 200)
            } else if !panel.loadError.isEmpty {
                errorCard(theme)
            } else {
                zones(theme)
            }
        }
        .raceToast(panel.toastMessage) { panel.toastMessage = nil }
        .task { await panel.activate(app: model) }
    }

    private func errorCard(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            Text(panel.loadError)
                .font(theme.font(.fs14))
                .foregroundStyle(theme.muted)
            Button("重试") {
                Task { await panel.fetch() }
            }
            .font(theme.font(.fs14, weight: .medium))
            .foregroundStyle(theme.accentDeep)
        }
        .frame(maxWidth: .infinity)
        .padding(theme.space(.xl))
    }

    // MARK: - 三区平铺

    @ViewBuilder
    private func zones(_ theme: any Theme) -> some View {
        // devops#1018 P2：空区整区隐藏不留白（released/accepted 原有；投票池
        // 空时连区头带投票规则说明一起收起，不再渲染「0 个想法」空壳）；
        // 三区全空走 mp 全量空态（roadmap-panel empty 同款文案）。
        if panel.releasedRows.isEmpty && panel.acceptedRows.isEmpty && panel.poolRows.isEmpty {
            VStack(spacing: theme.space(.xs)) {
                Text("产品路线还在筹备中")
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(theme.muted)
                Text("上线后在这里投票，决定我们做什么")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.mutedTwo)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, theme.space(.xxl))
        } else {
            VStack(alignment: .leading, spacing: theme.space(.xl)) {
                if !panel.releasedRows.isEmpty {
                    zone(title: "最近上线", subtitle: "你的票变成了功能", count: "\(panel.releasedRows.count)", dot: theme.accentDeep, theme: theme) {
                        ForEach(panel.releasedRows) { row in
                            releasedRow(row, theme: theme)
                        }
                    }
                }
                if !panel.acceptedRows.isEmpty {
                    zone(title: "正在做", subtitle: "已采纳", count: "\(panel.acceptedRows.count)", dot: theme.warning, theme: theme) {
                        ForEach(panel.acceptedRows) { row in
                            acceptedRow(row, theme: theme)
                        }
                    }
                }
                if !panel.poolRows.isEmpty {
                    zone(title: "投票池", subtitle: "决定我们接下来做什么", count: "\(panel.poolRows.count) 个想法", dot: theme.accent, theme: theme) {
                        ForEach(panel.poolRows) { row in
                            poolRow(row, theme: theme)
                        }
                        Text("每人可给多个想法投票，再点一次可撤销；已排期或上线后不可再投。")
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.mutedTwo)
                            .padding(.top, theme.space(.xs))
                    }
                }
            }
            .padding(theme.space(.lg))
        }
    }

    /// 区头（mp sec-head 同款：彩色点 + 标题 + 副标题 + 右侧计数徽标；
    /// devops#1003 P2-5 三区分组强化。点色映射 mp success/info/accent →
    /// 主题 token accentDeep/warning/accent）。
    private func zone<Content: View>(title: String, subtitle: String, count: String, dot: Color, theme: any Theme, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            HStack(spacing: theme.space(.sm)) {
                Circle().fill(dot).frame(width: 6, height: 6)
                Text(title)
                    .font(theme.font(.fs14, weight: .bold))
                    .foregroundStyle(theme.foreground)
                Text("· \(subtitle)")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
                Spacer()
                Text(count)
                    .font(theme.font(.fs11, weight: .medium))
                    .foregroundStyle(theme.muted)
                    .padding(.horizontal, theme.space(.sm))
                    .padding(.vertical, 2)
                    .background(Capsule().fill(theme.borderSoft))
            }
            VStack(alignment: .leading, spacing: theme.space(.md)) {
                content()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func rowTap(_ id: Int) {
        model.router.push(.roadmapDetail(id: id))
    }

    private func releasedRow(_ row: RoadmapPanelModel.ReleasedRow, theme: any Theme) -> some View {
        Button {
            rowTap(row.id)
        } label: {
            HStack(alignment: .top, spacing: theme.space(.md)) {
                Circle()
                    .fill(theme.accent)
                    .frame(width: 8, height: 8)
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    HStack(spacing: theme.space(.sm)) {
                        Text(row.date)
                            .font(theme.font(.fs12, mono: true))
                            .foregroundStyle(theme.muted)
                        Text(row.title)
                            .font(theme.font(.fs15, weight: .medium))
                            .foregroundStyle(theme.foreground)
                    }
                    if !row.blurb.isEmpty {
                        Text(row.blurb)
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.muted)
                            .lineLimit(2)
                    }
                    Text("由 \(row.proof) 位跑友投票促成")
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.mutedTwo)
                }
                Spacer()
            }
        }
        .buttonStyle(.plain)
    }

    private func acceptedRow(_ row: RoadmapPanelModel.AcceptedRow, theme: any Theme) -> some View {
        Button {
            rowTap(row.id)
        } label: {
            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                HStack(spacing: theme.space(.sm)) {
                    Text(row.title)
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    if !row.plannedNote.isEmpty {
                        Text(row.plannedNote)
                            .font(theme.font(.fs11))
                            .foregroundStyle(theme.accentDeep)
                            .padding(.horizontal, theme.space(.sm))
                            .padding(.vertical, 2)
                            .background(Capsule().strokeBorder(theme.accent.opacity(0.4)))
                    }
                    Spacer()
                    Text("\(row.votes) 票")
                        .font(theme.font(.fs12, mono: true))
                        .foregroundStyle(theme.muted)
                }
                if !row.blurb.isEmpty {
                    Text(row.blurb)
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.muted)
                        .lineLimit(2)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func poolRow(_ row: RoadmapPanelModel.PoolRow, theme: any Theme) -> some View {
        HStack(alignment: .top, spacing: theme.space(.md)) {
            Button {
                rowTap(row.id)
            } label: {
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    HStack(spacing: theme.space(.sm)) {
                        if row.isNew {
                            Text("NEW")
                                .font(theme.font(.fs10, weight: .bold))
                                .foregroundStyle(theme.onAccent)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Capsule().fill(theme.danger))
                        }
                        Text(row.title)
                            .font(theme.font(.fs15, weight: .medium))
                            .foregroundStyle(theme.foreground)
                    }
                    if !row.blurb.isEmpty {
                        Text(row.blurb)
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.muted)
                            .lineLimit(2)
                    }
                }
                Spacer()
            }
            .buttonStyle(.plain)

            Button {
                Task { await panel.toggleVote(row.id) }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: row.voted ? "checkmark" : "arrowtriangle.up.fill")
                        .font(theme.font(.fs11))
                    Text("\(row.votes)")
                        .font(theme.font(.fs13, mono: true))
                }
                .foregroundStyle(row.voted ? theme.onAccent : theme.muted)
                .padding(.horizontal, theme.space(.md))
                .padding(.vertical, theme.space(.xs))
                .background(Capsule().fill(row.voted ? theme.accent : theme.surface)
                    .overlay(Capsule().strokeBorder(row.voted ? Color.clear : theme.border)))
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, theme.space(.xs))
    }
}
