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

    @MainActor func testRealZonesNetworkFailureRecoversAfterRetry() async throws {
        try requireOptIn()
        try await Self.setZonesFailure(true)
        addTeardownBlock { try await Self.setZonesFailure(false) }
        let app = XCUIApplication()
        app.launchArguments = ["-StrideLocalRead", "-StrideLocalReadCase", "two-sided"]
        app.launch()
        let retry = app.buttons["重试"]
        XCTAssertTrue(retry.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["加载失败"].exists)
        XCTAssertFalse(app.staticTexts["3:34"].exists)
        capture(app, "real-network-failure")

        try await Self.setZonesFailure(false)
        retry.tap()
        XCTAssertTrue(app.staticTexts["3:34"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["166"].exists)
        XCTAssertTrue(app.staticTexts["支持范围 3:34–3:36 /km"].exists)
        XCTAssertFalse(retry.exists)
        capture(app, "real-network-retry-recovered")
    }

    @MainActor func testProducerFieldHalfPointProtocolAndProbableEffort() throws {
        try requireOptIn()
        let app = assertProducerHR(name: "producer-field-half", value: "167",
                                   method: "场地测试协议（30分钟测试的后20分钟）",
                                   target: "目标：现场心率代理，不是生理乳酸阈值实测")
        let paceHelp = app.buttons["阈值配速依据与日期"]
        for _ in 0..<6 where !paceHelp.isHittable { app.swipeDown() }
        XCTAssertTrue(paceHelp.isHittable)
        paceHelp.tap()
        let effort = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "全力支持：可能全力")).firstMatch
        XCTAssertTrue(effort.waitForExistence(timeout: 5))
        for _ in 0..<6 where !effort.isHittable { app.swipeUp() }
        XCTAssertTrue(effort.isHittable)
        capture(app, "producer-field-probable-effort")
    }

    @MainActor func testProducerLabHalfPointKeepsSpecificLabMethod() throws {
        try requireOptIn()
        _ = assertProducerHR(name: "producer-lab-half", value: "169",
                             method: "实验室乳酸阈值报告",
                             target: "目标：实验室方法特定乳酸阈值 · lactate_turnpoint")
    }

    /// T6 (#1000): evolved-v4 five-state labels, joint-HR marker, revision
    /// disclosure and the per-user override fallback wording on the real UI.
    @MainActor func testEvolvedStatesAndOverrideDisclosureRenderPlainWords() throws {
        try requireOptIn()
        // v4 rev3: HR walks the §6.4 regression branch in these vectors; no
        // measured_reference centers are published (v4.md §8.3).
        let evolved = launchCase("evolved-low-evidence")
        XCTAssertTrue(evolved.staticTexts["4:49"].exists)
        XCTAssertTrue(evolved.staticTexts["162"].exists)
        XCTAssertTrue(evolved.staticTexts["支持范围 4:15–5:03 /km"].exists)
        XCTAssertTrue(evolved.staticTexts["模型估计 · 基于你的普通训练估计"].exists)
        let evolvedHRHelp = evolved.buttons["阈值心率依据与日期"]
        for _ in 0..<4 where !evolvedHRHelp.isHittable { evolved.swipeUp() }
        evolvedHRHelp.tap()
        XCTAssertTrue(evolved.staticTexts["对数速度回归（尺度不可辨识）"].waitForExistence(timeout: 5))
        capture(evolved, "evolved-low-evidence-cards")

        let prior = launchCase("evolved-prior-only")
        XCTAssertTrue(prior.staticTexts["先验主导 · 基于研究先验估计"].exists)
        XCTAssertTrue(prior.staticTexts["5:41"].exists)
        capture(prior, "evolved-prior-only-cards")

        let reference = launchCase("evolved-measured-reference")
        XCTAssertTrue(reference.staticTexts["模型估计 · 基于你的普通训练估计"].exists)
        XCTAssertTrue(reference.staticTexts["167"].exists)
        capture(reference, "evolved-measured-reference-cards")

        let unavailable = launchCase("evolved-unavailable")
        XCTAssertTrue(unavailable.staticTexts["暂无估计 · 窗口内没有有效跑步输入"].exists)
        XCTAssertTrue(unavailable.staticTexts["暂无估计 · 没有心率序列，也没有可用的静息心率先验"].exists)
        XCTAssertFalse(unavailable.staticTexts["3:34"].exists)
        capture(unavailable, "evolved-unavailable-cards")

        let pinned = launchCase("override-selected")
        let pinnedHelp = pinned.buttons["阈值配速依据与日期"]
        for _ in 0..<4 where !pinnedHelp.isHittable { pinned.swipeUp() }
        pinnedHelp.tap()
        XCTAssertTrue(pinned.staticTexts["已按你的选择使用 v4（修订 v4-rev3-2026-11）"].waitForExistence(timeout: 5))
        XCTAssertTrue(pinned.staticTexts["当前有效算法 v4 · 修订 v4-rev3-2026-11"].exists)
        capture(pinned, "override-selected-cards")

        let fallback = launchCase("override-fallback")
        XCTAssertTrue(fallback.staticTexts["3:34"].exists)
        let fallbackHelp = fallback.buttons["阈值配速依据与日期"]
        for _ in 0..<4 where !fallbackHelp.isHittable { fallback.swipeUp() }
        fallbackHelp.tap()
        XCTAssertTrue(fallback.staticTexts["你选择的版本在该日期无快照，暂用全局有效版本"].waitForExistence(timeout: 5))
        XCTAssertFalse(fallback.staticTexts["已按你的选择使用 v4（修订 v4-rev3-2026-11）"].exists)
        capture(fallback, "override-fallback-cards")
    }

    @MainActor private func assertProducerHR(name: String, value: String, method: String, target: String) -> XCUIApplication {
        let app = launchCase(name)
        XCTAssertTrue(app.staticTexts[value].exists)
        XCTAssertTrue(app.staticTexts["支持范围 167–169 bpm"].exists)
        XCTAssertFalse(app.staticTexts["3:34"].exists, "Producer has no pace center; do not borrow legacy values")
        capture(app, "\(name)-cards")
        app.buttons["阈值心率依据与日期"].tap()
        let methodText = app.staticTexts["方法：\(method)"]
        XCTAssertTrue(methodText.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts[target].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "数据质量：通过协议质量门槛")).firstMatch.exists)
        for _ in 0..<6 where !methodText.isHittable { app.swipeUp() }
        XCTAssertTrue(methodText.isHittable)
        capture(app, "\(name)-protocol")
        return app
    }

    private static func setZonesFailure(_ enabled: Bool) async throws {
        // Test-owned transparent loopback proxy only. It does not fabricate any
        // calibration response: enabled zones forwarding connects to closed port1.
        var request = URLRequest(url: URL(string: "http://127.0.0.1:19891/_test/zones-failure")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["enabled": enabled])
        request.timeoutInterval = 5
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
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
