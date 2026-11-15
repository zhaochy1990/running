#if DEBUG
import Foundation
import Testing
@testable import StrideKit

@Suite struct LocalReadConfigurationTests {
    @Test func localReadHarnessCannotSendFixtureTokenToRemoteHost() throws {
        for url in ["https://api.stride-running.cn", "http://localhost:19890", "http://127.0.0.1:19890@api.stride-running.cn", "http://127.0.0.1:19890/api", "http://127.0.0.1:19890?redirect=prod"] {
            let data = try JSONSerialization.data(withJSONObject: ["url": url, "token": "test-only"])
            #expect(throws: (any Error).self) { try DebugLocalReadConfiguration(data: data) }
        }
        let local = try DebugLocalReadConfiguration(data: Data(#"{"url":"http://127.0.0.1:19890","token":"test-only"}"#.utf8))
        #expect(local.url.host == "127.0.0.1")
    }

    @Test func caseSelectionUsesPrivateFileAndRejectsUnknownIdentity() throws {
        let data = Data(#"{"url":"http://127.0.0.1:19890","cases":[{"name":"missing","token":"test-only"}]}"#.utf8)
        _ = try DebugLocalReadConfiguration(data: data, caseName: "missing")
        #expect(throws: (any Error).self) { try DebugLocalReadConfiguration(data: data, caseName: "unknown") }
    }
}
#endif
