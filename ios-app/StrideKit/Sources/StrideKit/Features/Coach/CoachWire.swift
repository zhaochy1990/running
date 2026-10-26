import Foundation

// coach_agent_api wire 契约镜像（devops#421 决议「协议规范全文」+ #755 规格）。
// 命名一律 snake_case 对齐服务端 DTO；数值口径由服务端 zod 把关，客户端只做
// 鸭子类型形状校验（CoachCardRegistry）。

// MARK: - 会话 target（后端 CoachTurnScope / turnScope.ts）

/// 教练对话的权威目标引用：target 随每轮消息发送，服务端经
/// `<coach_turn_scope>` 注入模型聚焦该计划 session / 周 / 赛事。
/// kind=race 强制 raceEventId + itemType；week 携带 folder；
/// session 携带 date + sessionIndex。
public struct CoachTarget: Hashable, Codable, Sendable {

    public enum Kind: String, Codable, Sendable {
        case master
        case week
        case session
        case race
    }

    public var kind: Kind
    public var planId: String?
    public var folder: String?
    public var date: String?
    public var sessionIndex: Int?
    public var raceEventId: Int?
    public var itemType: String?

    public init(
        kind: Kind,
        planId: String? = nil,
        folder: String? = nil,
        date: String? = nil,
        sessionIndex: Int? = nil,
        raceEventId: Int? = nil,
        itemType: String? = nil
    ) {
        self.kind = kind
        self.planId = planId
        self.folder = folder
        self.date = date
        self.sessionIndex = sessionIndex
        self.raceEventId = raceEventId
        self.itemType = itemType
    }

    enum CodingKeys: String, CodingKey {
        case kind
        case planId = "plan_id"
        case folder, date
        case sessionIndex = "session_index"
        case raceEventId = "race_event_id"
        case itemType = "item_type"
    }
}

// MARK: - 流式事件

/// 服务端 status 事件的 phase（协议规范：phase 只有 running_tool|analyzing；
/// in_subagent 为历史兼容值）。
public enum CoachPhase: String, Sendable {
    case inSubagent = "in_subagent"
    case runningTool = "running_tool"
    case analyzing
}

/// status 事件载荷：`{turn_id, phase, tool?, tool_status?}`，
/// toolStatus ∈ running|finished|error。
public struct CoachStatus: Equatable, Sendable {
    public let phase: CoachPhase
    public let tool: String?
    public let toolStatus: String?

    public init(phase: CoachPhase, tool: String? = nil, toolStatus: String? = nil) {
        self.phase = phase
        self.tool = tool
        self.toolStatus = toolStatus
    }
}

/// 流内中间事件（进度区，绝不混入回答正文）。
public enum CoachStreamEvent: Equatable, Sendable {
    /// 工具/取数阶段变化。
    case status(CoachStatus)
    /// 工具调用前的整段进度说明（一次到达，非增量）。
    case narration(String)
    /// 回答正文增量（打字机拼接；与 done.message 一致）。
    case delta(String)
}

/// done 事件载荷：message 来自服务端最终 values 快照，是权威文本；
/// card 为本轮 intent 命中的结构化产物信封 `{$type, data}`。
public struct CoachDone: Equatable, Sendable {
    public enum Status: String, Sendable {
        case completed
        case needsInput = "needs_input"
    }

    public let status: Status?
    public let message: String?
    /// needs_input 时后端 interrupt 的可展示文本（question 优先）。
    public let interruptText: String?
    /// 结构化产物信封（未知 $type 由注册表降级 markdown）。
    public let card: CoachCardWire?

    public init(status: Status? = nil, message: String? = nil, interruptText: String? = nil, card: CoachCardWire? = nil) {
        self.status = status
        self.message = message
        self.interruptText = interruptText
        self.card = card
    }
}

/// 终止失败：服务端三码（client_turn_id_conflict|coach_thread_busy|
/// coach_turn_failed）或客户端码（network/timeout/unauthorized/…）。
public struct CoachStreamError: Error, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    /// 用户可见中文文案（错误码层）。
    public var localized: String {
        switch code {
        case "client_turn_id_conflict": "请求冲突了，请重试"
        case "coach_thread_busy": "上一条回复还在生成中，请稍候再试"
        case "coach_turn_failed": "教练本轮生成失败，请重试"
        case "timeout": message
        case "unauthorized", "session_expired": "登录已过期，请重新登录"
        default: message
        }
    }
}

// MARK: - 结构化产物信封

/// done.card / 历史行 card 的 wire 形态。data 保持原始 JSON（形状校验在
/// 注册表做，未知产物降级 markdown 而不是丢弃）。
public struct CoachCardWire: Equatable, Sendable {
    public let type: String
    public let data: Data

    public init(type: String, data: Data) {
        self.type = type
        self.data = data
    }

    /// 宽松解析：{$type, data} 双字段齐全才成信封。
    public static func parse(_ raw: Data?) -> CoachCardWire? {
        guard let raw,
              let object = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let type = object["$type"] as? String, !type.isEmpty,
              let data = object["data"], JSONSerialization.isValidJSONObject(data)
        else { return nil }
        // data 原样重序列化（stable），避免 Any 逃逸出解码边界。
        guard let payload = try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]) else {
            return nil
        }
        return CoachCardWire(type: type, data: payload)
    }

    /// data →鸭子类型字典（形状校验共用入口）。
    var dataObject: [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

// MARK: - 会话模型（sessions / history）

/// `GET /api/users/me/coach/sessions` 行：新→旧，preview=首条 user 消息。
public struct CoachSessionSummary: Equatable, Sendable {
    public let sessionId: String
    public let updatedAt: String?
    public let preview: String?

    public init(sessionId: String, updatedAt: String? = nil, preview: String? = nil) {
        self.sessionId = sessionId
        self.updatedAt = updatedAt
        self.preview = preview
    }
}

/// `GET /api/users/me/coach/sessions/{id}/messages` 行：user/assistant 两种
/// 气泡；card 信封挂产生它的 assistant 行；中间 tool 步服务端已剔除。
public struct CoachHistoryMessage: Equatable, Sendable {
    public enum Role: String, Sendable {
        case user
        case assistant
    }

    public let role: Role
    public let content: String
    public let card: CoachCardWire?

    public init(role: Role, content: String, card: CoachCardWire? = nil) {
        self.role = role
        self.content = content
        self.card = card
    }
}

public struct CoachHistoryResponse: Equatable, Sendable {
    public let sessionId: String
    public let messages: [CoachHistoryMessage]

    public init(sessionId: String, messages: [CoachHistoryMessage]) {
        self.sessionId = sessionId
        self.messages = messages
    }
}

/// `POST /api/users/me/coach/sessions/{id}/share` 响应（多选转发快照）。
public struct CoachShareResult: Equatable, Sendable {
    public let sid: String
    public let reused: Bool

    public init(sid: String, reused: Bool) {
        self.sid = sid
        self.reused = reused
    }
}

// MARK: - 卡片载荷（形状校验的鸭子类型面）

/// race-strategy 卡 data：数值口径由后端 zod 把关，这里只保展示必填字段。
public struct RaceStrategy: Equatable, Sendable {
    public let raceName: String
    public let itemType: String
    public let targetFinishTime: String
    public let paceSegmentCount: Int

    /// 原始 JSON 原样保留（草稿交接给赛事报告页用，PR-6 定稿结构）。
    public let payload: Data
}

/// master-plan 卡 data：goal + apply_token/content 可选对（#585
/// apply-from-content；缺省 = 降级/旧卡片，无「应用」CTA）。
public struct MasterPlanCard: Equatable, Sendable {
    public struct Goal: Equatable, Sendable {
        public let raceName: String
        public let distance: String
        public let raceDate: String
        public let targetTime: String
    }

    public let goal: Goal
    public let totalWeeks: Int
    public let applyToken: String?
    /// 完整 v2 计划 doc（apply 端点原样回传；不透明 JSON）。
    public let content: Data?
    public let payload: Data
}

/// custom-workout 卡 data：save_token 幂等 upsert；reissue=改内容重发卡。
public struct CustomWorkoutCard: Equatable, Sendable {
    public let saveToken: String
    public let date: String
    public let kind: String?
    public let name: String
    public let summary: String
    public let totalDistanceM: Double?
    public let totalDurationS: Double?
    public let estimatedDose: Double?
    public let spec: Data
    public let reissue: Bool
    public let payload: Data
}

/// workout-op 确认卡 data：op ∈ delete|move（move 必带 new_date）。
public struct WorkoutOpCard: Equatable, Sendable {
    public enum Op: String, Sendable {
        case delete
        case move
    }

    public let op: Op
    public let workoutId: String
    public let date: String
    public let name: String
    public let pushed: Bool
    public let newDate: String?
    public let payload: Data
}

// MARK: - 卡片动作端点响应面

/// 统一课表行的教练侧最小投影（`GET /api/users/me/plan/sessions`）：对账只
/// 消费 workout_id/date/pushed/save_token 四个字段。完整 wire 镜像
/// `PlanSessionRow`（训练域 devops#768）与其并存，重名规避改名。
public struct CoachPlanSessionRow: Equatable, Sendable {
    public let workoutId: String
    public let date: String
    public let source: String
    public let pushed: Bool
    public let saveToken: String?

    public init(workoutId: String, date: String, source: String, pushed: Bool, saveToken: String? = nil) {
        self.workoutId = workoutId
        self.date = date
        self.source = source
        self.pushed = pushed
        self.saveToken = saveToken
    }
}

/// 改期自建课响应（T1 move 端点）：watch_synced=false 表示改期已生效、
/// 仅手表副本未跟上。
public struct MoveWorkoutResult: Equatable, Sendable {
    public let row: CoachPlanSessionRow
    public let watchSynced: Bool

    public init(row: CoachPlanSessionRow, watchSynced: Bool) {
        self.row = row
        self.watchSynced = watchSynced
    }
}

/// `GET /master-plan/current` 的当前计划身份（替换三态预检用）。
public struct CurrentPlanRef: Equatable, Sendable {
    public let planId: String
    public let revision: Int?
}
