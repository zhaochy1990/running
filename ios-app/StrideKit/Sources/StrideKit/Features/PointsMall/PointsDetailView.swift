import SwiftUI

/// 积分明细页（devops#938，mp pages/points-detail 直译）：余额大数字白卡 →
/// 流水倒序列表（类型/时间/带符号分值 + redeem 订单号副行 + 调分原因副行）→
/// 加载更多 → 空态「去签到赚分」。
public struct PointsDetailView: View {

    @Environment(AppModel.self) private var model
    @State private var home = PointsDetailModel()

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(spacing: theme.space(.md)) {
                if home.loadFailed {
                    VStack(spacing: theme.space(.md)) {
                        Text("加载失败")
                            .font(theme.font(.fs15, weight: .medium))
                            .foregroundStyle(theme.muted)
                        Button("重试") { Task { await home.load() } }
                            .font(theme.font(.fs15, weight: .medium))
                            .foregroundStyle(theme.accent)
                    }
                    .padding(.vertical, theme.space(.xl))
                } else if home.loading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, theme.space(.xl))
                } else {
                    balanceCard(theme)
                    if home.rows.isEmpty {
                        emptyState(theme)
                    } else {
                        ledgerCard(theme)
                        footer(theme)
                    }
                }
            }
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle("积分明细")
        .inlineNavigationTitle()
        .raceToast(home.toastMessage) { home.toastMessage = nil }
        .task { await home.activate(app: model) }
        .onAppear { Task { await home.reappear() } }
    }

    private func balanceCard(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.xs)) {
            Text("当前积分")
                .font(theme.font(.fs13))
                .foregroundStyle(theme.muted)
            Text("\(home.balance)")
                .font(theme.font(.fsDisplay40, weight: .bold))
                .foregroundStyle(theme.foreground)
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    private func emptyState(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.sm)) {
            Text("暂无积分明细")
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.muted)
            Button("去签到赚分 ›") { model.router.push(.checkin(gained: nil)) }
                .font(theme.font(.fs13, weight: .medium))
                .foregroundStyle(theme.accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, theme.space(.xxxl))
    }

    private func ledgerCard(_ theme: any Theme) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(home.rows.enumerated()), id: \.element.id) { index, row in
                ledgerRow(row, theme: theme)
                if index < home.rows.count - 1 {
                    Divider().overlay(theme.borderSoft)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
        .clipShape(RoundedRectangle(cornerRadius: theme.radius(.lg)))
    }

    private func ledgerRow(_ row: PointDetailRow, theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.label)
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Text(row.delta)
                    .font(theme.font(.fs15, weight: .bold))
                    .foregroundStyle(row.positive ? theme.accentDeep : theme.muted)
                    .monospacedDigit()
            }
            HStack(alignment: .firstTextBaseline) {
                Text(row.time)
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.mutedTwo)
                Spacer()
                if !row.ref.isEmpty {
                    Text(row.ref)
                        .font(theme.font(.fs11, mono: true))
                        .foregroundStyle(theme.mutedTwo)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            if !row.remark.isEmpty {
                Text(row.remark)
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
            }
        }
        .padding(theme.space(.lg))
    }

    @ViewBuilder
    private func footer(_ theme: any Theme) -> some View {
        if home.hasMore {
            Button {
                Task { await home.loadMore() }
            } label: {
                HStack(spacing: theme.space(.xs)) {
                    if home.loadingMore {
                        ProgressView().controlSize(.small)
                    }
                    Text(home.loadingMore ? "加载中…" : "加载更多")
                }
                .font(theme.font(.fs13))
                .foregroundStyle(theme.muted)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .disabled(home.loadingMore)
        } else {
            Text("— 到底啦 —")
                .font(theme.font(.fs12))
                .foregroundStyle(theme.mutedTwo)
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.xs))
        }
    }
}
