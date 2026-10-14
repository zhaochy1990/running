import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/activity/models/activity_detail.dart';
import 'package:stride/features_v2/activity/providers/activity_detail_provider.dart';
import 'package:stride/features_v2/activity/providers/timeseries_provider.dart';
import 'package:stride/features_v2/activity/widgets/timeseries_chart.dart';

void main() {
  testWidgets("pace tooltip formats seconds as m'ss\"", (tester) async {
    final chartData = await _pumpChart(
      tester,
      field: ChartField.pace,
      points: const [
        TsPoint(timestamp: 0, speed: 270),
        TsPoint(timestamp: 6000, speed: 285),
        TsPoint(timestamp: 12000, speed: 300),
      ],
    );

    final bar = chartData.lineBarsData.single;
    final tooltipItems = chartData.lineTouchData.touchTooltipData
        .getTooltipItems([LineBarSpot(bar, 0, bar.spots.first)]);

    expect(tooltipItems.single!.children!.single.text, '4\'30"');
  });

  testWidgets('heart rate y axis adds padding without cropping values', (
    tester,
  ) async {
    final chartData = await _pumpChart(
      tester,
      field: ChartField.hr,
      points: const [
        TsPoint(timestamp: 0, hr: 120),
        TsPoint(timestamp: 6000, hr: 150),
        TsPoint(timestamp: 12000, hr: 180),
      ],
    );

    expect(chartData.minY, lessThan(120));
    expect(chartData.maxY, greaterThan(180));
  });

  testWidgets('hr line uses zone-gradient coloring when zones present', (
    tester,
  ) async {
    final chartData = await _pumpChart(
      tester,
      field: ChartField.hr,
      points: const [
        TsPoint(timestamp: 0, hr: 130),
        TsPoint(timestamp: 6000, hr: 165),
      ],
      zones: const [
        ZoneV2(
          zoneType: 'heartRate',
          zoneIndex: 1,
          durationS: 60,
          percent: 50,
          rangeMin: 120,
          rangeMax: 160,
        ),
        ZoneV2(
          zoneType: 'heartRate',
          zoneIndex: 2,
          durationS: 60,
          percent: 50,
          rangeMin: 160,
          rangeMax: 180,
        ),
      ],
    );

    final gradient = chartData.lineBarsData.single.gradient;
    expect(gradient, isNotNull);
    // 两个档位 → 颜色表含重复边界 stop（硬边界），首尾颜色不同。
    expect(gradient!.colors.first, isNot(gradient.colors.last));
    expect(gradient.colors.toSet().length, 2);
  });

  testWidgets('hr line falls back to single color without zone ranges', (
    tester,
  ) async {
    final chartData = await _pumpChart(
      tester,
      field: ChartField.hr,
      points: const [
        TsPoint(timestamp: 0, hr: 130),
        TsPoint(timestamp: 6000, hr: 165),
      ],
      zones: const [
        ZoneV2(
          zoneType: 'heartRate',
          zoneIndex: 1,
          durationS: 120,
          percent: 100,
        ),
      ],
    );

    expect(chartData.lineBarsData.single.gradient, isNull);
    expect(chartData.lineBarsData.single.color, isNotNull);
  });
}

Future<LineChartData> _pumpChart(
  WidgetTester tester, {
  required ChartField field,
  required List<TsPoint> points,
  List<ZoneV2> zones = const [],
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        timeseriesProvider('ACT_001').overrideWith((_) async => points),
        activityDetailProvider('ACT_001').overrideWith(
          (_) async => ActivityDetailV2(
            activity: const ActivityV2(
              labelId: 'ACT_001',
              sportType: 1,
              sportName: 'running',
              date: '2026-05-11',
              distanceKm: 10,
              durationFmt: '4:00',
              paceFmt: "4'00\"",
            ),
            segments: const [],
            zones: zones,
          ),
        ),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: TimeseriesChart(activityId: 'ACT_001', field: field),
        ),
      ),
    ),
  );

  await tester.pumpAndSettle();

  return tester.widget<LineChart>(find.byType(LineChart)).data;
}
