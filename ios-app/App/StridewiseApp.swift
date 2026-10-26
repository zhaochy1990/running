import SwiftUI
import StrideKit

/// Stridewise App 入口（devops#764 PR-1 骨架）。
/// 冷启动 bootstrap（checkAuth 等价）+ onOpenURL 深链接力（devops#749 §4.3）。
@main
struct StridewiseApp: App {

    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task {
                    GeistFonts.registerIfNeeded()
                    await model.bootstrap()
                }
                .onOpenURL { url in
                    model.open(url)
                }
        }
    }
}
