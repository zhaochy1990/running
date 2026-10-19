/// workoutFixturesDir 自身回归：两种 checkout 深度（CI 平铺 / 本地 worktree）
/// 下都必须命中仓库根的 tests/fixtures/workout。
library;

import 'package:flutter_test/flutter_test.dart';

import 'workout_fixtures.dart';

void main() {
  test('从当前 CWD 向上定位到 tests/fixtures/workout 且非空', () {
    final dir = workoutFixturesDir();
    expect(dir.path, endsWith('tests/fixtures/workout'));
    expect(dir.existsSync(), isTrue);
    expect(
      dir.listSync().map((e) => e.path.split('/').last),
      containsAll(<String>['interval-rest-field.json', 'cadence-target.json']),
    );
  });
}
