import SwiftUI

/// 跨平台视图修饰符：包要在 macOS 宿主机跑 `swift test`，iOS 专属修饰符
/// 在此收敛条件编译，页面代码保持干净。
extension View {

    /// iOS 手机号键盘（macOS 宿主编译兜底为无操作）。
    @ViewBuilder
    public func phoneKeyboard() -> some View {
        #if canImport(UIKit)
        self.keyboardType(.phonePad)
        #else
        self
        #endif
    }

    /// iOS inline 导航标题（macOS 无该模式，兜底为无操作）。
    @ViewBuilder
    public func inlineNavigationTitle() -> some View {
        #if canImport(UIKit)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    /// iOS 数字键盘（验证码输入）。
    @ViewBuilder
    public func numberKeyboard() -> some View {
        #if canImport(UIKit)
        self.keyboardType(.numberPad)
        #else
        self
        #endif
    }

    /// iOS 邮箱键盘。
    @ViewBuilder
    public func emailKeyboard() -> some View {
        #if canImport(UIKit)
        self.keyboardType(.emailAddress)
        #else
        self
        #endif
    }

    /// 小数键盘（身高/体重；macOS 兜底无操作）。
    @ViewBuilder
    public func decimalKeyboard() -> some View {
        #if canImport(UIKit)
        self.keyboardType(.decimalPad)
        #else
        self
        #endif
    }

    /// 手机号语义（autofill 归类；iOS `.telephoneNumber`，macOS 无对等）。
    @ViewBuilder
    public func textContentTypeTelephone() -> some View {
        #if canImport(UIKit)
        self.textContentType(.telephoneNumber)
        #else
        self
        #endif
    }

    /// 短信验证码自动填充（`.oneTimeCode`，devops#752 决议二）。
    @ViewBuilder
    public func textContentTypeOneTimeCode() -> some View {
        #if canImport(UIKit)
        self.textContentType(.oneTimeCode)
        #else
        self
        #endif
    }

    /// 邮箱语义填充。
    @ViewBuilder
    public func textContentTypeEmail() -> some View {
        #if canImport(UIKit)
        self.textContentType(.emailAddress)
        #else
        self
        #endif
    }

    /// 关闭自动大写（邮箱/密码输入；macOS 无此修饰符）。
    @ViewBuilder
    public func textInputAutocapitalizationNo() -> some View {
        #if canImport(UIKit)
        self.textInputAutocapitalization(.never)
        #else
        self
        #endif
    }
}
