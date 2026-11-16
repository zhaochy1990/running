import Foundation
import Testing
@testable import StrideKit

@Suite struct CalibrationDisplayTests {
    struct Fixture: Decodable {
        struct Case: Decodable {
            struct Expected: Decodable {
                let pace: String
                let pace_range: String?
                let hr: String
                let evidence_day: String?
                let cutoff_day: String?
                let computed_shanghai: String?
                let hr_range: String?
                let hr_method_label: String?
                let speed_effort_label: String?
                let lab_method: String?
                let source_unavailable: Bool?
                let rejected_evidence_day: String?
                let stale_evidence_day: String?
                let current_hr_supported: Bool?
                let hr_evidence_day: String?
                // T6 (#1000) shared parity literals with Web/mp.
                let pace_state: String?
                let hr_state: String?
                let pace_algorithm_label: String?
                let override_label: String?
                let override_fallback_label: String?
                let hr_joint_label: String?
                let hr_proxy_label: String?
                let hr_model_target_label: String?
                let hr_reference_target_label: String?
            }
            let name: String
            let response: StrideZonesResponse
            let expected: Expected
        }
        let cases: [Case]
    }

    static func cases() throws -> [Fixture.Case] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: root.appendingPathComponent("docs/calibration/fixtures/client-display-v1.json"))).cases
    }

    static func caseNamed(_ name: String) throws -> Fixture.Case {
        try cases().first { $0.name == name }!
    }

    @Test func sharedServerUnitsRangesAndThreeDates() throws {
        for item in try Self.cases() {
            let pace = calibrationDisplay(item.response, metric: .pace)
            let hr = calibrationDisplay(item.response, metric: .heartRate)
            #expect(pace.value == item.expected.pace, "\(item.name)")
            #expect(pace.range == item.expected.pace_range, "\(item.name)")
            #expect(hr.value == item.expected.hr, "\(item.name)")
            #expect(pace.evidenceDay == item.expected.evidence_day)
            #expect(pace.cutoffDay == item.expected.cutoff_day)
            #expect(pace.computedShanghai == item.expected.computed_shanghai)
            Self.assertAdditionalDisplays(item.expected, pace: pace, hr: hr)
            if item.expected.source_unavailable == true { #expect(pace.support == "来源信息不可用"); #expect(hr.support == "来源信息不可用") }

        }
    }

    /// T6 (#1000): the five-state labels, joint-HR marker, per-user override
    /// disclosure and the effective-algorithm line render the same literals as
    /// Web/mp on the same shared fixture responses.
    @Test func sharedEvolvedStateAlgorithmAndOverrideLabels() throws {
        for item in try Self.cases() {
            let pace = calibrationDisplay(item.response, metric: .pace)
            let hr = calibrationDisplay(item.response, metric: .heartRate)
            if let state = item.expected.pace_state { #expect(pace.support == state, "\(item.name)") }
            if let state = item.expected.hr_state { #expect(hr.support == state, "\(item.name)") }
            if let label = item.expected.pace_algorithm_label {
                #expect(pace.details.contains(label), "\(item.name)")
                #expect(hr.details.contains(label), "\(item.name)")
            }
            if let label = item.expected.override_label {
                #expect(pace.details.contains(label), "\(item.name)")
                #expect(hr.details.contains(label), "\(item.name)")
            }
            if let label = item.expected.override_fallback_label {
                #expect(pace.details.contains(label), "\(item.name)")
                #expect(!pace.details.contains { $0.contains("已按你的选择使用") }, "\(item.name)")
            }
            if let label = item.expected.hr_joint_label { #expect(hr.details.contains(label), "\(item.name)") }
        }
    }

    @Test func evolvedFiveStatesInPlainWords() throws {
        let low = calibrationDisplay(try Self.caseNamed("evolved-low-evidence").response, metric: .pace)
        #expect(low.support == "模型估计 · 基于你的普通训练估计")
        #expect(low.value == "4:18")
        #expect(low.range == "支持范围 4:01–4:52 /km")
        let lowHR = calibrationDisplay(try Self.caseNamed("evolved-low-evidence").response, metric: .heartRate)
        #expect(lowHR.support == "模型估计 · 基于你的普通训练估计")
        #expect(lowHR.value == "171")
        #expect(lowHR.range == "支持范围 160–181 bpm")
        #expect(lowHR.details.contains("联合估计，非独立验证"))
        #expect(!low.details.joined().contains("必须先测试"))
        #expect(low.range?.contains("95%") != true)

        let prior = calibrationDisplay(try Self.caseNamed("evolved-prior-only").response, metric: .pace)
        #expect(prior.support == "先验主导 · 基于研究先验估计")
        #expect(prior.details.contains { $0.contains("证据不足以区分能力与余量") })
        let priorHR = calibrationDisplay(try Self.caseNamed("evolved-prior-only").response, metric: .heartRate)
        #expect(priorHR.support == "先验主导 · 基于研究先验估计")
        #expect(priorHR.details.contains { $0.contains("心率估计仅来自生理先验") })
        #expect(prior.value != "—" && priorHR.value != "—")

        let reference = calibrationDisplay(try Self.caseNamed("evolved-measured-reference").response, metric: .heartRate)
        #expect(reference.support == "实测参考")
        #expect(reference.details.contains { $0.contains("实测参考中位数（已核验协议）") })
        #expect(reference.details.contains { $0.hasSuffix("参考条件下预计心率（一小时能力配速）") })
        #expect(!reference.details.contains { $0.contains("模型推算稳态心率") })
        #expect(!reference.details.contains("联合估计，非独立验证"))

        let unavailablePace = calibrationDisplay(try Self.caseNamed("evolved-unavailable").response, metric: .pace)
        #expect(unavailablePace.support == "暂无估计 · 窗口内没有有效跑步输入")
        #expect(unavailablePace.value == "—")
        #expect(unavailablePace.range == nil)
        let unavailableHR = calibrationDisplay(try Self.caseNamed("evolved-unavailable").response, metric: .heartRate)
        #expect(unavailableHR.support == "暂无估计 · 没有心率序列，也没有可用的静息心率先验")
        #expect(unavailableHR.value == "—")
    }

    @Test func historicalV4RowsKeepLegacyWordingWithoutRevision() throws {
        let pace = calibrationDisplay(try Self.caseNamed("historical-v4").response, metric: .pace)
        #expect(pace.support == "能力支持：高")
        #expect(pace.details.contains("当前有效算法 v4"))
        #expect(!pace.details.contains { $0.contains("修订") })
        #expect(!pace.details.contains { $0.contains("模型估计") })
    }

    @Test func overridePinAndSnapshotMissingFallbackDisclosedSeparately() throws {
        let pinned = calibrationDisplay(try Self.caseNamed("override-selected").response, metric: .pace)
        #expect(pinned.details.contains("已按你的选择使用 v4（修订 v4-rev2-2026-11）"))
        #expect(pinned.details.contains("当前有效算法 v4 · 修订 v4-rev2-2026-11"))
        let fallback = calibrationDisplay(try Self.caseNamed("override-fallback").response, metric: .pace)
        #expect(fallback.details.contains("你选择的版本在该日期无快照，暂用全局有效版本"))
        #expect(fallback.details.contains("当前有效算法 v3"))
        #expect(!fallback.details.contains { $0.contains("已按你的选择使用") })
    }

    @Test func unknownFutureStateDegradesConservatively() throws {
        let json = """
        {"threshold":{"pace_per_km_sec":214,"as_of_date":"2026-11-14","source":{"schema_version":1,"state":"available","speed":{"state":"some_future_state","method":"robust_map_effort_margin_fit","support":"medium"}}},"pace_zones":[],"hr_zones":[]}
        """
        let response = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        let display = calibrationDisplay(response, metric: .pace)
        #expect(display.value == "3:34")
        #expect(display.support == "来源信息不可用")
    }

    static func assertAdditionalDisplays(_ expected: Fixture.Case.Expected, pace: CalibrationDisplay, hr: CalibrationDisplay) {
        if let day = expected.rejected_evidence_day {
            if let stale = expected.stale_evidence_day { #expect(hr.details.contains("最近陈旧协议日 \(stale)")) }
            #expect(hr.details.contains("最近未采用证据日 \(day)") == (day != expected.stale_evidence_day))
            #expect(hr.details.contains("未采用历史协议（不参与当前估计）"))
            if expected.stale_evidence_day != nil { #expect(hr.details.contains("未采用协议：协议证据已过期")) }
            #expect(!hr.details.contains("心率支持已陈旧，等待新的有效证据。"))
            #expect(hr.support == (expected.current_hr_supported == true ? "能力支持：低" : "能力支持：不足"))
            if expected.current_hr_supported == true { #expect(hr.value == "170"); #expect(hr.evidenceDay == expected.hr_evidence_day) }
        }
        if let range = expected.hr_range { #expect(hr.range == range) }
        if let method = expected.hr_method_label { #expect(hr.details.contains("方法：\(method)")) }
        if let effort = expected.speed_effort_label { #expect(pace.details.contains { $0.contains("全力支持：\(effort)") }) }
        if let method = expected.lab_method { #expect(hr.details.contains { $0.contains("· \(method)") }) }
        // T6 (#1000) parity keys, shared literals with Web/mp.
        if let state = expected.pace_state { #expect(pace.support == state) }
        if let state = expected.hr_state { #expect(hr.support == state) }
        if let label = expected.pace_algorithm_label { #expect(pace.details.contains(label)); #expect(hr.details.contains(label)) }
        if let label = expected.override_label { #expect(pace.details.contains(label)); #expect(hr.details.contains(label)) }
        if let label = expected.override_fallback_label {
            #expect(pace.details.contains(label))
            #expect(!pace.details.contains { $0.contains("已按你的选择使用") })
        }
        if let label = expected.hr_joint_label { #expect(hr.details.contains(label)) }
        // P2-3 (#1000 review): one shared proxy/target wording across platforms,
        // no "LTHR" abbreviation for end users.
        // iOS renders target lines with a "目标：" field prefix; the shared
        // parity literal is the suffix after the platform prefix.
        if let label = expected.hr_proxy_label { #expect(hr.details.contains { $0.hasSuffix(label) }) }
        if let label = expected.hr_model_target_label { #expect(hr.details.contains { $0.hasSuffix(label) }) }
        if let label = expected.hr_reference_target_label {
            #expect(hr.details.contains { $0.hasSuffix(label) })
            #expect(!hr.details.contains { $0.contains("模型推算稳态心率") })
        }
        // P2-1 (#1000 review): the same categorical reason may be stamped by
        // both the speed fit and the joint refit; render each text once.
        // Evidence source lines are factual lists and are excluded.
        for lines in [pace.details, hr.details] {
            let kept = lines.filter { !$0.isEmpty && !$0.hasPrefix("关键来源：") }
            #expect(Set(kept).count == kept.count)
        }
    }

    @Test func productionMethodsAndLegacyDetectionStayHonest() throws {
        let json = """
        {"threshold":{"pace_per_km_sec":214,"hr_bpm":166,"as_of_date":"2026-11-14",
         "source":{"schema_version":1,"state":"available","speed":{"method":"direct_60min_maximal","support":"high","measurement_quality":"high","effort_support":"probable_maximal"},
         "hr":{"method":"legacy_v3_training_estimate","target_type":"legacy_training_estimate_not_independent_LTHR","support":"high"}}},"pace_zones":[],"hr_zones":[]}
        """
        let response = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        let pace = calibrationDisplay(response, metric: .pace)
        #expect(pace.details.contains("方法：约一小时全力锚点"))
        #expect(pace.details.contains { $0.contains("可能全力") })
        let hr = calibrationDisplay(response, metric: .heartRate)
        #expect(hr.support.contains("旧版支持标签"))
        #expect(hr.details.contains { $0.contains("未经独立生理检测") })
    }

    @Test func invalidOptionalExplanationCannotLoseExistingCenters() throws {
        let json = """
        {"threshold":{"pace_per_km_sec":214,"hr_bpm":166,"as_of_date":"2026-11-14", "source":{"state":"source_unavailable"},"selection":{"state":"future_state"},"speed_range_pace_per_km_sec":{"bound_kind":"future_bound"}},"pace_zones":[],"hr_zones":[]}
        """
        let response = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        #expect(response.threshold?.pacePerKmSec == 214)
        #expect(calibrationDisplay(response, metric: .pace).support == "来源信息不可用")
    }

    @Test func futureSourceSchemaDoesNotBorrowKnownSupportLabels() throws {
        let json = """
        {"threshold":{"pace_per_km_sec":214,"as_of_date":"2026-11-14","source":{"schema_version":2,"state":"available","speed":{"support":"high","measurement_quality":"high"}}},"pace_zones":[],"hr_zones":[]}
        """
        let response = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        let value = calibrationDisplay(response, metric: .pace)
        #expect(value.value == "3:34")
        #expect(value.support == "来源信息不可用")
    }

    @Test func missingCandidateHRSourceDoesNotBecomeLegacyEstimate() throws {
        let json = """
        {"threshold":{"pace_per_km_sec":214,"hr_bpm":null,"as_of_date":"2026-11-14","source":{"schema_version":1,"state":"available","speed":{"support":"high"}}},"pace_zones":[],"hr_zones":[]}
        """
        let response = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        let value = calibrationDisplay(response, metric: .heartRate)
        #expect(value.support == "心率证据信息未提供")
        #expect(!value.details.contains { $0.contains("保留已有训练估计") })
    }

    @Test func realProtocolQualityAndHourReasonsKeepTheirMeaning() throws {
        let json = """
        {"threshold":{"as_of_date":"2026-11-14","source":{"schema_version":1,"state":"available","hr":{"target_type":"unavailable","measurement_quality":"protocol_quality_gate_passed","support":"low","reasons":["no_independent_maximal_anchors","hour_extrapolation_not_identified_by_independent_recent_anchors"]}}},"pace_zones":[],"hr_zones":[]}
        """
        let response = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        let value = calibrationDisplay(response, metric: .heartRate)
        #expect(value.support == "能力支持：低")
        #expect(value.details.contains { $0.contains("数据质量：通过协议质量门槛") })
        #expect(value.details.contains { $0.contains("缺少独立近全力证据") })
        #expect(value.details.contains { $0.contains("近期独立锚点不足，无法推断一小时能力") })
        #expect(value.details.contains("目标：暂无可用心率参考"))
    }

    @Test func heartRateHalfPointsUsePositiveTiesUpForCenterAndRange() throws {
        let json = """
        {"threshold":{"pace_per_km_sec":214,"hr_bpm":166.5,"as_of_date":"2026-11-14","source":{"schema_version":1,"state":"available","hr":{"method":"field_30min_last20_v1","target_type":"field_HR_proxy_not_physiological_LTHR","range_low":166.5,"range_high":168.5,"support":"medium"}}},"pace_zones":[],"hr_zones":[]}
        """
        let response = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        let hr = calibrationDisplay(response, metric: .heartRate)
        #expect(hr.value == "167")
        #expect(hr.range == "支持范围 167–169 bpm")
        #expect(calibrationDisplay(response, metric: .pace).value == "3:34")
    }

    @Test func labProtocolLabelKeepsSpecificMethod() throws {
        let json = """
        {"threshold":{"hr_bpm":168.5,"as_of_date":"2026-11-14","source":{"schema_version":1,"state":"available","hr":{"method":"lab_lthr_report_v1","target_type":"lab_method_specific_LTHR","lab_method":"OBLA4.0","support":"medium"}}},"pace_zones":[],"hr_zones":[]}
        """
        let response = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        let hr = calibrationDisplay(response, metric: .heartRate)
        #expect(hr.value == "169")
        #expect(hr.details.contains("方法：实验室乳酸阈值报告"))
        #expect(hr.details.contains("目标：实验室方法特定乳酸阈值 · OBLA4.0"))
    }
}
