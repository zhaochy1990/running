import SwiftUI

/// 登录页骨架（PR-1）：品牌头 + 手机号预填输入 + 说明。
/// 双 tab 登录表单（手机验证码 / 邮箱密码）、18 错误码中文映射、
/// 协议勾选与提交链路归登录域票（PR-2）实现。
public struct LoginView: View {

    @Environment(AppModel.self) private var model
    @State private var phone: String = ""

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: theme.space(.xl)) {
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    Text("STRIDE")
                        .font(theme.font(.fs22, weight: .bold))
                        .foregroundStyle(theme.foreground)
                    Text("登录以同步训练数据")
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.muted)
                }

                VStack(alignment: .leading, spacing: theme.space(.sm)) {
                    Text("手机号")
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.muted)
                    TextField("请输入手机号", text: $phone)
                        .font(theme.font(.fs15))
                        .phoneKeyboard()
                        .textFieldStyle(.roundedBorder)
                }

                Text("验证码登录与邮箱登录表单即将开放")
                    .font(theme.font(.fs12))
                    .foregroundStyle(theme.mutedTwo)
            }
            .padding(theme.space(.lg))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(theme.background)
        .onAppear { phone = model.prefilledPhone ?? "" }
    }
}
