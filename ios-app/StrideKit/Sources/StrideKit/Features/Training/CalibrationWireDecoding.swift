import Foundation

// Optional additive explanation metadata must not make an old center unreadable.
extension StrideThreshold {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        speedMps = try c.decodeIfPresent(Double.self, forKey: .speedMps)
        pacePerKmSec = try c.decodeIfPresent(Double.self, forKey: .pacePerKmSec)
        hrBpm = try c.decodeIfPresent(Double.self, forKey: .hrBpm)
        speedConfidence = try c.decodeIfPresent(String.self, forKey: .speedConfidence)
        hrConfidence = try c.decodeIfPresent(String.self, forKey: .hrConfidence)
        asOfDate = try c.decodeIfPresent(String.self, forKey: .asOfDate) ?? ""
        calibrationId = try? c.decodeIfPresent(UInt64.self, forKey: .calibrationId)
        algorithmVersion = try? c.decodeIfPresent(Int.self, forKey: .algorithmVersion)
        computedAt = try? c.decodeIfPresent(String.self, forKey: .computedAt)
        selection = try? c.decodeIfPresent(CalibrationSelection.self, forKey: .selection)
        source = try? c.decodeIfPresent(CalibrationSource.self, forKey: .source)
        fingerprint = try? c.decodeIfPresent(String.self, forKey: .fingerprint)
        speedRangePacePerKmSec = try? c.decodeIfPresent(CalibrationPaceRange.self, forKey: .speedRangePacePerKmSec)
    }
}

extension StrideZonesResponse {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threshold = try c.decodeIfPresent(StrideThreshold.self, forKey: .threshold)
        selection = try? c.decodeIfPresent(CalibrationSelection.self, forKey: .selection)
        source = try? c.decodeIfPresent(CalibrationSource.self, forKey: .source)
        paceZones = try c.decode([StridePaceZone].self, forKey: .paceZones)
        hrZones = try c.decode([StrideHrZone].self, forKey: .hrZones)
    }
}

extension CalibrationSource {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = (try? c.decodeIfPresent(Int.self, forKey: .schemaVersion)) ?? 0
        state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "source_unavailable"
        strategy = try? c.decodeIfPresent(String.self, forKey: .strategy)
        implementation = try? c.decodeIfPresent(String.self, forKey: .implementation)
        parameterVersion = try? c.decodeIfPresent(String.self, forKey: .parameterVersion)
        dataCutoffDay = try? c.decodeIfPresent(String.self, forKey: .dataCutoffDay)
        availabilitySemantics = try? c.decodeIfPresent(String.self, forKey: .availabilitySemantics)
        fingerprint = try? c.decodeIfPresent(String.self, forKey: .fingerprint)
        speed = try? c.decodeIfPresent(CalibrationMetricSource.self, forKey: .speed)
        hr = try? c.decodeIfPresent(CalibrationMetricSource.self, forKey: .hr)
    }
}
