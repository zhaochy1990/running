import XCTest

/// Opt-in UI smoke. Seed the installed app's Documents/StrideLocalRead.json
/// with the disposable local service account before running these tests.
final class CalibrationReadUITests: XCTestCase {
    @MainActor func testThresholdExplanationIsTouchableAndDatesStayDistinct() throws {
        try requireOptIn()
        let app = XCUIApplication()
        app.launchArguments = ["-StrideLocalRead"]
        app.launch()
        let help = app.buttons["阈值配速依据与日期"]
        XCTAssertTrue(help.waitForExistence(timeout: 20), "Requires the local signed-JWT service and private simulator configuration")
        XCTAssertTrue(app.staticTexts["3:34"].exists)
        XCTAssertTrue(app.staticTexts["支持范围 3:34–3:36 /km"].exists)
        help.tap()
        XCTAssertTrue(app.staticTexts["方法：约一小时全力锚点"].waitForExistence(timeout: 5))
        for _ in 0..<6 where !app.staticTexts["数据截止：2026-11-14"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.staticTexts["证据日期：2026-10-01"].exists)
        XCTAssertTrue(app.staticTexts["数据截止：2026-11-14"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "校准执行：2026-11-15 00:30")).firstMatch.exists)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "threshold-help-three-dates"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor func testAccessibilityTextKeepsHelpReadable() throws {
        try requireOptIn()
        let app = XCUIApplication()
        app.launchArguments = ["-StrideLocalRead", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let help = app.buttons["阈值配速依据与日期"]
        XCTAssertTrue(help.waitForExistence(timeout: 20), "Requires local read configuration")
        for _ in 0..<5 where !help.isHittable { app.swipeUp() }
        XCTAssertTrue(help.isHittable)
        help.tap()
        let definition = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阈值配速是约一小时全力跑能力")).firstMatch
        XCTAssertTrue(definition.waitForExistence(timeout: 5))
        for _ in 0..<10 where !definition.isHittable { app.swipeUp() }
        XCTAssertTrue(definition.isHittable)
        XCTAssertLessThanOrEqual(definition.frame.maxX, app.frame.maxX)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "threshold-accessibility-text"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func requireOptIn() throws {
        guard ProcessInfo.processInfo.environment["STRIDE_CALIBRATION_UI_TESTS"] == "YES" else {
            throw XCTSkip("Set STRIDE_CALIBRATION_UI_TESTS=YES after seeding the private local read configuration")
        }
    }

    @MainActor func testConstraintsOnlyDoesNotBorrowLegacyCenter() throws {
        try requireOptIn()
        let app = launchCase("constraints-only")
        XCTAssertTrue(app.staticTexts["至少可达到 4:10 /km（配速 ≤ 4:10）"].exists)
        XCTAssertFalse(app.staticTexts["3:34"].exists)
        app.buttons["阈值配速依据与日期"].tap()
        XCTAssertTrue(app.staticTexts["方法：仅约束，未形成中心估计"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["全力证据不足，暂不提升能力支持或补造中心值。"].exists)
        capture(app, "constraints-only-no-center")
    }

    @MainActor func testMissingSnapshotDoesNotInventEstimate() throws {
        try requireOptIn()
        let app = launchCase("missing")
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "暂无估计")).count, 2)
        XCTAssertFalse(app.staticTexts["3:34"].exists)
        XCTAssertFalse(app.staticTexts["166"].exists)
        app.buttons["阈值配速依据与日期"].tap()
        XCTAssertTrue(app.staticTexts["尚无可用校准快照；不会用其他版本补造中心值。"].waitForExistence(timeout: 5))
        capture(app, "missing-snapshot")
    }

    @MainActor func testLowSupportAndStaleHRReasonRemainVisible() throws {
        try requireOptIn()
        let app = launchCase("low-stale")
        XCTAssertTrue(app.staticTexts["能力支持：低"].exists)
        XCTAssertFalse(app.staticTexts["166"].exists)
        app.buttons["阈值心率依据与日期"].tap()
        let reason = app.staticTexts["心率支持已陈旧，等待新的有效证据。"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5))
        for _ in 0..<4 where !reason.isHittable { app.swipeUp() }
        XCTAssertTrue(reason.isHittable)
        capture(app, "low-support-stale-hr")
    }

    @MainActor private func launchCase(_ name: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-StrideLocalRead", "-StrideLocalReadCase", name]
        app.launch()
        XCTAssertTrue(app.buttons["阈值配速依据与日期"].waitForExistence(timeout: 20))
        return app
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
