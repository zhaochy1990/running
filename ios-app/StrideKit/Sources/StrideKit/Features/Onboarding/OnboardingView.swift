import SwiftUI
import PhotosUI

/// Onboarding 单页三步视图（PR-2 登录域，devops#752 决议翻译；镜像小程序
/// `pages/onboarding/onboarding`）：loading / profile / watch / sync / ready
/// 五视图切换；进入页面与前台恢复都重算落点（`OnboardingModel.refresh`）。
public struct OnboardingView: View {

    @Environment(AppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: OnboardingModel?
    @State private var pickedAvatar: PhotosPickerItem?
    @State private var dobDraft: Date = Self.defaultDob
    @State private var showDobPicker = false

    /// 未选过时默认打开 1990-01-01（防「随手一点把生日设成今天」）。
    static let defaultDob: Date = {
        var components = DateComponents()
        components.year = 1990; components.month = 1; components.day = 1
        return Calendar(identifier: .gregorian).date(from: components) ?? Date()
    }()

    public init() {}

    public var body: some View {
        ZStack {
            if let model {
                content(model)
            } else {
                ProgressView()
            }
        }
        .background(appModel.theme.current.background)
        .task {
            guard model == nil else { return }
            let model = appModel.makeOnboardingModel()
            self.model = model
            await model.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            // 前台恢复重算落点：杀进程回来靠视图重建，这里覆盖不杀进程的挂后台。
            guard phase == .active else { return }
            Task { @MainActor in
                await self.model?.refresh()
            }
        }
    }

    @ViewBuilder
    private func content(_ model: OnboardingModel) -> some View {
        let theme = appModel.theme.current
        switch model.step {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .profile:
            ScrollView {
                ProfileStepView(model: model, theme: theme, pickedAvatar: $pickedAvatar,
                                dobDraft: $dobDraft, showDobPicker: $showDobPicker)
            }
        case .watch:
            ScrollView {
                WatchStepView(model: model, theme: theme)
            }
        case .sync:
            SyncStepView(model: model, theme: theme)
        case .ready:
            ReadyStepView(model: model, theme: theme)
        }
    }
}

// MARK: - 通用骨架

/// 步骤指示条（单页三步：资料 → 手表 → 同步）。
private struct StepBadge: View {
    let index: Int
    let name: String
    let theme: any Theme

    var body: some View {
        Text("第 \(index)/3 步 · \(name)")
            .font(theme.font(.fs12, weight: .medium))
            .foregroundStyle(theme.accentDeep)
            .padding(.horizontal, theme.space(.md))
            .padding(.vertical, theme.space(.xs))
            .background(Capsule().fill(theme.accentTint))
    }
}

// MARK: - 第一步：资料（六字段 + 头像）

private struct ProfileStepView: View {
    @Bindable var model: OnboardingModel
    let theme: any Theme
    @Binding var pickedAvatar: PhotosPickerItem?
    @Binding var dobDraft: Date
    @Binding var showDobPicker: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(.xl)) {
            StepBadge(index: 1, name: "资料", theme: theme)

            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                Text("先认识一下你")
                    .font(theme.font(.fs22, weight: .bold))
                    .foregroundStyle(theme.foreground)
                Text("这些信息用来算训练负荷和能力基线，填一次就好")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.muted)
            }

            AvatarPickerField(avatarData: model.avatarData, selection: $pickedAvatar, theme: theme) { data in
                model.avatarData = data
            }

            fieldLabel("昵称", theme: theme)
            TextField("怎么称呼你", text: $model.displayName)
                .font(theme.font(.fs15))
                .foregroundStyle(theme.foreground)
                .textFieldStyle(.roundedBorder)

            fieldLabel("性别", theme: theme)
            Picker("性别", selection: $model.sex) {
                ForEach(ProfileSex.allCases) { sex in
                    Text(sex.label).tag(ProfileSex?.some(sex))
                }
            }
            .pickerStyle(.segmented)

            fieldLabel("生日", theme: theme)
            Button {
                dobDraft = model.dob.flatMap { Self.parse($0) } ?? OnboardingView.defaultDob
                showDobPicker = true
            } label: {
                fieldShell(model.dob ?? "请选择", theme: theme, placeholder: model.dob == nil)
            }
            .buttonStyle(.plain)
            .sheet(isPresented: $showDobPicker) {
                dobPickerSheet(theme: theme)
            }

            HStack(alignment: .firstTextBaseline, spacing: theme.space(.md)) {
                VStack(alignment: .leading, spacing: 0) {
                    fieldLabel("身高 (cm)", theme: theme)
                    TextField("170", text: $model.heightText)
                        .font(theme.font(.fs15))
                        .foregroundStyle(theme.foreground)
                        .decimalKeyboard()
                        .textFieldStyle(.roundedBorder)
                }
                VStack(alignment: .leading, spacing: 0) {
                    fieldLabel("体重 (kg)", theme: theme)
                    TextField("65", text: $model.weightText)
                        .font(theme.font(.fs15))
                        .foregroundStyle(theme.foreground)
                        .decimalKeyboard()
                        .textFieldStyle(.roundedBorder)
                }
            }

            fieldLabel("跑步年限", theme: theme)
            Picker("跑步年限", selection: $model.runningAge) {
                Text("请选择").tag(RunningAgeRange?.none)
                ForEach(RunningAgeRange.allCases) { range in
                    Text(range.label).tag(RunningAgeRange?.some(range))
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)

            if let formError = model.formError {
                Text(formError)
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.danger)
            }

            Button {
                Task { await model.saveProfile() }
            } label: {
                HStack(spacing: theme.space(.sm)) {
                    if model.saving { ProgressView().tint(theme.onAccent) }
                    Text(model.saving ? "保存中…" : "保存并继续")
                        .font(theme.font(.fs15, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.md))
            }
            .buttonStyle(.plain)
            .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.accent))
            .foregroundStyle(theme.onAccent)
            .disabled(model.saving)
        }
        .padding(theme.space(.lg))
    }

    private func dobPickerSheet(theme: any Theme) -> some View {
        VStack(spacing: theme.space(.lg)) {
            DatePicker(
                "选择生日",
                selection: $dobDraft,
                in: Self.earliest...Date(),
                displayedComponents: .date
            )
            .datePickerStyle(.graphical)
            .labelsHidden()

            HStack(spacing: theme.space(.md)) {
                Button("清除") {
                    model.dob = nil
                    showDobPicker = false
                }
                .foregroundStyle(theme.muted)

                Button("确认") {
                    model.dob = Self.isoString(dobDraft)
                    showDobPicker = false
                }
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.accentDeep)
            }
        }
        .padding(theme.space(.lg))
        .presentationDetents([.medium, .large])
    }

    private static let earliest: Date = {
        var components = DateComponents()
        components.year = 1940; components.month = 1; components.day = 1
        return Calendar(identifier: .gregorian).date(from: components) ?? Date.distantPast
    }()

    private static func isoString(_ date: Date) -> String {
        let components = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 1990, components.month ?? 1, components.day ?? 1)
    }

    private static func parse(_ raw: String) -> Date? {
        let parts = raw.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]; components.month = parts[1]; components.day = parts[2]
        return Calendar(identifier: .gregorian).date(from: components)
    }

    private func fieldLabel(_ text: String, theme: any Theme) -> some View {
        Text(text)
            .font(theme.font(.fs12))
            .foregroundStyle(theme.muted)
    }

    private func fieldShell(_ text: String, theme: any Theme, placeholder: Bool) -> some View {
        HStack {
            Text(text)
                .font(theme.font(.fs15))
                .foregroundStyle(placeholder ? theme.mutedTwo : theme.foreground)
            Spacer()
        }
        .padding(.vertical, theme.space(.md))
        .padding(.horizontal, theme.space(.md))
        .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).stroke(theme.border))
    }
}

// MARK: - 第二步：绑表（可跳过）

private struct WatchStepView: View {
    @Bindable var model: OnboardingModel
    let theme: any Theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space(.xl)) {
            StepBadge(index: 2, name: "手表", theme: theme)

            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                Text("连接你的运动手表")
                    .font(theme.font(.fs22, weight: .bold))
                    .foregroundStyle(theme.foreground)
                Text("绑定后训练数据自动同步，训练量与疲劳趋势无需手动记录")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.muted)
            }

            HStack(spacing: theme.space(.md)) {
                brandCard(.coros, name: "COROS 高驰", subtitle: "同步训练与心率数据", theme: theme)
                brandCard(.garmin, name: "Garmin 佳明", subtitle: "同步训练与生理数据", theme: theme)
            }

            fieldLabel("账号（邮箱）", theme: theme)
            TextField("手表账号邮箱", text: $model.watchEmail)
                .font(theme.font(.fs15))
                .foregroundStyle(theme.foreground)
                .emailKeyboard()
                .textInputAutocapitalizationNo()
                .textFieldStyle(.roundedBorder)

            fieldLabel("密码", theme: theme)
            SecureField("手表账号密码", text: $model.watchPassword)
                .font(theme.font(.fs15))
                .foregroundStyle(theme.foreground)
                .textFieldStyle(.roundedBorder)

            fieldLabel("区域", theme: theme)
            Picker("区域", selection: $model.watchRegion) {
                ForEach(WatchRegion.allCases) { region in
                    Text(region.label).tag(region)
                }
            }
            .pickerStyle(.segmented)

            if let watchError = model.watchError {
                Text(watchError)
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.danger)
            }

            Button {
                Task { await model.bindWatch() }
            } label: {
                HStack(spacing: theme.space(.sm)) {
                    if model.connecting { ProgressView().tint(theme.onAccent) }
                    Text(model.connecting ? "绑定中…" : "绑定并同步")
                        .font(theme.font(.fs15, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.md))
            }
            .buttonStyle(.plain)
            .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.accent))
            .foregroundStyle(theme.onAccent)
            .disabled(model.connecting)

            Button {
                model.skipToHome()
            } label: {
                Text("稍后再说，先逛逛")
                    .font(theme.font(.fs14))
                    .foregroundStyle(theme.muted)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
        }
        .padding(theme.space(.lg))
    }

    private func brandCard(_ provider: WatchProvider, name: String, subtitle: String, theme: any Theme) -> some View {
        let selected = model.watchProvider == provider
        return Button {
            model.watchProvider = provider
            model.watchError = nil
        } label: {
            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                Text(name)
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(selected ? theme.accentDeep : theme.foreground)
                Text(subtitle)
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(theme.space(.md))
            .background(
                RoundedRectangle(cornerRadius: theme.radius(.md))
                    .fill(selected ? theme.accentTint : theme.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: theme.radius(.md))
                    .stroke(selected ? theme.accent : theme.border)
            )
        }
        .buttonStyle(.plain)
    }

    private func fieldLabel(_ text: String, theme: any Theme) -> some View {
        Text(text)
            .font(theme.font(.fs12))
            .foregroundStyle(theme.muted)
    }
}

// MARK: - 第三步：同步（可跳过）

private struct SyncStepView: View {
    @Bindable var model: OnboardingModel
    let theme: any Theme

    var body: some View {
        let hasError = model.syncError != nil
        VStack(spacing: theme.space(.xl)) {
            StepBadge(index: 3, name: "同步", theme: theme)

            Text(model.syncPending ? "还在同步中" : "正在准备你的训练数据")
                .font(theme.font(.fs22, weight: .bold))
                .foregroundStyle(theme.foreground)
            Text(model.syncPending
                 ? "数据量大时会久一些，下次进来会自动接着同步"
                 : "首次同步会拉取历史训练并计算能力基线，通常需要十几分钟")
                .font(theme.font(.fs13))
                .foregroundStyle(theme.muted)
                .multilineTextAlignment(.center)

            Text(model.syncError ?? model.syncText)
                .font(model.syncError == nil ? theme.font(.fs15, weight: GeistWeight.medium) : theme.font(.fs13))
                .foregroundStyle(model.syncError == nil ? theme.foreground : theme.danger)
                .multilineTextAlignment(.center)

            if model.syncError == nil {
                ProgressView(value: Double(model.percent) / 100)
                    .tint(theme.accent)
                Text("\(model.percent)%")
                    .font(theme.font(.fs13, weight: .regular, mono: true))
                    .foregroundStyle(theme.muted)
            }

            if hasError {
                Button {
                    Task { await model.retrySync() }
                } label: {
                    Text("重试")
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, theme.space(.md))
                        .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.accent))
                }
                .buttonStyle(.plain)
            }

            Button {
                model.skipToHome()
            } label: {
                Text(hasError ? "稍后再说，先逛逛" : "先进入首页")
                    .font(theme.font(.fs14))
                    .foregroundStyle(theme.muted)
            }
            .buttonStyle(.plain)
        }
        .padding(theme.space(.xxl))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - ready

private struct ReadyStepView: View {
    @Bindable var model: OnboardingModel
    let theme: any Theme

    var body: some View {
        VStack(spacing: theme.space(.lg)) {
            Image(systemName: "checkmark.circle.fill")
                .font(theme.font(.fsDisplay48))
                .foregroundStyle(theme.accent)
            Text("准备就绪")
                .font(theme.font(.fs22, weight: .bold))
                .foregroundStyle(theme.foreground)
            Text("档案已保存。绑了手表的话，训练数据会在首页自动出现")
                .font(theme.font(.fs14))
                .foregroundStyle(theme.muted)
                .multilineTextAlignment(.center)

            Button {
                model.skipToHome()
            } label: {
                Text("进入首页")
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(theme.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.accent))
            }
            .buttonStyle(.plain)
            .padding(.top, theme.space(.lg))
        }
        .padding(theme.space(.xxl))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 头像选择（PhotosPicker；chooseAvatar 的 iOS 对应，#752 决议）

/// 独立小组件：把 @Sendable label/onChange 闭包与 @MainActor 状态隔开，
/// 徽章在闭包内用 Sendable 输入（avatarData/theme）就地构建。
private struct AvatarPickerField: View {
    let avatarData: Data?
    @Binding var selection: PhotosPickerItem?
    let theme: any Theme
    /// 加载完成后回写（@MainActor）。
    let onLoaded: @MainActor @Sendable (Data?) -> Void

    var body: some View {
        PhotosPicker(selection: $selection, matching: .images) {
            ZStack {
                Circle()
                    .fill(theme.accentTint)
                    .frame(width: 72, height: 72)
                if let avatarData, let image = PlatformImage.image(data: avatarData) {
                    image.resizable().scaledToFill()
                        .frame(width: 72, height: 72)
                        .clipShape(Circle())
                } else {
                    Image(systemName: "person.fill")
                        .font(theme.font(.fs22))
                        .foregroundStyle(theme.accent)
                }
                Image(systemName: "pencil.circle.fill")
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.accentDeep)
                    .offset(x: 24, y: 24)
            }
        }
        .buttonStyle(.plain)
        .onChange(of: selection) { _, item in
            guard let item else { return }
            let callback = onLoaded
            Task {
                let data = try? await item.loadTransferable(type: Data.self)
                await MainActor.run { callback(data) }
            }
        }
    }
}
