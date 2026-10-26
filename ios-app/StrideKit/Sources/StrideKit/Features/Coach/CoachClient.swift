import Foundation
import os

// coach 传输层抽象（测试注入用；URLSession 提供生产实现）。
// 流式请求不能走 APIClient 的 data(for:)（会缓冲整条流），SSE 通道据此
// 独立成一套「字节流 + 自管 401 单飞刷新」（票面：SSE 通道独立 401 refresh 单飞）。

/// 异步字节块源（单消费者语义：流式任务串行拉取）。
public protocol ChunkSource: Sendable {
    /// 下一批字节；流结束返回 nil。
    func nextChunk() async throws -> [UInt8]?
}

/// 流式传输抽象：返回字节块源 + HTTP 状态（流式 body 不落 Data）。
public protocol StreamTransport: Sendable {
    func stream(for request: URLRequest) async throws -> (source: ChunkSource, response: HTTPURLResponse)
}

/// URLSession.bytes 适配：8KB 缓冲成块喂解析器（字节边界本就任意）。
/// 单消费者：仅被发起流的那个 Task 串行访问。
private final class URLSessionChunkSource: ChunkSource, @unchecked Sendable {
    private var iterator: URLSession.AsyncBytes.Iterator

    init(bytes: URLSession.AsyncBytes) {
        self.iterator = bytes.makeAsyncIterator()
    }

    func nextChunk() async throws -> [UInt8]? {
        var chunk: [UInt8] = []
        while chunk.count < 8192 {
            guard let byte = try await iterator.next() else {
                return chunk.isEmpty ? nil : chunk
            }
            chunk.append(byte)
        }
        return chunk
    }
}

extension URLSession: StreamTransport {
    public func stream(for request: URLRequest) async throws -> (source: ChunkSource, response: HTTPURLResponse) {
        let (bytes, response) = try await self.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CoachStreamError(code: "non_http_response", message: "非 HTTP 响应")
        }
        return (URLSessionChunkSource(bytes: bytes), http)
    }
}

// MARK: - 回调与句柄

/// 流式回调（全部在 MainActor 上按到达序串行投递）。
public struct CoachStreamCallbacks: Sendable {
    public var onEvent: (@MainActor @Sendable (CoachStreamEvent) -> Void)?
    public var onComplete: (@MainActor @Sendable (CoachDone) -> Void)?
    public var onError: (@MainActor @Sendable (CoachStreamError) -> Void)?

    public init(
        onEvent: (@MainActor @Sendable (CoachStreamEvent) -> Void)? = nil,
        onComplete: (@MainActor @Sendable (CoachDone) -> Void)? = nil,
        onError: (@MainActor @Sendable (CoachStreamError) -> Void)? = nil
    ) {
        self.onEvent = onEvent
        self.onComplete = onComplete
        self.onError = onError
    }
}

/// 流句柄：abort 后不再投递任何回调（服务端无取消传播，turn 会继续跑完
/// 写 checkpoint，立即同 id 重发会撞 thread 锁 —— 调用方自担）。
public struct CoachStreamHandle: Sendable {
    let cancel: @Sendable () -> Void

    /// 中止在途流。
    public func abort() { cancel() }
}

// MARK: - CoachClient

/// coach_agent_api 客户端（actor）：
///
/// - **流式**：`POST /api/users/me/coach/chat` + `Accept: text/event-stream`，
///   `URLSession.bytes` + 字节级 `SSEParser`（勿用 EventSource 库——票面硬约束）；
///   五事件 status/narration/text_delta/done/error；done/error 是唯一终止信号
///   （无 [DONE]、无 heartbeat）。
/// - **超时**：`timeoutInterval` 即 URLSession 的**空闲**超时（每到数据即重置）
///   —— 分钟级以适配长工具静默期（#421：服务端无心跳）；总上限另设 11 分钟
///   （服务端单 turn 预算 10 分钟，放宽保证失败文案先于客户端超时到达）。
/// - **401**：流式/JSON 两条通道各自「刷新一次 → 原请求重试一次」；刷新
///   单飞（并发 401 共享同一刷新）；刷新失败 → 清 token → onSessionExpired。
/// - **幂等**：body 一次编码、逐字节复用（服务端 fingerprint = body sha256，
///   同 id 不同 body → 409 client_turn_id_conflict）。
public actor CoachClient {

    private let config: APIConfig
    private let tokens: any TokenStore
    private let transport: any HTTPTransport
    private let streamTransport: any StreamTransport
    private var refreshTask: Task<String, Error>?
    private var sessionExpiredHandler: (@MainActor @Sendable () async -> Void)?
    private let log = Logger(subsystem: "com.lipaotech.stridewise", category: "coach-api")

    public init(
        config: APIConfig = APIConfig(),
        tokens: any TokenStore,
        transport: any HTTPTransport = URLSession.shared,
        streamTransport: any StreamTransport = URLSession.shared
    ) {
        self.config = config
        self.tokens = tokens
        self.transport = transport
        self.streamTransport = streamTransport
    }

    public func setSessionExpiredHandler(_ handler: @escaping @MainActor @Sendable () async -> Void) {
        sessionExpiredHandler = handler
    }

    // MARK: - 流式 chat

    /// 发起一轮流式对话（立即返回句柄；事件经 callbacks 串行投递）。
    /// nonisolated：只读不可变 config + 内部 Task 跳回 actor，非隔离面可直呼。
    public nonisolated func stream(
        message: String,
        sessionId: String,
        clientTurnId: String,
        target: CoachTarget?,
        callbacks: CoachStreamCallbacks
    ) -> CoachStreamHandle {
        // body 一次编码：重试轮逐字节相同（fingerprint 幂等）。
        let body: Data
        do {
            struct ChatBody: Codable {
                let session_id: String
                let message: String
                let client_turn_id: String
                let target: CoachTarget?
            }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            body = try encoder.encode(ChatBody(session_id: sessionId, message: message, client_turn_id: clientTurnId, target: target))
        } catch {
            let error = CoachStreamError(code: "encode_failed", message: "请求编码失败")
            Task { await callbacks.onError?(error) }
            return CoachStreamHandle {}
        }
        let task = Task {
            await runStream(
                body: body,
                callbacks: callbacks,
                parser: SSEParser(),
                isRetry: false
            )
        }
        return CoachStreamHandle { task.cancel() }
    }

    /// 单次流式尝试；401 → 刷新一次后整轮重试（parser 重建，不残留旧字节）。
    private func runStream(
        body: Data,
        callbacks: CoachStreamCallbacks,
        parser: SSEParser,
        isRetry: Bool
    ) async {
        var parser = parser
        // 终止标记（done/error 已投递）：跨隔离闭包读写，经锁保护的 Sendable
        // 装箱承载（单消费者流循环 + 一次性置位）。
        let terminal = TerminalFlag()

        func failOnce(_ error: CoachStreamError) async {
            guard !terminal.isSet else { return }
            terminal.set()
            await callbacks.onError?(error)
        }

        // 投递单个事件；done/error 置 terminal。
        func dispatch(_ event: SSEParser.Event) async {
            guard !terminal.isSet else { return }
            switch event.event {
            case "done":
                terminal.set()
                await callbacks.onComplete?(Self.parseDone(event.data))
            case "error":
                terminal.set()
                let o = Self.safeObject(event.data)
                await callbacks.onError?(CoachStreamError(
                    code: (o["code"] as? String) ?? "coach_turn_failed",
                    message: (o["message"] as? String) ?? "coach turn failed"
                ))
            case "status":
                let o = Self.safeObject(event.data)
                await callbacks.onEvent?(.status(CoachStatus(
                    phase: CoachPhase(rawValue: (o["phase"] as? String) ?? "") ?? .analyzing,
                    tool: o["tool"] as? String,
                    toolStatus: o["tool_status"] as? String
                )))
            case "narration":
                let o = Self.safeObject(event.data)
                await callbacks.onEvent?(.narration((o["delta"] as? String) ?? ""))
            case "text_delta":
                let o = Self.safeObject(event.data)
                await callbacks.onEvent?(.delta((o["delta"] as? String) ?? ""))
            default:
                break
            }
        }

        let token = await tokens.accessToken() ?? ""
        var request = URLRequest(url: config.coachBaseURL.appending(path: "/api/users/me/coach/chat"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = config.coachIdleTimeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(config.clientID, forHTTPHeaderField: "X-Client-Id")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let source: ChunkSource
        let response: HTTPURLResponse
        do {
            (source, response) = try await streamTransport.stream(for: request)
        } catch {
            if error is CancellationError || Task.isCancelled { return }
            await failOnce(CoachStreamError(code: "network", message: "网络异常，请稍后重试"))
            return
        }
        guard !Task.isCancelled else { return }

        // 401 → 刷新单飞一次 → 整轮重试（fresh parser）；再 401 = 会话失效。
        if response.statusCode == 401 {
            if isRetry {
                await handleSessionExpired()
                await failOnce(CoachStreamError(code: "unauthorized", message: "登录已过期"))
                return
            }
            do {
                _ = try await refreshedAccessToken()
                await runStream(body: body, callbacks: callbacks, parser: SSEParser(), isRetry: true)
            } catch {
                await handleSessionExpired()
                await failOnce(CoachStreamError(code: "session_expired", message: "登录已过期"))
            }
            return
        }
        guard (200..<300).contains(response.statusCode) else {
            await failOnce(CoachStreamError(code: "http_\(response.statusCode)", message: "请求失败(\(response.statusCode))"))
            return
        }

        // 字节循环：空闲超时由 timeoutInterval 承担（静默期到点 nextChunk 抛
        // timedOut）；总上限在此看表——超时取消任务，产出 timeout 错误。
        let deadline = ContinuousClock.now + Duration.seconds(config.coachTotalTimeout)
        while !terminal.isSet {
            if ContinuousClock.now >= deadline {
                await failOnce(CoachStreamError(code: "timeout", message: "生成时间过长，已中止"))
                return
            }
            let chunk: [UInt8]?
            do {
                chunk = try await withTimeout(until: deadline) { try await source.nextChunk() }
            } catch let error as CoachStreamError {
                await failOnce(error)
                return
            } catch {
                if Task.isCancelled || error is CancellationError { return }
                if (error as? URLError)?.code == .timedOut {
                    await failOnce(CoachStreamError(code: "timeout", message: "回复超时，请重试"))
                } else {
                    await failOnce(CoachStreamError(code: "network", message: "网络异常，请稍后重试"))
                }
                return
            }
            guard let chunk else { break }
            for event in parser.feed(chunk) {
                await dispatch(event)
                if terminal.isSet { return }
            }
        }
        guard !terminal.isSet else { return }
        // 2xx 但流关闭且未见 done/error：先 flush 残余字节恢复被截断的终态
        // 事件；仍没有才算失败（避免页面停在流式状态）。
        for event in parser.flush() {
            await dispatch(event)
        }
        await failOnce(CoachStreamError(code: "empty", message: "未收到回复"))
    }

    /// 总上限竞争包裹：nextChunk 挂死时由 deadline 先行超时。
    private func withTimeout<T: Sendable>(
        until deadline: ContinuousClock.Instant,
        _ operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                let remaining = deadline - ContinuousClock.now
                try await Task.sleep(for: remaining)
                throw CoachStreamError(code: "timeout", message: "生成时间过长，已中止")
            }
            guard let first = try await group.next() else {
                throw CancellationError()
            }
            group.cancelAll()
            return first
        }
    }

    // MARK: - 会话 JSON 端点（手动 Bearer + 401 刷新重试一次）

    /// `GET /api/users/me/coach/sessions` —— 全量会话，新→旧。
    public func fetchSessions() async throws -> [CoachSessionSummary] {
        let o = try await getJSONObject(path: "/api/users/me/coach/sessions")
        guard let list = o["sessions"] as? [[String: Any]] else { return [] }
        return list.compactMap { row in
            guard let id = row["session_id"] as? String else { return nil }
            return CoachSessionSummary(
                sessionId: id,
                updatedAt: row["updated_at"] as? String,
                preview: row["preview"] as? String
            )
        }
    }

    /// `GET /api/users/me/coach/sessions/{id}/messages` —— 历史 user/assistant 行。
    public func fetchHistory(sessionId: String) async throws -> CoachHistoryResponse {
        let o = try await getJSONObject(path: "/api/users/me/coach/sessions/\(sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId)/messages")
        let rows = (o["messages"] as? [[String: Any]]) ?? []
        let messages = rows.compactMap { row -> CoachHistoryMessage? in
            guard let content = row["content"] as? String else { return nil }
            return CoachHistoryMessage(
                role: (row["role"] as? String) == "user" ? .user : .assistant,
                content: content,
                card: CoachCardWire.parse(row["card"].flatMap { try? JSONSerialization.data(withJSONObject: $0) })
            )
        }
        return CoachHistoryResponse(sessionId: (o["session_id"] as? String) ?? sessionId, messages: messages)
    }

    /// `POST /api/users/me/coach/sessions/{id}/share` —— 多选转发快照。
    public func createShare(sessionId: String, indices: [Int], sharerName: String?) async throws -> CoachShareResult {
        var body: [String: Any] = ["indices": indices]
        if let sharerName, !sharerName.isEmpty { body["sharer_name"] = sharerName }
        let o = try await postJSONObject(
            path: "/api/users/me/coach/sessions/\(sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId)/share",
            body: body
        )
        guard let sid = o["sid"] as? String else {
            throw CoachStreamError(code: "invalid_response", message: "分享创建失败")
        }
        return CoachShareResult(sid: sid, reused: (o["reused"] as? Bool) == true)
    }

    // MARK: - 卡片动作端点（用户数据面，经普通 JSON 通道）

    /// `GET /api/users/{u}/master-plan/current` —— 替换三态预检；404 = 确认没有。
    public func currentPlan(userId: String) async throws -> CurrentPlanRef? {
        let o: [String: Any]
        do {
            o = try await getJSONObject(path: "/api/users/\(userId)/master-plan/current")
        } catch let error as ApiError where error.statusCode == 404 {
            return nil
        }
        guard let planId = o["plan_id"] as? String else { return nil }
        let envelope = o["plan"] as? [String: Any]
        return CurrentPlanRef(
            planId: planId,
            revision: (envelope?["revision"] as? Int) ?? (o["revision"] as? Int)
        )
    }

    /// `POST /api/users/{u}/master-plan/apply` —— apply_token 幂等应用；
    /// 409/422 由调用方复查收口。
    public func applyPlan(
        userId: String,
        applyToken: String,
        content: Data,
        expectation: (planId: String, revision: Int?)?
    ) async throws {
        var body: [String: Any] = [
            "apply_token": applyToken,
            "content": try JSONSerialization.jsonObject(with: content),
        ]
        if let expectation {
            body["expected_active_plan_id"] = expectation.planId
            body["expected_active_revision"] = expectation.revision ?? 1
        }
        _ = try await postJSONObject(path: "/api/users/\(userId)/master-plan/apply", body: body)
    }

    /// `POST /api/users/me/custom-workouts` —— save_token 幂等 upsert。
    public func upsertCustomWorkout(_ card: CustomWorkoutCard) async throws -> PlanSessionRow {
        let body: [String: Any] = [
            "date": card.date,
            "kind": card.kind ?? "run",
            "name": card.name,
            "summary": card.summary,
            "spec": try JSONSerialization.jsonObject(with: card.spec),
            "total_distance_m": card.totalDistanceM ?? NSNull(),
            "total_duration_s": card.totalDurationS ?? NSNull(),
            "estimated_dose": card.estimatedDose ?? NSNull(),
            "save_token": card.saveToken,
        ]
        let o = try await postJSONObject(path: "/api/users/me/custom-workouts", body: body)
        return Self.parsePlanRow(o)
    }

    /// `POST /api/users/me/custom-workouts/{id}/push` —— 推送到手表。
    public func pushCustomWorkout(workoutId: String) async throws {
        _ = try await postJSONObject(path: "/api/users/me/custom-workouts/\(workoutId)/push", body: [:])
    }

    /// `DELETE /api/users/me/custom-workouts/{id}` —— 软删。
    public func deleteCustomWorkout(userId: String, workoutId: String) async throws {
        _ = try await requestJSONObject(
            path: "/api/users/me/custom-workouts/\(workoutId)",
            method: "DELETE", body: nil
        )
    }

    /// `POST /api/users/me/custom-workouts/{id}/move` —— T1 改期端点。
    public func moveCustomWorkout(userId: String, workoutId: String, date: String) async throws -> MoveWorkoutResult {
        let o = try await postJSONObject(path: "/api/users/me/custom-workouts/\(workoutId)/move", body: ["date": date])
        return MoveWorkoutResult(
            row: Self.parsePlanRow(o),
            watchSynced: (o["watch_synced"] as? Bool) ?? false
        )
    }

    /// `GET /api/users/me/plan/sessions?date_from=&date_to=` —— 卡片终态对账窗口。
    public func planSessions(userId: String, from: String, to: String) async throws -> [PlanSessionRow] {
        let o = try await getJSONObject(
            path: "/api/users/me/plan/sessions?date_from=\(from)&date_to=\(to)"
        )
        let rows = (o["sessions"] as? [[String: Any]]) ?? []
        return rows.map(Self.parsePlanRow)
    }

    static func parsePlanRow(_ o: [String: Any]) -> PlanSessionRow {
        PlanSessionRow(
            workoutId: (o["workout_id"] as? String) ?? "",
            date: (o["date"] as? String) ?? "",
            source: (o["source"] as? String) ?? "",
            pushed: (o["pushed"] as? Bool) ?? false,
            saveToken: o["save_token"] as? String
        )
    }

    // MARK: - JSON 底座（手动 Bearer + 401 刷新重试一次）

    private func getJSONObject(path: String) async throws -> [String: Any] {
        try await requestJSONObject(path: path, method: "GET", body: nil)
    }

    private func postJSONObject(path: String, body: [String: Any]) async throws -> [String: Any] {
        try await requestJSONObject(path: path, method: "POST", body: body)
    }

    private func requestJSONObject(path: String, method: String, body: [String: Any]?) async throws -> [String: Any] {
        var attempt = 0
        while true {
            let token = await tokens.accessToken() ?? ""
            let data = try await performJSON(path: path, method: method, body: body, token: token)
            if data.statusCode == 401 {
                if attempt > 0 {
                    await handleSessionExpired()
                    throw ApiError.sessionExpired
                }
                attempt += 1
                _ = try await refreshedAccessToken()
                continue
            }
            guard (200..<300).contains(data.statusCode) else {
                throw ApiError.make(statusCode: data.statusCode, body: data.body)
            }
            guard !data.body.isEmpty else { return [:] }
            guard let object = try? JSONSerialization.jsonObject(with: data.body) as? [String: Any] else {
                throw ApiError.decodeFailure([String: Any].self)
            }
            return object
        }
    }

    private func performJSON(
        path: String,
        method: String,
        body: [String: Any]?,
        token: String
    ) async throws -> (statusCode: Int, body: Data) {
        var request = URLRequest(url: config.coachBaseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = config.timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(config.clientID, forHTTPHeaderField: "X-Client-Id")
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await transport.data(forHTTP: request)
        return (response.statusCode, data)
    }

    // MARK: - 刷新单飞（coach 通道独立；请求面与 APIClient 相同）

    private func refreshedAccessToken() async throws -> String {
        if let refreshTask {
            return try await refreshTask.value
        }
        let task = Task<String, Error> { try await performRefresh() }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    private func performRefresh() async throws -> String {
        guard let refreshToken = await tokens.refreshToken() else {
            throw ApiError(statusCode: 0, code: "no_refresh_token", detail: "无 refresh token")
        }
        var request = URLRequest(url: config.authBaseURL.appending(path: "/api/auth/refresh"))
        request.httpMethod = "POST"
        request.timeoutInterval = config.timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(config.clientID, forHTTPHeaderField: "X-Client-Id")
        request.httpBody = try JSONEncoder().encode(["refresh_token": refreshToken])
        let (data, response) = try await transport.data(forHTTP: request)
        guard response.statusCode == 200 else {
            throw ApiError.make(statusCode: response.statusCode, body: data)
        }
        struct RefreshResponse: Decodable {
            let access_token: String
            let refresh_token: String
            let expires_in: Int
        }
        let refreshed = try JSONDecoder().decode(RefreshResponse.self, from: data)
        await tokens.save(
            access: refreshed.access_token,
            refresh: refreshed.refresh_token,
            expiresIn: TimeInterval(refreshed.expires_in)
        )
        return refreshed.access_token
    }

    private func handleSessionExpired() async {
        await tokens.clear()
        log.warning("coach 会话失效：已清 token")
        await sessionExpiredHandler?()
    }

    // MARK: - 解析工具

    private static func safeObject(_ data: String) -> [String: Any] {
        guard let raw = data.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: raw) as? [String: Any]
        else { return [:] }
        return object
    }

    /// done.data → CoachDone：needs_input 的 interrupt 取 question/header 文本。
    private static func parseDone(_ data: String) -> CoachDone {
        let o = safeObject(data)
        let interrupt: String?
        if let text = o["interrupt"] as? String {
            interrupt = text
        } else if let payload = o["interrupt"] as? [String: Any] {
            if let question = payload["question"] as? String, !question.isEmpty {
                interrupt = question
            } else if let header = payload["header"] as? String, !header.isEmpty {
                interrupt = header
            } else {
                interrupt = nil
            }
        } else {
            interrupt = nil
        }
        return CoachDone(
            status: (o["status"] as? String).flatMap(CoachDone.Status.init(rawValue:)),
            message: o["message"] as? String,
            interruptText: interrupt,
            card: CoachCardWire.parse(o["card"].flatMap { try? JSONSerialization.data(withJSONObject: $0) })
        )
    }
}

/// 一次性终止标记（锁保护，@unchecked Sendable：只做单调置位/读）。
final class TerminalFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        defer { lock.unlock() }
        value = true
    }
}

// MARK: - 服务协议（CoachChatModel 依赖面；测试注入 mock）

public protocol CoachServicing: Sendable {
    func stream(
        message: String,
        sessionId: String,
        clientTurnId: String,
        target: CoachTarget?,
        callbacks: CoachStreamCallbacks
    ) -> CoachStreamHandle

    func fetchSessions() async throws -> [CoachSessionSummary]
    func fetchHistory(sessionId: String) async throws -> CoachHistoryResponse
    func createShare(sessionId: String, indices: [Int], sharerName: String?) async throws -> CoachShareResult

    func currentPlan(userId: String) async throws -> CurrentPlanRef?
    func applyPlan(userId: String, applyToken: String, content: Data, expectation: (planId: String, revision: Int?)?) async throws
    func upsertCustomWorkout(_ card: CustomWorkoutCard) async throws -> PlanSessionRow
    func pushCustomWorkout(workoutId: String) async throws
    func deleteCustomWorkout(userId: String, workoutId: String) async throws
    func moveCustomWorkout(userId: String, workoutId: String, date: String) async throws -> MoveWorkoutResult
    func planSessions(userId: String, from: String, to: String) async throws -> [PlanSessionRow]
}

extension CoachClient: CoachServicing {}
