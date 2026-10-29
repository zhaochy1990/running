import Foundation

// MARK: - onboarding 选项与进度展示（纯函数，devops#418 / #461 决议）

/// 性别（Go `profileInput` oneof：male|female|other；OPTIONS 展示与 VALUES
/// 提交分离——中文标签只做 UI，提交必须用 rawValue）。
public enum ProfileSex: String, Hashable, Sendable, CaseIterable, Identifiable {
    case male, female, other

    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .male: "男"
        case .female: "女"
        case .other: "其他"
        }
    }
}

/// 跑龄档位（Go oneof 含 unknown；与小程序 `utils/profileFields.ts` 同表）。
public enum RunningAgeRange: String, Hashable, Sendable, CaseIterable, Identifiable {
    case unknown
    case lt6m = "lt_6m"
    case m6y1 = "6m_1y"
    case y1y3 = "1y_3y"
    case y3Plus = "3y_plus"

    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .unknown: "暂不透露"
        case .lt6m: "不足 6 个月"
        case .m6y1: "6 个月 – 1 年"
        case .y1y3: "1 – 3 年"
        case .y3Plus: "3 年以上"
        }
    }
}

/// 绑表区域（小程序 REGION_OPTIONS：中国区 / 国际区；提交 cn | global）。
public enum WatchRegion: String, Hashable, Sendable, CaseIterable, Identifiable {
    case cn, global

    public var id: String { rawValue }
    public var label: String {
        switch self {
        case .cn: "中国区"
        case .global: "国际区"
        }
    }
}

/// onboarding pipeline 六步的进度展示（与小程序 `utils/onboardingSteps.ts`
/// 同名同义：sync → race_detection → calibration → compute → route_shapes
/// → ability；后三步 ContinueOnFailure——步失败标注但 run 仍 done。
/// route_shapes 由退役的 route_thumbnails PNG 步骤演变而来（devops#829）：
/// 后端只产 route_thumb_json 形状，缩略图由端上矢量绘制。
public struct RunProgress: Equatable, Sendable {
    public static let stepLabels: [String: String] = [
        "sync": "同步训练数据",
        "race_detection": "识别比赛",
        "calibration": "计算能力基线",
        "compute": "生成负荷与趋势",
        "route_shapes": "生成路线缩略图",
        "ability": "评估当前能力",
    ]

    public let label: String
    /// 第几步（1 基）/ 共几步。
    public let stepIndex: Int
    public let stepTotal: Int
    /// 0–100，按步骤数算的粗粒度进度。
    public let percent: Int

    /// 从 run 状态算展示（未知步骤回落后端原名，无步回落「准备中」；
    /// currentStep 夹紧容忍后端加/减步骤）。
    public init(run: PipelineRun) {
        let total = run.steps.isEmpty ? 1 : run.steps.count
        let index = min(max(run.currentStep, 0), total - 1)
        let name = index < run.steps.count ? run.steps[index].name : ""
        let finished = run.isDone ? total : index
        self.label = Self.stepLabels[name] ?? (name.isEmpty ? "准备中" : name)
        self.stepIndex = index + 1
        self.stepTotal = total
        self.percent = Int((Double(finished) / Double(total) * 100).rounded())
    }
}

/// 资料步表单校验（六字段必填；与 Go profileInput 口径一致）。
public enum ProfileFormValidation {

    public enum Field: String, CaseIterable, Sendable {
        case displayName = "昵称"
        case dob = "生日"
        case sex = "性别"
        case height = "身高"
        case weight = "体重"
        case runningAge = "跑步年限"
    }

    /// 缺啥报啥（小程序/Flutter「还差：…」同款文案）。
    public static func missingFields(
        displayName: String,
        dob: String?,
        sex: ProfileSex?,
        heightText: String,
        weightText: String,
        runningAge: RunningAgeRange?
    ) -> [Field] {
        var missing: [Field] = []
        if displayName.trimmingCharacters(in: .whitespaces).isEmpty { missing.append(.displayName) }
        if dob == nil { missing.append(.dob) }
        if sex == nil { missing.append(.sex) }
        if Double(heightText).flatMap({ $0 > 0 }) != true { missing.append(.height) }
        if Double(weightText).flatMap({ $0 > 0 }) != true { missing.append(.weight) }
        if runningAge == nil { missing.append(.runningAge) }
        return missing
    }
}
