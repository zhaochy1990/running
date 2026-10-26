import Foundation

/// 教练结构化产物卡片注册表 —— MP `utils/coachCards.ts` 的 Swift 移植
/// （devops#767 PR-4）。把 done.card / 历史行 card 信封翻译成聊天气泡里的
/// 通知卡片展示属性，聊天页与卡片组件不感知各产物类型的细节。
///
/// 已注册四型：race-strategy / master-plan / custom-workout / workout-op；
/// 未知 `$type` 或形状不对 → nil 降级 markdown。
public enum CoachCardRegistry {

    /// 聊天气泡里的通知卡片（展示属性全部由注册表产出，组件只管渲染）。
    public struct View: Equatable, Sendable {
        public enum Action: Equatable, Sendable {
            /// 导航类（race-strategy）：卡片主体/CTA 跳目标页。
            case navigate
            /// 动作类：聊天页直调端点（master-plan 应用 / custom-workout 保存 / workout-op 确认）。
            case apply
            case save
            case push
            case confirmDelete
            case confirmMove
        }

        public let type: String
        /// SF Symbols 名（D-icon-1：SVG 资产图标 SF Symbols 重制）。
        public let icon: String
        public let title: String
        public let subtitle: String
        /// 角标（如「初稿」「待保存」）；终态回写时改写它。
        public var badge: String
        /// 主 CTA 文案；空则不渲染按钮（终态回写时收掉）。
        public var buttonText: String
        public var buttonAction: Action?
        /// 次级动作按钮（custom-workout「推送到手表」）；空则不渲染。
        public var secondaryButtonText: String
        public var secondaryAction: Action?
        /// 卡片主体是否可跳转（导航类才有）。
        public let navigable: Bool
        /// 产物本体（CTA 执行与对账的载荷）。
        public let payload: CardPayload
        /// 摘要即卡片（master-plan / custom-workout 模式）：卡片头部下方继续
        /// 渲染 markdown 正文；false 时卡片替代正文。
        public let inlineBody: Bool
    }

    /// 产物本体（强类型载荷，CTA 执行不再二次解析 JSON）。
    public enum CardPayload: Equatable, Sendable {
        case raceStrategy(RaceStrategy)
        case masterPlan(MasterPlanCard)
        case customWorkout(CustomWorkoutCard)
        case workoutOp(WorkoutOpCard)
    }

    /// 「2026-10-20」→「10月20日」（卡片副标题 / CTA / 确认弹窗文案用）。
    public static func monthDayLabel(_ ymd: String) -> String {
        let parts = ymd.split(separator: "-")
        guard parts.count == 3,
              let month = Int(parts[1]),
              let day = Int(parts[2])
        else { return ymd }
        return "\(month)月\(day)日"
    }

    /// done.card / 历史行 card → 卡片视图；信封不认识 / 形状不对返回 nil
    /// （降级走 markdown）。
    public static func build(_ wire: CoachCardWire?, target: CoachTarget?) -> View? {
        guard let wire else { return nil }
        switch wire.type {
        case "race-strategy": return raceStrategy(wire, target: target)
        case "master-plan": return masterPlan(wire)
        case "custom-workout": return customWorkout(wire)
        case "workout-op": return workoutOp(wire)
        default: return nil
        }
    }

    // MARK: - race-strategy（导航类）

    private static func raceStrategy(_ wire: CoachCardWire, target: CoachTarget?) -> View? {
        guard let strategy = parseRaceStrategy(wire) else { return nil }
        // 无 race target 时无法定位赛事（策略生成本就依赖 race target，这里
        // 只是防御）：仍出卡片，navigable=false（目标页归 PR-6 赛事域落地，
        // 骨架期策略报告页不可达时同样不跳）。
        let raceId = target?.kind == .race ? target?.raceEventId : nil
        return View(
            type: wire.type,
            icon: "flag.fill",
            title: "比赛策略已生成",
            subtitle: "\(strategy.raceName) · 目标 \(strategy.targetFinishTime)，含 \(strategy.paceSegmentCount) 段配速与补给计划",
            badge: "初稿",
            buttonText: "查看详情",
            buttonAction: .navigate,
            secondaryButtonText: "",
            secondaryAction: nil,
            navigable: raceId != nil,
            payload: .raceStrategy(strategy),
            inlineBody: false
        )
    }

    private static func parseRaceStrategy(_ wire: CoachCardWire) -> RaceStrategy? {
        guard let o = wire.dataObject,
              let raceName = o["race_name"] as? String, !raceName.isEmpty,
              let itemType = o["item_type"] as? String, !itemType.isEmpty,
              let targetFinishTime = o["target_finish_time"] as? String,
              let segments = o["pace_segments"] as? [Any], !segments.isEmpty
        else { return nil }
        return RaceStrategy(
            raceName: raceName,
            itemType: itemType,
            targetFinishTime: targetFinishTime,
            paceSegmentCount: segments.count,
            payload: wire.data
        )
    }

    // MARK: - master-plan（摘要即卡片，动作类）

    private static func masterPlan(_ wire: CoachCardWire) -> View? {
        guard let o = wire.dataObject,
              let goalObject = o["goal"] as? [String: Any],
              let raceName = goalObject["race_name"] as? String, !raceName.isEmpty,
              let totalWeeks = o["total_weeks"] as? Int, totalWeeks > 0
        else { return nil }
        let distance = (goalObject["distance"] as? String) == "FM" ? "全马" : "半马"
        let targetTime = (goalObject["target_time"] as? String) ?? ""
        let target = targetTime.isEmpty ? "" : "，目标 \(targetTime)"
        // #585 apply-from-content：content+apply_token 成对才出「应用」CTA；
        // 降级卡 / 旧卡片（只带 plan_id）纯展示。
        let applyToken = o["apply_token"] as? String
        // 注意勿写 `o["content"] as? Any`——Any? 转 Any 会把缺键包成 .some(nil)，
        // NSJSONSerialization 遇 nil 片段直接抛 ObjC 异常（try? 接不住）。
        let contentData: Data? = {
            guard let raw = o["content"], JSONSerialization.isValidJSONObject(raw) else { return nil }
            return try? JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys])
        }()
        let applicable = applyToken.map { !$0.isEmpty } == true && contentData != nil
        let card = MasterPlanCard(
            goal: .init(
                raceName: raceName,
                distance: (goalObject["distance"] as? String) ?? "",
                raceDate: (goalObject["race_date"] as? String) ?? "",
                targetTime: targetTime
            ),
            totalWeeks: totalWeeks,
            applyToken: applicable ? applyToken : nil,
            content: applicable ? contentData : nil,
            payload: wire.data
        )
        return View(
            type: wire.type,
            icon: "calendar",
            title: "赛季训练计划已生成",
            subtitle: "\(raceName)（\(distance)） · \(totalWeeks) 周备赛\(target)",
            badge: "初稿",
            buttonText: applicable ? "应用" : "",
            buttonAction: applicable ? .apply : nil,
            secondaryButtonText: "",
            secondaryAction: nil,
            navigable: false,
            payload: .masterPlan(card),
            inlineBody: true
        )
    }

    // MARK: - custom-workout（双 CTA：保存 / 推送到手表）

    private static func customWorkout(_ wire: CoachCardWire) -> View? {
        guard let card = parseCustomWorkout(wire) else { return nil }
        let dayLabel = monthDayLabel(card.date)
        // devops#698 reissue：改内容重发卡复用原 save_token，副标题明示覆盖
        // 对象（防 agent 选错源课的误覆盖，用户点保存前看得见要覆盖哪节课）。
        if card.reissue {
            return View(
                type: wire.type,
                icon: "figure.run",
                title: "训练课已调整",
                subtitle: "将更新 \(dayLabel) · \(card.name)",
                badge: "待保存",
                buttonText: "保存到\(dayLabel)",
                buttonAction: .save,
                secondaryButtonText: "推送到手表",
                secondaryAction: .push,
                navigable: false,
                payload: .customWorkout(card),
                inlineBody: true
            )
        }
        return View(
            type: wire.type,
            icon: "figure.run",
            title: "训练课已创建",
            subtitle: "\(dayLabel) · \(card.summary)",
            badge: "待保存",
            buttonText: "保存到\(dayLabel)",
            buttonAction: .save,
            secondaryButtonText: "推送到手表",
            secondaryAction: .push,
            navigable: false,
            payload: .customWorkout(card),
            inlineBody: true
        )
    }

    private static func parseCustomWorkout(_ wire: CoachCardWire) -> CustomWorkoutCard? {
        guard let o = wire.dataObject,
              let saveToken = o["save_token"] as? String, !saveToken.isEmpty,
              let date = o["date"] as? String, isYmd(date),
              let name = o["name"] as? String, !name.isEmpty,
              let summary = o["summary"] as? String, !summary.isEmpty,
              let specObject = o["spec"] as? [String: Any],
              let blocks = specObject["blocks"] as? [Any], !blocks.isEmpty
        else { return nil }
        let spec = (try? JSONSerialization.data(withJSONObject: specObject, options: [.sortedKeys])) ?? Data("{}".utf8)
        return CustomWorkoutCard(
            saveToken: saveToken,
            date: date,
            kind: o["kind"] as? String,
            name: name,
            summary: summary,
            totalDistanceM: o["total_distance_m"] as? Double,
            totalDurationS: o["total_duration_s"] as? Double,
            estimatedDose: o["estimated_dose"] as? Double,
            spec: spec,
            reissue: (o["reissue"] as? Bool) == true,
            payload: wire.data
        )
    }

    // MARK: - workout-op（单 CTA 确认卡：删除双确认 / 改期）

    private static func workoutOp(_ wire: CoachCardWire) -> View? {
        guard let op = parseWorkoutOp(wire) else { return nil }
        let dayLabel = monthDayLabel(op.date)
        // inlineBody=false：确认卡信息自足，教练的文字确认冗余不显示
        //（10-23 用户拍板；正文仍随 done.message 下发，供旧版降级）。
        if op.op == .delete {
            return View(
                type: wire.type,
                icon: "trash",
                title: "删除训练课",
                subtitle: op.pushed
                    ? "\(dayLabel) · \(op.name) · 删除将同步移除手表副本"
                    : "\(dayLabel) · \(op.name)",
                badge: "待确认",
                buttonText: "确认删除",
                buttonAction: .confirmDelete,
                secondaryButtonText: "",
                secondaryAction: nil,
                navigable: false,
                payload: .workoutOp(op),
                inlineBody: false
            )
        }
        return View(
            type: wire.type,
            icon: "calendar.badge.clock",
            title: "训练课改期",
            subtitle: "\(dayLabel) → \(monthDayLabel(op.newDate ?? op.date)) · \(op.name)",
            badge: "待确认",
            buttonText: "确认改期",
            buttonAction: .confirmMove,
            secondaryButtonText: "",
            secondaryAction: nil,
            navigable: false,
            payload: .workoutOp(op),
            inlineBody: false
        )
    }

    private static func parseWorkoutOp(_ wire: CoachCardWire) -> WorkoutOpCard? {
        guard let o = wire.dataObject,
              let opRaw = o["op"] as? String,
              let op = WorkoutOpCard.Op(rawValue: opRaw),
              let workoutId = o["workout_id"] as? String, !workoutId.isEmpty,
              let date = o["date"] as? String, isYmd(date),
              let name = o["name"] as? String, !name.isEmpty
        else { return nil }
        let newDate = o["new_date"] as? String
        if op == .move {
            guard let newDate, isYmd(newDate) else { return nil }
        }
        return WorkoutOpCard(
            op: op,
            workoutId: workoutId,
            date: date,
            name: name,
            pushed: (o["pushed"] as? Bool) == true,
            newDate: op == .move ? newDate : nil,
            payload: wire.data
        )
    }

    // MARK: - 历史自愈（信封泄漏）

    /// 历史消息自愈：正文若是泄漏的比赛策略信封 JSON（裸 `{` 开头或整段
    /// ```json 围栏），捞回成卡片信封。与后端 parseRaceStrategyFromText 同
    /// 口径（信封/裸对象双形状，兼容 {disposition,content}），只做形状校验、
    /// 不做数值复验——历史数据原样展示。
    public static func parseLeakedRaceStrategyEnvelope(_ content: String) -> CoachCardWire? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        var text = trimmed
        // 先剥整段 ```json 围栏（泄漏的另一形态）。
        if let fence = try? fenceRegex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
           let inner = Range(fence.range(at: 1), in: trimmed) {
            text = String(trimmed[inner]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard text.hasPrefix("{"), let data = text.data(using: .utf8) else { return nil }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        // {disposition:"return_direct", content:{…}} → content 即策略本体。
        if let disposition = parsed["disposition"] as? String, disposition == "return_direct",
           let inner = parsed["content"], JSONSerialization.isValidJSONObject(inner) {
            guard let payload = try? JSONSerialization.data(withJSONObject: inner, options: [.sortedKeys]) else { return nil }
            return CoachCardWire(type: "race-strategy", data: payload)
        }
        guard let payload = try? JSONSerialization.data(withJSONObject: parsed, options: [.sortedKeys]) else { return nil }
        return CoachCardWire(type: "race-strategy", data: payload)
    }

    private static let fenceRegex = try! NSRegularExpression(pattern: "^```(?:json)?\\s*\\n([\\s\\S]*?)\\n?```\\s*$")

    /// 流式正文是否「形似 JSON 泄漏」（旧后端防御）：呈现层换成中性占位文案。
    public static func looksLikeJsonText(_ text: String) -> Bool {
        let trimmed = text.drop(while: { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" })
        if trimmed.hasPrefix("{") { return true }
        if trimmed.hasPrefix("Returning structured response:") { return true }
        return trimmed.prefix(120).contains("\"disposition\"")
    }
}

// MARK: - 小工具

/// YMD 日期形状校验（鸭子类型守卫，与 MP 同正则口径）。
func isYmd(_ value: String) -> Bool {
    value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil
}
