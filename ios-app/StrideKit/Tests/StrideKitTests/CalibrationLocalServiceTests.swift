import CryptoKit
import Foundation
import Testing
@testable import StrideKit

/// Opt-in read-only integration against the disposable MySQL + Gin service.
/// This never registers a user or sends a fixture credential to a remote host.
@Suite struct CalibrationLocalServiceTests {
    struct Manifest: Decodable {
        struct Case: Decodable {
            let name: String
            let user_id: String
            let token: String
            let sha256: String
            let expected: CalibrationDisplayTests.Fixture.Case.Expected
        }
        let url: URL
        let cases: [Case]
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["STRIDE_LOCAL_READ_MANIFEST"] != nil))
    func realAPIClientReadsSharedCases() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["STRIDE_LOCAL_READ_MANIFEST"])
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard manifest.url.absoluteString == "http://127.0.0.1:19890" else { throw CocoaError(.fileReadCorruptFile) }
        for item in manifest.cases {
            let tokens = InMemoryTokenStore()
            await tokens.save(access: item.token, refresh: "", expiresIn: 300)
            let api = APIClient(config: APIConfig(baseURL: manifest.url, authBaseURL: manifest.url), tokens: tokens)
            let data = try await api.send(APIRequest(path: "/api/\(item.user_id)/stride/zones"))
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            #expect(digest == item.sha256, "\(item.name): exact server response identity")
            let zones = try JSONDecoder().decode(StrideZonesResponse.self, from: data)
            let pace = calibrationDisplay(zones, metric: .pace)
            let hr = calibrationDisplay(zones, metric: .heartRate)
            #expect(pace.value == item.expected.pace, "\(item.name)")
            #expect(pace.range == item.expected.pace_range, "\(item.name)")
            #expect(hr.value == item.expected.hr, "\(item.name)")
            #expect(pace.evidenceDay == item.expected.evidence_day)
            #expect(pace.cutoffDay == item.expected.cutoff_day)
            #expect(pace.computedShanghai == item.expected.computed_shanghai)
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["STRIDE_LOCAL_READ_MANIFEST"] != nil))
    @MainActor func realSessionLoadsTrainingStatusModel() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["STRIDE_LOCAL_READ_MANIFEST"])
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        guard manifest.url.absoluteString == "http://127.0.0.1:19890" else { throw CocoaError(.fileReadCorruptFile) }
        for item in manifest.cases {
            let tokens = InMemoryTokenStore()
            await tokens.save(access: item.token, refresh: "", expiresIn: 300)
            let app = AppModel(api: APIClient(config: APIConfig(baseURL: manifest.url, authBaseURL: manifest.url), tokens: tokens), tokens: tokens)
            await app.bootstrap(entry: .trainingStatus)
            #expect(app.me?.id == item.user_id, "\(item.name): verified local JWT identity")
            let model = TrainingStatusModel()
            await model.activate(app: app)
            #expect(model.errorText.isEmpty, "\(item.name)")
            #expect(model.metrics.first { $0.label == "阈值配速" }?.value == item.expected.pace)
            #expect(model.metrics.first { $0.label == "阈值心率" }?.value == item.expected.hr)
        }
    }

    @Test func realDisconnectedLoopbackKeepsNetworkFailureExplicit() async throws {
        let api = APIClient(config: APIConfig(baseURL: URL(string: "http://127.0.0.1:1")!, timeout: 1), tokens: InMemoryTokenStore())
        do {
            _ = try await TrainingRepository(api: api).strideZones(userId: "synthetic-no-account")
            Issue.record("A refused local connection must remain a failure, not fabricated calibration")
        } catch let error as URLError {
            #expect(error.code == .cannotConnectToHost)
        }
    }
}
