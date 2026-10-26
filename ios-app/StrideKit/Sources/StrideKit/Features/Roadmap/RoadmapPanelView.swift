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

    private func zones(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.xl)) {
            if !panel.releasedRows.isEmpty {
                zone(title: "最近上线", theme: theme) {
                    ForEach(panel.releasedRows) { row in
                        releasedRow(row, theme: theme)
                    }
                }
            }
            if !panel.acceptedRows.isEmpty {
                zone(title: "正在做", theme: theme) {
                    ForEach(panel.acceptedRows) { row in
                        acceptedRow(row, theme: theme)
                    }
                }
            }
            zone(title: "投票池", theme: theme) {
                ForEach(panel.poolRows) { row in
                    poolRow(row, theme: theme)
                }
                Text("每人可给多个想法投票，再点一次可撤销；已排期或上线后不可再投。")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.mutedTwo)
                    .padding(.top, theme.space(.xs))
            }
        }
        .padding(theme.space(.lg))
    }

    private func zone<Content: View>(title: String, theme: any Theme, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            Text(title)
                .font(theme.font(.fs14, weight: .bold))
                .foregroundStyle(theme.foreground)
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
