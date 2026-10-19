/// 布局无关地定位仓库共享 fixtures 目录 `tests/fixtures/workout/`。
///
/// flutter test 的 CWD = mobile/，但 checkout 深度随环境变化
/// （CI 平铺 checkout 离仓库根 1 层，本地 worktree 可达 3+ 层），
/// 裸相对路径 `../../..` 会红（#589 CI 教训）：从 Directory.current
/// 逐级向上找，上限 8 层。
library;

import 'dart:io';

/// 返回 `tests/fixtures/workout` 的绝对路径；找不到时抛出含当前 CWD 的错误。
Directory workoutFixturesDir() {
  var dir = Directory.current;
  for (var i = 0; i < 8; i++) {
    final candidate = Directory('${dir.path}/tests/fixtures/workout');
    if (candidate.existsSync()) return candidate;
    dir = dir.parent;
  }
  throw StateError(
      'workout fixtures 未找到：从 CWD ${Directory.current.path} 向上 '
      '8 层内不存在 tests/fixtures/workout，请确认在仓库 checkout 内运行 flutter test');
}
