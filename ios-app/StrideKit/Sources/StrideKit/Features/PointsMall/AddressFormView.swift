import SwiftUI

/// 新增/编辑地址表单（devops#938，mp pages/address-form 直译）：表单卡
/// （收货人/手机号/所在地区-级联选择器/详细地址）→ 默认地址卡 switch →
/// 底部固定保存钮。
public struct AddressFormView: View {

    @Environment(AppModel.self) private var model
    @State private var home: AddressFormModel

    public init(id: Int?) {
        _home = State(initialValue: AddressFormModel(id: id))
    }

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(spacing: theme.space(.lg)) {
                if home.loadFailed {
                    VStack(spacing: theme.space(.md)) {
                        Text("地址不存在或已被删除")
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
                    formCard(theme)
                    defaultCard(theme)
                }
            }
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle(home.editing ? "编辑地址" : "新增地址")
        .inlineNavigationTitle()
        .raceToast(home.toastMessage) { home.toastMessage = nil }
        .safeAreaInset(edge: .bottom) { saveButton(theme) }
        .sheet(isPresented: pickerBinding) { RegionCascadePicker(onPick: home.applyRegion) }
        .task { await home.activate(app: model) }
        .onDisappear { home.cancelDismiss() }
    }

    private var pickerBinding: Binding<Bool> {
        Binding(
            get: { home.pickerVisible },
            set: { if !$0 { home.pickerVisible = false } }
        )
    }

    /// 手机号输入（iOS 数字键盘；macOS 测试宿主无 keyboardType）。
    private func phoneField(_ theme: any Theme) -> some View {
        #if canImport(UIKit)
        TextField("11 位手机号", text: $home.form.phone)
            .keyboardType(.numberPad)
            .autocorrectionDisabled()
        #else
        TextField("11 位手机号", text: $home.form.phone)
            .autocorrectionDisabled()
        #endif
    }

    private func formCard(_ theme: any Theme) -> some View {
        VStack(spacing: 0) {
            fieldRow(title: "收货人", theme: theme) {
                TextField("姓名", text: $home.form.name)
                    .autocorrectionDisabled()
            }
            Divider().overlay(theme.borderSoft)
            fieldRow(title: "手机号", theme: theme) {
                phoneField(theme)
            }
            Divider().overlay(theme.borderSoft)
            Button {
                home.showPicker()
            } label: {
                fieldRow(title: "所在地区", theme: theme, vertical: true) {
                    HStack {
                        Text(home.regionText.isEmpty ? "省 / 市 / 区" : home.regionText)
                            .font(theme.font(.fs15))
                            .foregroundStyle(home.regionText.isEmpty ? theme.mutedTwo : theme.foreground)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.mutedTwo)
                    }
                }
            }
            .buttonStyle(.plain)
            Divider().overlay(theme.borderSoft)
            fieldRow(title: "详细地址", theme: theme) {
                TextField("街道、门牌号等", text: $home.form.detail, axis: .vertical)
                    .lineLimit(1...3)
            }
        }
        .padding(.horizontal, theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    private func fieldRow<Content: View>(title: String, theme: any Theme,
                                         vertical: Bool = false,
                                         @ViewBuilder content: () -> Content) -> some View {
        Group {
            if vertical {
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    Text(title)
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.muted)
                    content()
                }
                .padding(.vertical, theme.space(.md))
            } else {
                HStack(spacing: theme.space(.md)) {
                    Text(title)
                        .font(theme.font(.fs15))
                        .foregroundStyle(theme.foreground)
                        .frame(width: 72, alignment: .leading)
                    content()
                }
                .padding(.vertical, theme.space(.md))
            }
        }
    }

    private func defaultCard(_ theme: any Theme) -> some View {
        HStack {
            Text("设为默认地址")
                .font(theme.font(.fs15))
                .foregroundStyle(theme.foreground)
            Spacer()
            Toggle("", isOn: $home.form.isDefault)
                .labelsHidden()
                .tint(theme.accent)
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    private func saveButton(_ theme: any Theme) -> some View {
        Button {
            Task { await home.save() }
        } label: {
            Text(home.saving ? "保存中…" : "保存")
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.onAccent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.md))
                .background(Capsule().fill(theme.accent))
        }
        .buttonStyle(.plain)
        .disabled(home.saving)
        .opacity(home.saving ? 0.6 : 1)
        .padding(.horizontal, theme.space(.lg))
        .padding(.vertical, theme.space(.sm))
        .background(theme.background)
    }
}

/// 三级级联选择器（拍板 2：省→市→区逐级 drill-down sheet）。
/// 数据 RegionPickerData（标准行政区划，与微信 region picker/后端运费匹配同源）。
public struct RegionCascadePicker: View {

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismissSheet
    /// 三级进度：nil=选省；some=已选省市选区。
    @State private var selectedProvince: String?
    @State private var selectedCity: String?
    let onPick: (String, String, String) -> Void

    public init(onPick: @escaping (String, String, String) -> Void) {
        self.onPick = onPick
    }

    public var body: some View {
        let theme = app.theme.current
        NavigationStack {
            List(currentItems, id: \.self) { item in
                Button {
                    tap(item)
                } label: {
                    HStack {
                        Text(item)
                            .foregroundStyle(theme.foreground)
                        Spacer()
                        if item == selectedProvince || item == selectedCity {
                            Image(systemName: "checkmark")
                                .foregroundStyle(theme.accent)
                        }
                    }
                }
            }
            .navigationTitle(title)
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if selectedProvince != nil {
                        Button("重新选择") { reset() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("取消") {
                        reset()
                        dismissSheet()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var title: String {
        if selectedCity != nil { return "选择区县" }
        if let province = selectedProvince { return "选择城市（\(province)）" }
        return "选择省份"
    }

    private var currentItems: [String] {
        if let province = selectedProvince, let city = selectedCity {
            return RegionPickerData.districts(province: province, city: city)
        }
        if let province = selectedProvince {
            return RegionPickerData.cities(province: province)
        }
        return RegionPickerData.provinces
    }

    private func tap(_ item: String) {
        if selectedProvince == nil {
            selectedProvince = item
        } else if selectedCity == nil {
            selectedCity = item
            let districts = RegionPickerData.districts(province: selectedProvince!, city: item)
            // 只有一个「区」（不设区地级市回退）时直接完成，避免多余一步。
            if districts.count == 1 {
                onPick(selectedProvince!, item, districts[0])
                reset()
            }
        } else {
            onPick(selectedProvince!, selectedCity!, item)
            reset()
        }
    }

    private func reset() {
        selectedProvince = nil
        selectedCity = nil
    }
}
