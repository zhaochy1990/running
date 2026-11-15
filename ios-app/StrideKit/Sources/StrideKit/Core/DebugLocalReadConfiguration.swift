#if DEBUG
import Foundation

/// Simulator-only READ smoke setup. The file lives in the app's private Documents
/// folder and must never be committed. No fixture token can target production.
public struct DebugLocalReadConfiguration {
    public let url: URL
    private let token: String

    public init(data: Data, caseName: String? = nil) throws {
        struct Payload: Decodable {
            struct Case: Decodable { let name: String; let token: String }
            let url: URL
            let token: String?
            let cases: [Case]?
        }
        let payload = try JSONDecoder().decode(Payload.self, from: data)
        let selectedToken: String?
        if let cases = payload.cases {
            selectedToken = cases.first { $0.name == (caseName ?? "two-sided") }?.token
        } else { selectedToken = payload.token }
        guard payload.url.scheme == "http", payload.url.host == "127.0.0.1",
              payload.url.port == 19890, payload.url.user == nil, payload.url.password == nil,
              ["", "/"].contains(payload.url.path), payload.url.query == nil, payload.url.fragment == nil,
              let selectedToken, !selectedToken.isEmpty else {
            throw CocoaError(.fileReadCorruptFile)
        }
        url = payload.url
        token = selectedToken
    }

    @MainActor public func makeAppModel() -> AppModel {
        let tokens = LocalReadTokens(token)
        let config = APIConfig(baseURL: url, authBaseURL: url, coachBaseURL: url, shareBaseURL: url)
        return AppModel(api: APIClient(config: config, tokens: tokens), tokens: tokens,
                        coach: CoachClient(config: config, tokens: tokens))
    }

    public static func loadForSimulator() -> DebugLocalReadConfiguration? {
        #if targetEnvironment(simulator)
        guard ProcessInfo.processInfo.arguments.contains("-StrideLocalRead"),
              let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? Data(contentsOf: folder.appendingPathComponent("StrideLocalRead.json")) else { return nil }
        let args = ProcessInfo.processInfo.arguments
        let caseName = args.firstIndex(of: "-StrideLocalReadCase").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        return try? DebugLocalReadConfiguration(data: data, caseName: caseName)
        #else
        return nil
        #endif
    }
}

private actor LocalReadTokens: TokenStore {
    private var token: String?
    init(_ token: String) { self.token = token }
    func accessToken() async -> String? { token }
    func refreshToken() async -> String? { nil }
    func expiresAt() async -> Date? { nil }
    func save(access: String, refresh: String, expiresIn: TimeInterval) async {}
    func clear() async { token = nil }
}
#endif
