/// onboarding pipeline 的进度展示 —— 纯函数。
/// 步骤名与 Go catalog 的 onboarding 步骤一一对应（与小程序
/// utils/onboardingSteps.ts 同名同义）：
///   sync → race_detection → calibration → compute → route_thumbnails → ability
library;

import '../../../data/models/pipeline.dart';

class RunProgress {
  const RunProgress({
    required this.label,
    required this.stepIndex,
    required this.stepTotal,
    required this.percent,
  });

  /// 当前步骤的中文名；未知步骤回落到后端给的步骤原名。
  final String label;

  /// 第几步（1 基）/ 共几步。
  final int stepIndex;
  final int stepTotal;

  /// 0-100，按步骤数算的粗粒度进度。
  final int percent;
}

const Map<String, String> kStepLabels = {
  'sync': '同步训练数据',
  'race_detection': '识别比赛',
  'calibration': '计算能力基线',
  'compute': '生成负荷与趋势',
  'route_thumbnails': '生成路线缩略图',
  'ability': '评估当前能力',
};

RunProgress describeRun(PipelineRun run) {
  final total = run.steps.isEmpty ? 1 : run.steps.length;
  // current_step 是"正在跑第几步"的下标；夹紧是为了容忍后端多加/少加步骤时的越界
  final index = run.currentStep.clamp(0, total - 1);
  final name = index < run.steps.length ? run.steps[index].name : '';
  final finished = run.isDone ? total : index;
  return RunProgress(
    label: kStepLabels[name] ?? (name.isEmpty ? '准备中' : name),
    stepIndex: index + 1,
    stepTotal: total,
    percent: ((finished / total) * 100).round(),
  );
}
