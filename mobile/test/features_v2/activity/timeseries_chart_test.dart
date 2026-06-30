import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/activity/models/timeseries_data.dart';
import 'package:stride/features_v2/activity/providers/timeseries_provider.dart';
import 'package:stride/features_v2/activity/widgets/timeseries_chart.dart';

void main() {
  testWidgets('pace tooltip formats seconds as m\'ss"', (tester) async {
    final chartData = await _pumpChart(
      tester,
      field: ChartField.pace,
      data: const TimeseriesData(
        labelId: 'ACT_001',
        durationSec: 120,
        pointCount: 3,
        intervalSec: 60,
        series: TimeseriesSeries(pace: [270, 285, 300]),
      ),
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
      data: const TimeseriesData(
        labelId: 'ACT_001',
        durationSec: 120,
        pointCount: 3,
        intervalSec: 60,
        series: TimeseriesSeries(hr: [120, 150, 180]),
      ),
    );

    expect(chartData.minY, lessThan(120));
    expect(chartData.maxY, greaterThan(180));
  });
}

Future<LineChartData> _pumpChart(
  WidgetTester tester, {
  required ChartField field,
  required TimeseriesData data,
}) async {
  final fields = field == ChartField.hr ? 'hr' : 'pace';
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        timeseriesProvider((
          id: 'ACT_001',
          fields: fields,
        )).overrideWith((_) async => data),
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
