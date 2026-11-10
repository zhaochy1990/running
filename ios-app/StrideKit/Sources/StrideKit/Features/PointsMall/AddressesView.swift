import SwiftUI

/// 地址簿页（devops#938，mp pages/addresses 直译；抖音商城地址页布局）：
/// 分节头（标题 + 「＋ 新建地址」文字链，两种模式都给）→ 地址卡（省市区灰行 /
/// 详细地址粗体 / 姓名手机行 / pick 态 radio / 操作行设默认·复制·编辑·删除）→
/// 空态。pick 模式点卡回传商城抽屉并返回。
public struct AddressesView: View {

    @Environment(AppModel.self) private var model
    @State private var home: AddressesModel

    public init(pick: Bool) {
        _home = State(initialValue: AddressesModel(pickMode: pick))
    }

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: theme.space(.md)) {
                sectionHeader(theme)
                if home.loadFailed {
                    VStack(spacing: theme.space(.md)) {
                        Text("加载失败")
                            .font(theme.font(.fs15, weight: .medium))
                            .foregroundStyle(theme.muted)
                        Button("重试") { Task { await home.load() } }
                            .font(theme.font(.fs15, weight: .medium))
                            .foregroundStyle(theme.accent)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.xl))
                } else if home.loading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, theme.space(.xl))
                } else if home.addresses.isEmpty {
                    emptyState(theme)
                } else {
                    ForEach(home.addresses) { row in
                        addressCard(row, theme: theme)
                    }
                }
            }
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle(home.pickMode ? "选择地址" : "收货地址")
        .inlineNavigationTitle()
        .raceToast(home.toastMessage) { home.toastMessage = nil }
        .task { await home.activate(app: model) }
        .onAppear { Task { await home.reappear() } }
    }

    private func sectionHeader(_ theme: any Theme) -> some View {
        HStack {
            Text(home.pickMode ? "选择收货地址" : "我的收货地址")
                .font(theme.font(.fs15, weight: .bold))
                .foregroundStyle(theme.foreground)
            Spacer()
            Button {
                model.router.push(.addressForm(id: nil))
            } label: {
                Text("＋ 新建地址")
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
            }
            .buttonStyle(.plain)
        }
    }

    private func emptyState(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.sm)) {
            Image(systemName: "mappin.and.ellipse")
                .font(theme.font(.fsDisplay40))
                .foregroundStyle(theme.mutedTwo)
            Text("还没有收货地址")
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.muted)
            Text("点右上角新建地址")
                .font(theme.font(.fs13))
                .foregroundStyle(theme.mutedTwo)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, theme.space(.xxxl))
    }

    private func addressCard(_ row: AddressesModel.AddressRow, theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.sm)) {
            Button {
                home.pick(row.id)
            } label: {
                HStack(alignment: .top, spacing: theme.space(.sm)) {
                    if home.pickMode {
                        Image(systemName: row.selected ? "checkmark.circle.fill" : "circle")
                            .font(theme.font(.fs18))
                            .foregroundStyle(row.selected ? theme.accent : theme.mutedTwo)
                            .padding(.top, 2)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.region)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                        Text(row.detail)
                            .font(theme.font(.fs15, weight: .bold))
                            .foregroundStyle(theme.foreground)
                            .multilineTextAlignment(.leading)
                        HStack(spacing: theme.space(.sm)) {
                            Text(row.name)
                                .font(theme.font(.fs13))
                                .foregroundStyle(theme.muted)
                            Text(row.phone)
                                .font(theme.font(.fs13, mono: true))
                                .foregroundStyle(theme.muted)
                            if row.isDefault {
                                Text("默认")
                                    .font(theme.font(.fs10, weight: .medium))
                                    .foregroundStyle(theme.onAccent)
                                    .padding(.horizontal, theme.space(.sm))
                                    .padding(.vertical, 1)
                                    .background(Capsule().fill(theme.accent))
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)

            actionsRow(row, theme: theme)
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
        .overlay {
            if row.selected {
                RoundedRectangle(cornerRadius: theme.radius(.lg))
                    .strokeBorder(theme.accent, lineWidth: 1)
            }
        }
    }

    /// 操作行：设为默认（粉字，仅非默认）｜复制｜编辑｜删除。
    private func actionsRow(_ row: AddressesModel.AddressRow, theme: any Theme) -> some View {
        HStack(spacing: theme.space(.xl)) {
            if !row.isDefault {
                Button("设为默认") { Task { await home.setDefault(row.id) } }
                    .foregroundStyle(theme.accentDeep)
            }
            Button("复制") { Task { await home.copy(row.id) } }
                .foregroundStyle(theme.muted)
            Button("编辑") {
                model.router.push(.addressForm(id: row.id))
            }
            .foregroundStyle(theme.muted)
            Button("删除") { Task { await home.delete(row.id) } }
                .foregroundStyle(theme.muted)
            Spacer()
        }
        .font(theme.font(.fs12, weight: .medium))
        .buttonStyle(.plain)
    }
}
