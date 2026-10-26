import Foundation
import Testing
@testable import StrideKit

/// 卡片注册表测试：四型形状校验 / 角标与 CTA / race target 依赖 /
/// 历史信封自愈 / JSON 泄漏占位。
@Suite struct CoachCardRegistryTests {

    private func wire(type: String, payload: String) -> CoachCardWire {
        CoachCardWire(type: type, data: Data(payload.utf8))
    }

    private let raceTarget = CoachTarget(kind: .race, raceEventId: 42, itemType: "marathon")

    private var racePayload: String {
        """
        {"race_name":"上海马拉松","item_type":"FM","target_finish_time":"3:30:00",
         "pace_segments":[{"segment":"前5km","distance_km":5,"pace":"5:00/km"}],
         "fueling_plan":[],"course_tips":[],"weather_tips":[],"basis_note":""}
        """
    }

    private var masterPlanPayload: String {
        """
        {"goal":{"race_name":"上马","distance":"FM","race_date":"2027-01-01","target_time":"3:30:00"},
         "start_date":"2026-10-26","end_date":"2027-01-01","total_weeks":16,
         "apply_token":"tok-1","content":{"schema":"v2","sessions":[]}}
        """
    }

    private var customWorkoutPayload: String {
        """
        {"save_token":"save-1","date":"2026-10-28","name":"轻松跑","summary":"8km Z2",
         "total_distance_m":8000,"total_duration_s":2700,"estimated_dose":42.0,
         "spec":{"blocks":[{"kind":"warmup","minutes":10}]}}
        """
    }

    private var moveOpPayload: String {
        "{\"op\":\"move\",\"workout_id\":\"w-9\",\"date\":\"2026-10-28\",\"new_date\":\"2026-10-30\",\"name\":\"轻松跑\"}"
    }

    // MARK: - race-strategy

    @Test func raceStrategyCardWithTarget() throws {
        let card = CoachCardRegistry.build(wire(type: "race-strategy", payload: racePayload), target: raceTarget)
        let view = try #require(card)
        #expect(view.title == "比赛策略已生成")
        #expect(view.badge == "初稿")
        #expect(view.buttonText == "查看详情")
        #expect(view.buttonAction == .navigate)
        #expect(view.navigable)
        #expect(!view.inlineBody)
        #expect(view.subtitle.contains("上海马拉松"))
        #expect(view.subtitle.contains("1 段配速"))
    }

    @Test func raceStrategyWithoutRaceTargetNotNavigable() throws {
        let card = CoachCardRegistry.build(wire(type: "race-strategy", payload: racePayload), target: nil)
        let view = try #require(card)
        #expect(!view.navigable)
    }

    @Test func raceStrategyRejectsBadShape() {
        let bad = wire(type: "race-strategy", payload: "{\"race_name\":\"x\"}")
        #expect(CoachCardRegistry.build(bad, target: raceTarget) == nil)
    }

    // MARK: - master-plan

    @Test func masterPlanCardApplicable() throws {
        let card = CoachCardRegistry.build(wire(type: "master-plan", payload: masterPlanPayload), target: nil)
        let view = try #require(card)
        #expect(view.title == "赛季训练计划已生成")
        #expect(view.inlineBody)
        #expect(view.buttonText == "应用")
        #expect(view.buttonAction == .apply)
        #expect(view.subtitle.contains("16 周备赛"))
        if case .masterPlan(let plan) = view.payload {
            #expect(plan.applyToken == "tok-1")
            #expect(plan.content != nil)
        } else {
            Issue.record("payload 应为 masterPlan")
        }
    }

    @Test func masterPlanLegacyCardWithoutApplyToken() throws {
        let legacy = """
        {"goal":{"race_name":"上马","distance":"HM","race_date":"2027-01-01","target_time":""},
         "total_weeks":12,"plan_id":"p-1"}
        """
        let view = try #require(CoachCardRegistry.build(wire(type: "master-plan", payload: legacy), target: nil))
        #expect(view.buttonText.isEmpty)
        #expect(view.buttonAction == nil)
    }

    // MARK: - custom-workout

    @Test func customWorkoutCardDualCTA() throws {
        let view = try #require(CoachCardRegistry.build(wire(type: "custom-workout", payload: customWorkoutPayload), target: nil))
        #expect(view.title == "训练课已创建")
        #expect(view.badge == "待保存")
        #expect(view.buttonText == "保存到10月28日")
        #expect(view.buttonAction == .save)
        #expect(view.secondaryButtonText == "推送到手表")
        #expect(view.secondaryAction == .push)
        #expect(view.inlineBody)
    }

    @Test func customWorkoutReissueCard() throws {
        var payload = customWorkoutPayload
        payload.removeLast() // }
        payload += ",\"reissue\":true}"
        let view = try #require(CoachCardRegistry.build(wire(type: "custom-workout", payload: payload), target: nil))
        #expect(view.title == "训练课已调整")
        #expect(view.subtitle == "将更新 10月28日 · 轻松跑")
    }

    @Test func customWorkoutRejectsMissingSpec() {
        let bad = "{\"save_token\":\"s\",\"date\":\"2026-10-28\",\"name\":\"n\",\"summary\":\"s\",\"spec\":{}}"
        #expect(CoachCardRegistry.build(wire(type: "custom-workout", payload: bad), target: nil) == nil)
    }

    // MARK: - workout-op

    @Test func workoutOpMoveCard() throws {
        let view = try #require(CoachCardRegistry.build(wire(type: "workout-op", payload: moveOpPayload), target: nil))
        #expect(view.title == "训练课改期")
        #expect(view.subtitle == "10月28日 → 10月30日 · 轻松跑")
        #expect(view.buttonText == "确认改期")
        #expect(view.buttonAction == .confirmMove)
        #expect(!view.inlineBody)
    }

    @Test func workoutOpDeleteCardWatchHint() throws {
        let payload = "{\"op\":\"delete\",\"workout_id\":\"w-1\",\"date\":\"2026-10-28\",\"name\":\"轻松跑\",\"pushed\":true}"
        let view = try #require(CoachCardRegistry.build(wire(type: "workout-op", payload: payload), target: nil))
        #expect(view.buttonText == "确认删除")
        #expect(view.buttonAction == .confirmDelete)
        #expect(view.subtitle.contains("手表副本"))
    }

    @Test func workoutOpMoveRequiresNewDate() {
        let bad = "{\"op\":\"move\",\"workout_id\":\"w\",\"date\":\"2026-10-28\",\"name\":\"n\"}"
        #expect(CoachCardRegistry.build(wire(type: "workout-op", payload: bad), target: nil) == nil)
    }

    // MARK: - 未知类型降级

    @Test func unknownTypeDegradesToNil() {
        #expect(CoachCardRegistry.build(wire(type: "weekly-plan", payload: "{}"), target: nil) == nil)
    }

    // MARK: - 历史自愈

    @Test func leakedEnvelopeBareObject() throws {
        let envelope = racePayload // 裸 { 开头即比赛策略本体
        let recovered = try #require(CoachCardRegistry.parseLeakedRaceStrategyEnvelope(envelope))
        #expect(recovered.type == "race-strategy")
        let view = try #require(CoachCardRegistry.build(recovered, target: raceTarget))
        #expect(view.navigable)
    }

    @Test func leakedEnvelopeFencedAndDisposition() throws {
        let fenced = "```json\n\(racePayload)\n```"
        #expect(CoachCardRegistry.parseLeakedRaceStrategyEnvelope(fenced) != nil)
        let wrapped = "{\"disposition\":\"return_direct\",\"content\":\(racePayload)}"
        let recovered = try #require(CoachCardRegistry.parseLeakedRaceStrategyEnvelope(wrapped))
        let view = try #require(CoachCardRegistry.build(recovered, target: nil))
        #expect(view.title == "比赛策略已生成")
    }

    @Test func plainTextNotEnvelope() {
        #expect(CoachCardRegistry.parseLeakedRaceStrategyEnvelope("今天跑个轻松跑") == nil)
    }

    // MARK: - JSON 泄漏占位

    @Test func looksLikeJsonTextDetection() {
        #expect(CoachCardRegistry.looksLikeJsonText("{\"race_name\""))
        #expect(CoachCardRegistry.looksLikeJsonText("Returning structured response: {"))
        #expect(CoachCardRegistry.looksLikeJsonText("xx \"disposition\" yy"))
        #expect(!CoachCardRegistry.looksLikeJsonText("配速建议：5:00/km"))
    }

    // MARK: - 日期标签

    @Test func monthDayLabelFormats() {
        #expect(CoachCardRegistry.monthDayLabel("2026-10-08") == "10月8日")
        #expect(CoachCardRegistry.monthDayLabel("bad") == "bad")
    }
}
