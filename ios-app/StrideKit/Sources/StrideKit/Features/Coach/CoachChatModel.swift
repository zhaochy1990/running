import Foundation
import Observation

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

// MARK: - 消息与会话模型

/// 聊天消息（MP coach.ts CoachMessage 镜像）。
public struct CoachMessage: Identifiable, Equatable, Sendable {
    public let id: Int
    public let role: CoachHistoryMessage.Role
    /// 助手正文（markdown）；卡片消息按 inlineBody 决定是否渲染正文。
    public var content: String
    /// 结构化产物通知卡片（done.card 经注册表翻译）。
    public var card: CoachCardRegistry.View?
    /// user 消息本轮 client_turn_id（失败重试复用同 id）。
    public var clientTurnId: String?
    /// 发送失败待重试标记。
    public var failed: Bool = false
    /// 服务端历史投影序号（多选转发 indices 基准）；nil=不在投影内不可转发。
    public var shareIndex: Int?
    public var selectable: Bool = false
    public var selected: Bool = false
    /// 展示时间戳 HH:mm（仅本会话内新产生的消息带）。
    public var ts: String?
}

/// 本地会话元信息（id 与服务端 thread `{user}:coach:{id}` 一一对应）。
public struct CoachSession: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var title: String
    /// 该会话锚定的目标（每轮消息随发）。
    public var target: CoachTarget?
    /// 展示标签，如「轻松跑 12km · 9月8日」。
    public var contextLabel: String?

    public init(id: String, title: String, target: CoachTarget? = nil, contextLabel: String? = nil) {
        self.id = id
        self.title = title
        self.target = target
        self.contextLabel = contextLabel
    }
}

// MARK: - 会话持久化（wx storage 等价）

/// 会话列表 + 当前会话 id 的本地持久化。
public protocol CoachSessionStore: Sendable {
    func loadSessions() -> [CoachSession]
    func saveSessions(_ sessions: [CoachSession])
    func loadCurrentSessionId() -> String
    func saveCurrentSessionId(_ id: String)
}

/// UserDefaults 实现（生产）。
public final class DefaultsCoachSessionStore: CoachSessionStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private static let sessionsKey = "coach.sessions"
    private static let currentKey = "coach.currentSessionId"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func loadSessions() -> [CoachSession] {
        guard let data = defaults.data(forKey: Self.sessionsKey),
              let sessions = try? JSONDecoder().decode([CoachSession].self, from: data)
        else { return [] }
        return sessions
    }

    public func saveSessions(_ sessions: [CoachSession]) {
        guard let data = try? JSONEncoder().encode(sessions) else { return }
        defaults.set(data, forKey: Self.sessionsKey)
    }

    public func loadCurrentSessionId() -> String {
        defaults.string(forKey: Self.currentKey) ?? ""
    }

    public func saveCurrentSessionId(_ id: String) {
        defaults.set(id, forKey: Self.currentKey)
    }
}

// MARK: - 页面模型

/// 教练 tab 页面模型（MP `pages/coach/coach.ts` 全链移植，devops#767 PR-4）。
///
/// 单会话单流；done 才权威；失败轮次 failed 标记可重试（复用 client_turn_id
/// 幂等）；重进会话按 save_token 对账恢复卡片终态；回前台静默重拉历史对账。
@MainActor
@Observable
public final class CoachChatModel {

    public static let defaultSessionId = "ios-default"
    static let placeholderTitle = "新对话"
    static let maxShareMessages = 30

    /// status phase → 提示文案（用户可见就两个阶段）。
    static let phaseLabels: [CoachPhase: String] = [
        .inSubagent: "正在查询数据…",
        .runningTool: "正在查询数据…",
        .analyzing: "正在分析…",
    ]

    // MARK: 状态

    public private(set) var messages: [CoachMessage] = []
    public var input = ""
    public private(set) var sending = false
    public private(set) var streaming = false
    public private(set) var streamPhase = ""
    public private(set) var streamNarration = ""
    public private(set) var streamText = ""
    /// 流式气泡跳变序号（驱动自动滚底，随打字机变长自增）。
    public private(set) var streamTick = 0
    /// 消息滚动目标（msg-<id> / msg-streaming）。
    public var scrollTarget: String?

    public private(set) var sessions: [CoachSession] = []
    public private(set) var currentSessionId = CoachChatModel.defaultSessionId
    public var drawerOpen = false
    public private(set) var contextHint = ""

    // 多选转发
    public private(set) var selectMode = false
    public private(set) var selectCount = 0
    public private(set) var allSelected = false
    /// 转发产物（创建分享成功后由视图呈现系统分享面板）。
    /// picks 为 5:4 气泡封面的纯数据投影（前两条所选节选折行），视图层
    /// ImageRenderer 出图（PR-8；模型不碰渲染器）。
    public struct SharePayload: Identifiable, Equatable, Sendable {
        public let id = UUID()
        public let url: URL
        public let title: String
        public let picks: [CoachBubbleCoverView.Pick]
    }
    public var sharePayload: SharePayload?

    // 弹层 / toast
    public struct Confirmation: Identifiable, Sendable {
        public enum Kind: Equatable, Sendable {
            case replacePlan(uncertain: Bool)
            case deleteWorkout(name: String, dayLabel: String)
        }
        public let id = UUID()
        public let kind: Kind
        let onConfirm: @MainActor () async -> Void
        public static func == (lhs: Confirmation, rhs: Confirmation) -> Bool { lhs.id == rhs.id }
    }
    public var confirmation: Confirmation?
    public var toast: String?

    /// 最近一次历史加载是否失败（失败时投影序号不可信，多选转发拦截）。
    public private(set) var historySyncFailed = false

    // 依赖
    private let service: any CoachServicing
    private let store: any CoachSessionStore
    private let clock: () -> Date
    /// 卡片动作需要的用户 id（AppModel.me 注入，`/api/{user}/...` 路径用）。
    private let userIdProvider: () -> String?
    /// 分享者昵称（AppModel.me.displayName 注入；转发文案与服务端快照共用，
    /// coach.ts createSelectedShare 的 userStore name 等价）。
    private let sharerNameProvider: () -> String?
    /// race-strategy 卡片草稿交接（写 AppModel.pendingStrategyDraft + 路由）。
    private let openStrategyDraft: @MainActor (_ raceId: Int, _ strategy: RaceStrategy) -> Void

    // 运行态
    private var streamHandle: CoachStreamHandle?
    private var streamRawText = ""
    private var messageSeq = 0
    private var turnSeq = 0
    /// 当前会话已加载的服务端投影长度（本地新消息按它领投影序号）。
    private var projectionLength = 0
    /// 卡片动作串行化（防双击重复提交）。
    private var cardActionInFlight = false
    /// 后台中断的在途轮次 user 消息（回前台时标 failed 可重试）。
    private var backgroundInterruptedMessageId: Int?
    private var toastTask: Task<Void, Never>?

    public init(
        service: any CoachServicing,
        store: any CoachSessionStore = DefaultsCoachSessionStore(),
        clock: @escaping () -> Date = { Date() },
        userIdProvider: @escaping () -> String? = { nil },
        sharerNameProvider: @escaping () -> String? = { nil },
        openStrategyDraft: @escaping @MainActor (_ raceId: Int, _ strategy: RaceStrategy) -> Void = { _, _ in }
    ) {
        self.service = service
        self.store = store
        self.clock = clock
        self.userIdProvider = userIdProvider
        self.sharerNameProvider = sharerNameProvider
        self.openStrategyDraft = openStrategyDraft
    }

    // MARK: - 启动 / 生命周期

    /// 页面首载：读本地会话 → 服务端刷新列表 → 拉当前会话历史。
    public func bootstrap() async {
        let saved = store.loadSessions()
        sessions = saved.isEmpty ? [CoachSession(id: Self.defaultSessionId, title: "与教练的对话")] : saved
        let savedId = store.loadCurrentSessionId()
        currentSessionId = savedId.isEmpty ? Self.defaultSessionId : savedId
        contextHint = contextHint(of: sessions.first { $0.id == currentSessionId })
        await loadSessions()
        await loadSession(currentSessionId)
    }

    /// 回前台对账：静默重拉快照（GET messages）+ 本地投影对账；后台中断的
    /// 轮次若未落服务端（内容不在快照里），恢复为 failed 气泡供重试。
    public func handleSceneActive() {
        if let interruptedId = backgroundInterruptedMessageId {
            backgroundInterruptedMessageId = nil
            let interrupted = messages.first { $0.id == interruptedId }
            let sessionId = currentSessionId
            Task { [weak self] in
                await self?.loadSession(sessionId)
                guard let self, let interrupted else { return }
                // 服务端 turn 多数会在中断后继续跑完落 checkpoint——重拉即对
                // 账到终态；没落库的轮次把 user 气泡恢复成可重试（不占投影
                // 序号，服务端没见过的消息不可转发）。
                let landed = self.messages.contains { $0.role == .user && $0.content == interrupted.content }
                if !landed {
                    var retriable = interrupted
                    retriable.failed = true
                    retriable.shareIndex = nil
                    retriable.selectable = false
                    self.messages.append(retriable)
                }
            }
        } else if historySyncFailed {
            Task { await loadSession(currentSessionId) }
        }
    }

    /// 退后台：中止在途流（服务端 turn 继续跑完写 checkpoint，回前台对账）。
    public func handleSceneBackground() {
        if streaming || sending, let last = messages.last(where: { $0.role == .user }) {
            backgroundInterruptedMessageId = last.id
        }
        resetStream()
    }

    /// 消费入口页移交的上下文（首页「和教练聊一聊」/ 赛事策略 CTA）：
    /// 新建会话并挂 target；带 kickoff 时自动发出首条消息。
    public func consumePendingContext(_ pending: PendingCoachContext) {
        startContextSession(target: pending.target, label: pending.label, kickoff: pending.kickoff)
    }

    // MARK: - 会话抽屉

    /// 从服务端刷新会话列表（成功以服务端为准，失败保留本地）。
    public func loadSessions() async {
        guard let list = try? await service.fetchSessions() else { return }
        let locals = sessions
        var merged: [CoachSession] = list.map { summary in
            let local = locals.first { $0.id == summary.sessionId }
            return CoachSession(
                id: summary.sessionId,
                title: (summary.preview ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? Self.placeholderTitle : (summary.preview ?? Self.placeholderTitle),
                target: local?.target,
                contextLabel: local?.contextLabel
            )
        }
        // 服务端 target（race 卡片定位/草稿交接依赖）存本地，覆盖时带回。
        var seen = Set<String>()
        merged = merged.filter { seen.insert($0.id).inserted }
        // 尚未落库的新会话（本地刚建、还没发过消息）保持条目，防「当前」徽标失效。
        if !merged.contains(where: { $0.id == currentSessionId }) {
            let local = locals.first { $0.id == currentSessionId }
                ?? CoachSession(id: currentSessionId, title: Self.placeholderTitle)
            merged.insert(local, at: 0)
        }
        guard !merged.isEmpty else { return }
        sessions = merged
        store.saveSessions(merged)
    }

    func startContextSession(target: CoachTarget, label: String?, kickoff: String?) {
        resetStream()
        let session = CoachSession(id: nextId(prefix: "ios"), title: Self.placeholderTitle, target: target, contextLabel: label)
        sessions.insert(session, at: 0)
        store.saveSessions(sessions)
        currentSessionId = session.id
        store.saveCurrentSessionId(session.id)
        messageSeq = 0
        projectionLength = 0
        messages = kickoff == nil ? [welcomeMessage()] : []
        scrollTarget = nil
        drawerOpen = false
        contextHint = contextHint(of: session)
        exitSelectMode()
        if let kickoff, !kickoff.isEmpty {
            Task { await send(text: kickoff) }
        }
    }

    public func newConversation() {
        resetStream()
        let session = CoachSession(id: nextId(prefix: "ios"), title: Self.placeholderTitle)
        sessions.insert(session, at: 0)
        store.saveSessions(sessions)
        currentSessionId = session.id
        store.saveCurrentSessionId(session.id)
        messageSeq = 0
        projectionLength = 0
        messages = [welcomeMessage()]
        scrollTarget = nil
        drawerOpen = false
        contextHint = ""
        exitSelectMode()
    }

    public func selectSession(_ id: String) {
        guard !id.isEmpty else { return }
        // 同步中止在途流：loadSession 的 resetStream 在 Task 内，切换与回调
        // 都在 MainActor 上排队——先掐掉已入队的流回调，防旧轮次落进新会话。
        resetStream()
        currentSessionId = id
        store.saveCurrentSessionId(id)
        drawerOpen = false
        contextHint = contextHint(of: sessions.first { $0.id == id })
        exitSelectMode()
        Task { await loadSession(id) }
    }

    /// 清空当前会话 target（后续消息不再围绕该训练）。
    public func clearContext() {
        guard let index = sessions.firstIndex(where: { $0.id == currentSessionId }) else { return }
        sessions[index].target = nil
        sessions[index].contextLabel = nil
        store.saveSessions(sessions)
        contextHint = ""
    }

    /// 当前会话锚定的 target；无则 nil（普通对话）。
    var currentTarget: CoachTarget? {
        sessions.first { $0.id == currentSessionId }?.target
    }

    func contextHint(of session: CoachSession?) -> String {
        guard let label = session?.contextLabel, !label.isEmpty else { return "" }
        return "正在围绕「\(label)」对话"
    }

    // MARK: - 历史加载

    /// 加载指定会话历史；不存在/失败保留欢迎语（失败置 historySyncFailed
    /// 拦截多选转发，回前台/回显静默重拉直到成功）。
    public func loadSession(_ sessionId: String) async {
        resetStream()
        do {
            let history = try await service.fetchHistory(sessionId: sessionId)
            guard currentSessionId == sessionId else { return } // 等待期间已切换
            if history.messages.isEmpty {
                messageSeq = 0
                projectionLength = 0
                messages = [welcomeMessage()]
            } else {
                messageSeq = 0
                let target = sessions.first { $0.id == sessionId }?.target
                messages = history.messages.enumerated().map { index, row in
                    toMessage(row, index: index, target: target)
                }
                projectionLength = history.messages.count
            }
            // 自建课卡片对账：历史是静态快照，按钮终态只活在内存，重进即回退；
            // 用课表行按 save_token / workout_id 对上恢复终态。
            await reconcileCustomWorkoutCards()
            historySyncFailed = false
            scrollTarget = messages.last.map { "msg-\($0.id)" }
        } catch {
            if messages.isEmpty { messages = [welcomeMessage()] }
            historySyncFailed = true
        }
    }

    func toMessage(_ row: CoachHistoryMessage, index: Int, target: CoachTarget?) -> CoachMessage {
        if row.role == .assistant {
            // 首选服务端信封；兜底历史自愈（防御解析上线前的信封泄漏文本）。
            if let card = CoachCardRegistry.build(row.card, target: target) {
                return cardMessage(card, content: row.content, shareIndex: index)
            }
            if let leaked = CoachCardRegistry.parseLeakedRaceStrategyEnvelope(row.content),
               let card = CoachCardRegistry.build(leaked, target: target) {
                return cardMessage(card, content: row.content, shareIndex: index)
            }
        }
        return CoachMessage(
            id: nextMessageId(),
            role: row.role,
            content: row.content,
            shareIndex: index,
            selectable: true
        )
    }

    func cardMessage(_ card: CoachCardRegistry.View, content: String, shareIndex: Int?) -> CoachMessage {
        CoachMessage(
            id: nextMessageId(),
            role: .assistant,
            content: card.inlineBody ? content : card.title,
            card: card,
            shareIndex: shareIndex,
            selectable: true
        )
    }

    func welcomeMessage() -> CoachMessage {
        let content = "你好，我是你的 AI 教练。可以问我今天的训练安排、疲劳状态、配速建议，或复盘某次训练。"
        return CoachMessage(id: nextMessageId(), role: .assistant, content: content, selectable: false)
    }

    // MARK: - 发送 / 流式

    public func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        await send(text: text)
    }

    /// 发送一条用户消息（输入框与入口 kickoff 共用）：刷会话标题、落气泡、发起本轮。
    func send(text: String) async {
        guard !sending else { return }
        // 新会话用首条消息当标题（覆盖占位标题）。
        if let index = sessions.firstIndex(where: { $0.id == currentSessionId }) {
            let newTitle = Self.titleFromText(text)
            if sessions[index].title == Self.placeholderTitle || sessions[index].title == "与教练的对话" {
                sessions[index].title = newTitle
                store.saveSessions(sessions)
            }
        }
        let clientTurnId = nextId(prefix: "ios-turn")
        let userMessage = CoachMessage(
            id: nextMessageId(),
            role: .user,
            content: text,
            clientTurnId: clientTurnId,
            ts: nowHhmm()
        )
        messages.append(userMessage)
        input = ""
        scrollTarget = "msg-\(userMessage.id)"
        await doSend(text: text, clientTurnId: clientTurnId, userMessageId: userMessage.id)
    }

    /// 失败重试：复用上一轮 client_turn_id（服务端幂等命中返回同 turn）。
    public func retry(messageId: Int) async {
        guard !sending else { return }
        guard let message = messages.first(where: { $0.id == messageId }),
              message.role == .user,
              let clientTurnId = message.clientTurnId
        else { return }
        await doSend(text: message.content, clientTurnId: clientTurnId, userMessageId: messageId)
    }

    func doSend(text: String, clientTurnId: String, userMessageId: Int) async {
        resetStream()
        sending = true
        streaming = true
        streamPhase = ""
        streamNarration = ""
        streamText = ""
        streamRawText = ""
        scrollTarget = "msg-streaming"
        streamHandle = service.stream(
            message: text,
            sessionId: currentSessionId,
            clientTurnId: clientTurnId,
            target: currentTarget,
            callbacks: CoachStreamCallbacks(
                onEvent: { [weak self] event in self?.handleStreamEvent(event) },
                onComplete: { [weak self] done in self?.finishStream(done: done, userMessageId: userMessageId) },
                onError: { [weak self] error in self?.failStream(error, userMessageId: userMessageId) }
            )
        )
    }

    /// 流式事件：status 更新阶段；narration 更新进度说明；delta 累积打字机正文。
    func handleStreamEvent(_ event: CoachStreamEvent) {
        switch event {
        case .narration(let delta):
            // 工具前整段进度说明（一次到达），展示最新一条；绝不进正文。
            let text = delta.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty, streamNarration != text { streamNarration = text }
        case .delta(let delta):
            streamRawText += delta
            // 旧后端可能把信封 JSON 当正文流出：呈现层换中性占位文案（不预设
            // 产物类型），done 后由卡片/历史自愈接管。
            streamText = CoachCardRegistry.looksLikeJsonText(streamRawText)
                ? "正在整理内容…"
                : streamRawText
            streamTick += 1
            scrollTarget = "msg-streaming"
        case .status(let status):
            let label = Self.phaseLabels[status.phase] ?? "正在分析…"
            if streamPhase != label { streamPhase = label }
        }
    }

    /// 流结束：结构化产物出通知卡片，其余把完整 markdown 落成气泡。
    func finishStream(done: CoachDone, userMessageId: Int) {
        streamHandle = nil
        sending = false
        streaming = false
        var content = done.status == .completed ? done.message : done.interruptText
        let card = CoachCardRegistry.build(done.card, target: currentTarget)
        // 空回复降级（服务端实证 reasoning 吃满 output budget）：turn 已完成
        // 落库，user 消息照常占投影位；空 assistant 回复也占一位（无气泡渲染），
        // 两处都计入长度，防后续轮次序号漂移。
        if (content ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && card == nil {
            if done.status == .completed {
                markMessage(userMessageId) {
                    $0.failed = false
                    $0.shareIndex = projectionLength
                    $0.selectable = true
                    $0.ts = nowHhmm()
                }
                projectionLength += 2
                scrollTarget = "msg-\(userMessageId)"
                refreshAllSelected()
                clearStreamText()
                return
            }
            failStream(CoachStreamError(code: "empty", message: "no_answer"), userMessageId: userMessageId)
            return
        }
        if (content ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            content = card?.title ?? ""
        }
        // 非内联产物（race-strategy / workout-op）：卡片替代正文，content 留作
        // 复制/分享兜底（MP cardCoachMessage 口径）。
        if let card, !card.inlineBody { content = card.title }
        // 本轮确认落库：user 占一个投影位；completed 才有 assistant 回复占下一位；
        // needs_input 的追问泡只是本地渲染，不领序号、不可多选。
        let userShareIndex = projectionLength
        projectionLength += 1
        let assistantShareIndex = done.status == .completed ? projectionLength : nil
        if done.status == .completed { projectionLength += 1 }
        let ts = nowHhmm()
        markMessage(userMessageId) {
            $0.failed = false
            $0.shareIndex = userShareIndex
            $0.selectable = true
            $0.ts = ts
        }
        var assistant = CoachMessage(
            id: nextMessageId(),
            role: .assistant,
            content: content ?? "",
            shareIndex: assistantShareIndex,
            selectable: assistantShareIndex != nil
        )
        assistant.ts = ts
        assistant.card = card
        messages.append(assistant)
        scrollTarget = "msg-\(assistant.id)"
        refreshAllSelected()
        clearStreamText()
    }

    /// 流失败：user 消息打 failed 标记展示重试按钮。
    func failStream(_ error: CoachStreamError, userMessageId: Int) {
        streamHandle = nil
        sending = false
        streaming = false
        markMessage(userMessageId) { $0.failed = true }
        scrollTarget = "msg-\(userMessageId)"
        clearStreamText()
        if error.code != "aborted" { showToast(error.localized) }
    }

    func clearStreamText() {
        streamText = ""
        streamPhase = ""
        streamNarration = ""
        streamRawText = ""
    }

    /// 中止在途流 + 清流式状态（切会话 / 新建 / 卸载 / 退后台）。
    func resetStream() {
        streamHandle?.abort()
        streamHandle = nil
        sending = false
        streaming = false
        clearStreamText()
    }

    // MARK: - 多选转发（devops#717）

    /// 长按消息 → 直接进选择模式且该条预选中（微信范式；不可选 toast 原因）。
    public func handleMessageLongPress(_ messageId: Int) {
        if selectMode {
            toggleSelect(messageId)
            return
        }
        guard !historySyncFailed else {
            showToast("对话尚未同步，暂时无法多选转发")
            return
        }
        guard let message = messages.first(where: { $0.id == messageId }) else { return }
        guard message.selectable else {
            showToast(unselectableReason(message))
            return
        }
        enterSelectMode(firstId: messageId)
    }

    func unselectableReason(_ message: CoachMessage) -> String {
        message.failed ? "发送失败的消息不可转发" : "该消息暂不可转发"
    }

    func enterSelectMode(firstId: Int?) {
        selectMode = true
        selectCount = 0
        allSelected = false
        if let firstId { toggleSelect(firstId) }
    }

    public func exitSelectMode() {
        guard selectMode else { return }
        selectMode = false
        selectCount = 0
        allSelected = false
        for index in messages.indices { messages[index].selected = false }
    }

    /// 选择模式中点消息行：可勾选的切换，不可选 toast 原因。
    public func handleMessageTap(_ messageId: Int) {
        guard selectMode else { return }
        toggleSelect(messageId)
    }

    func toggleSelect(_ messageId: Int) {
        guard let index = messages.firstIndex(where: { $0.id == messageId }) else { return }
        guard messages[index].selectable else {
            showToast(unselectableReason(messages[index]))
            return
        }
        if !messages[index].selected {
            guard selectCount < Self.maxShareMessages else {
                showToast("一次最多转发 \(Self.maxShareMessages) 条")
                return
            }
            messages[index].selected = true
            selectCount += 1
        } else {
            messages[index].selected = false
            selectCount -= 1
        }
        refreshAllSelected()
    }

    /// 全选/取消全选：全选超限自动截前 30 条。
    public func toggleSelectAll() {
        guard selectMode else { return }
        if allSelected {
            for index in messages.indices { messages[index].selected = false }
            selectCount = 0
            allSelected = false
            return
        }
        for index in messages.indices { messages[index].selected = false }
        var count = 0
        for index in messages.indices where messages[index].selectable && count < Self.maxShareMessages {
            messages[index].selected = true
            count += 1
        }
        selectCount = count
        let selectableCount = messages.filter(\.selectable).count
        allSelected = selectableCount > 0 && count >= selectableCount
        if selectableCount > Self.maxShareMessages {
            showToast("一次最多转发 \(Self.maxShareMessages) 条")
        }
    }

    func refreshAllSelected() {
        let selectable = messages.filter(\.selectable)
        allSelected = !selectable.isEmpty && selectable.allSatisfy(\.selected)
    }

    /// 转发所选：升序去重投影序号 → 创建分享快照 → 系统分享面板
    ///（D-share-1：微信转发渠道无对等，单一路分享用 universal link 承载）。
    /// PR-8 出向矩阵（#771）：对话封面=图+文案+链接 —— 5:4 气泡封面
    ///（CoachBubbleCoverView）+ 品牌口径文案（不提教练）+ `/s/` 分流链接
    ///（阅读端 coach-share 落地页）；封面渲染失败仅降级无图（fail-soft）。
    public func forwardSelected() async {
        guard selectMode, selectCount > 0 else { return }
        guard !historySyncFailed else {
            showToast("对话尚未同步，暂时无法多选转发")
            return
        }
        let indices = Set(messages.filter { $0.selected }.compactMap(\.shareIndex)).sorted()
        guard !indices.isEmpty else { return }
        let sharerName = sharerNameProvider()
        do {
            let result = try await service.createShare(sessionId: currentSessionId, indices: indices, sharerName: sharerName)
            let url = ShareOutbound.link(route: .coachShare(sid: result.sid))
            sharePayload = SharePayload(
                url: url,
                title: ShareCopy.coachConversation(sharerName: sharerName, count: indices.count),
                picks: CoachBubbleCoverView.picks(messages: messages)
            )
        } catch let error as ApiError {
            showToast(error.detail.isEmpty ? "分享创建失败，请稍后再试" : "分享创建失败：\(error.detail)")
        } catch {
            showToast("分享创建失败，请稍后再试")
        }
    }

    // MARK: - 复制

    /// 复制一条消息全文（assistant 优先取剥离 markdown 装饰的纯文本）。
    public func copyMessageText(_ messageId: Int) -> Bool {
        guard let message = messages.first(where: { $0.id == messageId }) else { return false }
        #if canImport(UIKit)
        UIPasteboard.general.string = message.content
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.content, forType: .string)
        #endif
        return true
    }

    // MARK: - 卡片动作

    /// 卡片主体 / 导航类 CTA：race-strategy 草稿交接（仅 kind=race 且有
    /// race_event_id）→ 路由到策略报告页；动作类卡片主体不可跳转。
    public func openCard(messageId: Int) {
        guard let message = messages.first(where: { $0.id == messageId }),
              let card = message.card, card.navigable
        else { return }
        if case .raceStrategy(let strategy) = card.payload,
           let target = currentTarget, target.kind == .race, let raceId = target.raceEventId {
            openStrategyDraft(raceId, strategy)
        }
    }

    /// 主 CTA 分发：master-plan 应用 / custom-workout 保存 / workout-op 确认；
    /// 其余与主体 tap 同款跳转。
    public func cardPrimaryAction(messageId: Int) async {
        guard let message = messages.first(where: { $0.id == messageId }), let card = message.card else { return }
        switch card.buttonAction {
        case .apply: await applyMasterPlanCard(messageId: messageId)
        case .save: _ = await saveCustomWorkoutCard(messageId: messageId)
        case .confirmDelete: await deleteWorkoutOpCard(messageId: messageId)
        case .confirmMove: await moveWorkoutOpCard(messageId: messageId)
        case .navigate, .none: openCard(messageId: messageId)
        case .push: break
        }
    }

    /// 次级 CTA：custom-workout 推送到手表（未保存先走幂等保存链）。
    public func cardSecondaryAction(messageId: Int) async {
        guard let message = messages.first(where: { $0.id == messageId }), let card = message.card else { return }
        guard card.secondaryAction == .push else { return }
        await pushCustomWorkoutCard(messageId: messageId)
    }

    // master-plan 应用流（#537 三态预检 + #585 apply-from-content）：

    /// 应用 master-plan 卡片：先查当前启用计划——有则弹替换确认带身份应用；
    /// 确认没有才直接应用；查不到按「可能有」保守确认。409/422 复查收口。
    func applyMasterPlanCard(messageId: Int) async {
        guard !cardActionInFlight else { return }
        guard let message = messages.first(where: { $0.id == messageId }),
              case .masterPlan(let plan) = message.card?.payload
        else { return }
        guard let applyToken = plan.applyToken, let content = plan.content else {
            // 旧卡片（#429 只带 plan_id）/ 降级卡片：无 apply 载荷。
            markCard(messageId, badge: "已失效", keepPrimary: false, keepSecondary: false)
            showToast("这版计划不可再应用，请重新生成")
            return
        }
        guard let userId = userIdProvider(), !userId.isEmpty else {
            showToast("请先登录后再应用")
            return
        }
        cardActionInFlight = true
        defer { cardActionInFlight = false }
        // 三态预检（#537）：有当前计划 | 确认没有（服务端 404 归一为 nil）|
        // 查不到（网络/5xx 抛错）。注意勿用 `try?` 判「查不到」——SE-0230 会把
        // 抛错与返回 nil 压平成同一个 nil。「查不到」绝不当作「没有」——破坏性
        // 决策按「可能有」保守确认。
        let current: CurrentPlanRef?
        let precheckUnknown: Bool
        do {
            current = try await service.currentPlan(userId: userId)
            precheckUnknown = false
        } catch {
            current = nil
            precheckUnknown = true
        }
        if precheckUnknown {
            confirmation = Confirmation(kind: .replacePlan(uncertain: true)) { [weak self] in
                await self?.applyPlanContent(
                    messageId: messageId, userId: userId, applyToken: applyToken, content: content,
                    expectation: nil
                )
            }
        } else if let ref = current {
            confirmation = Confirmation(kind: .replacePlan(uncertain: false)) { [weak self] in
                await self?.applyPlanContent(
                    messageId: messageId, userId: userId, applyToken: applyToken, content: content,
                    expectation: (planId: ref.planId, revision: ref.revision)
                )
            }
        } else {
            await applyPlanContent(messageId: messageId, userId: userId, applyToken: applyToken, content: content, expectation: nil)
        }
    }

    /// 调 apply 端点并回写终态；409（身份过期/存在未确认）/422（内容无效）
    /// 由复查收口：查不到 → 保留 CTA 可重试；查得到 → 这版已失效。
    func applyPlanContent(
        messageId: Int,
        userId: String,
        applyToken: String,
        content: Data,
        expectation: (planId: String, revision: Int?)?
    ) async {
        do {
            try await service.applyPlan(userId: userId, applyToken: applyToken, content: content, expectation: expectation)
            markCard(messageId, badge: "已应用", keepPrimary: false, keepSecondary: false)
            showToast("已应用，可在「我的训练计划」查看")
        } catch let error as ApiError where error.statusCode == 409 || error.statusCode == 422 {
            let recheck: CurrentPlanRef? = try? await service.currentPlan(userId: userId)
            if recheck == nil {
                showToast("该计划状态暂时查不到，请稍后再试")
                return
            }
            markCard(messageId, badge: "已失效", keepPrimary: false, keepSecondary: false)
            showToast(error.statusCode == 422 ? "这版计划内容无效，无法应用" : "当前计划已更新，这版已失效")
        } catch {
            showToast("应用失败，请稍后再试")
        }
    }

    // custom-workout 保存 / 推送（devops#587 幂等链）：

    /// 保存自建课卡片：save_token 幂等 upsert；成功回写「已保存」收主 CTA
    /// （推送保留）；失败不写终态可重试。
    @discardableResult
    func saveCustomWorkoutCard(messageId: Int, alreadyGuarded: Bool = false, silent: Bool = false) async -> CoachPlanSessionRow? {
        guard let message = messages.first(where: { $0.id == messageId }),
              case .customWorkout(let card) = message.card?.payload
        else { return nil }
        guard !card.saveToken.isEmpty, !card.spec.isEmpty else {
            markCard(messageId, badge: "已失效", keepPrimary: false, keepSecondary: false)
            showToast("这张卡片不可再保存，请重新生成")
            return nil
        }
        guard userIdProvider() != nil else {
            showToast("请先登录后再保存")
            return nil
        }
        if !alreadyGuarded, cardActionInFlight { return nil }
        cardActionInFlight = true
        defer { cardActionInFlight = false }
        do {
            let row = try await service.upsertCustomWorkout(card)
            markCard(messageId, badge: "已保存", keepPrimary: false, keepSecondary: true)
            if !silent { showToast("已保存") }
            return row
        } catch {
            showToast("保存失败，请稍后再试")
            return nil
        }
    }

    /// 推送自建课到手表：未保存先保存（幂等）再推；成功角标「已推送」
    ///（隐含已保存）；失败不写终态可重试。
    func pushCustomWorkoutCard(messageId: Int) async {
        guard !cardActionInFlight else { return }
        cardActionInFlight = true
        defer { cardActionInFlight = false }
        guard let row = await saveCustomWorkoutCard(messageId: messageId, alreadyGuarded: true, silent: true),
              !row.workoutId.isEmpty
        else { return }
        do {
            try await service.pushCustomWorkout(workoutId: row.workoutId)
            markCard(messageId, badge: "已推送", keepPrimary: false, keepSecondary: false)
            showToast("已推送到手表")
        } catch let error as ApiError {
            showToast(error.detail.isEmpty ? "推送失败" : (error.detail.count > 15 ? "推送失败" : error.detail))
        } catch {
            showToast("推送失败")
        }
    }

    // workout-op 确认卡（devops#698 删除双确认 / 改期）：

    /// 删除确认卡 CTA：alert 双重确认 → 现有软删端点；404 = 该课已在别处
    /// 删除，同样是删除终态。
    func deleteWorkoutOpCard(messageId: Int) async {
        guard !cardActionInFlight else { return }
        guard let message = messages.first(where: { $0.id == messageId }),
              case .workoutOp(let op) = message.card?.payload, op.op == .delete
        else { return }
        guard let userId = userIdProvider(), !userId.isEmpty else {
            showToast("请先登录后再操作")
            return
        }
        confirmation = Confirmation(
            kind: .deleteWorkout(name: op.name, dayLabel: CoachCardRegistry.monthDayLabel(op.date))
        ) { [weak self] in
            await self?.performDeleteWorkout(messageId: messageId, userId: userId, workoutId: op.workoutId)
        }
    }

    func performDeleteWorkout(messageId: Int, userId: String, workoutId: String) async {
        guard !cardActionInFlight else { return }
        cardActionInFlight = true
        defer { cardActionInFlight = false }
        do {
            try await service.deleteCustomWorkout(userId: userId, workoutId: workoutId)
            markCard(messageId, badge: "已删除", keepPrimary: false, keepSecondary: false)
            showToast("已删除")
        } catch let error as ApiError where error.statusCode == 404 {
            markCard(messageId, badge: "已删除", keepPrimary: false, keepSecondary: false)
            showToast("该课已删除")
        } catch {
            showToast("删除失败，请稍后再试")
        }
    }

    /// 改期确认卡 CTA：T1 move 端点；watch_synced=false → 「已改期·手表未同步」。
    func moveWorkoutOpCard(messageId: Int) async {
        guard !cardActionInFlight else { return }
        guard let message = messages.first(where: { $0.id == messageId }),
              case .workoutOp(let op) = message.card?.payload, op.op == .move,
              let newDate = op.newDate
        else { return }
        guard let userId = userIdProvider(), !userId.isEmpty else {
            showToast("请先登录后再操作")
            return
        }
        cardActionInFlight = true
        defer { cardActionInFlight = false }
        do {
            let result = try await service.moveCustomWorkout(userId: userId, workoutId: op.workoutId, date: newDate)
            if result.watchSynced {
                markCard(messageId, badge: "已改期", keepPrimary: false, keepSecondary: false)
                showToast("已改期")
            } else {
                markCard(messageId, badge: "已改期·手表未同步", keepPrimary: false, keepSecondary: false)
                showToast("已改期，手表暂未同步")
            }
        } catch {
            showToast("改期失败，请稍后再试")
        }
    }

    /// 卡片状态回写：badge + 双 CTA 独立收放（保存只收主 CTA，推送收双）。
    func markCard(_ messageId: Int, badge: String, keepPrimary: Bool, keepSecondary: Bool) {
        markMessage(messageId) { message in
            guard message.card != nil else { return }
            message.card?.badge = badge
            if !keepPrimary { message.card?.buttonText = "" }
            if !keepSecondary { message.card?.secondaryButtonText = "" }
        }
    }

    /// 自建课卡片对账（历史加载后调用）：custom-workout 卡按 save_token 对
    /// 课表行恢复「已保存/已推送」；workout-op 卡按 workout_id 对账——行
    /// 消失 → 已删除终态；行在且日期已等于 new_date → 已改期。对账失败
    /// 静默保持原状（旧版无 save_token 时同样降级为未保存）。
    func reconcileCustomWorkoutCards() async {
        guard let userId = userIdProvider(), !userId.isEmpty else { return }
        var dates: Set<String> = []
        for message in messages {
            switch message.card?.payload {
            case .customWorkout(let card): dates.insert(card.date)
            case .workoutOp(let op):
                dates.insert(op.date)
                if let newDate = op.newDate { dates.insert(newDate) }
            default: break
            }
        }
        guard !dates.isEmpty, let from = dates.min(), let to = dates.max() else { return }
        guard let rows = try? await service.planSessions(userId: userId, from: from, to: to) else { return }
        let byToken = Dictionary(rows.filter { $0.source == "custom" && $0.saveToken != nil }.map { ($0.saveToken!, $0) },
                                 uniquingKeysWith: { first, _ in first })
        let byWorkoutId = Dictionary(rows.map { ($0.workoutId, $0) }, uniquingKeysWith: { first, _ in first })
        for index in messages.indices {
            switch messages[index].card?.payload {
            case .customWorkout(let card):
                guard let row = byToken[card.saveToken] else { continue }
                if row.pushed {
                    messages[index].card?.badge = "已推送"
                    messages[index].card?.buttonText = ""
                    messages[index].card?.secondaryButtonText = ""
                } else {
                    messages[index].card?.badge = "已保存"
                    messages[index].card?.buttonText = ""
                }
            case .workoutOp(let op):
                guard let row = byWorkoutId[op.workoutId] else {
                    // 行消失（软删后不在 active 投影）：删除终态；move 卡一并归此。
                    messages[index].card?.badge = "已删除"
                    messages[index].card?.buttonText = ""
                    messages[index].card?.secondaryButtonText = ""
                    continue
                }
                if op.op == .move, let newDate = op.newDate, row.date == newDate {
                    messages[index].card?.badge = "已改期"
                    messages[index].card?.buttonText = ""
                    messages[index].card?.secondaryButtonText = ""
                }
            default:
                break
            }
        }
    }

    // MARK: - 确认弹层 / toast

    public func confirmPending() async {
        guard let pending = confirmation else { return }
        confirmation = nil
        await pending.onConfirm()
    }

    public func cancelConfirmation() {
        confirmation = nil
    }

    func showToast(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.5))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    // MARK: - 小工具

    func markMessage(_ messageId: Int, _ mutate: (inout CoachMessage) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == messageId }) else { return }
        mutate(&messages[index])
    }

    func nextMessageId() -> Int {
        messageSeq += 1
        return messageSeq
    }

    /// `ios-{ts}-{seq}`（服务端正则 ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$）。
    func nextId(prefix: String) -> String {
        turnSeq += 1
        return "\(prefix)-\(Int(clock().timeIntervalSince1970 * 1000))-\(turnSeq)"
    }

    static func titleFromText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        return trimmed.count > 12 ? String(trimmed.prefix(12)) + "…" : trimmed
    }

    func nowHhmm() -> String {
        let date = clock()
        let calendar = Calendar.current
        return String(format: "%02d:%02d", calendar.component(.hour, from: date), calendar.component(.minute, from: date))
    }
}
