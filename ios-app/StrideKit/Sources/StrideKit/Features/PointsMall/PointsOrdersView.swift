import SwiftUI

/// 我的兑换页（devops#938，mp pages/points-orders 直译）：订单卡列表
/// （时间+状态 chip 四态 / 订单号+复制 / 商品行 / 运费快照 / 快递信息+复制 /
/// 待支付小程序引导文案 / 已取消退分说明）+ cursor 加载更多 + 空态。
public struct PointsOrdersView: View {

    @Environment(AppModel.self) private var model
    @State private var home = PointsOrdersModel()

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
                } else if home.orders.isEmpty {
                    emptyState(theme)
                } else {
                    ForEach(home.orders) { row in
                        orderCard(row, theme: theme)
                    }
                    footer(theme)
                }
            }
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle("我的兑换")
        .inlineNavigationTitle()
        .raceToast(home.toastMessage) { home.toastMessage = nil }
        .task { await home.activate(app: model) }
        .onAppear { Task { await home.reappear() } }
    }

    private func emptyState(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.sm)) {
            Image(systemName: "shippingbox")
                .font(theme.font(.fsDisplay40))
                .foregroundStyle(theme.mutedTwo)
            Text("还没有兑换记录")
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.muted)
            Button("去商城挑点喜欢的吧") { model.router.push(.pointsMall) }
                .font(theme.font(.fs13, weight: .medium))
                .foregroundStyle(theme.accent)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, theme.space(.xxxl))
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

    private func orderCard(_ row: OrderRow, theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            HStack {
                Text(row.date)
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
                Spacer()
                statusChip(row.chip, theme: theme)
            }

            Button {
                home.copyOrderNo(row)
            } label: {
                HStack(spacing: theme.space(.xs)) {
                    Text("R-\(row.id)")
                        .font(theme.font(.fs11, mono: true))
                        .foregroundStyle(theme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Image(systemName: "doc.on.doc")
                        .font(theme.font(.fs10))
                        .foregroundStyle(theme.mutedTwo)
                }
            }
            .buttonStyle(.plain)

            HStack(alignment: .top, spacing: theme.space(.md)) {
                orderImage(row, theme: theme)
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.name)
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    if !row.skuLabel.isEmpty {
                        Text("尺码 \(row.skuLabel)")
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                    }
                    Text("寄到 \(row.destination)")
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.muted)
                }
                Spacer()
                Text("-\(row.cost)")
                    .font(theme.font(.fs15, weight: .bold))
                    .foregroundStyle(theme.accentDeep)
            }

            HStack {
                Text("运费")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
                Spacer()
                Text(row.feeText)
                    .font(theme.font(.fs12, weight: .medium))
                    .foregroundStyle(row.feeFree ? Color.green : theme.warning)
            }

            if row.payPending {
                Text("本单含运费，请在砺跑马拉松助手小程序完成支付；超时未支付将自动取消并退回积分")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.warning)
            }
            if row.cancelled {
                Text("超时未支付已自动取消，积分已退回")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
            }
            if row.shipped {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        if !row.courier.isEmpty {
                            Text(row.courier)
                                .font(theme.font(.fs12))
                                .foregroundStyle(theme.muted)
                        }
                        Text(row.trackingNo)
                            .font(theme.font(.fs12, mono: true))
                            .foregroundStyle(theme.muted)
                    }
                    Spacer()
                    Button {
                        home.copyTracking(row)
                    } label: {
                        Text("复制单号")
                            .font(theme.font(.fs11, weight: .medium))
                            .foregroundStyle(theme.accentDeep)
                            .padding(.horizontal, theme.space(.sm))
                            .padding(.vertical, 2)
                            .background(Capsule().strokeBorder(theme.accent.opacity(0.5)))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    @ViewBuilder
    private func orderImage(_ row: OrderRow, theme: any Theme) -> some View {
        if let url = row.imageURL.isEmpty ? nil : URL(string: row.imageURL) {
            AsyncImage(url: url) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Rectangle().fill(theme.accentTint.opacity(0.4))
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: theme.radius(.md)))
        } else {
            RoundedRectangle(cornerRadius: theme.radius(.md))
                .fill(theme.accentTint.opacity(0.4))
                .frame(width: 56, height: 56)
                .overlay {
                    Image(systemName: "gift")
                        .font(theme.font(.fs18))
                        .foregroundStyle(theme.accentDeep.opacity(0.7))
                }
        }
    }

    /// 状态 chip 四态配色（待支付橙 / 待发货橙黄 / 已发货绿 / 已取消灰）。
    private func statusChip(_ chip: OrderStatusChip, theme: any Theme) -> some View {
        let color: Color = switch chip.style {
        case .unpaid: theme.warning
        case .pending: theme.warning.opacity(0.75)
        case .shipped: Color.green
        case .cancelled: theme.muted
        }
        return Text(chip.label)
            .font(theme.font(.fs11, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, theme.space(.sm))
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.12)))
    }
}
