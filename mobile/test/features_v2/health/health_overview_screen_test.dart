import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/health/health_overview_screen.dart';
import 'package:stride/features_v2/health/models/health_overview.dart';
import 'package:stride/features_v2/health/providers/health_overview_provider.dart';

/// Pump the HealthOverviewScreen with a provider override.
Future<void> _pump(
  WidgetTester tester,
  AsyncValue<HealthOverview> state,
) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        healthOverviewProvider.overrideWith((_) => _resolve(state)),
      ],
      child: const MaterialApp(home: HealthOverviewScreen()),
    ),
  );
  await tester.pump();
}

/// Convert a synchronous AsyncValue into the right future/stream for override.
Future<HealthOverview> _resolve(AsyncValue<HealthOverview> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    // AsyncLoading — never completes so the screen stays in loading state.
    _ => Completer<HealthOverview>().future,
  };
}

const _fullOverview = HealthOverview(
  rhr: 52,
  rhrBaselineDiff: 2,
  hrv: 48.0,
  hrvLow: 40.0,
  hrvHigh: 65.0,
  fatigue: 42.0,
  fatigueBand: FatigueBand.normal,
  loadState: 'Optimal',
  loadRatio: 0.95,
  sleepHistory: [7.0 * 3600, 6.5 * 3600, 8.0 * 3600, 7.5 * 3600, 7.0 * 3600, 6.0 * 3600, 7.2 * 3600],
  dataDate: '20260512',
);

void main() {
  testWidgets('renders 4 metric card titles from full data', (tester) async {
    await _pump(tester, const AsyncData(_fullOverview));

    expect(find.text('静息心率'), findsOneWidget);
    expect(find.text('睡眠 HRV'), findsOneWidget);
    expect(find.text('疲劳值'), findsOneWidget);
    expect(find.text('训练负荷'), findsOneWidget);
  });

  testWidgets('renders metric values from full data', (tester) async {
    await _pump(tester, const AsyncData(_fullOverview));

    expect(find.text('52'), findsOneWidget);  // RHR
    expect(find.text('48'), findsOneWidget);  // HRV
    expect(find.text('42'), findsOneWidget);  // Fatigue
    expect(find.text('0.95'), findsOneWidget); // Load ratio
  });

  testWidgets('fatigue=65 shows 高疲劳 pill', (tester) async {
    const overview = HealthOverview(
      fatigue: 65.0,
      fatigueBand: FatigueBand.high,
    );
    await _pump(tester, const AsyncData(overview));

    expect(find.text('高疲劳'), findsOneWidget);
  });

  testWidgets('fatigue < 40 shows 已恢复 pill', (tester) async {
    const overview = HealthOverview(
      fatigue: 35.0,
      fatigueBand: FatigueBand.recovered,
    );
    await _pump(tester, const AsyncData(overview));

    expect(find.text('已恢复'), findsOneWidget);
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    // Use a Completer that never completes so the screen stays loading.
    final completer = Completer<HealthOverview>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          healthOverviewProvider.overrideWith((_) => completer.future),
        ],
        child: const MaterialApp(home: HealthOverviewScreen()),
      ),
    );
    // First frame shows loading state before the future resolves.
    await tester.pump();

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    // Clean up — complete the completer so the test doesn't hang.
    completer.completeError(Exception('test done'));
    await tester.pump();
  });

  testWidgets('error state shows error text', (tester) async {
    await _pump(
      tester,
      AsyncError(Exception('network error'), StackTrace.empty),
    );
    await tester.pump();

    expect(find.text('加载失败'), findsOneWidget);
  });

  testWidgets('no sleep data shows placeholder text', (tester) async {
    const overview = HealthOverview(
      fatigueBand: FatigueBand.normal,
      sleepHistory: null,
    );
    await _pump(tester, const AsyncData(overview));

    // Cards may be below the fold in a 600px test viewport — scroll down.
    await tester.scrollUntilVisible(
      find.textContaining('v1.x 即将支持'),
      200.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.textContaining('v1.x 即将支持'), findsOneWidget);
  });

  testWidgets('AI interpret card visible', (tester) async {
    await _pump(tester, const AsyncData(_fullOverview));

    // AI card is below the fold — scroll down to it.
    await tester.scrollUntilVisible(
      find.text('AI 解读'),
      200.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('AI 解读'), findsOneWidget);
  });

  testWidgets('hero renders 身体指标 eyebrow + 健康概览 title', (tester) async {
    await _pump(tester, const AsyncData(_fullOverview));

    expect(find.text('身体指标 · 今日'), findsOneWidget);
    expect(find.text('健康概览'), findsOneWidget);
  });
}
