import CryptoKit
import Foundation
import Testing
@testable import StrideKit

/// Real APIClient + decoder + display projection against the captured, private
/// nonfinal Go/Rabbit/MySQL stack. No HTTP interception or account creation.
@Suite struct CalibrationCapturedStackTests {
    struct Fixture: Decodable {
        let phase: String
        let url: URL
        let user_id: String
        let token: String
        let sha256: String
        let cutoff: String
    }
    struct NodeSummary: Decodable {
        struct Display: Decodable { let pace: String; let hr: String; let range: String? }
        let algorithm_version: Int
        let web: Display
        let mp: Display
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["STRIDE_991_STACK_OUTPUT"] != nil))
    func capturedResponseMatchesOtherClientsAndPreservesNil() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["STRIDE_991_STACK_OUTPUT"])
        guard path.hasPrefix("/tmp/stride-983/private/") else { throw CocoaError(.fileReadCorruptFile) }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard fixture.url.absoluteString == "http://127.0.0.1:19892" else { throw CocoaError(.fileReadCorruptFile) }
        let summary = try JSONDecoder().decode(NodeSummary.self, from: Data(contentsOf: URL(fileURLWithPath: "\(path).\(fixture.phase).node.json")))
        let tokens = InMemoryTokenStore()
        await tokens.save(access: fixture.token, refresh: "", expiresIn: 300)
        let client = APIClient(config: APIConfig(baseURL: fixture.url, authBaseURL: fixture.url), tokens: tokens)
        let data = try await client.send(APIRequest(path: "/api/\(fixture.user_id)/stride/zones"))
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        #expect(hash == fixture.sha256)
        let zones = try JSONDecoder().decode(StrideZonesResponse.self, from: data)
        #expect(zones.threshold?.algorithmVersion == summary.algorithm_version)
        #expect(zones.threshold?.asOfDate == fixture.cutoff)
        let pace = calibrationDisplay(zones, metric: .pace)
        let hr = calibrationDisplay(zones, metric: .heartRate)
        #expect(pace.value == summary.web.pace)
        #expect(pace.value == summary.mp.pace)
        #expect(hr.value == summary.web.hr)
        #expect(hr.value == summary.mp.hr)
        #expect(pace.range == summary.web.range)
        #expect(pace.cutoffDay == fixture.cutoff)
        if fixture.phase == "active4" {
            #expect(zones.threshold?.speedMps == nil)
            #expect(zones.threshold?.hrBpm == nil)
            #expect(pace.value == "—")
            #expect(hr.value == "—")
            if zones.threshold?.speedRangePacePerKmSec?.boundKind == "speed_lower_bound" {
                #expect(pace.range?.contains("至少可达到") == true)
            } else if zones.threshold?.speedRangePacePerKmSec?.boundKind == "unavailable" {
                #expect(pace.range == nil)
            }
        }
    }
}
