import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/health/models/race_prediction.dart';
import 'package:stride/features_v2/health/predictions_screen.dart';
import 'package:stride/features_v2/health/providers/race_prediction_provider.dart';

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<RacePrediction> predState, {
  AsyncValue<List<PredictionHistoryPoint>>? historyState,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        racePredictionProvider.overrideWith((_) => _resolvePred(predState)),
        racePredictionHistoryProvider.overrideWith(
          (_) => _resolveHistory(historyState ??
              const AsyncData(<PredictionHistoryPoint>[])),
        ),
      ],
      child: const MaterialApp(home: PredictionsScreen()),
    ),
  );
  await tester.pump();
}

Future<RacePrediction> _resolvePred(AsyncValue<RacePrediction> s) {
  return switch (s) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<RacePrediction>().future,
  };
}

Future<List<PredictionHistoryPoint>> _resolveHistory(
    AsyncValue<List<PredictionHistoryPoint>> s) {
  return switch (s) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<List<PredictionHistoryPoint>>().future,
  };
}

const _fmPrediction = RacePrediction(
  distances: {
    '5K': DistancePrediction(
        predictedTimeSec: 1200, predictedPaceSecPerKm: 240),
    '10K': DistancePrediction(
        predictedTimeSec: 2520, predictedPaceSecPerKm: 252),
    'HM': DistancePrediction(
        predictedTimeSec: 5460, predictedPaceSecPerKm: 259),
    'FM': DistancePrediction(
        predictedTimeSec: 11400, predictedPaceSecPerKm: 270),
  },
  vo2max: 52.3,
  vo2maxTrend: 'up',
);

const _predWithGap = RacePrediction(
  distances: {
    'FM': DistancePrediction(
        predictedTimeSec: 11400, predictedPaceSecPerKm: 270),
  },
  vo2max: 50.0,
  targetGap: TargetGap(
    distance: 'FM',
    targetTimeSec: 10800,
    currentTimeSec: 11400,
    gapSec: 600,
  ),
);

void main() {
  testWidgets('top bar title is 成绩预测', (tester) async {
    await _pump(tester, const AsyncData(_fmPrediction));

    expect(find.text('成绩预测'), findsOneWidget);
  });

  testWidgets('hero card shows FM time 3:10:00', (tester) async {
    await _pump(tester, const AsyncData(_fmPrediction));

    // 11400s = 3h 10m 0s — appears in hero card and distance compare row
    expect(find.text('3:10:00'), findsAtLeast(1));
  });

  testWidgets('hero card shows pace', (tester) async {
    await _pump(tester, const AsyncData(_fmPrediction));

    // pace 270s/km = 4'30"/km
    expect(find.textContaining("4'30\""), findsAtLeast(1));
  });

  testWidgets('distance compare card shows 4 rows', (tester) async {
    await _pump(tester, const AsyncData(_fmPrediction));

    expect(find.text('各距离预测'), findsOneWidget);
    // All 4 distance labels present
    expect(find.text('5K'), findsAtLeast(1));
    expect(find.text('10K'), findsAtLeast(1));
    expect(find.text('半马'), findsAtLeast(1));
    expect(find.text('全马'), findsAtLeast(1));
  });

  testWidgets('VO2max card shows value', (tester) async {
    await _pump(tester, const AsyncData(_fmPrediction));

    expect(find.text('52.3'), findsOneWidget);
  });

  testWidgets('target_gap card shown when gap is non-null', (tester) async {
    await _pump(tester, const AsyncData(_predWithGap));

    expect(find.text('目标进度'), findsOneWidget);
    expect(find.text('距目标还差 10 分 0 秒'), findsOneWidget);
  });

  testWidgets('target_gap card not shown when gap is null', (tester) async {
    await _pump(tester, const AsyncData(_fmPrediction));

    expect(find.text('目标进度'), findsNothing);
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    final completer = Completer<RacePrediction>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          racePredictionProvider.overrideWith((_) => completer.future),
          racePredictionHistoryProvider.overrideWith(
              (_) => Future.value(<PredictionHistoryPoint>[])),
        ],
        child: const MaterialApp(home: PredictionsScreen()),
      ),
    );
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    completer.completeError(Exception('done'));
    await tester.pump();
  });

  testWidgets('error state shows 加载失败', (tester) async {
    await _pump(
      tester,
      AsyncError(Exception('network error'), StackTrace.empty),
    );
    await tester.pump();

    expect(find.text('加载失败'), findsOneWidget);
  });
}
