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
      overrides: [
        trendsProvider(days).overrideWith((_) => _resolve(state)),
      ],
      child: const MaterialApp(home: TrendsScreen()),
    ),
  );
  await tester.pump();
}

Future<List<HealthRecord>> _resolve(AsyncValue<List<HealthRecord>> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<List<HealthRecord>>().future,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

List<HealthRecord> _makeRecords(int n) {
  return List.generate(n, (i) {
    return HealthRecord(
      date: '20260${(i ~/ 30 + 1).toString().padLeft(2, '0')}${(i % 30 + 1).toString().padLeft(2, '0')}',
      fatigue: 42.0 + i.toDouble(),
      rhr: 52 + (i % 5),
      trainingLoadRatio: 0.9 + (i % 3) * 0.1,
      sleepTotalS: 7.0 * 3600 + i * 60,
    );
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  testWidgets('top bar title is 趋势详情', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    expect(find.text('趋势详情'), findsOneWidget);
  });

  testWidgets('dimension seg control has all 5 options', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    // 疲劳 appears in both seg control and chart header (active dim)
    expect(find.text('疲劳'), findsAtLeast(1));
    expect(find.text('HRV'), findsOneWidget);
    expect(find.text('RHR'), findsOneWidget);
    expect(find.text('睡眠'), findsOneWidget);
    expect(find.text('负荷'), findsOneWidget);
  });

  testWidgets('time range seg control has 7天/30天/90天', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    expect(find.text('7天'), findsOneWidget);
    expect(find.text('30天'), findsOneWidget);
    expect(find.text('90天'), findsOneWidget);
  });

  testWidgets('default dimension is 疲劳 with unit 分', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(14)));
    // Both seg label and chart header show 疲劳
    expect(find.text('疲劳'), findsWidgets);
    // 分 appears in chart header and stat row unit cells
    expect(find.text('分'), findsAtLeast(1));
  });

  testWidgets('switching to RHR shows unit bpm', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    // Tap the RHR seg option
    await tester.tap(find.text('RHR'));
    await tester.pump();
    // bpm appears in chart header and stat row unit cells
    expect(find.text('bpm'), findsAtLeast(1));
  });

  testWidgets('switching to 睡眠 shows unit h', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    await tester.tap(find.text('睡眠'));
    await tester.pump();
    // h appears in chart header and stat row unit cells
    expect(find.text('h'), findsAtLeast(1));
  });

  testWidgets('switching to 负荷 shows unit ACWR', (tester) async {
    await _pump(tester, AsyncData(_makeRecords(7)));
    await tester.tap(find.text('负荷'));
    await tester.pump();
    expect(find.text('ACWR'), findsAtLeast(1));
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
        overrides: [
          trendsProvider(30).overrideWith((_) => completer.future),
        ],
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
    // HRV is not per-record (no field in HealthRecord), so always no data.
    await _pump(tester, AsyncData(_makeRecords(7)));
    await tester.tap(find.text('HRV'));
    await tester.pump();
    expect(find.text('该维度暂无数据'), findsOneWidget);
  });
}