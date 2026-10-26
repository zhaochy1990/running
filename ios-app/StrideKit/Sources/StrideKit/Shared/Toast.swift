import SwiftUI

/// 底部轻提示（`wx.showToast(icon: none)` 的 SwiftUI 等价物，devops#769）：
/// 文案出现后 1.8s 自动回调清除；调用方模型只持有一个 `toast: String?`。
public struct ToastModifier: ViewModifier {

    @Environment(AppModel.self) private var app
    let message: String?
    let onDismiss: () -> Void

    public func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let message, !message.isEmpty {
                Text(message)
                    .font(app.theme.current.font(.fs13, weight: .medium))
                    .foregroundStyle(app.theme.current.onAccent)
                    .padding(.horizontal, app.theme.current.space(.lg))
                    .padding(.vertical, app.theme.current.space(.sm))
                    .background(
                        Capsule().fill(app.theme.current.foregroundSoft.opacity(0.92))
                    )
                    .padding(.bottom, 72)
                    .transition(.opacity)
                    .task {
                        try? await Task.sleep(for: .milliseconds(1800))
                        onDismiss()
                    }
            }
        }
        .animation(.easeInOut(duration: 0.18), value: message)
    }
}

extension View {
    /// 挂载底部 toast；`message` 非 nil 时显示并计时自动清除。
    public func raceToast(_ message: String?, onDismiss: @escaping () -> Void) -> some View {
        modifier(ToastModifier(message: message, onDismiss: onDismiss))
    }
}
