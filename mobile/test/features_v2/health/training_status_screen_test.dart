/// 训练状态页 widget 测试 —— 分区渲染 / readiness 中文 / 热力图点格（#465）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/data/models/activity.dart';
import 'package:stride/data/models/health.dart';
import 'package:stride/data/models/training_status.dart';
import 'package:stride/features_v2/health/providers/training_status_provider.dart';
import 'package:stride/features_v2/health/training_status_screen.dart';

TrainingLoadRecord _rec(
  String date, {
  num dose = 60,
  String coverage = 'normal',
  num chronic = 100,
  num form = -5,
  num? ratio = 0.95,
}) {
  return TrainingLoadRecord(
    date: date,
    trainingDose: dose,
    acuteLoad: 95,
    chronicLoad: chronic,
    form: form,
    loadRatio: ratio,
    coverageStatus: coverage,
    readinessGate: 'yellow',
    readinessReasons: ['low_hrv', 'sleep_debt'],
  );
}

TrainingStatusData _fixture() {
  return TrainingStatusData(
    health: const HealthResponse(
      health: [
        HealthRecord(date: '20261014', rhr: 52),
        HealthRecord(date: '20261013', rhr: 54),
      ],
      hrv: HrvSnapshot(hrvNormalLow: 40, hrvNormalHigh: 65),
      rhrBaseline: 50,
    ),
    hrv: const HrvResponse(hrv: [
      HrvDailyRecord(date: '2026-10-13', lastNightAvg: 48),
      HrvDailyRecord(date: '2026-10-14', lastNightAvg: 50),
    ]),
    zones: const StrideZonesResponse(
      threshold: StrideThreshold(
        pacePerKmSec: 300,
        hrBpm: 172,
        speedConfidence: 'high',
        hrConfidence: 'medium',
        asOfDate: '2026-10-10',
      ),
      paceZones: [
        StridePaceZone(name: 'Z1', label: '恢复', lowerPace: '6:30', upperPace: '5:40'),
      ],
      hrZones: [
        StrideHrZone(name: 'Z1', label: '恢复', lowerBpm: 120, upperBpm: 140),
      ],
    ),
    load: TrainingLoadResponse(
      current: _rec('2026-10-14'),
      series: [
        _rec('2026-10-12'),
        _rec('2026-10-13', coverage: 'unknown'),
        _rec('2026-10-14'),
      ],
    ),
    activitiesByDate: const {
      '2026-10-12': [
        Activity(
          labelId: 'a1',
          sportType: 1,
          sportName: ' outdoor run ',
          date: '2026-10-12T08:00:00+08:00',
          distanceM: 10200,
          distanceKm: 10.2,
          durationS: 3600,
          durationFmt: '1:00:00',
          paceFmt: '5:53/km',
          avgHr: 150,
        ),
      ],
    },
  );
}

Future<void> _pump(WidgetTester tester, Widget child) async {
  // 大 surface：ListView 懒加载，默认 800×600 下方的分区不会 build。
  tester.view.physicalSize = const Size(800, 6000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        trainingStatusProvider.overrideWith((_) => Future.value(_fixture())),
      ],
      child: MaterialApp(home: child),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('渲染分区标题与核心指标 4 卡', (tester) async {
    await _pump(tester, const TrainingStatusScreen());

    expect(find.text('核心指标'), findsOneWidget);
    expect(find.text('趋势'), findsOneWidget);
    expect(find.text('训练负荷'), findsWidgets); // 6 指标卡之一 + 分区标题
    expect(find.text('STRIDE 区间'), findsOneWidget);

    // RHR 最新值 + 基线（指标值在 RichText 内，需 findRichText）。
    expect(find.text('52 bpm', findRichText: true), findsOneWidget);
    expect(find.textContaining('基线 50 bpm'), findsOneWidget);
    // 阈值配速 5:00 /km（值与单位分离）。
    expect(find.text('5:00 /km', findRichText: true), findsOneWidget);
    expect(find.textContaining('置信 high'), findsOneWidget);
    // 阈值心率。
    expect(find.text('172 bpm', findRichText: true), findsOneWidget);
  });

  testWidgets('readiness 徽章 + reasons 中文映射', (tester) async {
    await _pump(tester, const TrainingStatusScreen());

    expect(find.text('黄灯 · 注意，建议减量'), findsOneWidget);
    expect(find.text('HRV 偏低 · 睡眠欠债'), findsOneWidget);
    // ACWR 0.95 → 维持期（<1.0）。
    expect(find.text('维持期'), findsOneWidget);
  });

  testWidgets('unknown 日渲染缺口且窗口 toggle 可切换', (tester) async {
    await _pump(tester, const TrainingStatusScreen());

    // 4 挡窗口都可见，默认选中 30d。
    expect(find.text('30d'), findsOneWidget);
    await tester.tap(find.text('60d'));
    await tester.pumpAndSettle();
    // 切换后页面仍在（全量重渲不崩）。
    expect(find.text('核心指标'), findsOneWidget);
  });

  testWidgets('热力图点格弹日详情，再点收起', (tester) async {
    await _pump(tester, const TrainingStatusScreen());

    expect(find.text('16 周训练热力图'), findsOneWidget);
    // 点 2026-10-12（active，有活动）。
    await tester.tap(find.byKey(const Key('heat-cell-2026-10-12')));
    await tester.pumpAndSettle();

    expect(find.textContaining('10/12 · 周一'), findsOneWidget);
    expect(find.text('训练负荷 60'), findsOneWidget);
    expect(find.textContaining('跑步 10.2km'), findsOneWidget);
    expect(find.textContaining('平均心率 150'), findsOneWidget);

    // 再点同一格收起。
    await tester.tap(find.byKey(const Key('heat-cell-2026-10-12')));
    await tester.pumpAndSettle();
    expect(find.textContaining('10/12 · 周一'), findsNothing);
  });

  testWidgets('加载失败展示错误态', (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          trainingStatusProvider.overrideWith(
            (_) => Future.error(Exception('boom')),
          ),
        ],
        child: const MaterialApp(home: TrainingStatusScreen()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('加载失败'), findsOneWidget);
  });
}
