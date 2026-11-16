import XCTest

/// devops#1018 P1 锁定测试：训练页横扫切日手势与卡内「和教练聊一聊」CTA
/// 排他。修复前 CTA 是 Button——横扫起止点落在按钮内时 touch-up 照常触发，
/// `app.swipeRight()` 三连复现「滑日期被甩进教练 tab」（复现手法即本测试
/// 第 1 步的 press+drag）。修复后 CTA 为 tap 手势：tap 让位给 drag，横扫只
/// 切日期；同时验证点按 CTA 仍能进教练 tab、竖向轻扫不被横扫手势劫持。
///
/// 与 CalibrationReadUITests 同一 opt-in 门（STRIDE_CALIBRATION_UI_TESTS）：
/// 需要已 seed 的 `-StrideLocalRead` 模拟器配置，且种子账号当天有训练课
/// （CTA 只在今日卡有课时渲染）。
final class TrainingSwipeExclusivityUITests: XCTestCase {

    @MainActor func testHorizontalSwipeAcrossCoachCTAShiftsDayWithoutTabSwitch() throws {
        try requireOptIn()
        let app = XCUIApplication()
        app.launchArguments = ["-StrideLocalRead"]
        app.launch()

        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 20), "Requires the seeded local read configuration")
        tabBar.buttons["训练"].tap()

        // CTA 仅在选中日有课时渲染（种子账号当天需有训练课）。
        let cta = app.descendants(matching: .any)["和教练聊一聊"].firstMatch
        XCTAssertTrue(cta.waitForExistence(timeout: 20), "Seeded account has no workout today; CTA missing")

        // 1) 横扫起止点都落在 CTA 内 → 只切日期、不切 tab。
        let scheduleHeader = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "今日安排 ·")
        ).firstMatch
        XCTAssertTrue(scheduleHeader.waitForExistence(timeout: 5))
        let before = scheduleHeader.label

        let dy = (cta.frame.midY - app.frame.minY) / app.frame.height
        let start = cta.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: dy))
        start.press(forDuration: 0.05, thenDragTo: end)

        XCTAssertEqual(scheduleHeader.label, nextDayLabel(after: before),
                       "Swipe across the CTA must shift the selected day")
        XCTAssertTrue(app.tabBars.buttons["训练"].isSelected,
                      "Swipe across the CTA must not leave the training tab")
        XCTAssertTrue(cta.exists, "Swipe across the CTA must not navigate away")

        // 2) 静止点按 CTA 仍进入教练 tab（tap 未被 drag 排他吞掉）。
        cta.tap()
        let coachTab = app.tabBars.buttons["教练"]
        XCTAssertTrue(coachTab.waitForExistence(timeout: 5))
        XCTAssertTrue(coachTab.isSelected, "Tapping the CTA must still switch to the coach tab")

        // 3) 竖向轻扫不被横扫手势劫持：回训练 tab 上滑仍是滚动、不切 tab。
        tabBar.buttons["训练"].tap()
        XCTAssertTrue(cta.waitForExistence(timeout: 10))
        app.swipeUp(velocity: .fast)
        XCTAssertTrue(app.tabBars.buttons["训练"].isSelected,
                      "Vertical pan must stay a scroll, not trigger any navigation")
    }

    /// 「今日安排 · 11月16日」→ 后一天「今日安排 · 11月17日」。
    private func nextDayLabel(after header: String) -> String {
        let datePart = header.replacingOccurrences(of: "今日安排 · ", with: "")
        let parts = datePart.replacingOccurrences(of: "月", with: " ")
            .replacingOccurrences(of: "日", with: " ")
            .split(separator: " ")
        guard parts.count == 2, let month = Int(parts[0]), let day = Int(parts[1]) else {
            return header
        }
        var base = Calendar.current.dateComponents([.year], from: Date())
        base.month = month
        base.day = day
        base.hour = 12
        guard let current = Calendar.current.date(from: base),
              let next = Calendar.current.date(byAdding: .day, value: 1, to: current) else {
            return header
        }
        let nextParts = Calendar.current.dateComponents([.month, .day], from: next)
        return "今日安排 · \(nextParts.month!)月\(nextParts.day!)日"
    }

    private func requireOptIn() throws {
        guard ProcessInfo.processInfo.environment["STRIDE_CALIBRATION_UI_TESTS"] == "YES" else {
            throw XCTSkip("Set STRIDE_CALIBRATION_UI_TESTS=YES after seeding the private local read configuration")
        }
    }
}
