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
}
