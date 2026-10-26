import SwiftUI
import PhotosUI

/// 个人资料设置页（PR-7 收尾域 devops#770，baseline §9.1 + ADR 0013 直译）：
/// 身份段（PhotosPicker 头像即时上传 / 昵称失焦自动保存 / 邮箱只读）→
/// 身体段（已建立逐字段失焦 PATCH；未建立「完善身体数据」展开整表 POST）→
/// 手表绑定行 / 隐私与权限行 → 退出登录 → 注销账号（底部危险区，
/// App Store 5.1.1(v) 合规增量，#759 决议 2）。
public struct ProfileEditView: View {

    @Environment(AppModel.self) private var model
    @State private var edit = ProfileEditModel()

    @State private var nameDraft = ""
    @State private var pickingAvatar = false
    @State private var avatarItem: PhotosPickerItem?
    @State private var heightDraft = ""
    @State private var weightDraft = ""
    @State private var showLogoutConfirm = false
    @State private var showDeleteWarning = false
    @State private var showDeleteFinal = false
    @FocusState private var nameFocused: Bool
    @FocusState private var heightFocused: Bool
    @FocusState private var weightFocused: Bool

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(spacing: theme.space(.lg)) {
                identityCard(theme)
                bodyCard(theme)
                linkRows(theme)
                dangerZone(theme)
            }
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle("个人资料")
        .inlineNavigationTitle()
        .raceToast(edit.toastMessage) { edit.toastMessage = nil }
        .overlay {
            if edit.loading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await edit.activate(app: model) }
        .onChange(of: model.router.selectedTab) { _, tab in
            if tab == .profile { Task { await edit.load() } }
        }
        // 回到本页（从 watch/privacy 返回）回读：profile-edit.ts onShow
        .onAppear { syncDrafts() }
        .onChange(of: edit.hasProfile) { _, _ in syncDrafts() }
        .onChange(of: avatarItem) { _, item in
            guard let item else { return }
            avatarItem = nil
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    await edit.uploadAvatar(data)
                }
            }
        }
        .alert("退出登录", isPresented: $showLogoutConfirm) {
            Button("退出登录", role: .destructive) { Task { await edit.logout() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("确定要退出当前账号吗？")
        }
        // 注销两段确认：先警示不可恢复，再要求明确点「确认注销」。
        .alert("注销账号", isPresented: $showDeleteWarning) {
            Button("继续", role: .destructive) { showDeleteFinal = true }
            Button("取消", role: .cancel) {}
        } message: {
            Text("注销后账号数据将被永久删除，且无法恢复。")
        }
        .alert("确认注销", isPresented: $showDeleteFinal) {
            Button("确认注销", role: .destructive) { Task { await edit.deleteAccount() } }
            Button("再想想", role: .cancel) {}
        } message: {
            Text("此操作不可恢复，所有训练记录与订阅权益将被清除。")
        }
    }

    private func syncDrafts() {
        if nameDraft.isEmpty { nameDraft = edit.name }
        if heightDraft.isEmpty { heightDraft = edit.heightText }
        if weightDraft.isEmpty { weightDraft = edit.weightText }
    }

    // MARK: - 身份段

    private func identityCard(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.lg)) {
            PhotosPicker(selection: $avatarItem, matching: .images) {
                ZStack(alignment: .bottomTrailing) {
                    Group {
                        if let url = edit.avatarURL.flatMap(URL.init(string:)) {
                            AsyncImage(url: url) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                Circle().fill(theme.borderSoft)
                            }
                            .frame(width: 72, height: 72)
                            .clipShape(Circle())
                        } else {
                            Image(systemName: "person.crop.circle.fill")
                                .font(theme.font(.fsDisplay48))
                                .foregroundStyle(theme.mutedTwo)
                                .frame(width: 72, height: 72)
                        }
                    }
                    if edit.saving {
                        ProgressView()
                            .padding(4)
                            .background(Circle().fill(theme.surface))
                    } else {
                        Image(systemName: "pencil.circle.fill")
                            .font(theme.font(.fs18))
                            .foregroundStyle(theme.accent)
                            .background(Circle().fill(theme.background))
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(edit.saving)

            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                fieldLabel("昵称", theme: theme)
                TextField("昵称", text: $nameDraft)
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.foreground)
                    .textFieldStyle(.roundedBorder)
                    .focused($nameFocused)
                    .onSubmit { Task { await edit.updateName(nameDraft) } }
                    .onChange(of: nameFocused) { _, focused in
                        if !focused { Task { await edit.updateName(nameDraft) } }
                    }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: theme.space(.xs)) {
                fieldLabel("邮箱", theme: theme)
                Text(edit.email.isEmpty ? "—" : edit.email)
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    // MARK: - 身体段（ADR 0013）

    private func bodyCard(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            sectionTitle("身体数据", theme: theme)
            if edit.hasProfile {
                establishedRows(theme)
            } else if edit.creating {
                createForm(theme)
            } else {
                Button {
                    edit.startCreate()
                } label: {
                    Label("完善身体数据", systemImage: "plus.circle")
                        .font(theme.font(.fs14, weight: .medium))
                        .foregroundStyle(theme.accentDeep)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, theme.space(.md))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(theme.space(.lg))
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
    }

    /// 已建立：逐字段展示（picker/输入失焦触发 PATCH，失败回读）。
    private func establishedRows(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            Picker("性别", selection: Binding(
                get: { edit.sex ?? .other },
                set: { value in Task { await edit.updateSex(value) } }
            )) {
                ForEach(ProfileSex.allCases) { sex in
                    Text(sex.label).tag(sex)
                }
            }
            .pickerStyle(.segmented)

            dobPicker(dob: Binding(
                get: { edit.dob.isEmpty ? nil : edit.dob },
                set: { date in Task { await edit.updateDob(date ?? "") } }
            ), theme: theme)

            heightField(theme)
            weightField(theme)

            Picker("跑步年限", selection: Binding(
                get: { edit.runningAge },
                set: { value in Task { await edit.updateRunningAge(value) } }
            )) {
                ForEach(RunningAgeRange.allCases) { range in
                    Text(range.label).tag(range)
                }
            }
            .pickerStyle(.menu)
        }
    }

    /// 未建立：整表展开 + 保存按钮（POST；display_name 取当前昵称）。
    @State private var createDob = ""
    @State private var createSex: ProfileSex = .other
    @State private var createRunningAge: RunningAgeRange = .unknown

    private func createForm(_ theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            Picker("性别", selection: $createSex) {
                ForEach(ProfileSex.allCases) { sex in
                    Text(sex.label).tag(sex)
                }
            }
            .pickerStyle(.segmented)

            dobPicker(dob: Binding<String?>(
                  get: { createDob.isEmpty ? nil : createDob },
                  set: { createDob = $0 ?? "" }
              ), theme: theme)

            heightField(theme)
            weightField(theme)

            Picker("跑步年限", selection: $createRunningAge) {
                ForEach(RunningAgeRange.allCases) { range in
                    Text(range.label).tag(range)
                }
            }
            .pickerStyle(.menu)

            Button {
                let height = Double(heightDraft.trimmingCharacters(in: .whitespaces)) ?? 0
                let weight = Double(weightDraft.trimmingCharacters(in: .whitespaces)) ?? 0
                let dob = createDob.isEmpty ? edit.dob : createDob
                Task { await edit.saveBody(dob: dob, sex: createSex, height: height, weight: weight) }
            } label: {
                HStack(spacing: theme.space(.sm)) {
                    if edit.saving { ProgressView().tint(theme.onAccent) }
                    Text("保存")
                        .font(theme.font(.fs15, weight: .medium))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.md))
                .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.accent))
                .foregroundStyle(theme.onAccent)
            }
            .buttonStyle(.plain)
            .disabled(edit.saving)
        }
    }

    private func dobPicker(dob: Binding<String?>, theme: any Theme) -> some View {
        HStack {
            Text("生日")
                .font(theme.font(.fs14))
                .foregroundStyle(theme.foreground)
            Spacer()
            DatePicker(
                "生日",
                selection: Binding(
                    get: {
                        Shanghai.ymdDate(dob.wrappedValue ?? "")
                            ?? Shanghai.ymdDate("1990-01-01")!
                    },
                    set: { date in
                        dob.wrappedValue = Shanghai.todayYMD(now: date)
                    }
                ),
                in: ...Date.now,
                displayedComponents: .date
            )
            .datePickerStyle(.compact)
            .labelsHidden()
            .environment(\.locale, Locale(identifier: "zh_CN"))
        }
    }

    private func heightField(_ theme: any Theme) -> some View {
        HStack {
            Text("身高 (cm)")
                .font(theme.font(.fs14))
                .foregroundStyle(theme.foreground)
            Spacer()
            TextField("170", text: $heightDraft)
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.foreground)
                .multilineTextAlignment(.trailing)
                .frame(width: 90)
                .textFieldStyle(.roundedBorder)
                .decimalKeyboard()
                .focused($heightFocused)
                .onSubmit { Task { await edit.commitHeight(heightDraft) } }
                .onChange(of: heightFocused) { _, focused in
                    if !focused { Task { await edit.commitHeight(heightDraft) } }
                }
        }
    }

    private func weightField(_ theme: any Theme) -> some View {
        HStack {
            Text("体重 (kg)")
                .font(theme.font(.fs14))
                .foregroundStyle(theme.foreground)
            Spacer()
            TextField("60", text: $weightDraft)
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.foreground)
                .multilineTextAlignment(.trailing)
                .frame(width: 90)
                .textFieldStyle(.roundedBorder)
                .decimalKeyboard()
                .focused($weightFocused)
                .onSubmit { Task { await edit.commitWeight(weightDraft) } }
                .onChange(of: weightFocused) { _, focused in
                    if !focused { Task { await edit.commitWeight(weightDraft) } }
                }
        }
    }

    // MARK: - 手表 / 隐私 / 退出

    private func linkRows(_ theme: any Theme) -> some View {
        VStack(spacing: 0) {
            linkRow(title: "手表绑定", systemImage: "applewatch", theme: theme) {
                model.router.push(.watch(provider: nil))
            }
            divider(theme)
            linkRow(title: "隐私与权限", systemImage: "lock.shield", theme: theme) {
                model.router.push(.privacy)
            }
        }
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
        .clipShape(RoundedRectangle(cornerRadius: theme.radius(.lg)))
    }

    private func dangerZone(_ theme: any Theme) -> some View {
        VStack(spacing: 0) {
            linkRow(title: "退出登录", systemImage: "rectangle.portrait.and.arrow.right", theme: theme) {
                showLogoutConfirm = true
            }
            divider(theme)
            linkRow(title: "注销账号", systemImage: "trash", tint: theme.danger, theme: theme) {
                showDeleteWarning = true
            }
        }
        .background(RoundedRectangle(cornerRadius: theme.radius(.lg)).fill(theme.surface))
        .clipShape(RoundedRectangle(cornerRadius: theme.radius(.lg)))
    }

    private func linkRow(title: String, systemImage: String, tint: Color? = nil, theme: any Theme, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: theme.space(.md)) {
                Image(systemName: systemImage)
                    .font(theme.font(.fs15))
                    .foregroundStyle(tint ?? theme.accent)
                    .frame(width: 24)
                Text(title)
                    .font(theme.font(.fs15))
                    .foregroundStyle(tint ?? theme.foreground)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.mutedTwo)
            }
            .padding(theme.space(.lg))
        }
        .buttonStyle(.plain)
    }

    private func divider(_ theme: any Theme) -> some View {
        Rectangle()
            .fill(theme.borderSoft)
            .frame(height: 0.5)
            .padding(.leading, theme.space(.lg))
    }

    private func sectionTitle(_ text: String, theme: any Theme) -> some View {
        Text(text)
            .font(theme.font(.fs13, weight: .medium))
            .foregroundStyle(theme.muted)
    }

    private func fieldLabel(_ text: String, theme: any Theme) -> some View {
        Text(text)
            .font(theme.font(.fs12))
            .foregroundStyle(theme.muted)
    }
}
