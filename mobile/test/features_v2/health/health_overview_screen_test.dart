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
      overrides: [healthOverviewProvider.overrideWith((_) => _resolve(state))],
      child: const MaterialApp(home: HealthOverviewScreen()),
    ),
  );
  await tester.pump();
}

/// Convert a synchronous AsyncValue into the right future/stream for override.
Future<HealthOverview> _resolve(AsyncValue<HealthOverview> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) => Future.error(
      error,
      stackTrace,
    ),
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
  form: -3.0,
  loadRatio: 0.95,
  acuteLoad: 52.0,
  chronicLoad: 55.0,
  dataDate: '20260512',
);

void main() {
  testWidgets('renders 3 metric card titles from full data', (tester) async {
    await _pump(tester, const AsyncData(_fullOverview));

    expect(find.text('静息心率'), findsOneWidget);
    expect(find.text('睡眠 HRV'), findsOneWidget);
    // STRIDE training-load card; no vendor 疲劳值 card.
    expect(find.text('训练负荷'), findsOneWidget);
    expect(find.text('疲劳值'), findsNothing);
  });

  testWidgets('renders metric values from full data', (tester) async {
    await _pump(tester, const AsyncData(_fullOverview));

    expect(find.text('52'), findsOneWidget); // RHR
    expect(find.text('48'), findsOneWidget); // HRV
    expect(find.text('0.95'), findsOneWidget); // STRIDE load ratio (ACWR)
  });

  testWidgets('STRIDE load card shows ATL/CTL subtitle', (tester) async {
    await _pump(tester, const AsyncData(_fullOverview));

    // STRIDE acute/chronic load surfaced in the subtitle.
    expect(find.textContaining('ATL 52'), findsOneWidget);
    expect(find.textContaining('CTL 55'), findsOneWidget);
  });

  testWidgets('high load ratio shows 偏高 pill', (tester) async {
    const overview = HealthOverview(
      loadRatio: 1.5,
      acuteLoad: 75.0,
      chronicLoad: 50.0,
      form: -25.0,
    );
    await _pump(tester, const AsyncData(overview));

    expect(find.text('偏高'), findsOneWidget);
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

  testWidgets('hero trailing renders sync icon', (tester) async {
    await _pump(tester, const AsyncData(_fullOverview));
    expect(find.byIcon(Icons.sync), findsOneWidget);
  });
}
