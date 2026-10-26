import Foundation
import Testing
@testable import StrideKit

/// onboarding 选项与进度展示（OPTIONS 展示 / VALUES 提交分离、六步中文映射、
/// 资料步六字段校验）。
@Suite struct OnboardingStepsTests {

    private func run(status: String, currentStep: Int, steps: [PipelineStep]) -> PipelineRun {
        PipelineRun(runId: "r", pipelineName: "onboarding", status: status, currentStep: currentStep, steps: steps, errorMessage: nil)
    }

    @Test func progressMapsStepNamesToChinese() {
        let steps = [
            PipelineStep(name: "sync", status: "done"),
            PipelineStep(name: "race_detection", status: "running"),
            PipelineStep(name: "calibration", status: "pending"),
            PipelineStep(name: "compute", status: "pending"),
            PipelineStep(name: "route_thumbnails", status: "pending"),
            PipelineStep(name: "ability", status: "pending"),
        ]
        let progress = RunProgress(run: run(status: "running", currentStep: 1, steps: steps))
        #expect(progress.label == "识别比赛")
        #expect(progress.stepIndex == 2)
        #expect(progress.stepTotal == 6)
        #expect(progress.percent == 17) // 1/6
    }

    @Test func doneRunReachesFullPercent() {
        let steps = (0..<6).map { PipelineStep(name: "step\($0)", status: "done") }
        let progress = RunProgress(run: run(status: "done", currentStep: 5, steps: steps))
        #expect(progress.percent == 100)
        #expect(progress.stepIndex == 6)
    }

    @Test func unknownStepFallsBackToBackendName() {
        let steps = [PipelineStep(name: "brand_new_step", status: "running")]
        let progress = RunProgress(run: run(status: "running", currentStep: 0, steps: steps))
        #expect(progress.label == "brand_new_step")
    }

    @Test func currentStepClampedWhenBackendShrinks() {
        let steps = [PipelineStep(name: "sync", status: "done")]
        let progress = RunProgress(run: run(status: "running", currentStep: 9, steps: steps))
        #expect(progress.stepIndex == 1)
        #expect(progress.stepTotal == 1)
        #expect(progress.percent == 0)
    }

    @Test func optionValuesSeparateFromLabels() {
        // VALUES 是提交 token（Go oneof），OPTIONS 只是中文标签
        #expect(ProfileSex.allCases.map(\.rawValue) == ["male", "female", "other"])
        #expect(ProfileSex.female.label == "女")
        #expect(RunningAgeRange.allCases.map(\.rawValue) == ["unknown", "lt_6m", "6m_1y", "1y_3y", "3y_plus"])
        #expect(RunningAgeRange.lt6m.label == "不足 6 个月")
        #expect(RunningAgeRange.y3Plus.label == "3 年以上")
        #expect(WatchRegion.global.rawValue == "global")
        #expect(WatchRegion.cn.label == "中国区")
    }

    @Test func validationListsMissingFields() {
        let missing = ProfileFormValidation.missingFields(
            displayName: "  ", dob: nil, sex: nil,
            heightText: "abc", weightText: "-3", runningAge: nil
        )
        #expect(missing.map(\.rawValue) == ["昵称", "生日", "性别", "身高", "体重", "跑步年限"])

        let none = ProfileFormValidation.missingFields(
            displayName: "跑者", dob: "1990-01-01", sex: .male,
            heightText: "178", weightText: "70", runningAge: .unknown
        )
        #expect(none.isEmpty)
    }
}
