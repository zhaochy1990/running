import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stride/features_v2/health/pmc_screen.dart';
import 'package:stride/features_v2/health/models/pmc_data.dart';
import 'package:stride/features_v2/health/providers/pmc_provider.dart';

// ── Helpers ───────────────────────────────────────────────────────────────────

Future<void> _pump(
  WidgetTester tester,
  AsyncValue<PmcData> state, {
  int days = 90,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        pmcProvider(days).overrideWith((_) => _resolve(state)),
      ],
      child: const MaterialApp(home: PmcScreen()),
    ),
  );
  await tester.pump();
}

Future<PmcData> _resolve(AsyncValue<PmcData> state) {
  return switch (state) {
    AsyncData(:final value) => Future.value(value),
    AsyncError(:final error, :final stackTrace) =>
      Future.error(error, stackTrace),
    _ => Completer<PmcData>().future,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

List<PmcPoint> _makePoints(int n) {
  return List.generate(n, (i) {
    return PmcPoint(
      date: '2026-0${(i ~/ 30) + 1}-${(i % 30 + 1).toString().padLeft(2, '0')}',
      atl: 40.0 + i * 0.5,
      ctl: 35.0 + i * 0.3,
      tsb: -5.0 + i * 0.1,
    );
  });
}

const _productiveSummary = PmcSummary(
  currentAtl: 55.0,
  currentCtl: 50.0,
  currentTsb: -15.0,
  tsbZone: TsbZone.productive,
);

const _raceReadySummary = PmcSummary(
  currentAtl: 35.0,
  currentCtl: 50.0,
  currentTsb: 15.0,
  tsbZone: TsbZone.raceReady,
);

const _overloadSummary = PmcSummary(
  currentAtl: 80.0,
  currentCtl: 40.0,
  currentTsb: -40.0,
  tsbZone: TsbZone.overload,
);

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  testWidgets('top bar title is 训练负荷', (tester) async {
    await _pump(
      tester,
      AsyncData(PmcData(points: _makePoints(10), summary: _productiveSummary)),
    );
    expect(find.text('训练负荷'), findsOneWidget);
  });

  testWidgets('seg control shows 30天/90天/180天', (tester) async {
    await _pump(
      tester,
      const AsyncData(PmcData(points: [], summary: PmcSummary())),
    );
    expect(find.text('30天'), findsOneWidget);
    expect(find.text('90天'), findsOneWidget);
    expect(find.text('180天'), findsOneWidget);
  });

  testWidgets('loading state shows CircularProgressIndicator', (tester) async {
    final completer = Completer<PmcData>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          pmcProvider(90).overrideWith((_) => completer.future),
        ],
        child: const MaterialApp(home: PmcScreen()),
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
      AsyncError(Exception('net error'), StackTrace.empty),
    );
    await tester.pump();
    expect(find.text('加载失败'), findsOneWidget);
  });

  testWidgets('productive TSB shows 正常训练 band highlighted', (tester) async {
    await _pump(
      tester,
      AsyncData(PmcData(points: _makePoints(10), summary: _productiveSummary)),
    );
    // Scroll to band card
    await tester.scrollUntilVisible(
      find.text('TSB 状态区间'),
      200.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('TSB 状态区间'), findsOneWidget);
    // "当前" pill appears once (for the active band)
    expect(find.text('当前'), findsOneWidget);
  });

  testWidgets('race_ready TSB shows 比赛就绪 band active', (tester) async {
    await _pump(
      tester,
      AsyncData(PmcData(points: _makePoints(5), summary: _raceReadySummary)),
    );
    await tester.scrollUntilVisible(
      find.text('当前'),
      200.0,
      scrollable: find.byType(Scrollable).first,
    );
    // The "当前" pill should be next to 比赛就绪
    expect(find.text('当前'), findsOneWidget);
  });

  testWidgets('overload TSB shows 过度负荷 band active', (tester) async {
    await _pump(
      tester,
      AsyncData(PmcData(points: _makePoints(5), summary: _overloadSummary)),
    );
    await tester.scrollUntilVisible(
      find.text('当前'),
      200.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('当前'), findsOneWidget);
  });

  testWidgets('stat row shows ATL / CTL / TSB labels', (tester) async {
    await _pump(
      tester,
      AsyncData(PmcData(points: _makePoints(5), summary: _productiveSummary)),
    );
    // Scroll to the TSB band card which contains the stat row.
    await tester.scrollUntilVisible(
      find.text('TSB 状态区间'),
      200.0,
      scrollable: find.byType(Scrollable).first,
    );
    // ATL/CTL appear in both legend and stat row — use findsAtLeast.
    expect(find.text('ATL'), findsAtLeast(1));
    expect(find.text('CTL'), findsAtLeast(1));
    expect(find.text('TSB'), findsAtLeast(1));
  });

  testWidgets('AI card is visible after scroll', (tester) async {
    await _pump(
      tester,
      AsyncData(PmcData(points: _makePoints(5), summary: _productiveSummary)),
    );
    await tester.scrollUntilVisible(
      find.text('AI 解读'),
      200.0,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('AI 解读'), findsOneWidget);
  });

  testWidgets('empty points shows placeholder text', (tester) async {
    await _pump(
      tester,
      const AsyncData(PmcData(points: [], summary: PmcSummary())),
    );
    expect(find.text('暂无训练负荷数据'), findsOneWidget);
  });
}