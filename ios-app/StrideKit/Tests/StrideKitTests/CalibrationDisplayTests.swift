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

    static func assertAdditionalDisplays(_ expected: Fixture.Case.Expected, pace: CalibrationDisplay, hr: CalibrationDisplay) {
        if let day = expected.rejected_evidence_day {
            if let stale = expected.stale_evidence_day { #expect(hr.details.contains("最近陈旧协议日 \(stale)")) }
            #expect(hr.details.contains("最近未采用证据日 \(day)") == (day != expected.stale_evidence_day))
            if let stale = expected.stale_evidence_day, day != stale { #expect(hr.details.contains("心率存在突变或恢复，协议未采用")) }
            #expect(hr.details.contains { $0.contains("陈旧") })
            #expect(hr.support == "能力支持：不足")
        }
        if let range = expected.hr_range { #expect(hr.range == range) }
        if let method = expected.hr_method_label { #expect(hr.details.contains("方法：\(method)")) }
        if let effort = expected.speed_effort_label { #expect(pace.details.contains { $0.contains("全力支持：\(effort)") }) }
        if let method = expected.lab_method { #expect(hr.details.contains { $0.contains("· \(method)") }) }
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
