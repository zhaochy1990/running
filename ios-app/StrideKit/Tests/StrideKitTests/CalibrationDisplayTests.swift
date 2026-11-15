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
}
