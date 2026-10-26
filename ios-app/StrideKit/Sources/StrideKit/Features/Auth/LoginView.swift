import SwiftUI

/// 登录页（PR-2 登录域，devops#752 决议翻译）：双 tab —— 手机验证码
/// （默认）+ 邮箱密码；60s 倒计时（发送失败不启动）；协议勾选门默认不勾
/// （App Store 审核同款要求）；行内错误区走 18 错误码中文表
/// （`AuthErrorMessages`）；忘记密码「暂未开放」toast；invite_code 预留。
///
/// 登录成功分支（`AppModel.handleLoginSuccess`）：redirect 回跳 /
/// 新注册（档案未齐）→ onboarding 透传 redirect / 老用户 → 教练 tab。
public struct LoginView: View {

    @Environment(AppModel.self) private var model

    private enum Tab: Hashable {
        case sms, email
    }

    @State private var tab: Tab = .sms
    @State private var phone = ""
    @State private var code = ""
    @State private var email = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var agreed = false
    @State private var loading = false
    @State private var sending = false
    @State private var countdown = 0
    @State private var countdownTimer: Task<Void, Never>?
    @State private var errorText: String?
    @State private var toast: String?

    /// 与 auth-service `^1[3-9]\d{9}$` 同口径（#419：客户端校验对齐后端）。
    private static let phoneRegex = /^1[3-9]\d{9}$/
    private static let emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    private static let resendSeconds = 60

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: theme.space(.xl)) {
                header(theme)

                tabSegment(theme)

                switch tab {
                case .sms: smsFields(theme)
                case .email: emailFields(theme)
                }

                if let errorText {
                    Text(errorText)
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button {
                    submit()
                } label: {
                    HStack(spacing: theme.space(.sm)) {
                        if loading { ProgressView().tint(theme.onAccent) }
                        Text(loading ? "登录中…" : "立即登录")
                            .font(theme.font(.fs15, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.md))
                }
                .buttonStyle(.plain)
                .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(canSubmit ? theme.accent : theme.mutedTwo))
                .foregroundStyle(theme.onAccent)
                .disabled(!canSubmit)

                agreementRow(theme)
            }
            .padding(theme.space(.lg))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(theme.background)
        .overlay(alignment: .top) { toastView(theme) }
        .task {
            // 401 回登录页预填上次验证码手机号（#419 决议 4，一键重发）；
            // 只在用户还没输入时预填，别覆盖手快敲进去的字。
            if phone.isEmpty, let last = model.auth.lastSmsPhone() {
                phone = last
            }
        }
        .onDisappear { countdownTimer?.cancel() }
    }

    // MARK: - 区块

    private func header(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.xs)) {
            Text("STRIDE")
                .font(theme.font(.fs22, weight: .bold))
                .foregroundStyle(theme.foreground)
            Text("登录以同步训练数据")
                .font(theme.font(.fs13))
                .foregroundStyle(theme.muted)
        }
    }

    private func tabSegment(_ theme: any Theme) -> some View {
        HStack(spacing: 0) {
            tabButton(.sms, label: "验证码登录", theme: theme)
            tabButton(.email, label: "邮箱密码登录", theme: theme)
        }
        .background(
            RoundedRectangle(cornerRadius: theme.radius(.md))
                .fill(theme.surface)
                .overlay(RoundedRectangle(cornerRadius: theme.radius(.md)).stroke(theme.border))
        )
    }

    private func tabButton(_ target: Tab, label: String, theme: any Theme) -> some View {
        let selected = tab == target
        return Button {
            tab = target
            errorText = nil
        } label: {
            Text(label)
                .font(theme.font(.fs14, weight: selected ? .medium : .regular))
                .foregroundStyle(selected ? theme.onAccent : theme.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.md))
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: theme.radius(.md))
                .fill(selected ? theme.accent : Color.clear)
        )
    }

    private func smsFields(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.lg)) {
            fieldLabel("手机号", theme: theme)
            TextField("请输入手机号", text: $phone)
                .font(theme.font(.fs15))
                .foregroundStyle(theme.foreground)
                .phoneKeyboard()
                .textContentTypeTelephone()
                .textFieldStyle(.roundedBorder)
                .onChange(of: phone) { errorText = nil }

            fieldLabel("验证码", theme: theme)
            HStack(spacing: theme.space(.md)) {
                TextField("6 位验证码", text: $code)
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.foreground)
                    .numberKeyboard()
                    .textContentTypeOneTimeCode()
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: code) { errorText = nil }
                sendCodeButton(theme)
            }
        }
    }

    private func sendCodeButton(_ theme: any Theme) -> some View {
        let disabled = sending || countdown > 0
        return Button {
            sendCode()
        } label: {
            Text(countdown > 0 ? "\(countdown)s 后重发" : "获取验证码")
                .font(theme.font(.fs13))
                .foregroundStyle(disabled ? theme.mutedTwo : theme.accent)
                .padding(.horizontal, theme.space(.lg))
                .frame(height: 36)
                .background(
                    RoundedRectangle(cornerRadius: theme.radius(.sm))
                        .stroke(disabled ? theme.borderSoft : theme.accent)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func emailFields(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.lg)) {
            fieldLabel("邮箱", theme: theme)
            TextField("you@example.com", text: $email)
                .font(theme.font(.fs15))
                .foregroundStyle(theme.foreground)
                .emailKeyboard()
                .textContentTypeEmail()
                .textInputAutocapitalizationNo()
                .textFieldStyle(.roundedBorder)
                .onChange(of: email) { errorText = nil }

            fieldLabel("密码", theme: theme)
            HStack {
                Group {
                    if showPassword {
                        TextField("至少 8 位", text: $password)
                    } else {
                        SecureField("至少 8 位", text: $password)
                    }
                }
                .font(theme.font(.fs15))
                .foregroundStyle(theme.foreground)
                .textInputAutocapitalizationNo()
                .onChange(of: password) { errorText = nil }

                Button {
                    showPassword.toggle()
                } label: {
                    Image(systemName: showPassword ? "eye.slash" : "eye")
                        .foregroundStyle(theme.mutedTwo)
                }
                .buttonStyle(.plain)
            }
            .textFieldStyle(.roundedBorder)

            Button {
                showToast("暂未开放，请联系客服")
            } label: {
                Text("忘记密码")
                    .font(theme.font(.fs13))
                    .foregroundStyle(theme.muted)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    private func agreementRow(_ theme: any Theme) -> some View {
        HStack(alignment: .top, spacing: theme.space(.xs)) {
            Button {
                agreed.toggle()
                errorText = nil
            } label: {
                Image(systemName: agreed ? "checkmark.circle.fill" : "circle")
                    .font(theme.font(.fs15))
                    .foregroundStyle(agreed ? theme.accent : theme.mutedTwo)
            }
            .buttonStyle(.plain)

            Text("我已阅读并同意")
                .font(theme.font(.fs12))
                .foregroundStyle(theme.muted)

            legalLink("《用户协议》", docType: .userAgreement, theme: theme)
            Text("和")
                .font(theme.font(.fs12))
                .foregroundStyle(theme.muted)
            legalLink("《隐私政策》", docType: .privacyPolicy, theme: theme)
        }
    }

    /// 法务链接 → declaration 公开页（登录流的 NavigationStack push，返回回登录）。
    private func legalLink(_ label: String, docType: DeclarationType, theme: any Theme) -> some View {
        Button {
            model.router.push(.declaration(docType: docType))
        } label: {
            Text(label)
                .font(theme.font(.fs12))
                .foregroundStyle(theme.accentDeep)
        }
        .buttonStyle(.plain)
    }

    private func fieldLabel(_ text: String, theme: any Theme) -> some View {
        Text(text)
            .font(theme.font(.fs12))
            .foregroundStyle(theme.muted)
    }

    @ViewBuilder
    private func toastView(_ theme: any Theme) -> some View {
        if let toast {
            Text(toast)
                .font(theme.font(.fs13))
                .foregroundStyle(theme.onAccent)
                .padding(.horizontal, theme.space(.lg))
                .padding(.vertical, theme.space(.sm))
                .background(Capsule().fill(theme.foregroundSoft.opacity(0.92)))
                .padding(.top, theme.space(.xl))
                .task {
                    try? await Task.sleep(for: .seconds(2))
                    self.toast = nil
                }
        }
    }

    // MARK: - 动作

    private var canSubmit: Bool {
        guard !loading else { return false }
        switch tab {
        case .sms: return !phone.trimmingCharacters(in: .whitespaces).isEmpty && !code.isEmpty
        case .email: return !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
        }
    }

    private func sendCode() {
        guard agreed else {
            errorText = "请先阅读并勾选同意《用户协议》和《隐私政策》"
            return
        }
        guard (try? Self.phoneRegex.wholeMatch(in: phone)) != nil else {
            errorText = "请输入正确的手机号"
            return
        }
        sending = true
        errorText = nil
        let phone = self.phone
        Task {
            do {
                try await model.auth.sendSmsCode(phone: phone)
                startCountdown()
                showToast("验证码已发送")
            } catch let error as ApiError {
                // 发送失败不启动倒计时——60s 冷却/日上限的中文提示展示在错误区。
                errorText = AuthErrorMessages.message(for: error)
            } catch {
                errorText = "网络异常，请检查连接"
            }
            sending = false
        }
    }

    private func startCountdown() {
        countdown = Self.resendSeconds
        countdownTimer?.cancel()
        countdownTimer = Task {
            while countdown > 0 {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                countdown = max(countdown - 1, 0)
            }
        }
    }

    private func submit() {
        guard agreed else {
            errorText = "请先阅读并勾选同意《用户协议》和《隐私政策》"
            return
        }
        switch tab {
        case .sms:
            guard (try? Self.phoneRegex.wholeMatch(in: phone)) != nil else {
                errorText = "请输入正确的手机号"
                return
            }
            guard code.wholeMatch(of: /^\d{6}$/) != nil else {
                errorText = "请输入 6 位验证码"
                return
            }
        case .email:
            guard (try? Self.emailRegex.wholeMatch(in: email)) != nil else {
                errorText = "请输入正确的邮箱地址"
                return
            }
        }

        loading = true
        errorText = nil
        let tab = self.tab
        let phone = phone, code = code, email = email, password = password
        Task {
            do {
                switch tab {
                case .sms:
                    try await model.auth.verifySmsCode(phone: phone, code: code)
                case .email:
                    try await model.auth.login(email: email, password: password)
                }
                await model.handleLoginSuccess()
            } catch let error as ApiError {
                errorText = AuthErrorMessages.message(for: error)
            } catch {
                errorText = "登录失败，请重试"
            }
            loading = false
        }
    }

    private func showToast(_ text: String) {
        toast = text
    }
}
