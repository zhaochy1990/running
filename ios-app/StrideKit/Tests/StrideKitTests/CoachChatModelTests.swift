import Foundation
import os
import Testing
@testable import StrideKit

/// 教练页面模型测试：发送/流式生命周期 / 投影序号 / 失败重试幂等 /
/// 多选转发 / 历史恢复 + 卡片对账 / master-plan 三态预检 / 上下文会话。
@Suite struct CoachChatModelTests {

    // MARK: - 测试基建

    final class InMemorySessionStore: CoachSessionStore, @unchecked Sendable {
        private let lock = OSAllocatedUnfairLock()
        private var sessions: [CoachSession] = []
        private var current = ""

        func loadSessions() -> [CoachSession] { lock.withLock { sessions } }
        func saveSessions(_ sessions: [CoachSession]) { lock.withLock { self.sessions = sessions } }
        func loadCurrentSessionId() -> String { lock.withLock { current } }
        func saveCurrentSessionId(_ id: String) { lock.withLock { current = id } }
    }

    /// 可由测试直接驱动的服务 mock：stream 捕获回调，由 emit* 显式投递
    ///（保证事件顺序确定性）；JSON 端点结果可脚本化。
    final class MockService: CoachServicing, @unchecked Sendable {
        private let lock = OSAllocatedUnfairLock()
        private var _callbacks: CoachStreamCallbacks?
        private(set) var streamCalls: [(message: String, sessionId: String, clientTurnId: String, target: CoachTarget?)] = []

        var sessionsResult: Result<[CoachSessionSummary], Error> = .success([])
        var historyResult: Result<CoachHistoryResponse, Error> = .success(
            CoachHistoryResponse(sessionId: "ios-default", messages: [])
        )
        var shareResult: Result<CoachShareResult, Error> = .success(CoachShareResult(sid: "sid123", reused: false))
        var currentPlanResult: Result<CurrentPlanRef?, Error> = .success(nil)
        var applyError: Error?
        var upsertResult: Result<CoachPlanSessionRow, Error> = .success(
            CoachPlanSessionRow(workoutId: "w-1", date: "2026-10-28", source: "custom", pushed: false, saveToken: "save-1")
        )
        var pushError: Error?
        var deleteError: Error?
        var moveResult: Result<MoveWorkoutResult, Error> = .success(
            MoveWorkoutResult(
                row: CoachPlanSessionRow(workoutId: "w-9", date: "2026-10-30", source: "custom", pushed: false),
                watchSynced: true
            )
        )
        var planRowsResult: Result<[CoachPlanSessionRow], Error> = .success([])
        private(set) var applyCalls: [(userId: String, applyToken: String, expectation: (planId: String, revision: Int?)?)] = []
        private(set) var upsertCards: [CustomWorkoutCard] = []
        private(set) var deleteCalls: [String] = []
        private(set) var moveCalls: [(workoutId: String, date: String)] = []
        private(set) var shareCalls: [(sessionId: String, indices: [Int], sharerName: String?)] = []

        /// 锁保护的断言快照（写侧在锁内，读侧同锁）。
        var streamCallLog: [(message: String, sessionId: String, clientTurnId: String, target: CoachTarget?)] {
            lock.withLock { streamCalls }
        }

        func stream(
            message: String,
            sessionId: String,
            clientTurnId: String,
            target: CoachTarget?,
            callbacks: CoachStreamCallbacks
        ) -> CoachStreamHandle {
            lock.withLock {
                _callbacks = callbacks
                streamCalls.append((message, sessionId, clientTurnId, target))
            }
            return CoachStreamHandle {}
        }

        // 测试驱动（直接 await 投递到 MainActor 回调，顺序确定）。
        func emit(_ event: CoachStreamEvent) async {
            let cb = lock.withLock { _callbacks }
            await cb?.onEvent?(event)
        }

        func complete(_ done: CoachDone) async {
            let cb = lock.withLock { _callbacks }
            await cb?.onComplete?(done)
        }

        func fail(_ error: CoachStreamError) async {
            let cb = lock.withLock { _callbacks }
            await cb?.onError?(error)
        }

        func fetchSessions() async throws -> [CoachSessionSummary] {
            try sessionsResult.get()
        }

        func fetchHistory(sessionId: String) async throws -> CoachHistoryResponse {
            try historyResult.get()
        }

        func createShare(sessionId: String, indices: [Int], sharerName: String?) async throws -> CoachShareResult {
            try lock.withLock {
                shareCalls.append((sessionId, indices, sharerName))
                return try shareResult.get()
            }
        }

        func currentPlan(userId: String) async throws -> CurrentPlanRef? {
            try currentPlanResult.get()
        }

        func applyPlan(userId: String, applyToken: String, content: Data, expectation: (planId: String, revision: Int?)?) async throws {
            try lock.withLock {
                applyCalls.append((userId, applyToken, expectation))
                if let applyError { throw applyError }
            }
        }

        func upsertCustomWorkout(_ card: CustomWorkoutCard) async throws -> CoachPlanSessionRow {
            try lock.withLock {
                upsertCards.append(card)
                return try upsertResult.get()
            }
        }

        func pushCustomWorkout(workoutId: String) async throws {
            if let pushError { throw pushError }
        }

        func deleteCustomWorkout(userId: String, workoutId: String) async throws {
            try lock.withLock {
                deleteCalls.append(workoutId)
                if let deleteError { throw deleteError }
            }
        }

        func moveCustomWorkout(userId: String, workoutId: String, date: String) async throws -> MoveWorkoutResult {
            try lock.withLock {
                moveCalls.append((workoutId, date))
                return try moveResult.get()
            }
        }

        func planSessions(userId: String, from: String, to: String) async throws -> [CoachPlanSessionRow] {
            try planRowsResult.get()
        }
    }

    /// 固定时钟（本地日历 09:05，与 nowHhmm 的 Calendar.current 口径一致）。
    private var fixedClock: () -> Date {
        let date = Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 26, hour: 9, minute: 5))!
        return { date }
    }

    @MainActor
    private func waitUntil(_ condition: @MainActor () -> Bool) async {
        for _ in 0..<250 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    @MainActor
    private func makeModel(
        service: MockService = MockService(),
        userId: String? = "u-1",
        sharerNameProvider: (() -> String?)? = nil
    ) -> (CoachChatModel, MockService) {
        let model = CoachChatModel(
            service: service,
            store: InMemorySessionStore(),
            clock: fixedClock,
            userIdProvider: { userId },
            sharerNameProvider: sharerNameProvider ?? { nil },
            openStrategyDraft: { _, _ in }
        )
        return (model, service)
    }

    /// 带卡片信封的 done。
    private func donePayload(cardType: String?) -> CoachDone {
        let card = cardType.map {
            CoachCardWire(
                type: $0,
                data: Data("{\"save_token\":\"save-1\",\"date\":\"2026-10-28\",\"name\":\"轻松跑\",\"summary\":\"8km Z2\",\"spec\":{\"blocks\":[{\"k\":\"warmup\"}]}}".utf8)
            )
        }
        return CoachDone(status: .completed, message: "完整回复", interruptText: nil, card: card)
    }

    private var masterPlanCardWire: CoachCardWire {
        CoachCardWire(
            type: "master-plan",
            data: Data(
                """
                {"goal":{"race_name":"上马","distance":"FM","race_date":"2027-01-01","target_time":"3:30:00"},
                 "total_weeks":16,"apply_token":"tok-1","content":{"schema":"v2"}}
                """.utf8
            )
        )
    }

    // MARK: - 发送 / 流式生命周期

    @Test @MainActor func sendAppendsUserBubbleAndStreams() async {
        let (model, service) = makeModel()
        await model.bootstrap()

        model.input = "  今天练什么  "
        await model.send()

        #expect(model.input.isEmpty)
        #expect(model.sending)
        #expect(model.streaming)
        #expect(model.messages.count == 2) // 欢迎语 + user
        #expect(model.messages[1].role == .user)
        #expect(model.messages[1].content == "今天练什么")
        #expect(model.messages[1].clientTurnId != nil)
        #expect(model.messages[1].ts == "09:05")

        #expect(service.streamCallLog.count == 1)
        #expect(service.streamCallLog[0].message == "今天练什么")
        #expect(service.streamCallLog[0].sessionId == CoachChatModel.defaultSessionId)
    }

    @Test @MainActor func streamEventsDriveTypewriterAndPhases() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "hi")
        await service.emit(.status(CoachStatus(phase: .runningTool, tool: "query", toolStatus: "running")))
        await service.emit(.narration("正在查询你的训练数据"))
        await service.emit(.status(CoachStatus(phase: .analyzing)))
        await service.emit(.delta("配"))
        await service.emit(.delta("速建议"))

        #expect(model.streamPhase == "正在分析…")
        #expect(model.streamNarration == "正在查询你的训练数据")
        #expect(model.streamText == "配速建议")
        #expect(model.streamTick == 2)
    }

    @Test @MainActor func jsonLeakStreamShowsPlaceholder() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "hi")
        await service.emit(.delta("{\"race_name\": \""))
        #expect(model.streamText == "正在整理内容…")
    }

    @Test @MainActor func doneAppendsAssistantAndAssignsProjectionIndices() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "hi")
        await service.complete(donePayload(cardType: nil))

        #expect(!model.sending)
        #expect(!model.streaming)
        #expect(model.messages.count == 3)
        let user = model.messages[1]
        let assistant = model.messages[2]
        #expect(user.shareIndex == 0)
        #expect(user.failed == false)
        #expect(assistant.shareIndex == 1)
        #expect(assistant.selectable)
        #expect(assistant.content == "完整回复")
    }

    @Test @MainActor func doneWithCardReplacesBodyForNonInlineTypes() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "帮我改课")
        // workout-op 卡（inlineBody=false）：卡片替代正文。
        let opWire = CoachCardWire(
            type: "workout-op",
            data: Data("{\"op\":\"move\",\"workout_id\":\"w-9\",\"date\":\"2026-10-28\",\"new_date\":\"2026-10-30\",\"name\":\"轻松跑\"}".utf8)
        )
        await service.complete(CoachDone(status: .completed, message: "已生成改期确认", interruptText: nil, card: opWire))

        let assistant = model.messages.last
        #expect(assistant?.card?.type == "workout-op")
        #expect(assistant?.content == "训练课改期")
    }

    @Test @MainActor func needsInputAsksWithoutProjection() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "hi")
        await service.complete(CoachDone(status: .needsInput, message: nil, interruptText: "你最近一次比赛是？", card: nil))

        let assistant = model.messages.last
        #expect(assistant?.content == "你最近一次比赛是？")
        #expect(assistant?.shareIndex == nil)
        #expect(assistant?.selectable == false)
        // user 已确认落库：占一个投影位。
        #expect(model.messages[1].shareIndex == 0)
    }

    @Test @MainActor func emptyReplyDegradesButKeepsProjectionSequence() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "hi")
        await service.complete(CoachDone(status: .completed, message: "  ", interruptText: nil, card: nil))

        // 无 assistant 气泡；user 占位 + 空回复占位 = 投影长度 +2。
        #expect(model.messages.count == 2)
        #expect(model.messages[1].shareIndex == 0)
        #expect(model.messages[1].selectable)

        // 下一轮序号不漂移。
        await model.send(text: "再来")
        await service.complete(donePayload(cardType: nil))
        #expect(model.messages[2].shareIndex == 2)
        #expect(model.messages[3].shareIndex == 3)
    }

    @Test @MainActor func failedTurnMarksRetryableAndReusesTurnId() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "hi")
        await service.fail(CoachStreamError(code: "network", message: "网络异常"))

        #expect(!model.sending)
        #expect(model.messages[1].failed)
        let firstTurnId = service.streamCallLog[0].clientTurnId

        await model.retry(messageId: model.messages[1].id)
        #expect(service.streamCallLog.count == 2)
        #expect(service.streamCallLog[1].clientTurnId == firstTurnId, "重试复用同 client_turn_id（服务端幂等）")
        #expect(service.streamCallLog[1].message == "hi")
    }

    @Test @MainActor func historyFailureKeepsWelcomeAndBlocksMultiSelect() async {
        let service = MockService()
        service.historyResult = .failure(ApiError(statusCode: 500, code: nil, detail: "boom"))
        let (model, _) = makeModel(service: service)
        await model.bootstrap()

        #expect(model.messages.count == 1)
        #expect(model.messages[0].selectable == false)
        #expect(model.historySyncFailed)

        // 欢迎语不可选；多选入口被历史未同步拦截。
        model.handleMessageLongPress(model.messages[0].id)
        #expect(!model.selectMode)
        #expect(model.toast == "对话尚未同步，暂时无法多选转发")
    }

    // MARK: - 历史恢复 + 卡片

    @Test @MainActor func historyMapsCardsAndLeakedEnvelopes() async {
        let service = MockService()
        let strategyJSON = """
        {"race_name":"上马","item_type":"FM","target_finish_time":"3:30:00","pace_segments":[{"segment":"s1"}]}
        """
        service.historyResult = .success(CoachHistoryResponse(sessionId: "ios-default", messages: [
            CoachHistoryMessage(role: .user, content: "生成策略"),
            // 服务端信封卡（master-plan）。
            CoachHistoryMessage(
                role: .assistant, content: "计划已生成",
                card: masterPlanCardWire
            ),
            CoachHistoryMessage(role: .user, content: "再来一版策略"),
            // 泄漏信封（裸 JSON 当正文写进历史）：自愈回卡片。
            CoachHistoryMessage(role: .assistant, content: strategyJSON, card: nil),
        ]))
        let (model, _) = makeModel(service: service)
        await model.bootstrap()

        #expect(model.messages.count == 4)
        // 投影序号 = 历史行序。
        #expect(model.messages.map(\.shareIndex) == [0, 1, 2, 3])
        #expect(model.messages[1].card?.type == "master-plan")
        #expect(model.messages[1].card?.inlineBody == Optional(true))
        #expect(model.messages[3].card?.type == "race-strategy")
        #expect(model.historySyncFailed == false)
    }

    @Test @MainActor func reconcileRestoresCustomWorkoutTerminalStates() async {
        let service = MockService()
        let customWire = CoachCardWire(
            type: "custom-workout",
            data: Data("{\"save_token\":\"save-1\",\"date\":\"2026-10-28\",\"name\":\"轻松跑\",\"summary\":\"8km\",\"spec\":{\"blocks\":[{\"k\":\"w\"}]}}".utf8)
        )
        let moveWire = CoachCardWire(
            type: "workout-op",
            data: Data("{\"op\":\"move\",\"workout_id\":\"w-9\",\"date\":\"2026-10-28\",\"new_date\":\"2026-10-30\",\"name\":\"轻松跑\"}".utf8)
        )
        let deleteWire = CoachCardWire(
            type: "workout-op",
            data: Data("{\"op\":\"delete\",\"workout_id\":\"w-gone\",\"date\":\"2026-10-28\",\"name\":\"旧课\"}".utf8)
        )
        service.historyResult = .success(CoachHistoryResponse(sessionId: "ios-default", messages: [
            CoachHistoryMessage(role: .user, content: "建课"),
            CoachHistoryMessage(role: .assistant, content: "训练课已创建", card: customWire),
            CoachHistoryMessage(role: .user, content: "改期"),
            CoachHistoryMessage(role: .assistant, content: "训练课改期", card: moveWire),
            CoachHistoryMessage(role: .user, content: "删除"),
            CoachHistoryMessage(role: .assistant, content: "删除训练课", card: deleteWire),
        ]))
        // 课表行：save-1 已推送；w-9 已在新日期（已改期）；w-gone 已消失（已删除）。
        service.planRowsResult = .success([
            CoachPlanSessionRow(workoutId: "w-1", date: "2026-10-28", source: "custom", pushed: true, saveToken: "save-1"),
            CoachPlanSessionRow(workoutId: "w-9", date: "2026-10-30", source: "custom", pushed: false),
        ])
        let (model, _) = makeModel(service: service)
        await model.bootstrap()

        #expect(model.messages[1].card?.badge == "已推送")
        #expect(model.messages[1].card?.secondaryButtonText == "")
        #expect(model.messages[3].card?.badge == "已改期")
        #expect(model.messages[5].card?.badge == "已删除")
    }

    // MARK: - 卡片动作

    @Test @MainActor func saveCustomWorkoutMarksSavedKeepsPushCTA() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "建课")
        await service.complete(donePayload(cardType: "custom-workout"))

        await model.cardPrimaryAction(messageId: model.messages.last!.id)
        #expect(service.upsertCards.count == 1)
        #expect(model.messages.last?.card?.badge == "已保存")
        #expect(model.messages.last?.card?.buttonText == "")
        #expect(model.messages.last?.card?.secondaryButtonText == "推送到手表", "保存后推送仍可用")
    }

    @Test @MainActor func pushSavesFirstThenPushes() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "建课")
        await service.complete(donePayload(cardType: "custom-workout"))

        await model.cardSecondaryAction(messageId: model.messages.last!.id)
        #expect(service.upsertCards.count == 1, "未保存先走幂等保存")
        #expect(model.messages.last?.card?.badge == "已推送")
    }

    @Test @MainActor func workoutOpMoveConfirmFlow() async {
        let (model, service) = makeModel()
        await model.bootstrap()
        await model.send(text: "改期")
        let wire = CoachCardWire(
            type: "workout-op",
            data: Data("{\"op\":\"move\",\"workout_id\":\"w-9\",\"date\":\"2026-10-28\",\"new_date\":\"2026-10-30\",\"name\":\"轻松跑\"}".utf8)
        )
        await service.complete(CoachDone(status: .completed, message: "已生成", interruptText: nil, card: wire))

        await model.cardPrimaryAction(messageId: model.messages.last!.id)
        // 改期无二次确认（只有删除有），直接执行。
        #expect(service.moveCalls.count == 1)
        #expect(service.moveCalls[0].date == "2026-10-30")
        #expect(model.messages.last?.card?.badge == "已改期")
    }

    @Test @MainActor func workoutOpDeleteDoubleConfirmationAnd404Tolerance() async {
        let service = MockService()
        service.deleteError = ApiError(statusCode: 404, code: nil, detail: "not found")
        let (model, _) = makeModel(service: service)
        await model.bootstrap()
        await model.send(text: "删除")
        let wire = CoachCardWire(
            type: "workout-op",
            data: Data("{\"op\":\"delete\",\"workout_id\":\"w-1\",\"date\":\"2026-10-28\",\"name\":\"轻松跑\"}".utf8)
        )
        await service.complete(CoachDone(status: .completed, message: "已生成", interruptText: nil, card: wire))

        await model.cardPrimaryAction(messageId: model.messages.last!.id)
        // 第一道：弹确认（删除双确认）。
        #expect(model.confirmation != nil)
        #expect(service.deleteCalls.isEmpty)

        await model.confirmPending()
        // 404 = 已在别处删除，同样是删除终态。
        #expect(service.deleteCalls == ["w-1"])
        #expect(model.messages.last?.card?.badge == "已删除")
    }

    @Test @MainActor func masterPlanPrecheckHasCurrentPlanAsksReplaceConfirm() async {
        let service = MockService()
        service.currentPlanResult = .success(CurrentPlanRef(planId: "plan-A", revision: 3))
        let (model, _) = makeModel(service: service)
        await model.bootstrap()
        await model.send(text: "生成计划")
        await service.complete(CoachDone(
            status: .completed, message: "计划摘要", interruptText: nil, card: masterPlanCardWire
        ))

        await model.cardPrimaryAction(messageId: model.messages.last!.id)
        #expect(model.confirmation != nil, "有当前计划必须替换确认")
        #expect(service.applyCalls.isEmpty)

        await model.confirmPending()
        #expect(service.applyCalls.count == 1)
        #expect(service.applyCalls[0].expectation?.planId == "plan-A")
        #expect(service.applyCalls[0].expectation?.revision == 3)
        #expect(model.messages.last?.card?.badge == "已应用")
    }

    @Test @MainActor func masterPlanPrecheckNoneAppliesDirectly() async {
        let service = MockService()
        service.currentPlanResult = .success(nil)
        let (model, _) = makeModel(service: service)
        await model.bootstrap()
        await model.send(text: "生成计划")
        await service.complete(CoachDone(
            status: .completed, message: "计划摘要", interruptText: nil, card: masterPlanCardWire
        ))

        await model.cardPrimaryAction(messageId: model.messages.last!.id)
        #expect(model.confirmation == nil, "确认没有当前计划直接应用")
        #expect(service.applyCalls.count == 1)
        #expect(service.applyCalls[0].expectation == nil)
    }

    @Test @MainActor func masterPlanPrecheckUnknownAsksUncertainConfirm() async {
        let service = MockService()
        service.currentPlanResult = .failure(ApiError(statusCode: 500, code: nil, detail: "net"))
        let (model, _) = makeModel(service: service)
        await model.bootstrap()
        await model.send(text: "生成计划")
        await service.complete(CoachDone(
            status: .completed, message: "计划摘要", interruptText: nil, card: masterPlanCardWire
        ))

        await model.cardPrimaryAction(messageId: model.messages.last!.id)
        guard case .replacePlan(let uncertain) = model.confirmation?.kind else {
            Issue.record("查不到时按「可能有」保守确认")
            return
        }
        #expect(uncertain)
        #expect(service.applyCalls.isEmpty)
    }

    @Test @MainActor func masterPlan409RecheckMarksStale() async {
        let service = MockService()
        service.currentPlanResult = .success(CurrentPlanRef(planId: "plan-A", revision: 1))
        service.applyError = ApiError(statusCode: 409, code: "master_plan_changed", detail: "changed")
        let (model, _) = makeModel(service: service)
        await model.bootstrap()
        await model.send(text: "生成计划")
        await service.complete(CoachDone(
            status: .completed, message: "计划摘要", interruptText: nil, card: masterPlanCardWire
        ))

        await model.cardPrimaryAction(messageId: model.messages.last!.id)
        await model.confirmPending()
        // 409 复查：查得到（当前预检成功）→ 这版已失效。
        #expect(model.messages.last?.card?.badge == "已失效")
        #expect(model.messages.last?.card?.buttonText == "")
    }

    // MARK: - 多选转发

    @Test @MainActor func selectModeLongPressToggleAndCap() async {
        let service = MockService()
        service.historyResult = .success(CoachHistoryResponse(sessionId: "ios-default", messages: (0..<35).map {
            CoachHistoryMessage(role: $0 % 2 == 0 ? .user : .assistant, content: "m\($0)")
        }))
        let (model, _) = makeModel(service: service)
        await model.bootstrap()

        model.handleMessageLongPress(model.messages[1].id)
        #expect(model.selectMode)
        #expect(model.selectCount == 1)

        model.handleMessageTap(model.messages[3].id)
        #expect(model.selectCount == 2)

        model.toggleSelectAll()
        #expect(model.selectCount == CoachChatModel.maxShareMessages, "全选截前 30")
        #expect(!model.allSelected)

        model.exitSelectMode()
        #expect(model.selectCount == 0)
        #expect(model.messages.allSatisfy { !$0.selected })
    }

    @Test @MainActor func forwardCreatesShareWithSortedIndices() async {
        let service = MockService()
        service.historyResult = .success(CoachHistoryResponse(sessionId: "ios-default", messages: [
            CoachHistoryMessage(role: .user, content: "q1"),
            CoachHistoryMessage(role: .assistant, content: "a1"),
            CoachHistoryMessage(role: .user, content: "q2"),
            CoachHistoryMessage(role: .assistant, content: "a2"),
        ]))
        let (model, _) = makeModel(service: service)
        await model.bootstrap()

        model.handleMessageLongPress(model.messages[3].id)
        model.handleMessageTap(model.messages[1].id)
        await model.forwardSelected()

        #expect(service.shareCalls.count == 1)
        #expect(service.shareCalls[0].indices == [1, 3], "升序去重投影序号")
        #expect(model.sharePayload != nil)
        // PR-8：/s/ 分流链接 + 品牌口径文案（不提教练）
        #expect(
            model.sharePayload?.url.absoluteString
                == "https://stride-running.cn/s/pages/coach-share/coach-share?sid=sid123"
        )
        #expect(model.sharePayload?.title == "我与 StrideWise 的对话 · 2 条")
        // 封面投影：前两条所选（a1、a2 两条 assistant 节选）
        #expect(model.sharePayload?.picks == [
            CoachBubbleCoverView.Pick(isUser: false, lines: ["a1"]),
            CoachBubbleCoverView.Pick(isUser: false, lines: ["a2"]),
        ])
    }

    @Test @MainActor func forwardPassesSharerNameIntoSnapshotAndTitle() async {
        let service = MockService()
        service.historyResult = .success(CoachHistoryResponse(sessionId: "ios-default", messages: [
            CoachHistoryMessage(role: .user, content: "q1"),
            CoachHistoryMessage(role: .assistant, content: "a1"),
        ]))
        let (model, _) = makeModel(service: service, sharerNameProvider: { "小跑" })
        await model.bootstrap()

        model.handleMessageLongPress(model.messages[1].id)
        await model.forwardSelected()

        #expect(service.shareCalls[0].sharerName == "小跑", "昵称随快照上送（coach.ts 同款）")
        #expect(model.sharePayload?.title == "小跑 与 StrideWise 的对话 · 1 条")
    }

    // MARK: - 会话 / 上下文

    @Test @MainActor func sessionsMergeServerListKeepingLocalTargets() async {
        let service = MockService()
        service.sessionsResult = .success([
            CoachSessionSummary(sessionId: "qa-2026-10-01", preview: "旧 QA 会话"),
            CoachSessionSummary(sessionId: "ios-default", preview: nil),
        ])
        let (model, _) = makeModel(service: service)
        await model.bootstrap()

        #expect(model.sessions.map(\.id).contains("qa-2026-10-01"), "存量 qa-* 会话经列表自动延续")
        #expect(model.sessions.first { $0.id == "ios-default" }?.title == "新对话", "空 preview 用占位标题")
    }

    @Test @MainActor func pendingContextStartsTargetSessionWithKickoff() async {
        let (model, service) = makeModel()
        await model.bootstrap()

        let pending = PendingCoachContext(
            target: CoachTarget(kind: .session, date: "2026-10-26", sessionIndex: 1),
            label: "轻松跑 12km · 10月26日",
            kickoff: "帮我看看这节课怎么跑"
        )
        model.consumePendingContext(pending)

        #expect(model.contextHint == "正在围绕「轻松跑 12km · 10月26日」对话")
        #expect(!model.messages.contains(where: { $0.content == "你好，我是你的 AI 教练。可以问我今天的训练安排、疲劳状态、配速建议，或复盘某次训练。" }),
                "kickoff 入口不放通用欢迎语")
        // kickoff 自动发出（内部 Task）。
        await waitUntil { !service.streamCallLog.isEmpty }
        #expect(service.streamCallLog.count == 1)
        #expect(service.streamCallLog[0].target?.kind == .session)
        #expect(service.streamCallLog[0].message == "帮我看看这节课怎么跑")

        model.clearContext()
        #expect(model.contextHint.isEmpty)
    }

    @Test @MainActor func newConversationResetsToWelcome() async {
        let (model, _) = makeModel()
        await model.bootstrap()
        let before = model.currentSessionId
        model.newConversation()

        #expect(model.currentSessionId != before)
        #expect(model.currentSessionId.hasPrefix("ios-"))
        #expect(model.messages.count == 1)
        #expect(model.messages[0].content.contains("AI 教练"))
    }

    // MARK: - 断流恢复（前后台）

    @Test @MainActor func backgroundInterruptMarksFailedAndForegroundReconciles() async {
        let service = MockService()
        service.historyResult = .success(CoachHistoryResponse(sessionId: "ios-default", messages: [
            CoachHistoryMessage(role: .user, content: "q1"),
            CoachHistoryMessage(role: .assistant, content: "a1"),
        ]))
        let (model, _) = makeModel(service: service)
        await model.bootstrap()
        await model.send(text: "进行中的问题")

        // 退后台：中止在途流，记下中断轮次。
        model.handleSceneBackground()
        #expect(!model.streaming)

        // 回前台：静默重拉对账 + 未落库轮次恢复 failed 气泡。
        model.handleSceneActive()
        await waitUntil { model.messages.count == 3 && model.messages.last?.failed == true }
        #expect(model.messages.last?.failed == true)
        // 服务端两行投影 + 本地 failed user 行（无投影序号）。
        #expect(model.messages.map(\.shareIndex) == [0, 1, nil])
    }

    // MARK: - 标题

    @Test @MainActor func titleFromTextTruncatesToTwelve() {
        #expect(CoachChatModel.titleFromText("短问题") == "短问题")
        let long = "这是一个非常非常非常非常非常长的问题文本"
        #expect(CoachChatModel.titleFromText(long).count == 13) // 12 字 + …
    }
}
