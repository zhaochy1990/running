import Foundation
import Testing
@testable import StrideKit

@Suite struct CalibrationWireDecodingTests {
    @Test func constraintsOnlyAndSingleSidedRangeSurviveDecode() throws {
        let json = """
        {"threshold":{"speed_mps":null,"pace_per_km_sec":null,"hr_bpm":null,
          "as_of_date":"2026-11-14","calibration_id":44,"algorithm_version":4,
          "computed_at":"2026-11-15T01:02:03Z","fingerprint":"sha256-example",
          "selection":{"mode":"active","policy_revision":1,"requested_version":4,"effective_version":4,"state":"selected"},
          "source":{"schema_version":1,"state":"available","data_cutoff_day":"2026-11-14",
            "speed":{"method":"constraints_only","target_type":"hour_speed","measurement_quality":"high","effort_support":"unknown","support":"insufficient","range_low":4,"range_meaning":"performance_lower_bound","evidence_date":"2026-11-01","reasons":["no_maximal_anchor"],"limitations":[]},
            "hr":{"method":"field_30min_last20_v1","target_type":"field_HR_proxy_not_physiological_LTHR"}},
          "speed_range_pace_per_km_sec":{"fast":null,"slow":250,"meaning":"performance_lower_bound","bound_kind":"speed_lower_bound"}},"pace_zones":[],"hr_zones":[]}
        """
        let value = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(json.utf8))
        #expect(value.threshold?.pacePerKmSec == nil)
        #expect(value.threshold?.algorithmVersion == 4)
        #expect(value.threshold?.calibrationId == 44)
        #expect(value.threshold?.selection?.effectiveVersion == 4)
        #expect(value.threshold?.speedRangePacePerKmSec?.fast == nil)
        #expect(value.threshold?.speedRangePacePerKmSec?.slow == 250)
        #expect(value.threshold?.source?.speed?.evidenceDate == "2026-11-01")
        #expect(value.threshold?.computedAt == "2026-11-15T01:02:03Z")
        #expect(value.threshold?.source?.hr?.targetType == "field_HR_proxy_not_physiological_LTHR")
    }

    @Test func legacyAndUnavailableResponsesRemainDecodable() throws {
        let legacy = """
        {"threshold":{"pace_per_km_sec":300,"hr_bpm":168,"as_of_date":"2026-11-14"},"pace_zones":[],"hr_zones":[]}
        """
        let old = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(legacy.utf8))
        #expect(old.threshold?.pacePerKmSec == 300)
        #expect(old.threshold?.source == nil)
        let unavailable = """
        {"threshold":null,"pace_zones":[],"hr_zones":[],"selection":{"mode":"active","policy_revision":0,"requested_version":3,"effective_version":null,"state":"unavailable","reason":"no_historical_snapshot"},"source":{"schema_version":0,"state":"snapshot_unavailable"}}
        """
        let empty = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(unavailable.utf8))
        #expect(empty.threshold == nil)
        #expect(empty.selection?.reason == "no_historical_snapshot")
        #expect(empty.source?.state == "snapshot_unavailable")
    }
}
