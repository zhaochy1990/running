/// 圈速表标记 —— 移植小程序 `utils/lapRows.ts` 的 lapPaceMarks。
///
/// - 恢复圈（seg_name 恢复/休息，或原始 mode 3）不计圈号、不比箭头、
///   不参与最快/最慢。
/// - 箭头：本圈 vs 上一「有圈号」圈（跨过中间的恢复圈）。
/// - 最快/最慢：所有有 avg_pace 的普通圈一起排，按配速 s/km 比；有配速的
///   圈 <3 圈不标；全场同配速不分高下。
library;

import '../models/activity_detail.dart';

/// 有配速的圈少于这个数就不标最快/最慢。
const minRankableLaps = 3;

/// 后端 SegmentName 给停顿圈起的名字（exercise_type 4/3 → 恢复/休息）。
const restSegNames = ['恢复', '休息'];

/// COROS 原始圈类型：3 = 恢复圈。
const restMode = 3;

enum Trend { none, up, down }

class LapMark {
  const LapMark({
    this.trend = Trend.none,
    this.hrTrend = Trend.none,
    this.rest = false,
    this.fastest = false,
    this.slowest = false,
  });

  /// 配速走向（up=变快，配速值变小）。
  final Trend trend;

  /// 心率走向（up=升高）。
  final Trend hrTrend;
  final bool rest;
  final bool fastest;
  final bool slowest;
}

bool isRestSegment(LapV2 lap) =>
    restSegNames.contains(lap.segName) || lap.mode == restMode;

Trend _trend(num? cur, num? prev, {bool lowerIsUp = false}) {
  if (cur == null || prev == null || cur == prev) return Trend.none;
  final up = lowerIsUp ? cur < prev : cur > prev;
  return up ? Trend.up : Trend.down;
}

List<LapMark> lapMarks(List<LapV2> laps) {
  final rest = laps.map(isRestSegment).toList(growable: false);
  final paced = <int>[
    for (var i = 0; i < laps.length; i++)
      if (!rest[i] && laps[i].avgPace != null) i,
  ];

  var fast = -1;
  var slow = -1;
  if (paced.length >= minRankableLaps) {
    for (final i in paced) {
      if (fast < 0 || laps[i].avgPace! < laps[fast].avgPace!) fast = i;
      if (slow < 0 || laps[i].avgPace! > laps[slow].avgPace!) slow = i;
    }
    // 全部同配速时不分高下。
    if (laps[fast].avgPace == laps[slow].avgPace) {
      fast = -1;
      slow = -1;
    }
  }

  final marks = <LapMark>[];
  var prevActive = -1;
  for (var i = 0; i < laps.length; i++) {
    if (rest[i]) {
      marks.add(const LapMark(rest: true));
      continue;
    }
    final prev = prevActive >= 0 ? laps[prevActive] : null;
    prevActive = i;
    marks.add(
      LapMark(
        trend: _trend(laps[i].avgPace, prev?.avgPace, lowerIsUp: true),
        hrTrend: _trend(laps[i].avgHr, prev?.avgHr),
        fastest: i == fast,
        slowest: i == slow,
      ),
    );
  }
  return marks;
}
