/// 力量动作分组 —— 移植小程序 activity-detail.ts 的 buildStrengthSegments。
///
/// rest=mode∈{15,16,17}（注意与圈速表「恢复圈」mode 3 口径不同，各自保留）；
/// 连续同名动作合并为一组（组数=段数），组内均 HR 取有值段的平均。
library;

import '../models/activity_detail.dart';

/// 力量段的休息口径：mode 15/16/17（小程序 isRestSegment 的力量分支）。
const strengthRestModes = [15, 16, 17];

class ExerciseGroup {
  const ExerciseGroup({
    required this.name,
    required this.sets,
    required this.durationS,
    this.avgHr,
  });

  final String name;
  final int sets;
  final num durationS;
  final int? avgHr;
}

List<ExerciseGroup> buildStrengthGroups(List<LapV2> segments) {
  final groups = <ExerciseGroup>[];
  var current = const _Acc(name: '', sets: 0, durationS: 0, hrSum: 0, hrCount: 0);

  for (final seg in segments) {
    if (seg.mode != null && strengthRestModes.contains(seg.mode)) continue;
    final name = seg.segName.isEmpty ? '训练' : seg.segName;
    if (current.name == name && current.sets > 0) {
      current = _Acc(
        name: current.name,
        sets: current.sets + 1,
        durationS: current.durationS + seg.durationS,
        hrSum: current.hrSum + (seg.avgHr ?? 0),
        hrCount: current.hrCount + (seg.avgHr != null ? 1 : 0),
      );
    } else {
      if (current.sets > 0) groups.add(current.toGroup());
      current = _Acc(
        name: name,
        sets: 1,
        durationS: seg.durationS,
        hrSum: seg.avgHr ?? 0,
        hrCount: seg.avgHr != null ? 1 : 0,
      );
    }
  }
  if (current.sets > 0) groups.add(current.toGroup());
  return groups;
}

class _Acc {
  const _Acc({
    required this.name,
    required this.sets,
    required this.durationS,
    required this.hrSum,
    required this.hrCount,
  });

  final String name;
  final int sets;
  final num durationS;
  final int hrSum;
  final int hrCount;

  ExerciseGroup toGroup() => ExerciseGroup(
        name: name,
        sets: sets,
        durationS: durationS,
        avgHr: hrCount > 0 ? (hrSum / hrCount).round() : null,
      );
}
