import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/models/pipeline.dart';
import 'package:stride/features_v2/onboarding/onboarding_steps.dart';

PipelineRun _run({
  String status = 'running',
  int currentStep = 0,
  List<String> stepNames = const [
    'sync',
    'race_detection',
    'calibration',
    'compute',
    'route_thumbnails',
    'ability',
  ],
  String? errorMessage,
}) => PipelineRun(
  runId: 'run-1',
  pipelineName: 'onboarding',
  status: status,
  currentStep: currentStep,
  steps: stepNames
      .map((n) => PipelineStep(name: n, status: 'queued'))
      .toList(growable: false),
  errorMessage: errorMessage,
);

void main() {
  group('describeRun — 六步中文映射（与小程序 onboardingSteps.ts 同名同义）', () {
    test('第一步 sync → 同步训练数据，第1/6步，粗粒度 0%', () {
      final p = describeRun(_run(currentStep: 0));
      expect(p.label, '同步训练数据');
      expect(p.stepIndex, 1);
      expect(p.stepTotal, 6);
      expect(p.percent, 0);
    });

    test('第三步 calibration → 计算能力基线', () {
      final p = describeRun(_run(currentStep: 2));
      expect(p.label, '计算能力基线');
      expect(p.stepIndex, 3);
      expect(p.percent, 33); // 2/6
    });

    test('route_thumbnails 与 ability 是后三步的中文标签', () {
      expect(describeRun(_run(currentStep: 4)).label, '生成路线缩略图');
      expect(describeRun(_run(currentStep: 5)).label, '评估当前能力');
    });

    test('done → 100%', () {
      final p = describeRun(_run(status: 'done', currentStep: 5));
      expect(p.percent, 100);
      expect(p.stepIndex, 6);
    });

    test('current_step 越界夹紧（容忍后端多加/少加步骤）', () {
      final p = describeRun(_run(currentStep: 99));
      expect(p.stepIndex, 6);
      expect(p.label, '评估当前能力');
    });

    test('未知步骤名回落到后端原名；空 steps 表 total=1', () {
      final p = describeRun(_run(currentStep: 0, stepNames: []));
      expect(p.stepTotal, 1);
      expect(p.label, '准备中');

      final p2 = describeRun(_run(currentStep: 0, stepNames: ['mystery_step']));
      expect(p2.label, 'mystery_step');
    });
  });

  test('kStepLabels 覆盖六步且不夹带多余键', () {
    expect(kStepLabels.keys.toSet(), {
      'sync',
      'race_detection',
      'calibration',
      'compute',
      'route_thumbnails',
      'ability',
    });
  });
}
