import SwiftUI

/// 积分商城页（devops#938，mp pages/points-mall 直译）：hero（余额 + 四链接）
/// → 商品横排大卡列表（四态）→ 确认抽屉（尺码/数量/地址/运费/余额三态）→
/// 兑换成功弹卡 → 兑换规则弹窗。免支付口径：无支付流、无运费闸门。
public struct PointsMallView: View {

    @Environment(AppModel.self) private var model
    @State private var home = PointsMallModel()

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        ZStack {
            ScrollView {
                VStack(spacing: theme.space(.lg)) {
                    if home.loadFailed {
                        retryCard(theme)
                    } else {
                        heroCard(theme)
                        productList(theme)
                    }
                }
                .padding(theme.space(.lg))
            }
            if home.okVisible {
                okCard(theme)
            }
        }
        .background(theme.background)
        .navigationTitle("积分商城")
        .inlineNavigationTitle()
        .raceToast(home.toastMessage) { home.toastMessage = nil }
        .task { await home.activate(app: model) }
        .onAppear { Task { await home.reappear() } }
        .sheet(isPresented: confirmSheet) { confirmSheetView(theme) }
        .sheet(isPresented: rulesBinding) { RulesSheet(document: mallRulesDocument, onClose: home.hideRules) }
    }

    private var confirmSheet: Binding<Bool> {
        Binding(
            get: { home.sheetVisible },
            set: { if !$0 { home.closeSheet() } }
        )
    }

    private var rulesBinding: Binding<Bool> {
        Binding(get: { home.rulesVisible }, set: { if !$0 { home.hideRules() } })
    }

    private func retryCard(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            heroCard(theme)
            Text("加载失败")
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.muted)
            Button("重试") { Task { await home.load() } }
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.accent)
        }
    }

    // MARK: - hero（余额 + 明细/兑换记录/签到赚分/兑换规则四链接）

    private func heroCard(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            Text("我的积分")
                .font(theme.font(.fs13))
                .foregroundStyle(theme.onAccent.opacity(0.9))
            Text("\(home.balance) 分")
                .font(theme.font(.fsDisplay40, weight: .bold))
                .foregroundStyle(theme.onAccent)
            HStack(spacing: theme.space(.lg)) {
                Button("明细 ›") { model.router.push(.pointsDetail) }
                Button("兑换记录 ›") { model.router.push(.pointsOrders) }
                Button("签到赚分 ›") { model.router.push(.checkin(gained: nil)) }
                Button("兑换规则") { home.showRules() }
            }
            .font(theme.font(.fs12, weight: .medium))
            .foregroundStyle(theme.onAccent.opacity(0.95))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(theme.space(.lg))
        .background(
            LinearGradient(
                colors: [theme.accent, theme.accentDeep],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            .clipShape(RoundedRectangle(cornerRadius: theme.radius(.lg)))
        )
    }

    // MARK: - 商品横排大卡（四态）

    @ViewBuilder
    private func productList(_ theme: any Theme) -> some View {
        if home.loading {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.xl))
        } else if home.products.isEmpty {
            VStack(spacing: theme.space(.sm)) {
                Image(systemName: "gift")
                    .font(theme.font(.fsDisplay40))
                    .foregroundStyle(theme.mutedTwo)
                Text("商城筹备中，敬请期待")
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.muted)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, theme.space(.xxxl))
        } else {
            ForEach(home.products) { product in
                productCard(product, theme: theme)
            }
        }
    }

    private func productCard(_ product: MallProduct, theme: any Theme) -> some View {
        let disabled = product.soldOut || product.limitHit
        return Button {
            guard !disabled else { return }
            home.openSheet(product: product)
        } label: {
            HStack(alignment: .top, spacing: theme.space(.md)) {
                productImage(product, theme: theme)
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    Text(product.name)
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .multilineTextAlignment(.leading)
                    if !product.description.isEmpty {
                        Text(product.description)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    tagRow(product, theme: theme)
                    HStack {
                        Text("\(product.price) 积分")
                            .font(theme.font(.fs15, weight: .bold))
                            .foregroundStyle(theme.accentDeep)
                        Spacer()
                        redeemButton(product, theme: theme)
                    }
                }
            }
            .padding(theme.space(.lg))
            .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
            .overlay {
                if product.soldOut {
                    ZStack {
                        RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.background.opacity(0.55))
                        Text("已售罄")
                            .font(theme.font(.fs18, weight: .bold))
                            .foregroundStyle(theme.muted)
                            .padding(theme.space(.xs))
                            .background(Capsule().strokeBorder(theme.muted, lineWidth: 1))
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func productImage(_ product: MallProduct, theme: any Theme) -> some View {
        Group {
            if let url = product.imageURL.isEmpty ? nil : URL(string: product.imageURL) {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Rectangle().fill(theme.accentTint.opacity(0.4))
                }
                .frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: theme.radius(.md)))
            } else {
                RoundedRectangle(cornerRadius: theme.radius(.md))
                    .fill(theme.accentTint.opacity(0.4))
                    .frame(width: 96, height: 96)
                    .overlay {
                        Image(systemName: "gift")
                            .font(theme.font(.fsDisplay40))
                            .foregroundStyle(theme.accentDeep.opacity(0.7))
                    }
            }
        }
    }

    /// tag 行：「每人限 N 件」「已兑 n/limit」「售罄」。
    private func tagRow(_ product: MallProduct, theme: any Theme) -> some View {
        HStack(spacing: theme.space(.xs)) {
            if product.limit > 0 {
                tag("每人限 \(product.limit) 件", theme: theme)
                if product.limitHit {
                    tag("已兑 \(product.redeemed)/\(product.limit)", theme: theme)
                } else {
                    tag("已兑 \(product.redeemed)/\(product.limit)", theme: theme, dim: true)
                }
            }
            if product.soldOut {
                tag("售罄", theme: theme)
            }
        }
    }

    private func tag(_ text: String, theme: any Theme, dim: Bool = false) -> some View {
        Text(text)
            .font(theme.font(.fs11))
            .foregroundStyle(dim ? theme.muted : theme.accentDeep)
            .padding(.horizontal, theme.space(.sm))
            .padding(.vertical, 2)
            .background(Capsule().fill(theme.accentTint.opacity(dim ? 0.25 : 0.4)))
    }

    private func redeemButton(_ product: MallProduct, theme: any Theme) -> some View {
        let disabled = product.soldOut || product.limitHit
        let title = product.limitHit ? "已达限购" : (product.soldOut ? "已售罄" : "兑换")
        return Text(title)
            .font(theme.font(.fs13, weight: .medium))
            .foregroundStyle(disabled ? theme.muted : theme.onAccent)
            .padding(.horizontal, theme.space(.lg))
            .padding(.vertical, theme.space(.xs))
            .background(Capsule().fill(disabled ? theme.borderSoft : theme.accent))
    }

    // MARK: - 确认抽屉（底部 sheet）

    private func confirmSheetView(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            Capsule()
                .fill(theme.borderSoft)
                .frame(width: 36, height: 4)
                .frame(maxWidth: .infinity)
                .padding(.top, theme.space(.sm))

            if let product = home.sheetProduct {
                Text(product.name)
                    .font(theme.font(.fs15, weight: .bold))
                    .foregroundStyle(theme.foreground)
                Text("\(product.price) 积分/件")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)

                if product.bySku, !product.skus.isEmpty {
                    skuSection(product, theme: theme)
                }

                quantityRow(product, theme: theme)
                addressSection(theme)
                feeRow(theme)
                balanceRow(theme)
            }

            Button {
                Task { await home.confirmRedemption() }
            } label: {
                Text(home.sheetSubmitting ? "兑换中…" : "确认兑换")
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(theme.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.md))
                    .background(Capsule().fill(theme.accent))
                    .opacity(home.sheetConfirmEnabled ? 1 : 0.5)
            }
            .buttonStyle(.plain)
            .disabled(!home.sheetConfirmEnabled)
            .padding(.bottom, theme.space(.sm))
        }
        .padding(.horizontal, theme.space(.lg))
        .background(theme.background)
        .presentationDetents([.large, .medium])
        .interactiveDismissDisabled(home.sheetSubmitting)
    }

    /// 尺码区（by_sku）：chips 一行、售罄码置灰、未选提示。
    private func skuSection(_ product: MallProduct, theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.xs)) {
            Text(home.sheetSkuID == 0 ? "请选择尺码" : "尺码")
                .font(theme.font(.fs13, weight: .medium))
                .foregroundStyle(home.sheetSkuID == 0 ? theme.danger : theme.foreground)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: theme.space(.sm)) {
                    ForEach(product.skus) { sku in
                        let selected = home.sheetSkuID == sku.id
                        let soldOut = sku.stock <= 0
                        Button {
                            home.selectSku(sku.id)
                        } label: {
                            Text("\(sku.specValue)\(soldOut ? "（售罄）" : "")")
                                .font(theme.font(.fs13))
                                .foregroundStyle(soldOut ? theme.mutedTwo : (selected ? theme.onAccent : theme.foreground))
                                .padding(.horizontal, theme.space(.md))
                                .padding(.vertical, theme.space(.xs))
                                .background(
                                    Capsule().fill(selected ? theme.accent : theme.surface)
                                )
                                .overlay {
                                    if !selected {
                                        Capsule().strokeBorder(soldOut ? theme.borderSoft : theme.border)
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .disabled(soldOut)
                    }
                }
            }
        }
    }

    private func quantityRow(_ product: MallProduct, theme: any Theme) -> some View {
        HStack {
            Text("数量")
                .font(theme.font(.fs13))
                .foregroundStyle(theme.foreground)
            Spacer()
            Button {
                home.stepQty(-1)
            } label: {
                Image(systemName: "minus.circle")
                    .font(theme.font(.fs18))
                    .foregroundStyle(home.sheetQty > 1 ? theme.accent : theme.mutedTwo)
            }
            .buttonStyle(.plain)
            Text("\(home.sheetQty)")
                .font(theme.font(.fs15, weight: .medium))
                .monospacedDigit()
                .frame(minWidth: 28)
            Button {
                home.stepQty(1)
            } label: {
                Image(systemName: "plus.circle")
                    .font(theme.font(.fs18))
                    .foregroundStyle(home.sheetQty < home.sheetMaxQty ? theme.accent : theme.mutedTwo)
            }
            .buttonStyle(.plain)
            Text("合计 \(product.price * home.sheetQty) 积分")
                .font(theme.font(.fs13, weight: .medium))
                .foregroundStyle(theme.foreground)
        }
    }

    /// 「寄到哪」地址单选列表（默认地址预选、粉描边）+ 管理地址/去添加。
    private func addressSection(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            HStack {
                Text("寄到哪")
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Button(home.sheetNoAddress ? "去添加 ›" : "管理地址 ›") {
                    if home.sheetNoAddress {
                        home.addAddress()
                    } else {
                        home.manageAddresses()
                    }
                }
                .font(theme.font(.fs12, weight: .medium))
                .foregroundStyle(theme.accentDeep)
            }
            if home.sheetNoAddress {
                Text("还没有收货地址，添加后即可兑换")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
            } else {
                ForEach(home.sheetAddresses) { addr in
                    Button {
                        home.selectAddress(addr.id)
                    } label: {
                        HStack(alignment: .top, spacing: theme.space(.sm)) {
                            Image(systemName: home.sheetSelectedID == addr.id ? "checkmark.circle.fill" : "circle")
                                .font(theme.font(.fs15))
                                .foregroundStyle(home.sheetSelectedID == addr.id ? theme.accent : theme.mutedTwo)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(addr.name) \(addr.phone)")
                                    .font(theme.font(.fs13, weight: .medium))
                                    .foregroundStyle(theme.foreground)
                                Text(addr.addr)
                                    .font(theme.font(.fs12))
                                    .foregroundStyle(theme.muted)
                                    .multilineTextAlignment(.leading)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(theme.space(.sm))
                        .background(
                            RoundedRectangle(cornerRadius: theme.radius(.md))
                                .fill(home.sheetSelectedID == addr.id ? theme.accent.opacity(0.08) : theme.surface)
                        )
                        .overlay {
                            if home.sheetSelectedID == addr.id {
                                RoundedRectangle(cornerRadius: theme.radius(.md))
                                    .strokeBorder(theme.accent, lineWidth: 1)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// 运费行（拍板 3 透传展示：包邮绿 / ¥N / 未选「—」）。
    private func feeRow(_ theme: any Theme) -> some View {
        HStack {
            Text("运费")
                .font(theme.font(.fs13))
                .foregroundStyle(theme.foreground)
            Spacer()
            Text(home.sheetFeeText)
                .font(theme.font(.fs13, weight: .medium))
                .foregroundStyle(home.sheetFeeFree ? Color.green : theme.warning)
        }
    }

    /// 余额三态行：兑换后剩余 N 分 / 积分不足还差 N 分。
    private func balanceRow(_ theme: any Theme) -> some View {
        HStack {
            Text("当前积分 \(home.balance)")
                .font(theme.font(.fs12))
                .foregroundStyle(theme.muted)
            Spacer()
            if home.sheetInsufficient {
                Text("积分不足，还差 \(home.sheetLack) 分")
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.danger)
            } else {
                Text("兑换后剩余 \(home.sheetAfter) 分")
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.muted)
            }
        }
    }

    // MARK: - 兑换成功弹卡

    private func okCard(_ theme: any Theme) -> some View {
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()
            VStack(spacing: theme.space(.md)) {
                Image(systemName: "checkmark.circle.fill")
                    .font(theme.font(.fsDisplay48))
                    .foregroundStyle(theme.accent)
                Text("兑换成功")
                    .font(theme.font(.fs18, weight: .bold))
                    .foregroundStyle(theme.foreground)
                Text("\(home.okName)　-\(home.okCost) 分")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.muted)
                if !home.okSku.isEmpty {
                    Text("尺码 \(home.okSku)")
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.muted)
                }
                Text("剩余 \(home.okBalance) 分，可在「兑换记录」查看进度")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.mutedTwo)
                Button {
                    home.closeOkCard()
                    model.router.push(.pointsOrders)
                } label: {
                    Text("查看订单")
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, theme.space(.md))
                        .background(Capsule().fill(theme.accent))
                }
                .buttonStyle(.plain)
                Button("继续逛逛") { home.closeOkCard() }
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.muted)
            }
            .padding(theme.space(.lg))
            .frame(maxWidth: 320)
            .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
            .padding(theme.space(.lg))
        }
    }
}
