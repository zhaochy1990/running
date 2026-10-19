/// WeeklyPlan 模型回归 —— #584 前 Go 落库内容剥离 spec.schema 判别符，
/// WorkoutSpec.fromJson 按 schema 分发会把 run/strength spec 全部落入
/// _Unknown（课时详情 blocks 恒空）。修复后 session.kind 优先分发、schema 兜底。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/models/weekly_plan.dart';

import '../../helpers/workout_fixtures.dart';

void main() {
  test('run spec 无 schema 判别符 → kind 派发为 RunWorkoutSpec（旧存储形态）', () {
    final s = PlannedSession.fromJson({
      'date': '2026-10-12',
      'session_index': 0,
      'kind': 'run',
      'summary': 'Easy run',
      'spec': {
        'name': 'Easy run',
        'date': '2026-10-12',
        'note': null,
        'blocks': [
          {
            'repeat': 1,
            'steps': [
              {
                'step_kind': 'work',
                'duration': {'kind': 'distance_m', 'value': 8000},
                'target': {'kind': 'pace_s_km', 'low': 330, 'high': 360},
              },
            ],
          },
        ],
      },
    });
    expect(s.spec, isA<RunWorkoutSpec>());
    expect((s.spec as RunWorkoutSpec).blocks.first.steps, hasLength(1));
    expect(s.pushable, isTrue);
  });

  test('strength spec 无 schema 判别符 → kind 派发为 StrengthWorkoutSpec', () {
    final s = PlannedSession.fromJson({
      'date': '2026-10-13',
      'session_index': 0,
      'kind': 'strength',
      'summary': '力量',
      'spec': {
        'name': '力量训练',
        'date': '2026-10-13',
        'note': null,
        'exercises': [
          {
            'canonical_id': 'squat',
            'display_name': '深蹲',
            'sets': 3,
            'target_kind': 'reps',
            'target_value': 12,
            'rest_seconds': 90,
          },
        ],
      },
    });
    expect(s.spec, isA<StrengthWorkoutSpec>());
    expect((s.spec as StrengthWorkoutSpec).exercises, hasLength(1));
  });

  test('带 schema 判别符（#584 后新存储形态）仍正常解析', () {
    final s = PlannedSession.fromJson({
      'date': '2026-10-14',
      'session_index': 0,
      'kind': 'run',
      'summary': 'Easy run',
      'schema': 'plan-session/v1',
      'spec': {
        'schema': 'run-workout/v1',
        'name': 'Easy run',
        'date': '2026-10-14',
        'note': null,
        'blocks': <Map<String, dynamic>>[],
      },
    });
    expect(s.spec, isA<RunWorkoutSpec>());
  });

  test('null spec → spec 为 null；未知形态 → _Unknown 兜底', () {
    final rest = PlannedSession.fromJson({
      'date': '2026-10-15', 'session_index': 0, 'kind': 'rest', 'summary': 'Rest',
      'spec': null,
    });
    expect(rest.spec, isNull);

    final unknown = PlannedSession.fromJson({
      'date': '2026-10-16', 'session_index': 0, 'kind': 'cross', 'summary': 'X',
      'spec': <String, dynamic>{},
    });
    // 私有 _Unknown 兕底类型：既非 run 也非 strength。
    expect(unknown.spec, isNot(isA<RunWorkoutSpec>()));
    expect(unknown.spec, isNot(isA<StrengthWorkoutSpec>()));
  });

  group('#589 WorkoutStep duration/note/rest 解析（共享 fixtures）', () {
    PlannedSession sessionFromFixture(String name) {
      final raw =
          File('${workoutFixturesDir().path}/$name').readAsStringSync();
      return PlannedSession.fromJson({
        'date': '2026-05-12',
        'session_index': 0,
        'kind': 'run',
        'summary': '',
        'spec': jsonDecode(raw) as Map<String, dynamic>,
      });
    }

    test('interval-rest-field.json：duration + 步后 rest 字段', () {
      final spec = sessionFromFixture('interval-rest-field.json').spec as RunWorkoutSpec;
      expect(spec.blocks, hasLength(2));
      final step = spec.blocks.first.steps.single;
      expect(spec.blocks.first.repeat, 3);
      expect(step.duration.kind, 'distance_m');
      expect(step.duration.value, 4000);
      expect(step.rest?.kind, 'time_s');
      expect(step.rest?.value, 180);
    });

    test('cadence-target.json：步频 target + manual 休息 + note', () {
      final spec = sessionFromFixture('cadence-target.json').spec as RunWorkoutSpec;
      final step = spec.blocks.single.steps.single;
      expect(step.duration.kind, 'time_s');
      expect(step.duration.value, 20);
      expect(step.target.kind, 'cadence_spm');
      expect(step.target.low, 176);
      expect(step.target.high, 186);
      expect(step.rest?.kind, 'manual');
      expect(step.rest?.value, isNull);
      expect(step.note, '高步频快脚，躯干前倾');
    });
  });
}
