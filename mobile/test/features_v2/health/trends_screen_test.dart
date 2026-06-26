import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/health/trends_screen.dart';
import 'package:stride/features_v2/health/providers/trends_provider.dart';
import 'package:stride/data/models/health.dart';

// ── Helpers ───────────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<List<HealthRecord>> state, {
  int days = 30,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [trendsProvider(days).overrideWith((_) => _resolve(state))],
      child: const MaterialApp(home: TrendsScreen()),
    ),
  );
  await tester.pump();
}

Future<List<HealthRecord>> _resolve(AsyncValue<List<HealthRecord>> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) => Future.error(
      error,
      stackTrace,
    ),
    _ => Completer<List<HealthRecord>>().future,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

List<HealthRecord> _makeRecords(int n) {
  return List.generate(n, (i) {
    return HealthRecord(
      date:
          '20260${(i ~/ 30 + 1).toString().padLeft(2, '0')}${(i % 30 + 1).toString().padLeft(2, '0')}',
      fatigue: 42.0 + i.toDouble(),
      rhr: 52 + (i % 5),
      trainingLoadRatio: 0.9 + (i % 3) * 0.1,
    );
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  testWidgets('top bar title is 趋势详情', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    expect(find.text('趋势详情'), findsOneWidget);
  });

  testWidgets('dimension seg control has 2 universal options', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    // HRV appears in both seg control and chart header (default active dim).
    expect(find.text('HRV'), findsAtLeast(1));
    expect(find.text('RHR'), findsOneWidget);
    // Vendor fatigue + COROS load series and COROS-unavailable sleep removed.
    expect(find.text('睡眠'), findsNothing);
    expect(find.text('疲劳'), findsNothing);
    expect(find.text('负荷'), findsNothing);
  });

  testWidgets('time range seg control has 7天/30天/90天', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    expect(find.text('7天'), findsOneWidget);
    expect(find.text('30天'), findsOneWidget);
    expect(find.text('90天'), findsOneWidget);
  });

  testWidgets('default dimension is HRV with unit ms', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(14)));
    // Both seg label and chart header show HRV
    expect(find.text('HRV'), findsWidgets);
    // ms appears in chart header and stat row unit cells
    expect(find.text('ms'), findsAtLeast(1));
  });

  testWidgets('switching to RHR shows unit bpm', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    // Tap the RHR seg option
    await tester.tap(find.text('RHR'));
    await tester.pump();
    // bpm appears in chart header and stat row unit cells
    expect(find.text('bpm'), findsAtLeast(1));
  });

  testWidgets('stat row shows 当前值 / 7日均 / 趋势 labels', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(14)));
    expect(find.text('当前值'), findsOneWidget);
    expect(find.text('7日均'), findsOneWidget);
    expect(find.text('趋势'), findsOneWidget);
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    final completer = Completer<List<HealthRecord>>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [trendsProvider(30).overrideWith((_) => completer.future)],
        child: const MaterialApp(home: TrendsScreen()),
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

  testWidgets('HRV dimension with no HRV data shows 该维度暂无数据', (tester) async {
    // HRV is the default dim and is not per-record (no field in
    // HealthRecord), so it always renders the no-data placeholder.
    await _pump(tester, AsyncData(_makeRecords(7)));
    await tester.pump();
    expect(find.text('该维度暂无数据'), findsOneWidget);
  });
}
