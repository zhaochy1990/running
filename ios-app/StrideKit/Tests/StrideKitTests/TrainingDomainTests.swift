import Foundation
import Testing
@testable import StrideKit

// 训练域纯函数与 wire 解码测试（devops#768 PR-5，对齐小程序 plan.ts /
// workout-detail.ts / training-plan.ts / trainingStatus.ts 口径）。

// MARK: - 构造工具

private func step(_ kind: StepKind, durationKind: String, durationValue: Double?,
                  target: WorkoutTarget? = nil, rest: WorkoutStepRest? = nil,
                  hrCap: Double? = nil) -> WorkoutStep {
    WorkoutStep(stepKind: kind,
                duration: WorkoutStepDuration(kind: durationKind, value: durationValue),
                target: target, note: nil, hrCapBpm: hrCap, rest: rest)
}

private func paceTarget(_ low: Double, _ high: Double) -> WorkoutTarget {
    WorkoutTarget(kind: .paceSKm, low: low, high: high)
}

private func blocks(_ items: [(steps: [WorkoutStep], repeatCount: Int)]) -> [WorkoutBlock] {
    items.map { WorkoutBlock(steps: $0.steps, repeatCount: $0.repeatCount) }
}

// MARK: - 上海周运算

@Suite struct TrainingWeekTests {

    @Test func weekStartIsMonday() {
        // 2026-10-28 是周三；所在周周一 = 10-26。
        #expect(Shanghai.weekStart(ymd: "2026-10-28") == "2026-10-26")
        #expect(Shanghai.weekStart(ymd: "2026-10-26") == "2026-10-26")
        // 周日归上周：11-01（周日）所在周周一 = 10-26。
        #expect(Shanghai.weekStart(ymd: "2026-11-01") == "2026-10-26")
    }

    @Test func weekFolderNameShape() {
        #expect(Shanghai.weekFolderName(weekStartYmd: "2026-10-26") == "2026-10-26_11-01")
    }

    @Test func buildWeekDaysSpansMondayToSunday() {
        let days = Shanghai.buildWeekDays(anchorYmd: "2026-10-28", todayYmd: "2026-10-28")
        #expect(days.count == 7)
        #expect(days.first?.date == "2026-10-26")
        #expect(days.last?.date == "2026-11-01")
        #expect(days.first?.label == "Mon")
        #expect(days.last?.label == "Sun")
        #expect(days.first?.isToday == false)
        #expect(days[2].isToday == true)
        #expect(days[2].dayNumber == 28)
    }

    @Test func weekSubtitleShape() {
        #expect(Shanghai.weekSubtitle(weekStartYmd: "2026-07-06") == "(2026年7月)")
    }
}

// MARK: - 推送日期选项

@Suite struct PushDateOptionsTests {

    @Test func eightForwardDaysWithChineseLabels() {
        let options = buildPushDateOptions(plannedDate: "2026-10-30", todayYmd: "2026-10-26")
        #expect(options.count == 8)
        #expect(options[0].label == "今天")
        #expect(options[1].label == "明天")
        #expect(options[2].label == "后天")
        #expect(options[0].value == "2026-10-26")
        #expect(options[7].value == "2026-11-02")
        // 计划日在窗口内 → 默认选中计划日。
        #expect(options.first { $0.isSelected }?.value == "2026-10-30")
        // 计划日标尾巴。
        #expect(options.first { $0.value == "2026-10-30" }?.label.contains("（计划日）") == true)
    }

    @Test func overduePlanDateFallsBackToToday() {
        let options = buildPushDateOptions(plannedDate: "2026-10-20", todayYmd: "2026-10-26")
        #expect(options.first { $0.isSelected }?.value == "2026-10-26")
    }
}

// MARK: - 强度柱状图与估时

@Suite struct IntensityBarsTests {

    @Test func estimateWorkoutSecondsSumsRepeatsAndRests() {
        // 2×（1km@配速中值 5:15 + 90s 休息）= 2×(315 + 90) = 810s。
        let spec = blocks([
            ([step(.work, durationKind: "distance_m", durationValue: 1000, target: paceTarget(300, 330)),
              step(.rest, durationKind: "time_s", durationValue: 90)], 2),
        ])
        #expect(estimateWorkoutSeconds(blocks: spec) == 810)
    }

    @Test func openStepDefaultsToFiveMinutes() {
        let spec = blocks([([step(.work, durationKind: "open", durationValue: nil, target: WorkoutTarget(kind: .open, low: nil, high: nil))], 1)])
        #expect(estimateWorkoutSeconds(blocks: spec) == 300)
    }

    @Test func barsCarryRestSlotsAndDimFirst() {
        let spec = blocks([
            ([step(.warmup, durationKind: "time_s", durationValue: 600),
              step(.work, durationKind: "distance_m", durationValue: 800, target: paceTarget(240, 260),
                   rest: WorkoutStepRest(kind: "time_s", value: 90))], 1),
        ])
        let bars = deriveIntensityBars(blocks: spec)
        // 热身 + work + 步后休息 = 3 柱；休息零高度。
        #expect(bars.count == 3)
        #expect(bars[0].dim == true)
        #expect(bars[0].pct == 35)     // 热身固定 35
        #expect(bars[1].pct > 0)
        #expect(bars[2].pct == 0)      // 休息占位不画柱
        // 宽度 = 估时（600 / 800m@4:50 / 90）。
        #expect(bars[0].weight == 600)
        #expect(abs(bars[2].weight - 90) < 0.001)
    }

    @Test func moreThanSixteenBarsSampleEvenly() {
        let steps = (0..<20).map { i in
            step(.work, durationKind: "time_s", durationValue: Double(60 + i), target: paceTarget(300, 330))
        }
        let bars = deriveIntensityBars(blocks: blocks([(steps, 1)]))
        #expect(bars.count == 16)
    }

    @Test func stepIntensityPaceAnchors() {
        // 240s/km（4:00）= 90 分；420s/km = 55 分；区间取中值。
        #expect(stepIntensity(step: step(.work, durationKind: "time_s", durationValue: 60, target: paceTarget(230, 250))) == 90)
        #expect(stepIntensity(step: step(.work, durationKind: "time_s", durationValue: 60, target: paceTarget(410, 430))) == 55)
        // 无目标 → 75。
        #expect(stepIntensity(step: step(.work, durationKind: "time_s", durationValue: 60)) == 75)
    }
}

// MARK: - 课表类型 chip

@Suite struct WorkoutTypeChipTests {

    private func row(kind: SessionKind, spec: SessionSpec?, distanceM: Double?) -> PlanSessionRow {
        PlanSessionRow(workoutId: "w", date: "2026-10-28", source: .weekly, kind: kind,
                       name: "课", summary: nil, spec: spec, totalDistanceM: distanceM,
                       totalDurationS: nil, estimatedDose: nil, sessionIndex: 0,
                       planId: nil, provider: nil, providerEntityId: nil, pushed: false, saveToken: nil)
    }

    @Test func strengthChip() {
        #expect(deriveWorkoutType(kind: .strength, spec: nil, totalDistanceM: nil) == "力量")
    }

    @Test func intervalChipOnDistanceRepeat() {
        let spec = SessionSpec.run(RunWorkoutSpec(schema: nil, name: "n", date: "2026-10-28", note: nil,
                                                  blocks: blocks([([step(.work, durationKind: "distance_m", durationValue: 800, target: paceTarget(240, 260))], 6)])))
        #expect(deriveWorkoutType(kind: .run, spec: spec, totalDistanceM: 8000) == "间歇")
    }

    @Test func tempoChipOnLongTimeRepeat() {
        let spec = SessionSpec.run(RunWorkoutSpec(schema: nil, name: "n", date: "2026-10-28", note: nil,
                                                  blocks: blocks([([step(.work, durationKind: "time_s", durationValue: 300, target: paceTarget(280, 300))], 3)])))
        #expect(deriveWorkoutType(kind: .run, spec: spec, totalDistanceM: 6000) == "节奏")
    }

    @Test func longRunChipOnTotalKm() {
        let spec = SessionSpec.run(RunWorkoutSpec(schema: nil, name: "n", date: "2026-10-28", note: nil,
                                                  blocks: blocks([([step(.work, durationKind: "time_s", durationValue: 3600, target: paceTarget(360, 400))], 1)])))
        #expect(deriveWorkoutType(kind: .run, spec: spec, totalDistanceM: 16_000) == "长距离")
    }

    @Test func progressiveAndAerobicChips() {
        // 两段主课逐段提速 → 渐进。
        let progressive = SessionSpec.run(RunWorkoutSpec(schema: nil, name: "n", date: "2026-10-28", note: nil,
            blocks: blocks([([
                step(.work, durationKind: "time_s", durationValue: 1200, target: paceTarget(300, 320)),
                step(.work, durationKind: "time_s", durationValue: 1200, target: paceTarget(280, 300)),
            ], 1)])))
        #expect(deriveWorkoutType(kind: .run, spec: progressive, totalDistanceM: 10_000) == "渐进")
        // 单主课有氧。
        let aerobic = SessionSpec.run(RunWorkoutSpec(schema: nil, name: "n", date: "2026-10-28", note: nil,
            blocks: blocks([([step(.work, durationKind: "time_s", durationValue: 2400, target: paceTarget(340, 380))], 1)])))
        #expect(deriveWorkoutType(kind: .run, spec: aerobic, totalDistanceM: 8_000) == "有氧")
    }
}

// MARK: - 今日卡 / 营养卡构建

@Suite struct TodayCardBuildTests {

    private func content(sessions: [PlannedSession]? = nil, nutrition: [PlannedNutrition]? = nil,
                         coachNotes: String? = nil) -> WeeklyPlanContent {
        WeeklyPlanContent(schema: nil, sessions: sessions, nutrition: nutrition,
                          notesMd: nil, coachNotes: coachNotes)
    }

    private let runSpec = SessionSpec.run(RunWorkoutSpec(
        schema: nil, name: "n", date: "2026-10-28", note: nil,
        blocks: blocks([([step(.work, durationKind: "time_s", durationValue: 1800,
                              target: paceTarget(340, 380))], 1)])
    ))

    private func row(_ kind: SessionKind, source: WorkoutSource, name: String = "课",
                     spec: SessionSpec? = nil, idx: Int? = nil, pushed: Bool = false) -> PlanSessionRow {
        PlanSessionRow(workoutId: "w-\(kind)-\(source)", date: "2026-10-28", source: source,
                       kind: kind, name: name, summary: "概要", spec: spec,
                       totalDistanceM: 8000, totalDurationS: 3600, estimatedDose: 55.5,
                       sessionIndex: idx, planId: nil, provider: nil, providerEntityId: nil,
                       pushed: pushed, saveToken: nil)
    }

    @Test func meaningfulSessionWinsOverRest() {
        let view = TrainingHomeModel.buildDayView(
            plan: nil,
            rows: [
                row(.rest, source: .weekly, name: "休息日"),
                row(.run, source: .custom, name: "自建间歇"),
            ],
            dateYmd: "2026-10-28", todayYmd: "2026-10-28"
        )
        #expect(view.workout?.title == "自建间歇")
        #expect(view.workout?.deletable == true)
    }

    @Test func fallsBackToRestRowWhenOnlyRest() {
        let view = TrainingHomeModel.buildDayView(
            plan: nil, rows: [row(.rest, source: .weekly, name: "休息")],
            dateYmd: "2026-10-28", todayYmd: "2026-10-28"
        )
        #expect(view.workout?.title == "休息")
        #expect(view.workout?.isRunning == false)
    }

    @Test func weeklyCoachNoteFallsBackToPlanLevel() {
        let plan = WeeklyPlanDetail(planId: "p", weekName: "2026-10-26_11-01",
                                    dateFrom: "2026-10-26", dateTo: "2026-11-01",
                                    status: "active", contentVersion: 2, revision: 1,
                                    content: content(coachNotes: "本周注意补水"))
        let card = TrainingHomeModel.buildWorkoutCard(row: row(.run, source: .weekly, spec: runSpec, idx: 1), content: plan.content)
        #expect(card.coachNote == "本周注意补水")
        #expect(card.hasSpec == true)
        #expect(card.hasStructure == true)
    }

    @Test func customDurationFallsBackToEstimate() {
        // custom 课缺 total_duration_s → 配速中值估时。
        let spec = SessionSpec.run(RunWorkoutSpec(schema: nil, name: "n", date: "2026-10-28", note: nil,
            blocks: blocks([([step(.work, durationKind: "distance_m", durationValue: 1000, target: paceTarget(300, 360))], 1)])))
        let customRow = PlanSessionRow(workoutId: "cw", date: "2026-10-28", source: .custom,
                                       kind: .run, name: "自建", summary: nil, spec: spec,
                                       totalDistanceM: 1000, totalDurationS: nil, estimatedDose: nil,
                                       sessionIndex: nil, planId: nil, provider: nil, providerEntityId: nil,
                                       pushed: false, saveToken: "tok")
        let card = TrainingHomeModel.buildWorkoutCard(row: customRow, content: nil)
        // 1km @ 330s/km 中值 = 05:30。
        #expect(card.stats[1].value == "00:05:30")
        #expect(card.sourceLabel == "")
        #expect(card.deletable == true)
    }

    @Test func watchSourceLabeledButNotPushable() {
        let card = TrainingHomeModel.buildWorkoutCard(row: row(.run, source: .watch, spec: runSpec), content: nil)
        #expect(card.sourceLabel == "手表")
        #expect(card.hasSpec == false)     // watch 源不回推
        #expect(card.hasStructure == true) // 课表本身可看
    }

    @Test func nutritionHiddenWithoutAnyContent() {
        let empty = PlannedNutrition(date: "2026-10-28", kcalTarget: nil, carbsG: nil,
                                     proteinG: nil, fatG: nil, waterMl: nil, meals: [], notesMd: nil)
        #expect(TrainingHomeModel.buildNutritionCard(empty) == nil)
        let notesOnly = PlannedNutrition(date: "2026-10-28", kcalTarget: nil, carbsG: nil,
                                         proteinG: nil, fatG: nil, waterMl: nil, meals: [], notesMd: "训练日多碳水")
        #expect(TrainingHomeModel.buildNutritionCard(notesOnly)?.note == "训练日多碳水")
    }
}

// MARK: - 分段组

@Suite struct SegmentGroupTests {

    @Test func runGroupsCarryRepeatBadgeAndRestRows() {
        let spec = RunWorkoutSpec(schema: nil, name: "n", date: "2026-10-28", note: "带好水",
            blocks: blocks([
                ([step(.warmup, durationKind: "time_s", durationValue: 600),
                  step(.work, durationKind: "distance_m", durationValue: 800,
                       target: paceTarget(240, 250), rest: WorkoutStepRest(kind: "time_s", value: 90),
                       hrCap: 165)], 4),
            ]))
        let groups = buildRunGroups(spec: spec)
        #expect(groups.count == 1)
        #expect(groups[0].repeatCount == 4)
        // 热身 + work + 步后休息 = 3 行。
        #expect(groups[0].rows.count == 3)
        #expect(groups[0].rows[1].main == "800 m · 4:00–4:10/km")
        #expect(groups[0].rows[1].hrCapText == "心率≤165")
        #expect(groups[0].rows[2].quiet == true)
        #expect(groups[0].rows[2].main == "90 秒")
    }

    @Test func exerciseRows() {
        let spec = StrengthWorkoutSpec(schema: nil, name: "n", date: "2026-10-28", note: nil,
            exercises: [
                StrengthExercise(canonicalId: "squat", displayName: "深蹲", sets: 3,
                                 targetKind: "reps", targetValue: 12, restSeconds: 60, note: "慢下快上"),
                StrengthExercise(canonicalId: "plank", displayName: "平板支撑", sets: 3,
                                 targetKind: "time_s", targetValue: 45, restSeconds: 0, note: nil),
            ])
        let rows = buildExerciseRows(spec: spec)
        #expect(rows.count == 2)
        #expect(rows[0].target == "3 组 × 12 次")
        #expect(rows[0].rest == "组间休息 60 秒")
        #expect(rows[1].target == "3 组 × 0:45")
        #expect(rows[1].rest == "")
    }
}

// MARK: - master-plan 视图模型

@Suite struct TrainingPlanBuilderTests {

    private func phase(_ id: String, name: String, type: String? = nil,
                       start: String = "2026-10-05", end: String = "2026-10-25",
                       low: Double = 30, high: Double = 40) -> MasterPlanPhase {
        MasterPlanPhase(id: id, name: name, startDate: start, endDate: end, focus: "有氧基础",
                        weeklyDistanceKmLow: low, weeklyDistanceKmHigh: high,
                        keySessionTypes: ["long_run"], phaseType: type, rhythm: nil,
                        keyWorkouts: nil, monitoringTriggers: nil, coachNote: nil,
                        isCompleted: false, summary: nil)
    }

    private func week(_ idx: Int, _ phaseId: String, actualKm: Double? = nil) -> MasterPlanWeek {
        MasterPlanWeek(weekIndex: idx, weekStart: "2026-10-\(String(format: "%02d", 5 + (idx - 1) * 7))",
                       weekEnd: nil, phaseId: phaseId, targetWeeklyKmLow: 30, targetWeeklyKmHigh: 40,
                       targetTrainingDoseLow: nil, targetTrainingDoseHigh: nil,
                       keySessions: [], isRecoveryWeek: false, isTaperWeek: false,
                       plannedDistanceKm: 35, isCompleted: false, actualDistanceKm: actualKm,
                       actualAvgPaceFmt: nil, actualAvgHr: nil, actualTrainingDose: nil)
    }

    private func plan(phases: [MasterPlanPhase], weeks: [MasterPlanWeek],
                      currentWeek: Int? = nil, start: String = "2026-10-05",
                      endDate: String = "2026-12-27", totalWeeks: Int = 12) -> SeasonPlanContent {
        SeasonPlanContent(
            goal: MasterPlanGoal(goalId: "g", raceName: "上海马拉松", distance: "FM",
                                 raceDate: "2026-12-27", targetTime: "3:59:59"),
            startDate: start, endDate: endDate, totalWeeks: totalWeeks,
            phases: phases, milestones: [], weeks: weeks,
            trainingPrinciples: ["循序渐进", "一致性优先"],
            currentPhaseId: phases.first?.id, currentWeekNumber: currentWeek,
            nextMilestone: nil
        )
    }

    @Test func targetPaceDerivation() {
        #expect(TrainingPlanBuilder.targetPace(distance: "FM", targetTime: "3:59:59") == "5:41/km")
        #expect(TrainingPlanBuilder.targetPace(distance: "HM", targetTime: "1:59:59") == "5:41/km")
        #expect(TrainingPlanBuilder.targetPace(distance: "5K", targetTime: "") == "")
        #expect(TrainingPlanBuilder.targetPace(distance: nil, targetTime: "3:59:59") == "")
    }

    @Test func weekNowPrefersBackendValue() {
        let p = plan(phases: [phase("p1", name: "基础期")], weeks: [week(1, "p1"), week(2, "p1"), week(3, "p1")],
                     currentWeek: 2)
        #expect(TrainingPlanBuilder.resolveWeekNow(p, todayYmd: "2026-12-01") == 2)
    }

    @Test func weekNowDerivedFromStartDate() {
        let p = plan(phases: [phase("p1", name: "基础期")], weeks: [week(1, "p1"), week(2, "p1")],
                     currentWeek: nil, start: "2026-10-05")
        // 10-05 周一起，10-26（周一）= 第 4 周。
        #expect(TrainingPlanBuilder.resolveWeekNow(p, todayYmd: "2026-10-26") == 4)
    }

    @Test func phaseSpansDerivedForPhasesWithoutWeeks() {
        let p = plan(phases: [phase("p1", name: "基础期", start: "2026-10-05", end: "2026-10-18"),
                              phase("p2", name: "专项期", type: "build", start: "2026-10-19", end: "2026-11-01")],
                     weeks: [week(1, "p1"), week(2, "p1")])
        let spans = TrainingPlanBuilder.phaseWeekSpans(p)
        #expect(spans["p1"]?.from == 1)
        #expect(spans["p1"]?.to == 2)
        // p2 无周行 → 按日期推（10-19 在第 3 周）。
        #expect(spans["p2"]?.from == 3)
    }

    @Test func buildViewModelsShape() {
        let p = plan(
            phases: [phase("p1", name: "基础期", type: "base"),
                     phase("p2", name: "专项期", type: "build", start: "2026-10-26", end: "2026-11-15")],
            weeks: [week(1, "p1", actualKm: 38.2), week(2, "p1"), week(3, "p2")],
            currentWeek: 3
        )
        let vm = TrainingPlanBuilder.buildViewModels(plan: p, todayYmd: "2026-10-28")
        #expect(vm.raceName == "上海马拉松")
        #expect(vm.raceDistanceLabel == "全马")
        #expect(vm.raceDateLabel == "2026.12.27")
        #expect(vm.targetPace == "5:41/km")
        // 10-28 → 12-27 = 60 天。
        #expect(vm.countdownDays == 60)
        #expect(vm.weekNow == 3)
        #expect(vm.bars.count == 12)
        #expect(vm.bars[2].label == "当前")          // 当前周柱
        #expect(vm.bars[2].barColor == 0xFF6363)     // 粉红高亮
        #expect(vm.bars[0].fill > vm.bars[1].fill)   // 有实际的周 vs 只有计划的周
        // 时间轴：2 阶段块 + 3 周行；本周关键课随周行展开（空表）。
        #expect(vm.timeline.count == 5)
        #expect(vm.currentSessions.isEmpty)
        #expect(vm.principles.count == 2)
        #expect(vm.principles[0].0 == "01")
    }

    @Test func chartDetailActualVsPlan() {
        let p = plan(phases: [phase("p1", name: "基础期")], weeks: [week(1, "p1", actualKm: 38.2)], currentWeek: 1)
        let detail = TrainingPlanBuilder.buildChartDetail(
            plan: p, spans: TrainingPlanBuilder.phaseWeekSpans(p),
            weekNow: 1, weekIndex: 1, metric: false
        )
        #expect(detail.contains("W01"))
        #expect(detail.contains("计划 30-40 km"))
        #expect(detail.contains("实际 38.2 km"))
    }

    @Test func doseFallbackHeuristic() {
        let p = plan(phases: [phase("p1", name: "基础期", low: 30, high: 40)], weeks: [week(1, "p1")])
        let range = TrainingPlanBuilder.plannedDoseRange(week: p.weeks[0], phase: p.phases[0])
        // 周行无显式 dose → 30×6.6 / 40×7.6 兜底。
        #expect(range.low == 198)
        #expect(range.high == 304)
    }
}

// MARK: - 训练状态纯函数

@Suite struct TrainingStatusHelpersTests {

    @Test func formZoneClassification() {
        #expect(classifyForm(form: 15, chronic: 100) == .raceReady)   // +15%
        #expect(classifyForm(form: -5, chronic: 100) == .transition)
        #expect(classifyForm(form: -20, chronic: 100) == .productive)
        #expect(classifyForm(form: -30, chronic: 100) == .overload)
        #expect(classifyForm(form: 30, chronic: 100) == .overTaper)
        #expect(classifyForm(form: nil, chronic: 100) == nil)
        #expect(classifyForm(form: 10, chronic: 0) == nil)
    }

    @Test func loadStateLabelBuckets() {
        #expect(loadStateLabel(ratio: 0.7) == "恢复期")
        #expect(loadStateLabel(ratio: 0.9) == "维持期")
        #expect(loadStateLabel(ratio: 1.1) == "提升期")
        #expect(loadStateLabel(ratio: 1.5) == "过度负荷")
        #expect(loadStateLabel(ratio: nil) == "—")
    }

    @Test func heatmapBuckets() {
        #expect(heatmapBucket(dose: nil) == 0)
        #expect(heatmapBucket(dose: 0) == 0)
        #expect(heatmapBucket(dose: 25) == 1)
        #expect(heatmapBucket(dose: 60) == 2)
        #expect(heatmapBucket(dose: 100) == 3)
        #expect(heatmapBucket(dose: 300) == 4)
    }

    private func record(_ date: String, dose: Double?, coverage: String = "complete") -> StrideTrainingLoadRecord {
        StrideTrainingLoadRecord(date: date, trainingDose: dose, acuteLoad: nil, chronicLoad: nil,
                                 form: nil, loadRatio: nil, coverageStatus: coverage,
                                 readinessGate: nil, readinessReasons: nil)
    }

    @Test func heatCellsStates() {
        // 2026-10-28（周三）；本周周一 10-26，16 周首列 07-13。
        let series = [
            record("2026-10-26", dose: 50),       // active
            record("2026-10-27", dose: 0),        // rest（有记录零剂量）
            record("2026-10-28", dose: nil, coverage: "unknown"), // unknown
            // 10-29（未来）无行 → future；07-13 无行 → absent。
        ]
        let cells = buildHeatCells(series: series, weeks: 16, todayYmd: "2026-10-28")
        #expect(cells.count == 16 * 7)
        #expect(cells.first?.date == "2026-07-13")
        #expect(cells.first?.state == .absent)
        let active = cells.first { $0.date == "2026-10-26" }
        #expect(active?.state == .active)
        #expect(active?.dose == 50)
        #expect(active?.isToday == false)
        let rest = cells.first { $0.date == "2026-10-27" }
        #expect(rest?.state == .rest)
        let unknown = cells.first { $0.date == "2026-10-28" }
        #expect(unknown?.state == .unknown)
        #expect(unknown?.isToday == true)
        let future = cells.first { $0.date == "2026-10-29" }
        #expect(future?.state == .future)
    }

    @Test func heatWeeksMonthLabelsOnFirstCrossing() {
        let cells = buildHeatCells(series: [], weeks: 16, todayYmd: "2026-10-28")
        let weeks = buildHeatWeeks(cells: cells)
        #expect(weeks.count == 16)
        // 首列 07-13 标「7月」，跨 8 月首列标「8月」，依次到 10 月。
        #expect(weeks[0].month == "7月")
        #expect(weeks.firstIndex { $0.month == "8月" } != nil)
        // 10 月首列 = 10-05 那周挂「10月」，最后一列（10-26）不重复挂。
        let october = weeks.firstIndex { $0.month == "10月" }
        #expect(october != nil)
        #expect(weeks[october!].cells.first?.date == "2026-10-05")
        #expect(weeks.last?.month == "")
        // 中间周不重复挂月标签。
        #expect(weeks[1].month == "")
    }

    @Test func weeklyDoseAggregationWithUnknownWeek() {
        let series = [
            record("2026-10-26", dose: 40),      // 本周
            record("2026-10-27", dose: 20),
            record("2026-10-19", dose: nil, coverage: "unknown"), // 上周数据未确认
            record("2026-10-12", dose: 60),      // 上上周
        ]
        let buckets = aggregateWeeklyDose(records: series, todayYmd: "2026-10-28")
        #expect(buckets.count == 8)
        #expect(buckets.last?.weekLabel == "10/26")
        #expect(buckets.last?.totalDose == 60)
        #expect(buckets.last?.activeDays == 2)
        // unknown 周整体打洞。
        let unknownBucket = buckets.first { $0.weekStart == "2026-10-19" }
        #expect(unknownBucket?.totalDose == nil)
        let complete = buckets.first { $0.weekStart == "2026-10-12" }
        #expect(complete?.totalDose == 60)
    }

    @Test func durationHumanAndSportNames() {
        #expect(formatDurationHuman(6180) == "1h43min")
        #expect(formatDurationHuman(3600) == "1h")
        #expect(formatDurationHuman(2580) == "43min")
        #expect(formatDurationHuman(nil) == "—")
        #expect(chineseSportName("Trail Run") == "跑步")
        #expect(chineseSportName("Strength Training") == "力量训练")
        #expect(chineseSportName(nil) == "训练")
        #expect(isDistanceSport("Indoor Run") == true)
        #expect(isDistanceSport("Strength Training") == false)
    }

    @Test func normalizeYmdHandlesCompactForm() {
        #expect(normalizeYmd("20261028") == "2026-10-28")
        #expect(normalizeYmd("2026-10-28") == "2026-10-28")
    }
}

// MARK: - wire 解码

@Suite struct TrainingWireDecodingTests {

    @Test func planSessionsRowDecodesThreeSources() throws {
        let json = """
        {"sessions":[
          {"workout_id":"u1","date":"2026-10-28","source":"weekly","kind":"run",
           "name":"马拉松课","summary":null,
           "spec":{"name":"马拉松课","date":"2026-10-28","note":null,
                   "blocks":[{"steps":[{"step_kind":"work","duration":{"kind":"distance_m","value":800},
                     "target":{"kind":"pace_s_km","low":240,"high":260},"note":null,
                     "rest":{"kind":"time_s","value":90}}],"repeat":4}]},
           "total_distance_m":8000,"total_duration_s":3600,"estimated_dose":55.5,
           "session_index":1,"plan_id":"p","provider":null,"provider_entity_id":null,
           "pushed":true,"save_token":null},
          {"workout_id":"u2","date":"2026-10-28","source":"custom","kind":"strength",
           "name":"力量","summary":"s",
           "spec":{"name":"力量","date":"2026-10-28","note":null,
                   "exercises":[{"canonical_id":"squat","display_name":"深蹲","sets":3,
                     "target_kind":"reps","target_value":12,"rest_seconds":60,"note":null}]},
           "total_distance_m":null,"total_duration_s":null,"estimated_dose":null,
           "session_index":null,"plan_id":null,"provider":null,"provider_entity_id":null,
           "pushed":false,"save_token":"tok"},
          {"workout_id":"u3","date":"2026-10-28","source":"watch","kind":"run",
           "name":"手表课","summary":null,"spec":null,
           "total_distance_m":5000,"total_duration_s":1800,"estimated_dose":null,
           "session_index":null,"plan_id":null,"provider":"coros","provider_entity_id":"x",
           "pushed":false,"save_token":null}
        ]}
        """
        let res = try JSONDecoder().decode(PlanSessionsResponse.self, from: Data(json.utf8))
        #expect(res.sessions.count == 3)
        let weekly = res.sessions[0]
        #expect(weekly.source == .weekly)
        #expect(weekly.spec?.runSpec?.blocks.count == 1)
        #expect(weekly.pushed == true)
        let custom = res.sessions[1]
        #expect(custom.spec?.strengthSpec?.exercises.first?.sets == 3)
        #expect(custom.saveToken == "tok")
        let watch = res.sessions[2]
        #expect(watch.source == .watch)
        #expect(watch.spec == nil)
    }

    @Test func malformedSpecDegradesToNilWithoutKillingRow() throws {
        // spec 对象存在但形状残缺（空 blocks/exercises）→ 该行 spec 落 nil，
        // 行本身与其余行照常解码（评审修复回归位）。
        let json = """
        {"sessions":[
          {"workout_id":"bad","date":"2026-10-28","source":"custom","kind":"run",
           "name":"残缺课","summary":null,"spec":{"name":"x","date":"2026-10-28","note":null,"blocks":[]},
           "total_distance_m":null,"total_duration_s":null,"estimated_dose":null,
           "session_index":null,"plan_id":null,"provider":null,"provider_entity_id":null,
           "pushed":false,"save_token":null},
          {"workout_id":"ok","date":"2026-10-28","source":"watch","kind":"run",
           "name":"正常课","summary":null,"spec":null,
           "total_distance_m":5000,"total_duration_s":1800,"estimated_dose":null,
           "session_index":null,"plan_id":null,"provider":null,"provider_entity_id":null,
           "pushed":false,"save_token":null}
        ]}
        """
        let res = try JSONDecoder().decode(PlanSessionsResponse.self, from: Data(json.utf8))
        #expect(res.sessions.count == 2)
        #expect(res.sessions[0].spec == nil)
        #expect(res.sessions[0].name == "残缺课")
        #expect(res.sessions[1].workoutId == "ok")
    }

    @Test func weeklyPlanContentV2ObjectAndV1String() throws {
        let v2 = """
        {"plan_id":"p","week_name":"2026-10-26_11-01","date_from":"2026-10-26",
         "date_to":"2026-11-01","status":"active","content_version":2,"revision":3,
         "content":{"sessions":[{"date":"2026-10-28","session_index":1,"kind":"run",
           "summary":"课","spec":null,"notes_md":"先热身","total_distance_m":8000,
           "total_duration_s":null,"estimated_dose":null}],
           "nutrition":[{"date":"2026-10-28","kcal_target":2200,"carbs_g":300,
             "protein_g":120,"fat_g":60,"water_ml":2500,
             "meals":[{"name":"早餐","time_hint":"07:00","kcal":600,"carbs_g":80,
               "protein_g":20,"fat_g":15,"items_md":"燕麦 · 鸡蛋"}],
             "notes_md":null}],
           "notes_md":"计划备注","coach_notes":"教练备注"}}
        """
        let detail2 = try JSONDecoder().decode(WeeklyPlanDetail.self, from: Data(v2.utf8))
        #expect(detail2.content?.sessions?.count == 1)
        #expect(detail2.content?.nutrition?.count == 1)
        #expect(detail2.content?.coachNotes == "教练备注")

        let v1 = """
        {"plan_id":"p1","week_name":"2026-10-26_11-01","date_from":"2026-10-26",
         "date_to":"2026-11-01","status":"active","content_version":1,"revision":0,
         "content":"# 旧 markdown"}
        """
        let detail1 = try JSONDecoder().decode(WeeklyPlanDetail.self, from: Data(v1.utf8))
        #expect(detail1.contentVersion == 1)
        #expect(detail1.content == nil) // markdown 字符串不取（对齐 typeof object 判定）
    }

    @Test func masterPlanEnvelopeV1AndV2() throws {
        let v2 = """
        {"status":"active","plan_id":"mp1","created_at":"t","updated_at":"t",
         "content_version":2,"revision":7,
         "plan":{"goal":{"goal_id":"g","race_name":"上马","distance":"FM",
             "race_date":"2026-12-27","target_time":"3:59:59"},
           "start_date":"2026-10-05","end_date":"2026-12-27","total_weeks":12,
           "phases":[{"id":"p1","name":"基础期","start_date":"2026-10-05",
             "end_date":"2026-10-25","focus":"有氧","weekly_distance_km_low":30,
             "weekly_distance_km_high":40,"key_session_types":["long_run"],
             "milestone_ids":[]}],
           "milestones":[{"id":"m1","type":"race","date":"2026-12-27","phase_id":"p1",
             "target":"4:00","completed_actual":null}],
           "weeks":[{"week_index":1,"week_start":"2026-10-05","phase_id":"p1",
             "target_weekly_km_low":30,"target_weekly_km_high":40,"key_sessions":[]}],
           "training_principles":["循序渐进"],
           "generated_by":"coach","current_phase_id":"p1","current_week_number":3,
           "next_milestone":null}}
        """
        let env2 = try JSONDecoder().decode(CurrentSeasonPlan.self, from: Data(v2.utf8))
        #expect(env2.contentVersion == 2)
        #expect(env2.revision == 7)
        #expect(env2.plan?.phases.count == 1)
        #expect(env2.plan?.currentWeekNumber == 3)

        let v1 = """
        {"status":"active","plan_id":"mp0","created_at":"t","updated_at":"t",
         "content_version":1,"revision":null,"plan":"# markdown 计划"}
        """
        let env1 = try JSONDecoder().decode(CurrentSeasonPlan.self, from: Data(v1.utf8))
        #expect(env1.contentVersion == 1)
        #expect(env1.plan == nil)
    }

    @Test func healthAndLoadResponses() throws {
        let health = """
        {"health":[{"date":"20261028","ati":null,"cti":null,"rhr":52},
                    {"date":"2026-10-27","rhr":54}],
         "hrv":{"avg_sleep_hrv":58,"hrv_normal_low":45,"hrv_normal_high":70,
           "recovery_pct":80,"date":"2026-10-28"},
         "rhr_baseline":55}
        """
        let h = try JSONDecoder().decode(HealthResponse.self, from: Data(health.utf8))
        #expect(h.health.count == 2)
        #expect(h.hrv.hrvNormalLow == 45)
        #expect(h.rhrBaseline == 55)

        let load = """
        {"current":{"date":"2026-10-28","algorithm_version":3,"training_dose":88.2,
           "acute_load":52.1,"chronic_load":48.5,"form":-3.6,"load_ratio":1.07,
           "coverage_status":"complete","readiness_gate":"green",
           "readiness_reasons":["负荷平稳"]},
         "series":[{"date":"2026-10-27","algorithm_version":3,"training_dose":40,
           "acute_load":50,"chronic_load":48,"form":-2,"load_ratio":1.04,
           "coverage_status":"complete","readiness_gate":null,"readiness_reasons":[]}]}
        """
        let l = try JSONDecoder().decode(StrideTrainingLoadResponse.self, from: Data(load.utf8))
        #expect(l.current?.readinessGate == "green")
        #expect(l.series.count == 1)

        let zones = """
        {"threshold":{"speed_mps":3.2,"pace_per_km_sec":312,"hr_bpm":168,
           "speed_confidence":"high","hr_confidence":"medium","as_of_date":"2026-10-20",
           "calibration_id":9},
         "pace_zones":[{"name":"Z1","label":"轻松","upper_pace":"6:30","lower_pace":"5:40"}],
         "hr_zones":[{"name":"Z2","label":"有氧","lower_bpm":120,"upper_bpm":150}]}
        """
        let z = try JSONDecoder().decode(StrideZonesResponse.self, from: Data(zones.utf8))
        #expect(z.threshold?.pacePerKmSec == 312)
        #expect(z.paceZones.first?.label == "轻松")
        #expect(z.hrZones.first?.upperBpm == 150)
    }
}

// MARK: - 训练 tab 行构建

@Suite struct TodayActivityRowTests {

    @Test func dosePrefersStrideValue() {
        let a = Activity(labelId: "l1", name: nil, sportName: "Trail Run", sportType: 1,
                         date: "2026-10-28", distanceM: 10_000, distanceKm: 10, durationS: 3600,
                         trainingLoad: 50, strideTrainingDose: 66.6)
        let row = TrainingHomeModel.activityRow(a)
        #expect(row.name == "Trail Run")       // name 缺失回退 sport_name
        #expect(row.load == "66.6")            // STRIDE dose 优先
        #expect(row.distanceKm == "10.00")
        #expect(row.routeThumb == nil)         // 今日活动行同款 route_thumb 透传（devops#828）
    }
}
