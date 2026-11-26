import Foundation

// MARK: - 首次同步 session 契约（devops#1016 / epic #1004 T12）
//
// `GET/POST /api/users/me/onboarding/sync` 的客户端镜像（Go
// internal/onboardingsync.View）。视图是**服务端派生**的：本文件只做解码
// 与展示口径整形，readiness 一律信服务器上报，客户端不自行推断
// （completed_with_gaps ≠ 完整覆盖，不得当完整呈现——Web sessionModel.ts 同款约束）。

/// 单阶段 readiness 级别（Go Readiness 常量集）。
public enum OnboardingSyncReadiness: String, Decodable, Sendable, Equatable {
    case notStarted = "not_started"
    case pending
    case running
    case ready
    case readyWithGaps = "ready_with_gaps"
    case failed
    case partial
    case unavailable
}

/// 阶段覆盖缺口（Go StageGap）：from/to 为上海自然日，reason 说明合法缺测
/// 或失败原因——是「如实说明」，不是待办清单。
public struct OnboardingSyncStageGap: Decodable, Sendable, Equatable {
    public let from: String
    public let to: String
    public let reason: String?

    enum CodingKeys: String, CodingKey {
        case from, to, reason
    }
}

/// 单阶段投影（Go StageView）：目标范围 / 扫描范围 / 实际观测范围分开，
/// observed 缺端 = 尚未覆盖，保持开放语义。
public struct OnboardingSyncStageView: Decodable, Sendable, Equatable {
    public let stage: String
    public let status: String
    public let readiness: OnboardingSyncReadiness
    public let targetFrom: String
    public let targetTo: String
    public let scannedFrom: String?
    public let scannedTo: String?
    public let observedFrom: String?
    public let observedTo: String?
    public let gaps: [OnboardingSyncStageGap]?
    public let error: String?

    enum CodingKeys: String, CodingKey {
        case stage, status, readiness
        case targetFrom = "target_from"
        case targetTo = "target_to"
        case scannedFrom = "scanned_from"
        case scannedTo = "scanned_to"
        case observedFrom = "observed_from"
        case observedTo = "observed_to"
        case gaps, error
    }
}

/// 汇总 readiness 面（Go ViewReadiness）：近期数据/近期分析/历史扩展/
/// 历史补齐/历史分析与辅助任务分列——原始详情和分析缺项分别展示的依据。
public struct OnboardingSyncReadinessFlags: Decodable, Sendable, Equatable {
    public let shellReady: Bool
    public let recentData: OnboardingSyncReadiness
    public let recentAnalysis: OnboardingSyncReadiness
    public let extendedData: OnboardingSyncReadiness
    public let historicalData: OnboardingSyncReadiness
    public let historicalAnalysis: OnboardingSyncReadiness
    public let auxiliary: OnboardingSyncReadiness

    enum CodingKeys: String, CodingKey {
        case shellReady = "shell_ready"
        case recentData = "recent_data"
        case recentAnalysis = "recent_analysis"
        case extendedData = "extended_data"
        case historicalData = "historical_data"
        case historicalAnalysis = "historical_analysis"
        case auxiliary
    }
}

/// session 只读视图（Go View）。`shellReady` 为 true 仅当 session 与可靠
/// 派发记录均已持久化——这是「可以进首页」的唯一依据。
public struct OnboardingSyncSessionView: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let state: String
    public let shellReady: Bool
    public let provider: String
    public let bindingRevision: Int64
    public let anchorDay: String
    public let legacyRunId: String?
    public let retryCount: Int
    public let historicalAnalysisReason: String?
    public let historicalAnalysisPoll: Bool?
    public let error: String?
    public let stages: [OnboardingSyncStageView]
    public let readiness: OnboardingSyncReadinessFlags

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case state
        case shellReady = "shell_ready"
        case provider
        case bindingRevision = "binding_revision"
        case anchorDay = "anchor_day"
        case legacyRunId = "legacy_run_id"
        case retryCount = "retry_count"
        case historicalAnalysisReason = "historical_analysis_reason"
        case historicalAnalysisPoll = "historical_analysis_poll"
        case error, stages, readiness
    }
}

// MARK: - 端点

extension APIClient {

    /// 只读视图（GET /api/users/me/onboarding/sync）。严格只读：服务端不做
    /// 同步、不重算、不自愈写；404 = 尚无 session（老用户/未绑表）。
    public func onboardingSyncSession() async throws -> OnboardingSyncSessionView {
        try await send(APIRequest(path: "/api/users/me/onboarding/sync"), as: OnboardingSyncSessionView.self)
    }

    /// 原子创建或认领 session（POST /api/users/me/onboarding/sync）。客户端
    /// 唯一可传输入是 retry：只恢复未完成工作，成功抓取的范围不重拉。
    /// 默认发空体 `{}`（与 Web postJSON 同形）。
    public func createOnboardingSyncSession(retry: Bool) async throws -> OnboardingSyncSessionView {
        let body: Data
        if retry {
            body = (try? JSONEncoder().encode(["retry": true])) ?? Data("{}".utf8)
        } else {
            body = Data("{}".utf8)
        }
        return try await send(
            APIRequest(method: .post, path: "/api/users/me/onboarding/sync", body: body),
            as: OnboardingSyncSessionView.self
        )
    }
}

// MARK: - 展示口径（纯函数，与 Web frontend/src/onboardingSync/sessionModel.ts 同表）

/// session 视图的展示整形：状态/级别文案、tone 映射、阶段名与范围标签。
/// 文案三端（Web/小程序/iOS）同表，改这里须同步另两端。
public enum OnboardingSessionDisplay {

    /// 汇总 chip 的语气色（good=绿 / warn=琥珀 / bad=红 / muted=灰）。
    public enum Tone: Sendable, Equatable { case good, warn, bad, muted }

    public static func stateLabel(_ state: String) -> String {
        switch state {
        case "waiting_legacy": "接管已有同步任务"
        case "dispatching": "正在启动同步"
        case "running": "同步进行中"
        case "failed": "同步失败"
        case "completed_with_gaps": "同步完成（部分缺项）"
        case "completed": "同步完成"
        case "superseded": "已由新绑定取代"
        default: state
        }
    }

    /// 终态：session 链不再自行推进。failed / completed_with_gaps 的 banner
    /// 保留展示（错误 + 重试 / 缺项说明）；completed / superseded 隐藏。
    public static func isTerminal(_ state: String) -> Bool {
        state == "completed" || state == "completed_with_gaps" || state == "failed" || state == "superseded"
    }

    public static func readinessLabel(_ level: OnboardingSyncReadiness) -> String {
        switch level {
        case .ready: "已就绪"
        case .readyWithGaps: "已就绪（有缺项）"
        case .running: "进行中"
        case .pending: "等待中"
        case .failed: "失败"
        case .partial: "部分可用"
        case .unavailable: "暂不可用"
        case .notStarted: "未开始"
        }
    }

    public static func readinessTone(_ level: OnboardingSyncReadiness) -> Tone {
        switch level {
        case .ready: .good
        case .readyWithGaps, .partial: .warn
        case .failed: .bad
        case .running, .pending, .unavailable, .notStarted: .muted
        }
    }

    /// banner 头部汇总 chips 的键（spec：原始/派生/辅助分开，历史失败不
    /// 收回近期；shell_ready 是 bool 不是 readiness 级别，刻意不做 chip）。
    /// 声明顺序即展示顺序。
    public enum ReadinessKey: String, CaseIterable, Sendable {
        case recentData = "recent_data"
        case recentAnalysis = "recent_analysis"
        case extendedData = "extended_data"
        case historicalData = "historical_data"
        case historicalAnalysis = "historical_analysis"
        case auxiliary

        public var label: String {
            switch self {
            case .recentData: "近期数据"
            case .recentAnalysis: "近期分析"
            case .extendedData: "历史扩展"
            case .historicalData: "历史补齐"
            case .historicalAnalysis: "历史分析"
            case .auxiliary: "辅助任务"
            }
        }
    }

    /// 从服务端 flags 取该键的 readiness 级别。
    public static func readinessLevel(_ key: ReadinessKey, of flags: OnboardingSyncReadinessFlags) -> OnboardingSyncReadiness {
        switch key {
        case .recentData: flags.recentData
        case .recentAnalysis: flags.recentAnalysis
        case .extendedData: flags.extendedData
        case .historicalData: flags.historicalData
        case .historicalAnalysis: flags.historicalAnalysis
        case .auxiliary: flags.auxiliary
        }
    }

    public static func shouldPoll(_ view: OnboardingSyncSessionView) -> Bool {
        !isTerminal(view.state) || view.historicalAnalysisPoll == true
    }

    public static func historicalAnalysisLabel(_ view: OnboardingSyncSessionView) -> String {
        if view.historicalAnalysisReason != nil { return "待人工处理" }
        let level = view.readiness.historicalAnalysis
        return level == .pending ? "待处理" : readinessLabel(level)
    }

    static let stageLabels: [String: String] = [
        "recent_raw": "近期数据（活动 / 健康）",
        "recent_analysis": "近期分析",
        "extended_raw": "历史扩展（180日活动 / 90日健康）",
        "historical_raw": "历史补齐（全部可访问活动）",
        "auxiliary": "辅助任务（比赛识别 / 路线形状）",
    ]

    public static func stageLabel(_ stage: String) -> String {
        stageLabels[stage] ?? stage
    }

    /// "2026-11-10 ~ 2026-11-16"；缺端渲染开放端（…），未完成的扫描不读作
    /// 完整覆盖。
    public static func rangeLabel(from: String?, to: String?) -> String {
        switch (from, to) {
        case (nil, nil): "—"
        case (let from?, let to?): "\(from) ~ \(to)"
        case (nil, let to?): "… ~ \(to)"
        case (let from?, nil): "\(from) ~ …"
        }
    }
}
