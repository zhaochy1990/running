import SwiftUI

/// 手表管理页（PR-7 收尾域 devops#770，#425 决议 + baseline §8.1）：
/// 已绑态（品牌/账号/设备/上次同步/能力标签 + 成功横幅 + 解绑按钮 → 内联
/// 确认卡「已同步的训练数据不会被删除」）→ 未绑态：品牌网格（COROS /
/// GARMIN）→ 品牌登录表单（邮箱/密码/region picker 仅 Garmin + MFA 提示）。
public struct WatchView: View {

    @Environment(AppModel.self) private var model
    @State private var watch: WatchModel

    public init(provider: WatchProvider?) {
        _watch = State(initialValue: WatchModel(provider: provider))
    }

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(spacing: theme.space(.lg)) {
                switch watch.screen {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(theme.space(.xl))
                case .error:
                    VStack(spacing: theme.space(.md)) {
                        Text("加载手表信息失败")
                            .font(theme.font(.fs14))
                            .foregroundStyle(theme.muted)
                        Button("重试") {
                            Task { await watch.fetchWatch() }
                        }
                        .font(theme.font(.fs14, weight: .medium))
                        .foregroundStyle(theme.accentDeep)
                    }
                    .padding(theme.space(.xl))
                case .loaded:
                    if watch.connected {
                        boundCard(theme)
                    } else if let provider = watch.connectProvider {
                        loginForm(provider, theme: theme)
                    } else {
                        providerGrid(theme)
                    }
                }
            }
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle("手表管理")
        .inlineNavigationTitle()
        .raceToast(watch.toastMessage) { watch.toastMessage = nil }
        .task { await watch.activate(app: model) }
        .onAppear {
            // onShow 回读状态（从 onboarding/别处返回）。
            if watch.screen == .loaded { Task { await watch.fetchWatch() } }
        }
    }

    // MARK: - 已绑态

    private func boundCard(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            if !watch.successMessage.isEmpty {
                Text(watch.successMessage)
                    .font(theme.font(.fs13, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
            }
            HStack(spacing: theme.space(.md)) {
                Image(systemName: "applewatch")
                    .font(theme.font(.fs22))
                    .foregroundStyle(theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(watch.providerDisplayName.isEmpty ? "已绑定" : watch.providerDisplayName)
                        .font(theme.font(.fs15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    if let email = watch.info.email {
                        Text(email)
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.muted)
                    }
                }
                Spacer()
            }
            if let device = watch.info.device, !device.isEmpty {
                infoRow("设备", device, theme: theme)
            }
            infoRow("上次同步", watch.lastSyncText, theme: theme)
            if !watch.info.capabilities.isEmpty {
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    Text("支持的能力")
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.mutedTwo)
                    FlowTags(tags: watch.info.capabilities, theme: theme)
                }
            }
            if watch.showDisconnectConfirm {
                VStack(alignment: .leading, spacing: theme.space(.md)) {
                    Text("解除绑定后，已同步的训练数据不会被删除。")
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.muted)
                    HStack(spacing: theme.space(.md)) {
                        Button {
                            Task { await watch.confirmDisconnect() }
                        } label: {
                            HStack(spacing: theme.space(.xs)) {
                                if watch.disconnecting { ProgressView().controlSize(.small) }
                                Text("确认解绑")
                            }
                            .font(theme.font(.fs14, weight: .medium))
                            .foregroundStyle(theme.danger)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, theme.space(.sm))
                            .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).strokeBorder(theme.danger))
                        }
                        .buttonStyle(.plain)
                        .disabled(watch.disconnecting)
                        Button("取消") {
                            watch.showDisconnectConfirm = false
                        }
                        .font(theme.font(.fs14))
                        .foregroundStyle(theme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, theme.space(.sm))
                        .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).strokeBorder(theme.border))
                        .buttonStyle(.plain)
                    }
                }
                .padding(theme.space(.md))
                .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.danger.opacity(0.06)))
            } else {
                Button {
                    watch.showDisconnectConfirm = true
                } label: {
                    Text("解除绑定")
                        .font(theme.font(.fs14, weight: .medium))
                        .foregroundStyle(theme.danger)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, theme.space(.md))
                        .background(RoundedRectangle(cornerRadius: theme.radius(.md)).strokeBorder(theme.danger))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    private func infoRow(_ label: String, _ value: String, theme: any Theme) -> some View {
        HStack {
            Text(label)
                .font(theme.font(.fs13))
                .foregroundStyle(theme.muted)
            Spacer()
            Text(value)
                .font(theme.font(.fs13, weight: .medium))
                .foregroundStyle(theme.foreground)
        }
    }

    // MARK: - 品牌网格

    private func providerGrid(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            Text("选择手表品牌")
                .font(theme.font(.fs14, weight: .medium))
                .foregroundStyle(theme.muted)
            HStack(spacing: theme.space(.md)) {
                providerCard(.coros, name: "COROS", systemImage: "stopwatch", theme: theme)
                providerCard(.garmin, name: "GARMIN", systemImage: "gauge.with.needle", theme: theme)
            }
        }
    }

    private func providerCard(_ provider: WatchProvider, name: String, systemImage: String, theme: any Theme) -> some View {
        Button {
            watch.selectProvider(provider)
        } label: {
            VStack(spacing: theme.space(.sm)) {
                Image(systemName: systemImage)
                    .font(theme.font(.fsDisplay40))
                    .foregroundStyle(theme.accent)
                Text(name)
                    .font(theme.font(.fs15, weight: .bold))
                    .foregroundStyle(theme.foreground)
                Text("绑定")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.accentDeep)
            }
            .frame(maxWidth: .infinity)
            .padding(theme.space(.xl))
            .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
        }
        .buttonStyle(.plain)
    }

    // MARK: - 登录表单（email+password 双 provider 共用；region 仅 Garmin）

    private func loginForm(_ provider: WatchProvider, theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.lg)) {
            HStack {
                Text(provider == .garmin ? "绑定 Garmin 账号" : "绑定 COROS 账号")
                    .font(theme.font(.fs15, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Button("返回品牌") {
                    watch.backToProviders()
                }
                .font(theme.font(.fs13))
                .foregroundStyle(theme.muted)
            }

            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                Text("账号")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
                TextField(watch.emailPlaceholder, text: $watch.email)
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.foreground)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalizationNo()
                    .emailKeyboard()
                    .onChange(of: watch.email) { _, _ in watch.errorMessage = "" }
            }

            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                Text("密码")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.muted)
                SecureField("密码", text: $watch.password)
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.foreground)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: watch.password) { _, _ in watch.errorMessage = "" }
            }

            // region 选择器仅 Garmin 分支（#425 决议 1：COROS 不让用户选，
            // 后端登录后 token 自动探测）。
            if watch.isGarmin {
                Picker("区域", selection: $watch.region) {
                    ForEach(WatchRegion.allCases) { region in
                        Text(region.label).tag(region)
                    }
                }
                .pickerStyle(.segmented)
                Text("佳明账号需关闭两步验证（暂不支持 MFA）")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.mutedTwo)
            }

            if !watch.errorMessage.isEmpty {
                Text(watch.errorMessage)
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                Task { await watch.connect() }
            } label: {
                HStack(spacing: theme.space(.sm)) {
                    if watch.connecting { ProgressView().tint(theme.onAccent) }
                    Text(watch.connecting ? "绑定中…" : "绑定")
                        .font(theme.font(.fs15, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.md))
                .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(watch.canConnect ? theme.accent : theme.mutedTwo))
                .foregroundStyle(theme.onAccent)
            }
            .buttonStyle(.plain)
            .disabled(!watch.canConnect)
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }
}

/// 能力标签流式平铺（capabilities[]，#425「照后端标签展示，不做特殊 UI」）。
struct FlowTags: View {
    let tags: [String]
    let theme: any Theme

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: theme.space(.xs))],
                  alignment: .leading, spacing: theme.space(.xs)) {
            ForEach(tags, id: \.self) { tag in
                Text(tag)
                    .font(theme.font(.fs11))
                    .foregroundStyle(theme.muted)
                    .padding(.horizontal, theme.space(.sm))
                    .padding(.vertical, 3)
                    .frame(maxWidth: .infinity)
                    .background(Capsule().strokeBorder(theme.borderSoft))
            }
        }
    }
}
