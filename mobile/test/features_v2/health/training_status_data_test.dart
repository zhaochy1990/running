/// 训练状态纯函数层测试 —— 与小程序 utils/trainingStatus 同口径（#465）。
library;

import 'dart:ui' show Color;

import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/models/training_status.dart';
import 'package:stride/features_v2/health/models/training_status_data.dart';

TrainingLoadRecord rec(
  String date, {
  num? dose = 50,
  String coverage = 'normal',
  num? chronic = 100,
  num? form = -5,
}) {
  return TrainingLoadRecord(
    date: date,
    trainingDose: dose,
    chronicLoad: chronic,
    form: form,
    coverageStatus: coverage,
  );
}

void main() {
  group('classifyForm —— form/CTL 相对五档（#423 表）', () {
    test('五档边界', () {
      expect(classifyForm(26, 100), FormZone.overTaper); // >+.25
      expect(classifyForm(25, 100), FormZone.raceReady); // +.25 边界
      expect(classifyForm(10, 100), FormZone.raceReady); // +.10
      expect(classifyForm(9.9, 100), FormZone.transition);
      expect(classifyForm(-10, 100), FormZone.transition);
      expect(classifyForm(-10.1, 100), FormZone.productive);
      expect(classifyForm(-25, 100), FormZone.productive);
      expect(classifyForm(-25.1, 100), FormZone.overload); // <−.25
    });

    test('null / chronic<=0 → null', () {
      expect(classifyForm(null, 100), isNull);
      expect(classifyForm(5, null), isNull);
      expect(classifyForm(5, 0), isNull);
    });

    test('五档色值与 #423 表一致', () {
      expect(formZoneColor[FormZone.overTaper], const Color(0xFFFFAB00));
      expect(formZoneColor[FormZone.raceReady], const Color(0xFF0097A7));
      expect(formZoneColor[FormZone.transition], const Color(0xFF8888A0));
      expect(formZoneColor[FormZone.productive], const Color(0xFF00A85A));
      expect(formZoneColor[FormZone.overload], const Color(0xFFD32F2F));
    });
  });

  group('readiness gate', () {
    test('颜色与中文标签', () {
      expect(readinessColor('green'), const Color(0xFF00A85A));
      expect(readinessColor('yellow'), const Color(0xFFE68A00));
      expect(readinessColor('red'), const Color(0xFFD32F2F));
      // 未知 gate 归中性灰。
      expect(readinessColor('purple'), const Color(0xFF8888A0));
      expect(readinessColor(null), const Color(0xFF8888A0));
      expect(readinessLabel('green'), '可进行强度训练');
      expect(readinessGateLabel('red'), '红灯');
      expect(readinessLabel(null), '—');
    });

    test('reasons 中文映射（修英文 token 直显）', () {
      expect(
        readinessReasonsText(['low_hrv', 'rhr_elevated', 'sleep_debt', 'ok']),
        'HRV 偏低 · 静息心率偏高 · 睡眠欠债 · 正常',
      );
      // 未知 token 原样保留。
      expect(readinessReasonsText(['whatever']), 'whatever');
    });
  });

  test('loadStateLabel —— ACWR 四档', () {
    expect(loadStateLabel(null), '—');
    expect(loadStateLabel(0.79), '恢复期');
    expect(loadStateLabel(0.8), '维持期');
    expect(loadStateLabel(0.99), '维持期');
    expect(loadStateLabel(1.0), '提升期');
    expect(loadStateLabel(1.29), '提升期');
    expect(loadStateLabel(1.3), '过度负荷');
  });

  group('16 周热力图', () {
    // 固定 today：2026-10-14（周三）。thisMonday=2026-10-12，
    // firstMonday = 10-12 − 15×7d = 2026-06-29（周一）。
    const today = '2026-10-14';

    test('格子数与周一锚定', () {
      final cells = buildHeatCells(const [], today: today);
      expect(cells.length, 16 * 7);
      expect(cells.first.date, '2026-06-29');
      expect(cells.first.dayIdx, 0); // 周一
      expect(cells.last.date, '2026-10-18'); // 本周日
    });

    test('状态机：future / absent / unknown / rest / active', () {
      final cells = buildHeatCells([
        rec('2026-10-13', dose: 60), // active
        rec('2026-10-12', dose: 0), // rest
        rec('2026-10-11', dose: null, coverage: 'unknown'), // unknown
      ], today: today);
      final byDate = {for (final c in cells) c.date: c};
      expect(byDate['2026-10-15']!.state, HeatDayState.future);
      expect(byDate['2026-07-01']!.state, HeatDayState.absent);
      expect(byDate['2026-10-11']!.state, HeatDayState.unknown);
      expect(byDate['2026-10-12']!.state, HeatDayState.rest);
      expect(byDate['2026-10-13']!.state, HeatDayState.active);
      expect(byDate['2026-10-13']!.dose, 60);
      expect(byDate['2026-10-14']!.isToday, isTrue);
    });

    test('月份标签：跨月首列显示 M 月，同月列为空', () {
      final cells = buildHeatCells(const [], today: today);
      final labels = heatMonthLabels(cells);
      expect(labels.first, '6月');
      // 2026-06-29 所在列之后的下一列是 7/6 → 7月。
      expect(labels[1], '7月');
      expect(labels.where((l) => l == '7月').length, 1);
    });

    test('分桶', () {
      expect(heatmapBucket(null), 0);
      expect(heatmapBucket(0), 0);
      expect(heatmapBucket(40), 1);
      expect(heatmapBucket(41), 2);
      expect(heatmapBucket(80), 2);
      expect(heatmapBucket(81), 3);
      expect(heatmapBucket(120), 3);
      expect(heatmapBucket(121), 4);
    });
  });

  group('8 周周剂量聚合', () {
    const today = '2026-10-14'; // 周三；本周一 = 2026-10-12

    test('周桶求和 + activeDays', () {
      final buckets = aggregateWeeklyDose([
        rec('2026-10-12', dose: 30),
        rec('2026-10-13', dose: 40),
        rec('2026-10-14', dose: 0), // 零剂量不算 active
      ], today: today);
      expect(buckets.length, 8);
      expect(buckets.last.weekStart, '2026-10-12');
      expect(buckets.last.totalDose, 70);
      expect(buckets.last.activeDays, 2);
      expect(buckets.last.weekLabel, '10/12');
      // 无记录的周 totalDose 为 null（缺口）。
      expect(buckets.first.totalDose, isNull);
    });

    test('unknown 记录使整周置 null', () {
      final buckets = aggregateWeeklyDose([
        rec('2026-10-12', dose: 30),
        rec('2026-10-13', dose: 40, coverage: 'unknown'),
      ], today: today);
      expect(buckets.last.totalDose, isNull);
    });

    test('窗口外的记录被忽略', () {
      final buckets = aggregateWeeklyDose([
        rec('2026-06-01', dose: 999),
      ], today: today);
      expect(buckets.every((b) => b.totalDose == null), isTrue);
    });
  });

  group('文案 / 格式化', () {
    test('chineseSportName', () {
      expect(chineseSportName(' outdoor run '), '跑步');
      expect(chineseSportName('Strength'), '力量训练');
      expect(chineseSportName(null), '训练');
      expect(chineseSportName('Pickleball'), 'Pickleball');
    });

    test('isDistanceSport', () {
      expect(isDistanceSport('Treadmill'), isTrue);
      expect(isDistanceSport('HIIT'), isFalse);
    });

    test('formatDurationHuman', () {
      expect(formatDurationHuman(null), '—');
      expect(formatDurationHuman(0), '—');
      expect(formatDurationHuman(43 * 60), '43min');
      expect(formatDurationHuman(3600), '1h');
      expect(formatDurationHuman(3600 + 43 * 60), '1h43min');
    });

    test('formatDateShort 兼容 YYYYMMDD', () {
      expect(formatDateShort('2026-10-14'), '10/14');
      expect(formatDateShort('20261014'), '10/14');
      expect(formatDateShort('garbage'), 'garbage');
    });

    test('fmtPace', () {
      expect(fmtPace(300), '5:00/km');
      expect(fmtPace(null), '—');
      expect(fmtPace(0), '—');
    });

    test('padBounds', () {
      expect(padBounds(5, 5, 2), (min: 3.0, max: 7.0));
      expect(padBounds(0, 10, 1), (min: -1.0, max: 11.0));
      expect(padBounds(null, 10, 1), (min: 0.0, max: 1.0));
    });
  });
}
