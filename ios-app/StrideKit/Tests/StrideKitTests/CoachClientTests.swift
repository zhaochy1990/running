import Foundation
import Testing
@testable import StrideKit

/// CoachClient 流式通道测试：五事件流 / 401 单飞刷新重试（逐字节相同 body）/
/// 终止语义 / 截断恢复 / 总上限 / abort 静默。
@Suite struct CoachClientTests {

    // MARK: - 测试基建

    /// 顺序吐块的字节源；可选挂死（总上限测试）。
    final class MockChunkSource: ChunkSource, @unchecked Sendable {
        private let lock = NSLock()
        private var chunks: [[UInt8]]
        private var finished = false
        var hang: Bool

        init(chunks: [[UInt8]], hang: Bool = false) {
            self.chunks = chunks
            self.hang = hang
        }

        /// 同步弹出一块（锁不跨 await）；nil = 流结束，.some([]) = 挂死标记。
        private func popNext() -> [UInt8]? {
            lock.lock()
            defer { lock.unlock() }
            guard !chunks.isEmpty else { return hang ? [] : nil }
            return chunks.removeFirst()
        }

        func nextChunk() async throws -> [UInt8]? {
            guard let next = popNext() else { return nil } // 流结束
            if next.isEmpty {
                // 永不到达下一块（模拟长静默连接；靠总上限或取消退出）。
                while !Task.isCancelled {
                    try await Task.sleep(for: .seconds(1))
                }
                return nil
            }
            return next
        }
    }

    actor MockStreamTransport: StreamTransport {
        private var responses: [(status: Int, source: ChunkSource)]
        private(set) var requests: [URLRequest] = []

        init(responses: [(status: Int, source: ChunkSource)]) {
            self.responses = responses
        }

        func stream(for request: URLRequest) async throws -> (source: ChunkSource, response: HTTPURLResponse) {
            requests.append(request)
            let next = responses.isEmpty
                ? (status: 200, source: MockChunkSource(chunks: []))
                : responses.removeFirst()
            let http = HTTPURLResponse(url: request.url!, statusCode: next.status, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (next.source, http)
        }

        func requestBodies() -> [Data?] { requests.map(\.httpBody) }
    }

    /// JSON data 传输（refresh + coach JSON 端点共用）。
    actor MockDataTransport: HTTPTransport {
        private var plan: [String: (Int, Data)] = [:]
        private(set) var hits: [String] = []

        func plan(_ path: String, _ method: String = "POST", status: Int, body: Data) {
            plan["\(method) \(path)"] = (status, body)
        }

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            let key = "\(request.httpMethod ?? "GET") \(request.url!.path)"
            hits.append(key)
            let (status, body) = plan[key] ?? (404, Data())
            let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
            return (body, http)
        }
    }

    /// 线程安全的事件记录（回调在 MainActor 上串行写入）。
    final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _events: [String] = []
        private var _done: CoachDone?
        private var _error: CoachStreamError?

        var events: [String] { lock.lock(); defer { lock.unlock() }; return _events }
        var done: CoachDone? { lock.lock(); defer { lock.unlock() }; return _done }
        var error: CoachStreamError? { lock.lock(); defer { lock.unlock() }; return _error }

        func record(_ event: CoachStreamEvent) {
            lock.lock()
            defer { lock.unlock() }
            switch event {
            case .status(let s): _events.append("status:\(s.phase.rawValue)")
            case .narration(let d): _events.append("narration:\(d)")
            case .delta(let d): _events.append("delta:\(d)")
            }
        }

        func recordDone(_ done: CoachDone) { lock.lock(); defer { lock.unlock() }; self._done = done }
        func recordError(_ error: CoachStreamError) { lock.lock(); defer { lock.unlock() }; self._error = error }
    }

    private func makeClient(
        streamResponses: [(Int, MockChunkSource)],
        dataTransport: MockDataTransport = MockDataTransport(),
        tokens: InMemoryTokenStore = InMemoryTokenStore(),
        totalTimeout: TimeInterval = 5
    ) -> (CoachClient, MockStreamTransport, MockDataTransport, InMemoryTokenStore) {
        let streamTransport = MockStreamTransport(
            responses: streamResponses.map { (status: $0.0, source: $0.1) }
        )
        let config = APIConfig(
            baseURL: URL(string: "https://api.test")!,
            authBaseURL: URL(string: "https://auth.test")!,
            coachBaseURL: URL(string: "https://coach.test")!,
            coachTotalTimeout: totalTimeout
        )
        let client = CoachClient(
            config: config,
            tokens: tokens,
            transport: dataTransport,
            streamTransport: streamTransport
        )
        return (client, streamTransport, dataTransport, tokens)
    }

    private func waitUntil(_ condition: @Sendable () -> Bool) async {
        for _ in 0..<250 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    private func callbacks(_ recorder: Recorder) -> CoachStreamCallbacks {
        CoachStreamCallbacks(
            onEvent: { recorder.record($0) },
            onComplete: { recorder.recordDone($0) },
            onError: { recorder.recordError($0) }
        )
    }

    // MARK: - 五事件全流程 + card 信封

    @Test func streamsFiveEventsInOrder() async throws {
        let recorder = Recorder()
        let chunks = MockChunkSource(chunks: [
            Array("event: status\ndata: {\"phase\":\"running_tool\",\"tool\":\"query\",\"tool_status\":\"running\"}\n\n".utf8),
            Array("event: narration\ndata: {\"delta\":\"正在取数\"}\n\n".utf8),
            Array("event: status\ndata: {\"phase\":\"analyzing\"}\n\n".utf8),
            Array("event: text_delta\ndata: {\"delta\":\"配速\"}\n\n".utf8),
            Array("event: text_delta\ndata: {\"delta\":\"建议\"}\n\n".utf8),
            Array("event: done\ndata: {\"status\":\"completed\",\"message\":\"配速建议 5:00\",\"card\":{\"$type\":\"race-strategy\",\"data\":{\"race_name\":\"上马\",\"item_type\":\"FM\",\"target_finish_time\":\"3:30:00\",\"pace_segments\":[{\"segment\":\"s\"}]}}}\n\n".utf8),
        ])
        let (client, _, _, tokens) = makeClient(streamResponses: [(200, chunks)])
        await tokens.save(access: "acc-1", refresh: "ref-1", expiresIn: 300)

        let handle = client.stream(
            message: "配速多少", sessionId: "ios-default", clientTurnId: "ios-turn-1", target: nil,
            callbacks: callbacks(recorder)
        )
        await waitUntil { recorder.done != nil }
        handle.abort()

        let done = try #require(recorder.done)
        #expect(done.status == .completed)
        #expect(done.message == "配速建议 5:00")
        #expect(done.card?.type == "race-strategy")
        #expect(recorder.events == [
            "status:running_tool",
            "narration:正在取数",
            "status:analyzing",
            "delta:配速",
            "delta:建议",
        ])
        #expect(recorder.error == nil)
    }

    // MARK: - 401 → 刷新单飞 → 逐字节相同 body 重试

    @Test func unauthorizedRefreshesAndRetriesWithIdenticalBody() async throws {
        let recorder = Recorder()
        let unauthorized = MockChunkSource(chunks: [])
        let ok = MockChunkSource(chunks: [
            Array("event: done\ndata: {\"status\":\"completed\",\"message\":\"ok\"}\n\n".utf8),
        ])
        let dataTransport = MockDataTransport()
        await dataTransport.plan("/api/auth/refresh", status: 200, body: Data(
            #"{"access_token":"acc-2","refresh_token":"ref-2","expires_in":300}"#.utf8
        ))
        let (client, streamTransport, _, tokens) = makeClient(
            streamResponses: [(401, unauthorized), (200, ok)],
            dataTransport: dataTransport
        )
        await tokens.save(access: "stale", refresh: "ref-1", expiresIn: 300)

        let target = CoachTarget(kind: .session, date: "2026-10-26", sessionIndex: 0)
        _ = client.stream(
            message: "今天练什么", sessionId: "s-1", clientTurnId: "ios-turn-9", target: target,
            callbacks: callbacks(recorder)
        )
        await waitUntil { recorder.done != nil }

        let requests = await streamTransport.requests
        #expect(requests.count == 2)
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer stale")
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer acc-2")
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Accept") == "text/event-stream" })
        // 幂等：两轮 body 逐字节相同（fingerprint = body sha256）。
        let bodies = await streamTransport.requestBodies()
        #expect(bodies[0] == bodies[1])
        let json = try #require(bodies[0]).flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        #expect(json?["client_turn_id"] as? String == "ios-turn-9")
        #expect(json?["target"] != nil)
    }

    @Test func secondUnauthorizedFailsAsSessionExpired() async throws {
        let recorder = Recorder()
        let dataTransport = MockDataTransport()
        await dataTransport.plan("/api/auth/refresh", status: 200, body: Data(
            #"{"access_token":"acc-2","refresh_token":"ref-2","expires_in":300}"#.utf8
        ))
        let (client, _, _, tokens) = makeClient(
            streamResponses: [(401, MockChunkSource(chunks: [])), (401, MockChunkSource(chunks: []))],
            dataTransport: dataTransport
        )
        await tokens.save(access: "stale", refresh: "ref-1", expiresIn: 300)

        _ = client.stream(message: "hi", sessionId: "s", clientTurnId: "t", target: nil, callbacks: callbacks(recorder))
        await waitUntil { recorder.error != nil }
        #expect(recorder.error?.code == "unauthorized")
    }

    // MARK: - error 事件与终止

    @Test func errorEventTerminatesWithServerCode() async {
        let recorder = Recorder()
        let chunks = MockChunkSource(chunks: [
            Array("event: error\ndata: {\"code\":\"coach_thread_busy\",\"message\":\"busy\"}\n\n".utf8),
        ])
        let (client, _, _, tokens) = makeClient(streamResponses: [(200, chunks)])
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 300)

        _ = client.stream(message: "m", sessionId: "s", clientTurnId: "t", target: nil, callbacks: callbacks(recorder))
        await waitUntil { recorder.error != nil }
        #expect(recorder.error == CoachStreamError(code: "coach_thread_busy", message: "busy"))
    }

    // MARK: - 截断恢复 / 空流

    @Test func truncatedDoneRecoveredByFlush() async {
        let recorder = Recorder()
        // done 事件无终止符即关流：flush 恢复。
        let chunks = MockChunkSource(chunks: [
            Array("event: done\ndata: {\"status\":\"completed\",\"message\":\"recovered\"}".utf8),
        ])
        let (client, _, _, tokens) = makeClient(streamResponses: [(200, chunks)])
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 300)

        _ = client.stream(message: "m", sessionId: "s", clientTurnId: "t", target: nil, callbacks: callbacks(recorder))
        await waitUntil { recorder.done != nil || recorder.error != nil }
        #expect(recorder.done?.message == "recovered")
        #expect(recorder.error == nil)
    }

    @Test func emptyStreamFailsWithEmptyCode() async {
        let recorder = Recorder()
        let (client, _, _, tokens) = makeClient(streamResponses: [(200, MockChunkSource(chunks: []))])
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 300)

        _ = client.stream(message: "m", sessionId: "s", clientTurnId: "t", target: nil, callbacks: callbacks(recorder))
        await waitUntil { recorder.error != nil }
        #expect(recorder.error?.code == "empty")
    }

    @Test func non2xxFailsWithHttpCode() async {
        let recorder = Recorder()
        let (client, _, _, tokens) = makeClient(streamResponses: [(429, MockChunkSource(chunks: []))])
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 300)

        _ = client.stream(message: "m", sessionId: "s", clientTurnId: "t", target: nil, callbacks: callbacks(recorder))
        await waitUntil { recorder.error != nil }
        #expect(recorder.error?.code == "http_429")
    }

    // MARK: - 总上限

    @Test func totalTimeoutCapsHangingStream() async {
        let recorder = Recorder()
        let hang = MockChunkSource(chunks: [], hang: true)
        let (client, _, _, tokens) = makeClient(streamResponses: [(200, hang)], totalTimeout: 0.2)
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 300)

        _ = client.stream(message: "m", sessionId: "s", clientTurnId: "t", target: nil, callbacks: callbacks(recorder))
        await waitUntil { recorder.error != nil }
        #expect(recorder.error?.code == "timeout")
    }

    // MARK: - abort 静默

    @Test func abortSuppressesAllCallbacks() async {
        let recorder = Recorder()
        let chunks = MockChunkSource(chunks: [
            Array("event: text_delta\ndata: {\"delta\":\"x\"}\n\n".utf8),
        ])
        let (client, _, _, tokens) = makeClient(streamResponses: [(200, chunks)])
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 300)

        let handle = client.stream(message: "m", sessionId: "s", clientTurnId: "t", target: nil, callbacks: callbacks(recorder))
        handle.abort()
        try? await Task.sleep(for: .milliseconds(300))
        #expect(recorder.events.isEmpty)
        #expect(recorder.done == nil)
        #expect(recorder.error == nil)
    }

    // MARK: - 会话 JSON 端点

    @Test func fetchSessionsAndHistory() async throws {
        let dataTransport = MockDataTransport()
        await dataTransport.plan("/api/users/me/coach/sessions", "GET", status: 200, body: Data(
            #"{"sessions":[{"session_id":"qa-2026-10-01","updated_at":"2026-10-01","preview":"旧的 QA 会话"}]}"#.utf8
        ))
        await dataTransport.plan("/api/users/me/coach/sessions/qa-2026-10-01/messages", "GET", status: 200, body: Data(
            #"{"session_id":"qa-2026-10-01","thread_id":"u:coach:qa-2026-10-01","messages":[{"role":"user","content":"问"},{"role":"assistant","content":"答","card":{"$type":"master-plan","data":{"goal":{"race_name":"上马","distance":"FM","race_date":"2027-01-01","target_time":""},"total_weeks":12}}}]}"#.utf8
        ))
        let (client, _, _, tokens) = makeClient(streamResponses: [], dataTransport: dataTransport)
        await tokens.save(access: "acc", refresh: "ref", expiresIn: 300)

        let sessions = try await client.fetchSessions()
        #expect(sessions.map(\.sessionId) == ["qa-2026-10-01"])

        let history = try await client.fetchHistory(sessionId: "qa-2026-10-01")
        #expect(history.messages.count == 2)
        #expect(history.messages[1].card?.type == "master-plan")
    }
}
