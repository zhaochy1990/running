import Foundation
import Testing
@testable import StrideKit

/// 新域测试共用基建：mock transport 与内存指针库（与 APIClientTests 内嵌
/// 版同形，抽顶层供多 suite 复用）。
actor MockTransport: HTTPTransport {
    struct Call {
        let url: URL
        let method: String
        let headers: [String: String]
        let body: Data?
    }

    private var plan: [String: [(Int, Data)]] = [:]
    private var hits: [String: Int] = [:]
    private var calls: [Call] = []

    init() {}

    func plan(_ path: String, _ method: String = "GET", responses: [(Int, Data)]) {
        plan["\(path)|\(method)"] = responses
    }

    func count(path: String) -> Int {
        hits[path] ?? 0
    }

    func calls(to path: String) -> [Call] {
        calls.filter { $0.url.path == path }
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let key = request.url!.path + "|" + (request.httpMethod ?? "GET")
        hits[request.url!.path, default: 0] += 1
        let n = hits[request.url!.path]!
        var headers: [String: String] = [:]
        request.allHTTPHeaderFields.map { headers.merge($0) { _, new in new } }
        calls.append(Call(url: request.url!, method: request.httpMethod ?? "GET", headers: headers, body: request.httpBody))
        let responses = plan[key] ?? [(404, Data())]
        let (status, body) = responses[min(n - 1, responses.count - 1)]
        let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (body, http)
    }
}

/// 测试用 APIClient + token 组合（auth/api 双域名 mock）。
func makeTestClient(transport: HTTPTransport) -> (APIClient, InMemoryTokenStore) {
    let store = InMemoryTokenStore()
    let client = APIClient(
        config: APIConfig(
            baseURL: URL(string: "https://api.test")!,
            authBaseURL: URL(string: "https://auth.test")!,
            clientID: "app_test"
        ),
        tokens: store,
        transport: transport
    )
    return (client, store)
}

/// 测试用隔离 UserDefaults suite（用完清域）。
func makeTestDefaults(_ name: String) -> UserDefaults {
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
}

func jsonData(_ string: String) -> Data { Data(string.utf8) }

/// 内存版 onboarding 指针库。
actor InMemoryOnboardingRunStore: OnboardingRunStore {
    private var pointers: [String: String] = [:]
    private var keys: [String: String] = [:]

    func runPointer(userID: String) async -> String? { pointers[userID] }
    func saveRunPointer(userID: String, runID: String) async { pointers[userID] = runID }
    func clearRunPointer(userID: String) async { pointers[userID] = nil }
    func startKey(userID: String) async -> String? { keys[userID] }
    func saveStartKey(userID: String, _ key: String) async { keys[userID] = key }
    func clearStartKey(userID: String) async { keys[userID] = nil }
}
