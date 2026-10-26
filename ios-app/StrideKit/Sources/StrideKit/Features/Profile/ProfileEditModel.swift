import Foundation
import Observation

// 个人资料设置 ViewModel（PR-7 收尾域 devops#770，baseline §9.1 + ADR 0013）。
//
// 双面拆分：
//   - 身份（头像/昵称/邮箱）走 auth-service GET/PATCH /api/users/me；
//   - 身体（性别/生日/身高/体重/跑龄档）走数据面 GET/POST/PATCH /api/users/me/profile。
// profile 未建立（GET 返回 null）：身体段逐字段改动只落本地，底部「保存」
// 走整表 POST；已建立：逐字段 PATCH，失败回读服务端值防「界面停在未保存态」。
// 危险区（iOS 合规增量，#759 决议 2）：退出登录 modal 确认；注销账号二次
// 确认警示 → DELETE /api/users/me → 清 Keychain → Login。

@MainActor
@Observable
public final class ProfileEditModel {

    // ── 身份段 ─────────────────────────────────────────────────────────
    public private(set) var name = ""
    public private(set) var email = ""
    public private(set) var avatarURL: String?

    // ── 身体段 ─────────────────────────────────────────────────────────
    public private(set) var hasProfile = false
    /// 未建立时的「完善身体数据」展开态（onStartCreate）。
    public var creating = false
    public private(set) var sex: ProfileSex?
    public private(set) var dob = ""
    public private(set) var heightText = ""
    public private(set) var weightText = ""
    public private(set) var runningAge: RunningAgeRange = .unknown

    // ── 状态 ───────────────────────────────────────────────────────────
    public private(set) var loading = true
    public private(set) var saving = false
    public internal(set) var toastMessage: String?

    private var app: AppModel?
    private var started = false

    public init() {}

    // MARK: - 生命周期

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        await load()
    }

    /// onShow 等价：从 watch/privacy 页返回时回读（profile-edit.ts onShow）。
    public func load() async {
        guard let app else { return }
        applyIdentity(app.me)
        do {
            let data = try await app.api.myProfile()
            let core = data.profile
            hasProfile = core != nil
            creating = creating && !hasProfile
            sex = core.flatMap { ProfileSex(rawValue: $0.sex) }
            dob = core?.dob ?? ""
            heightText = core.flatMap { $0.heightCm > 0 ? Self.numberText($0.heightCm) : nil } ?? ""
            weightText = core.flatMap { $0.weightKg > 0 ? Self.numberText($0.weightKg) : nil } ?? ""
            runningAge = (core?.runningAgeRange ?? data.runningAgeRange).flatMap(RunningAgeRange.init(rawValue:)) ?? .unknown
            loading = false
        } catch {
            loading = false
            toastMessage = Self.friendlyError(error, fallback: "加载资料失败")
        }
    }

    private func applyIdentity(_ me: MeUser?) {
        name = me?.displayTitle ?? ""
        email = me?.email ?? ""
        avatarURL = me?.avatarURL
    }

    private static func numberText(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }

    // MARK: - 身份段动作

    /// PhotosPicker 选完头像即时上传（uploadAvatar → PATCH avatar_url）。
    public func uploadAvatar(_ imageData: Data) async {
        guard !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let url = try await app?.api.uploadAvatar(imageData)
            guard let url else { return }
            try await app?.api.updateAvatarURL(url)
            avatarURL = url
            if let me = app?.me {
                app?.updateIdentity(MeUser(id: me.id, email: me.email, name: me.name, avatarURL: url, displayName: me.displayName))
            }
        } catch {
            toastMessage = Self.friendlyError(error, fallback: "头像保存失败")
        }
    }

    /// 昵称失焦自动保存（空值/未改动不提交；失败回读身份面现值）。
    public func updateName(_ raw: String) async {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = app?.me?.displayTitle ?? ""
        name = raw
        guard !trimmed.isEmpty, trimmed != current, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            try await app?.api.updateDisplayName(trimmed)
            name = trimmed
            if let me = app?.me {
                app?.updateIdentity(MeUser(id: me.id, email: me.email, name: trimmed, avatarURL: me.avatarURL, displayName: me.displayName))
            }
        } catch {
            toastMessage = Self.friendlyError(error, fallback: "保存失败")
            applyIdentity(app?.me)
        }
    }

    // MARK: - 身体段动作（已建立 → 逐字段 PATCH；失败回读服务端值）

    public func updateSex(_ value: ProfileSex) async {
        sex = value
        await patchField(ProfilePatch(sex: value.rawValue))
    }

    public func updateDob(_ value: String) async {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return }
        dob = value
        await patchField(ProfilePatch(dob: value))
    }

    public func updateRunningAge(_ value: RunningAgeRange) async {
        runningAge = value
        await patchField(ProfilePatch(runningAgeRange: value.rawValue))
    }

    /// 身高失焦：非法值 toast + 回读；合法逐字段 PATCH（profile-edit.ts 同款）。
    public func commitHeight(_ raw: String) async {
        heightText = raw
        guard let parsed = Double(raw.trimmingCharacters(in: .whitespaces)), parsed > 0 else {
            toastMessage = "请输入有效身高 (cm)"
            await reloadBodyIfEstablished()
            return
        }
        await patchField(ProfilePatch(heightCm: parsed))
    }

    public func commitWeight(_ raw: String) async {
        weightText = raw
        guard let parsed = Double(raw.trimmingCharacters(in: .whitespaces)), parsed > 0 else {
            toastMessage = "请输入有效体重 (kg)"
            await reloadBodyIfEstablished()
            return
        }
        await patchField(ProfilePatch(weightKg: parsed))
    }

    /// 已建立 profile 的逐字段保存；失败 toast + 回读服务端值，避免界面
    /// 停留在未保存态（ADR 0013 失败回读）。
    private func patchField(_ patch: ProfilePatch) async {
        guard hasProfile, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            _ = try await app?.api.patchMyProfile(patch)
        } catch {
            toastMessage = Self.friendlyError(error, fallback: "保存失败")
            await load()
        }
    }

    private func reloadBodyIfEstablished() async {
        if hasProfile { await load() }
    }

    // MARK: - 未建立：整表 POST（display_name 取当前昵称）

    public func startCreate() {
        creating = true
    }

    /// 表单缺失字段（ProfileFormValidation 同口径，身体五字段 + 昵称兜底）。
    public var missingBodyFields: [ProfileFormValidation.Field] {
        guard !hasProfile, creating else { return [] }
        return ProfileFormValidation.missingFields(
            displayName: name,
            dob: dob.isEmpty ? nil : dob,
            sex: sex,
            heightText: heightText,
            weightText: weightText,
            runningAge: runningAge
        )
    }

    /// 未建立 profile：整表 POST 建立（display_name 取当前昵称；
    /// 跑龄 unknown 也是合法提交值）。
    public func saveBody(dob: String, sex: ProfileSex, height: Double, weight: Double) async {
        guard !saving else { return }
        let displayName = name.trimmingCharacters(in: .whitespaces)
        let missing = ProfileFormValidation.missingFields(
            displayName: displayName, dob: dob, sex: sex,
            heightText: String(height), weightText: String(weight), runningAge: runningAge
        )
        guard missing.isEmpty else {
            toastMessage = "请填写完整资料"
            return
        }
        saving = true
        defer { saving = false }
        do {
            try await app?.api.postProfile(ProfileInput(
                displayName: displayName,
                dob: dob,
                sex: sex.rawValue,
                heightCm: height,
                weightKg: weight,
                runningAgeRange: runningAge.rawValue
            ))
            toastMessage = "资料已保存"
            await load()
        } catch {
            toastMessage = Self.friendlyError(error, fallback: "保存失败")
        }
    }

    // MARK: - 危险区（退出登录 / 注销账号）

    /// 退出登录（modal 确认后调用；userStore.clear + reLaunch login 等价）。
    public func logout() async {
        await app?.logout()
    }

    /// 注销账号（二次确认警示后调用；失败保留会话由页面提示，#759 决议 2）。
    public func deleteAccount() async {
        do {
            try await app?.deleteAccount()
        } catch {
            toastMessage = "注销失败，请稍后再试"
        }
    }

    // MARK: - 错误文案

    /// 数据面 {detail, code} 与 auth 面 {error, message} 经 ApiError 归一；
    /// detail 可能是校验错误数组（归一失败落空串），只展示非空串。
    static func friendlyError(_ error: Error, fallback: String) -> String {
        if let apiError = error as? ApiError {
            if !apiError.detail.isEmpty { return apiError.detail }
            if let code = apiError.code, !code.isEmpty { return code }
        }
        return fallback
    }
}
